# code-orchestration Architecture

Nomad-based autonomous coding orchestrator for physical runner fleets.

Version: 0.2.0
Last updated: 2026-03-22

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Nomad Configuration](#2-nomad-configuration)
3. [Parameterized Job Template](#3-parameterized-job-template)
4. [Runtime Adapter Script](#4-runtime-adapter-script)
5. [`co` CLI Design](#5-co-cli-design)
6. [Nomad Variables for State](#6-nomad-variables-for-state)
7. [Technology Choices](#7-technology-choices)
8. [Security Model](#8-security-model)
9. [Scaling Path](#9-scaling-path)
10. [What We Don't Build](#10-what-we-dont-build)

---

## 1. System Overview

The system has two custom components and several off-the-shelf tools. Nomad does the heavy lifting -- scheduling, fleet management, log streaming, health checks, restart policies, drain logic, a built-in web UI, and encrypted key-value storage. We add a thin CLI for ergonomics and a shell script adapter for runtime execution.

### Custom Components

- **`co` CLI** -- a thin TypeScript wrapper around Nomad's HTTP API. Roughly 200 lines. It provides ergonomic defaults, prompt templating, and cost aggregation. It does not contain business logic that Nomad already handles.
- **Job templates** -- parameterized HCL job specs and a runtime adapter shell script (`run-agent.sh`) that wires up git worktrees, coding agent binaries, and post-run cleanup.

### Off-the-Shelf

- **Nomad** -- orchestration, scheduling, fleet management, log streaming, metadata, web UI, ACLs, encrypted variables, restart policies, node drain. Single Go binary. This replaces the custom API, BullMQ, Redis, the worker daemon, Bull Board, and the cost database.
- **Tailscale** -- encrypted WireGuard mesh networking between all nodes and the operator's laptop. Zero config, no port forwarding.
- **Ansible** -- fleet provisioning. Installs Nomad, coding agent runtimes, udev rules, clones project repos. Agentless, runs over SSH.
- **udev + flock** -- Linux-native device naming (stable `/dev/yubikey-1` symlinks) and POSIX file locking for exclusive device access.

### Architecture Diagram

```
                        +---------------------------+
                        |       Human Operator      |
                        |       (laptop)            |
                        +---------------------------+
                                    |
                                    | co run / co status / co logs
                                    | (HTTP to Nomad API via Tailscale)
                                    v
+-----------------------------------------------------------------------+
|                         co CLI (~200 lines TS)                        |
|  Thin wrapper: translates commands to Nomad HTTP API calls.           |
|  No server process. No database. Just a script.                       |
+-----------------------------------------------------------------------+
                                    |
                                    | Nomad HTTP API (:4646)
                                    | via Tailscale mesh
                                    v
+-----------------------------------------------------------------------+
|                                                                       |
|                    Nomad Server + Client                              |
|                    (co-dell-01.tailnet)                                |
|                                                                       |
|  +------------------+  +------------------+  +-------------------+    |
|  |  Job Scheduler   |  |   Nomad Web UI   |  | Nomad Variables   |    |
|  |  Parameterized   |  |   :4646/ui       |  | (encrypted KV)    |    |
|  |  batch dispatch  |  |                  |  | cost, sessions    |    |
|  +------------------+  +------------------+  +-------------------+    |
|                                                                       |
|  Also runs as client: executes jobs locally via raw_exec              |
|  meta: project_peer6=true, project_rule1=true                         |
+-----------------------------------------------------------------------+
         |                                           |
         | Nomad client protocol                     | Nomad client protocol
         | (via Tailscale)                           | (via Tailscale)
         v                                           v
+------------------------+                +------------------------+
|   co-dell-02           |                |   co-dell-03           |
|   Nomad Client         |                |   Nomad Client         |
|                        |                |                        |
|   raw_exec driver      |                |   raw_exec driver      |
|   run-agent.sh         |                |   run-agent.sh         |
|                        |                |                        |
|   meta:                |                |   meta:                |
|     project_login2     |                |     project_peer6      |
|     device_yubikey     |                |     project_login2     |
|     device_yubikey_    |                |                        |
|       path=/dev/       |                |                        |
|       yubikey-1        |                |                        |
+------------------------+                +------------------------+
         |
         v
   +-----------+
   | YubiKey 5 |
   | /dev/     |
   | yubikey-1 |
   +-----------+
```

The entire backend is Nomad. There is no custom API server, no message queue, no database server. The CLI talks directly to the Nomad HTTP API. Nomad schedules work onto the Dell fleet based on node metadata constraints, streams logs, manages retries, and provides a web UI for visibility.

---

## 2. Nomad Configuration

Each Dell runs a single Nomad agent. One node (co-dell-01) acts as both server and client. The others are client-only, joining the server over the Tailscale mesh.

### Server (co-dell-01)

```hcl
data_dir = "/opt/nomad/data"

server {
  enabled          = true
  bootstrap_expect = 1  # single server, fine for this scale
}

client {
  enabled = true
  meta {
    "project_peer6" = "true"
    "project_rule1" = "true"
  }
}

plugin "raw_exec" {
  config {
    enabled = true
  }
}
```

This node bootstraps a single-node Raft cluster and also participates as a client, running jobs alongside the other Dells. The `bootstrap_expect = 1` configuration is appropriate for this scale; upgrading to a 3-node Raft cluster is straightforward if HA becomes necessary (see [Scaling Path](#9-scaling-path)).

### Client-only (co-dell-02, co-dell-03)

```hcl
data_dir = "/opt/nomad/data"

server {
  enabled = false
}

client {
  enabled = true
  servers = ["co-dell-01.tailnet:4646"]
  meta {
    "project_login2"       = "true"
    "device_yubikey"       = "true"
    "device_yubikey_path"  = "/dev/yubikey-1"
  }
}

plugin "raw_exec" {
  config {
    enabled = true
  }
}
```

### Node Metadata

Node metadata is the routing mechanism. Each Dell advertises two categories of information:

- **Project availability** (`project_<name> = "true"`) -- which project repositories are cloned and ready on this node. When a job is dispatched for `peer6`, Nomad's constraint system ensures it lands on a node where `project_peer6 = "true"`.
- **Device availability** (`device_<type> = "true"`, `device_<type>_path = "/dev/..."`) -- which USB/serial devices are attached. Jobs that require a specific device (e.g., YubiKey for FIDO2 testing) are routed to nodes that have one.

Metadata is declared statically in the Nomad config and updated via Ansible when the fleet topology changes (new project cloned, device moved between nodes). Nomad supports runtime metadata updates via the API as well, which could be used for dynamic device hotplug detection in the future.

---

## 3. Parameterized Job Template

This is the core of the system. One parameterized job template handles all coding agent dispatches. When the `co` CLI dispatches a task, Nomad creates a child job from this template with the supplied parameters and routes it to an appropriate node.

### Job Spec

```hcl
job "run-coding-agent" {
  type = "batch"

  parameterized {
    payload       = "required"        # prompt text, can be large
    meta_required = ["project", "runtime", "model"]
    meta_optional = ["mode", "budget", "session_id", "needs_device"]
  }

  # Route to a node that has the project
  constraint {
    attribute = "${meta.project_${NOMAD_META_project}}"
    value     = "true"
  }

  group "agent" {
    task "execute" {
      driver = "raw_exec"

      config {
        command = "/opt/code-orchestration/scripts/run-agent.sh"
        args    = []  # all config via env vars from meta
      }

      dispatch_payload {
        file = "prompt.txt"
      }

      env {
        CO_PROJECT    = "${NOMAD_META_project}"
        CO_RUNTIME    = "${NOMAD_META_runtime}"
        CO_MODEL      = "${NOMAD_META_model}"
        CO_MODE       = "${NOMAD_META_mode}"
        CO_BUDGET     = "${NOMAD_META_budget}"
        CO_SESSION_ID = "${NOMAD_META_session_id}"
        CO_PROMPT_FILE = "${NOMAD_TASK_DIR}/prompt.txt"
      }

      resources {
        cpu    = 500
        memory = 512
      }

      restart {
        attempts = 2
        delay    = "30s"
        mode     = "fail"
      }
    }
  }
}
```

### How It Works

1. The operator runs `co run peer6 "Add pagination to the mentors list"`.
2. The `co` CLI sends `POST /v1/job/run-coding-agent/dispatch` with meta `{project: "peer6", runtime: "claude-code", model: "sonnet"}` and the prompt as the payload.
3. Nomad creates a child batch job (e.g., `run-coding-agent/dispatch-1711100000-abcdef`).
4. The constraint `${meta.project_peer6} = "true"` routes the job to a node that has peer6 cloned.
5. Nomad's `raw_exec` driver runs `/opt/code-orchestration/scripts/run-agent.sh` with the meta values injected as environment variables and the prompt written to `${NOMAD_TASK_DIR}/prompt.txt`.
6. The task runs, stdout/stderr are captured by Nomad's log system, and the exit code determines success/failure.
7. On failure, Nomad's restart policy retries up to 2 times with a 30-second delay.

### Constraint Interpolation Note

Nomad's constraint interpolation has limits. The dynamic attribute `${meta.project_${NOMAD_META_project}}` relies on Nomad interpolating the meta value into the attribute path, which works in recent Nomad versions for parameterized jobs. If this proves unreliable in practice, there are two workarounds:

- **Dispatch-time constraint baking**: The `co` CLI generates a non-parameterized job spec on the fly with the constraint hardcoded (e.g., `attribute = "${meta.project_peer6}"`), submits it as a regular batch job, and deletes it after completion.
- **Node pools**: Nomad Enterprise (or the OSS node pool feature in 1.6+) allows grouping nodes by project, avoiding dynamic constraint interpolation entirely.

---

## 4. Runtime Adapter Script

The `run-agent.sh` script is what Nomad actually executes via `raw_exec`. It bridges the gap between Nomad's job dispatch and the coding agent binaries. All configuration arrives via environment variables set by the job template.

### Script Outline

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- 1. Read configuration from environment ---
# CO_PROJECT, CO_RUNTIME, CO_MODEL, CO_MODE, CO_BUDGET,
# CO_SESSION_ID, CO_PROMPT_FILE
# NOMAD_ALLOC_ID, NOMAD_JOB_ID (set by Nomad automatically)

# --- 2. Resolve project workspace ---
PROJECT_DIR="/home/runner/workspaces/${CO_PROJECT}"
cd "$PROJECT_DIR"

# --- 3. Update source ---
git fetch origin
git checkout main
git pull --ff-only

# --- 4. Create isolated worktree ---
BRANCH="co/${NOMAD_JOB_ID}"
git worktree add "../worktrees/${BRANCH}" -b "$BRANCH"
cd "../worktrees/${BRANCH}"

# --- 5. Select runtime and build command ---
# Maps CO_RUNTIME to binary path and constructs CLI arguments.
# Supported runtimes: claude-code, codex, aider, goose, amp
# Applies CO_MODEL, CO_MODE, CO_BUDGET as runtime-specific flags.
# Reads prompt from CO_PROMPT_FILE.
# If CO_SESSION_ID is set, passes --resume/--continue flag.

# --- 6. Acquire device lock if needed ---
# If CO_NEEDS_DEVICE is set, flock the device path before proceeding.

# --- 7. Execute the coding agent ---
# Runs the constructed command, inheriting stdout/stderr for Nomad log capture.

# --- 8. Post-run: commit and push ---
git add -A
git commit -m "co: ${CO_PROJECT} - $(head -c 72 "$CO_PROMPT_FILE")" || true
git push origin "$BRANCH"
# Optionally: gh pr create --title "..." --body "..."

# --- 9. Store cost/metadata in Nomad Variables ---
# Parses cost from agent output (runtime-specific).
# PUT /v1/var/cost/${NOMAD_JOB_ID} via curl to local Nomad agent.

# --- 10. Notify ---
# POST to ntfy.sh topic with job result summary.

# --- 11. Cleanup ---
cd "$PROJECT_DIR"
git worktree remove "../worktrees/${BRANCH}" --force
```

### Key Design Decisions

- **git worktree** for isolation instead of Docker containers. Each dispatched job gets its own worktree on a dedicated branch, so multiple jobs for the same project can run concurrently on the same node without interference. Native git, no container overhead.
- **flock(1)** for device locking. If two jobs need the same YubiKey, the second one blocks on `flock` until the first releases it. POSIX standard, zero dependencies.
- **Nomad log capture**. The script inherits Nomad's stdout/stderr capture, so all agent output is available via `nomad alloc logs` and the Nomad UI with no additional log infrastructure.
- **Cost storage via Nomad Variables API**. The script writes cost metadata to Nomad's encrypted KV store using a `curl` call to the local agent's API. The `co cost` command aggregates these later.

---

## 5. `co` CLI Design

The `co` CLI is a thin TypeScript wrapper around Nomad's HTTP API. It exists to provide ergonomic defaults (project name aliases, default runtime/model, prompt templating) and to aggregate data that Nomad stores but doesn't present in the exact format we want (e.g., cost rollups). It does not duplicate any functionality that Nomad provides natively.

The CLI communicates with the Nomad server at `co-dell-01.tailnet:4646` over the Tailscale mesh. No additional server process is required.

### Command Mapping

Every `co` command maps directly to one or two Nomad API calls:

| `co` command | What it does | Nomad API call |
|---|---|---|
| `co run <project> "<prompt>"` | Dispatch a coding agent job | `POST /v1/job/run-coding-agent/dispatch` with meta (`project`, `runtime`, `model`) and prompt as payload |
| `co status` | List active and recent dispatched jobs | `GET /v1/job/run-coding-agent/allocations` (filter by status) |
| `co logs <id>` | Stream logs from a running or completed job | Resolve alloc ID from job, then `GET /v1/client/fs/logs/:alloc_id?task=execute&type=stdout&follow=true&plain=true` |
| `co stop <id>` | Kill a running job | `POST /v1/allocation/:alloc_id/stop` or `DELETE /v1/job/:job_id?purge=true` |
| `co continue <id> "<prompt>"` | Resume a previous session with new instructions | Dispatch new job with `session_id` set to the previous job's session ID (read from Nomad Variables) |
| `co runners` | List all nodes in the fleet with their status and metadata | `GET /v1/nodes` |
| `co drain <node>` | Mark a node as draining (finish current work, accept no new work) | `POST /v1/node/:node_id/drain` with drain spec |
| `co activate <node>` | Mark a drained node as eligible again | `POST /v1/node/:node_id/eligibility` with `{"Eligibility": "eligible"}` |
| `co devices` | List devices across the fleet | `GET /v1/nodes` then extract `device_*` metadata from each node |
| `co cost` | Show cost breakdown by project, model, and time period | `GET /v1/vars?prefix=cost/` then aggregate the JSON values |

### CLI Defaults

The CLI applies sensible defaults to reduce typing:

- **Runtime**: defaults to `claude-code` if not specified.
- **Model**: defaults to `sonnet` if not specified.
- **Mode**: defaults to `unspecified-low` if not specified.
- **Nomad address**: reads from `NOMAD_ADDR` env var or defaults to `http://co-dell-01.tailnet:4646`.
- **Nomad token**: reads from `NOMAD_TOKEN` env var.

A typical invocation is just:

```
co run peer6 "Add pagination to the mentors list endpoint"
```

This dispatches with `{project: "peer6", runtime: "claude-code", model: "sonnet", mode: "unspecified-low"}`.

---

## 6. Nomad Variables for State

Nomad includes a built-in encrypted key-value store called [Nomad Variables](https://developer.hashicorp.com/nomad/docs/concepts/variables). Values are encrypted at rest using a key managed by Nomad's keyring. We use this for all persistent state, eliminating the need for SQLite, D1, or any external database.

### Cost Tracking

After each job completes, `run-agent.sh` writes cost data:

```
PUT /v1/var/cost/{job-id}
```

```json
{
  "cost_usd": 0.0342,
  "input_tokens": 12450,
  "output_tokens": 3210,
  "model": "claude-sonnet-4-20250514",
  "project": "peer6",
  "runtime": "claude-code",
  "timestamp": "2026-03-22T14:30:00Z",
  "duration_seconds": 127
}
```

The `co cost` command reads all variables under the `cost/` prefix and aggregates them by project, model, time period, or any other dimension. This is a simple read-and-sum operation in the CLI -- no server-side aggregation needed.

### Session Mapping

For `co continue` to work, we need to map a human-readable job reference back to a session ID that the coding agent runtime understands:

```
PUT /v1/var/sessions/{session-id}
```

```json
{
  "job_id": "run-coding-agent/dispatch-1711100000-abcdef",
  "alloc_id": "a1b2c3d4",
  "project": "peer6",
  "runtime": "claude-code",
  "status": "complete",
  "branch": "co/run-coding-agent/dispatch-1711100000-abcdef"
}
```

### Why Not an External Database

- Nomad Variables are encrypted at rest with zero configuration.
- They are replicated via Raft (when running multi-server), so they survive server restarts.
- They are accessible via the same HTTP API the CLI already talks to.
- They support ACL policies for access control.
- For the volume of data we produce (dozens of cost records per day), the performance is more than adequate.

---

## 7. Technology Choices

| Component | Choice | Why |
|---|---|---|
| Orchestrator | **Nomad** | Replaces five or more custom components (API server, BullMQ, Redis, worker daemon, Bull Board). Single Go binary. Parameterized batch jobs, raw_exec driver, built-in web UI, ACL system, log streaming, encrypted variables, restart policies, node drain, health checks. Battle-tested at scale by HashiCorp and the industry. |
| CLI | **Custom TypeScript (`co`)** | Ergonomic wrapper around Nomad API. Adds project aliases, default runtime/model, prompt templating, cost aggregation. Approximately 200 lines. No framework, no build step beyond `tsc`. |
| Networking | **Tailscale** | Zero-config WireGuard mesh. Every node gets a stable DNS name (`co-dell-01.tailnet`). The Nomad server is accessible from the operator's laptop over Tailscale without port forwarding or VPN configuration. Encrypted by default. |
| Provisioning | **Ansible** | Installs Nomad, coding agent runtimes (Claude Code, Codex, Aider, Goose, Amp), udev rules, and clones project repos. Agentless (runs over SSH). Playbooks are idempotent and version-controlled. |
| Device naming | **udev** | Linux-native. Writes rules that create stable symlinks like `/dev/yubikey-1` regardless of USB enumeration order. Survives reboots and re-plugging. |
| Device locking | **flock(1)** | POSIX standard file locking. Zero dependencies. The adapter script calls `flock /var/lock/device-yubikey-1 ...` to get exclusive access. If the device is in use, the second caller blocks until it is released. |
| Git isolation | **git worktree** | Native git feature. Each dispatched job gets its own worktree on a dedicated branch. Multiple jobs for the same project can run concurrently on the same node. No Docker, no container overhead. |
| Notifications | **Ntfy.sh** | Simple HTTP POST from `run-agent.sh` on job completion or failure. Free, self-hostable, supports mobile push. No SDK, no dependencies -- just `curl`. |

---

## 8. Security Model

### Network

- The Nomad API (port 4646) is only reachable over the Tailscale mesh. It is not exposed to the public internet. Tailscale provides WireGuard encryption for all traffic between nodes and the operator's laptop.

### Authentication and Authorization

- **Nomad ACL tokens** control access to the API. A management token is used for fleet administration (drain, metadata changes). A client-scoped token is used by the `co` CLI for job dispatch, log streaming, and variable reads.
- The `co` CLI reads the token from the `NOMAD_TOKEN` environment variable, consistent with Nomad's own CLI conventions.

### Execution Isolation

- `raw_exec` runs jobs as the `runner` Linux user, which is unprivileged. It has read/write access to project workspaces under `/home/runner/workspaces/` and read/execute access to scripts under `/opt/code-orchestration/`. It does not have root access.
- Device access is mediated by wrapper scripts and udev rules. The `runner` user is added to the appropriate groups (e.g., `plugdev`) for USB device access. USBGuard whitelists are configured on each Dell to prevent unauthorized device connections.

### Data at Rest

- Nomad Variables (cost data, session mappings) are encrypted at rest using Nomad's built-in keyring. No additional encryption configuration is needed.

### Audit

- **Nomad event stream** captures all job lifecycle events (dispatch, start, complete, fail, stop) with timestamps and metadata. This provides a complete audit trail of what was run, when, on which node, and by whom.
- **run-agent.sh** logs all tool calls and agent output to stdout/stderr, which Nomad captures and retains. These logs are accessible via the API and the web UI.

---

## 9. Scaling Path

- **v1 (current target)**: Single Nomad server on co-dell-01, which also runs as a client. Two additional client-only Dells (co-dell-02, co-dell-03). Three nodes total. This handles the expected workload of dozens of concurrent agent dispatches.

- **v2 (add capacity)**: Add more Dell 5070s as Nomad clients. Provisioning is: install Nomad via Ansible, join the server, set node metadata. A new node can go from unboxing to accepting jobs in under 30 minutes.

- **v3 (high availability)**: If the single server becomes a reliability concern, add two more server nodes (any two of the existing Dells can be promoted) to form a 3-node Raft cluster. Nomad handles leader election and state replication automatically.

- **v4 (observability)**: For richer dashboards beyond what the Nomad UI provides, build a lightweight web frontend that consumes the Nomad event stream API. Alternatively, the built-in Nomad UI may be sufficient indefinitely.

---

## 10. What We Don't Build

The entire value proposition of this architecture is the volume of custom code we avoid writing. Nomad provides battle-tested implementations of everything below. Each item in this list represents hundreds to thousands of lines of custom code that would need to be written, tested, debugged, and maintained.

| Previously planned custom component | Replaced by |
|---|---|
| Custom API server (Hono, REST endpoints, route handlers) | Nomad HTTP API |
| BullMQ task queue (producer, consumer, job definitions) | Nomad parameterized batch jobs + scheduler |
| Redis (queue backend, pub/sub, state) | Not needed. Nomad is self-contained. |
| Worker daemon (systemd service, queue consumer, heartbeat) | Nomad client agent + raw_exec driver |
| Cloudflare Workers (control plane hosting) | Not needed. Nomad server runs on the Dell. |
| D1/SQLite (cost tracking, audit log, session state) | Nomad Variables (encrypted KV) |
| Bull Board (queue monitoring UI) | Nomad built-in web UI |
| Custom heartbeat/health check protocol | Nomad node health monitoring |
| Custom node drain logic | `nomad node drain` (built-in) |
| Custom retry/backoff logic | Nomad restart policies |
| Custom log streaming (WebSocket server, pub/sub) | Nomad log API (`/v1/client/fs/logs` with `follow=true`) |

The system reduces to: one HCL job template, one shell script, and a 200-line CLI wrapper. Everything else is Nomad.
