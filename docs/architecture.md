---
layout: doc
title: Architecture
description: Implemented components, Nomad config, job templates, CLI design, and security model.
---

# Architecture

Nomad-based autonomous coding orchestrator for physical runner fleets.

Version: 0.3.0
Last updated: 2026-03-22

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Nomad Configuration](#2-nomad-configuration)
3. [Parameterized Job Template](#3-parameterized-job-template)
4. [Runtime Adapter Script](#4-runtime-adapter-script)
5. [`yeet` CLI Design](#5-yeet-cli-design)
6. [Nomad Variables for State](#6-nomad-variables-for-state)
7. [Technology Choices](#7-technology-choices)
8. [Security Model](#8-security-model)
9. [Sandboxing with OpenShell](#9-sandboxing-with-openshell)
10. [Scaling Path](#10-scaling-path)

---

## 1. System Overview

The system has two custom components and several off-the-shelf tools. Nomad does the heavy lifting -- scheduling, fleet management, log streaming, health checks, restart policies, drain logic, a built-in web UI, and encrypted key-value storage. We add a thin CLI for ergonomics and a shell script adapter for runtime execution.

### Custom Components

- **`yeet` CLI** -- a thin TypeScript wrapper around Nomad's HTTP API. 380 lines across 3 files. It provides ergonomic defaults, prompt templating, and cost aggregation. It does not contain business logic that Nomad already handles.
- **`run-agent.sh`** -- runtime adapter script (538 lines) that wires up git worktrees, coding agent binaries, and post-run cleanup.
- **Job template** -- parameterized HCL job spec (163 lines) for Nomad batch dispatch.
- **Ansible** -- fleet provisioning (738 lines across 9 roles).
- **Total custom code**: ~1,800 lines.

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
                                    | yeet run / yeet status / yeet logs
                                    | (HTTP to Nomad API via Tailscale)
                                    v
+-----------------------------------------------------------------------+
|                       yeet CLI (380 lines TS, 3 files)                |
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
|                    (yeet-01.tailnet)                                |
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
|   yeet-02           |                |   yeet-03           |
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

The entire backend is Nomad. There is no custom API server, no message queue, no database server. The CLI talks directly to the Nomad HTTP API. Nomad schedules work onto the runner fleet based on node metadata constraints, streams logs, manages retries, and provides a web UI for visibility.

---

## 2. Nomad Configuration

Each node runs a single Nomad agent. One node (yeet-01) acts as both server and client. The others are client-only, joining the server over the Tailscale mesh.

### Server (yeet-01)

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

This node bootstraps a single-node Raft cluster and also participates as a client, running jobs alongside the other nodes. The `bootstrap_expect = 1` configuration is appropriate for this scale; upgrading to a 3-node Raft cluster is straightforward if HA becomes necessary (see [Scaling Path](#9-scaling-path)).

### Client-only (yeet-02, yeet-03)

```hcl
data_dir = "/opt/nomad/data"

server {
  enabled = false
}

client {
  enabled = true
  servers = ["yeet-01.tailnet:4646"]
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

Node metadata is the routing mechanism. Each node advertises two categories of information:

- **Project availability** (`project_<name> = "true"`) -- which project repositories are cloned and ready on this node. When a job is dispatched for `peer6`, Nomad's constraint system ensures it lands on a node where `project_peer6 = "true"`.
- **Device availability** (`device_<type> = "true"`, `device_<type>_path = "/dev/..."`) -- which USB/serial devices are attached. Jobs that require a specific device (e.g., YubiKey for FIDO2 testing) are routed to nodes that have one.

Metadata is declared statically in the Nomad config and updated via Ansible when the fleet topology changes (new project cloned, device moved between nodes). Nomad supports runtime metadata updates via the API as well, which could be used for dynamic device hotplug detection in the future.

---

## 3. Parameterized Job Template

This is the core of the system. One parameterized job template handles all coding agent dispatches. When the `yeet` CLI dispatches a task, Nomad creates a child job from this template with the supplied parameters and routes it to an appropriate node.

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
        command = "/opt/yeet/scripts/run-agent.sh"
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

1. The operator runs `yeet run peer6 "Add pagination to the mentors list"`.
2. The `yeet` CLI sends `POST /v1/job/run-coding-agent/dispatch` with meta `{project: "peer6", runtime: "claude-code", model: "sonnet"}` and the prompt as the payload.
3. Nomad creates a child batch job (e.g., `run-coding-agent/dispatch-1711100000-abcdef`).
4. The constraint `${meta.project_peer6} = "true"` routes the job to a node that has peer6 cloned.
5. Nomad's `raw_exec` driver runs `/opt/yeet/scripts/run-agent.sh` with the meta values injected as environment variables and the prompt written to `${NOMAD_TASK_DIR}/prompt.txt`.
6. The task runs, stdout/stderr are captured by Nomad's log system, and the exit code determines success/failure.
7. On failure, Nomad's restart policy retries up to 2 times with a 30-second delay.

### Constraint Interpolation Note

Nomad's constraint interpolation has limits. The dynamic attribute `${meta.project_${NOMAD_META_project}}` relies on Nomad interpolating the meta value into the attribute path, which works in recent Nomad versions for parameterized jobs. If this proves unreliable in practice, there are two workarounds:

- **Dispatch-time constraint baking**: The `yeet` CLI generates a non-parameterized job spec on the fly with the constraint hardcoded (e.g., `attribute = "${meta.project_peer6}"`), submits it as a regular batch job, and deletes it after completion.
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
BRANCH="yeet/${NOMAD_JOB_ID}"
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
git commit -m "yeet: ${CO_PROJECT} - $(head -c 72 "$CO_PROMPT_FILE")" || true
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
- **Cost storage via Nomad Variables API**. The script writes cost metadata to Nomad's encrypted KV store using a `curl` call to the local agent's API. The `yeet cost` command aggregates these later.

---

## 5. `yeet` CLI Design

The `yeet` CLI is a thin TypeScript wrapper around Nomad's HTTP API. It exists to provide ergonomic defaults (project name aliases, default runtime/model, prompt templating) and to aggregate data that Nomad stores but doesn't present in the exact format we want (e.g., cost rollups). It does not duplicate any functionality that Nomad provides natively.

The CLI communicates with the Nomad server at `yeet-01.tailnet:4646` over the Tailscale mesh. No additional server process is required.

### Command Mapping

Every `yeet` command maps directly to one or two Nomad API calls:

| `yeet` command | What it does | Nomad API call |
|---|---|---|
| `yeet run <project> "<prompt>"` | Dispatch a coding agent job | `POST /v1/job/run-coding-agent/dispatch` with meta (`project`, `runtime`, `model`) and prompt as payload |
| `yeet status` | List active and recent dispatched jobs | `GET /v1/job/run-coding-agent/allocations` (filter by status) |
| `yeet logs <id>` | Stream logs from a running or completed job | Resolve alloc ID from job, then `GET /v1/client/fs/logs/:alloc_id?task=execute&type=stdout&follow=true&plain=true` |
| `yeet stop <id>` | Kill a running job | `POST /v1/allocation/:alloc_id/stop` or `DELETE /v1/job/:job_id?purge=true` |
| `yeet continue <id> "<prompt>"` | Resume a previous session with new instructions | Dispatch new job with `session_id` set to the previous job's session ID (read from Nomad Variables) |
| `yeet runners` | List all nodes in the fleet with their status and metadata | `GET /v1/nodes` |
| `yeet drain <node>` | Mark a node as draining (finish current work, accept no new work) | `POST /v1/node/:node_id/drain` with drain spec |
| `yeet activate <node>` | Mark a drained node as eligible again | `POST /v1/node/:node_id/eligibility` with `{"Eligibility": "eligible"}` |
| `yeet devices` | List devices across the fleet | `GET /v1/nodes` then extract `device_*` metadata from each node |
| `yeet cost` | Show cost breakdown by project, model, and time period | `GET /v1/vars?prefix=cost/` then aggregate the JSON values |

### CLI Defaults

The CLI applies sensible defaults to reduce typing:

- **Runtime**: defaults to `claude-code` if not specified.
- **Model**: defaults to `sonnet` if not specified.
- **Mode**: defaults to `unspecified-low` if not specified.
- **Nomad address**: reads from `NOMAD_ADDR` env var or defaults to `http://yeet-01.tailnet:4646`.
- **Nomad token**: reads from `NOMAD_TOKEN` env var.

A typical invocation is just:

```
yeet run peer6 "Add pagination to the mentors list endpoint"
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

The `yeet cost` command reads all variables under the `cost/` prefix and aggregates them by project, model, time period, or any other dimension. This is a simple read-and-sum operation in the CLI -- no server-side aggregation needed.

### Session Mapping

For `yeet continue` to work, we need to map a human-readable job reference back to a session ID that the coding agent runtime understands:

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
  "branch": "yeet/run-coding-agent/dispatch-1711100000-abcdef"
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
| CLI | **Custom TypeScript (`yeet-cli`)** | Ergonomic wrapper around Nomad API. Adds project aliases, default runtime/model, prompt templating, cost aggregation. 380 lines across 3 files. No framework, no build step beyond `tsc`. |
| Networking | **Tailscale** | Zero-config WireGuard mesh. Every node gets a stable DNS name (`yeet-01.tailnet`). The Nomad server is accessible from the operator's laptop over Tailscale without port forwarding or VPN configuration. Encrypted by default. |
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

- **Nomad ACL tokens** control access to the API. A management token is used for fleet administration (drain, metadata changes). A client-scoped token is used by the `yeet` CLI for job dispatch, log streaming, and variable reads.
- The `yeet` CLI reads the token from the `NOMAD_TOKEN` environment variable, consistent with Nomad's own CLI conventions.

### Execution Isolation

- `raw_exec` runs jobs as the `runner` Linux user, which is unprivileged. It has read/write access to project workspaces under `/home/runner/workspaces/` and read/execute access to scripts under `/opt/yeet/`. It does not have root access.
- In v2, agent processes are wrapped in [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandboxes providing kernel-level isolation: Landlock filesystem allowlists, seccomp syscall filtering, and network namespace + HTTP proxy confinement. Per-task policies scope access to exactly the workspace, devices, and network hosts required. See [Sandboxing with OpenShell](#9-sandboxing-with-openshell).
- Device access is mediated by wrapper scripts, udev rules, and (in v2) Landlock filesystem policies that grant access only to declared devices. USBGuard whitelists are configured on each node to prevent unauthorized device connections.

### Data at Rest

- Nomad Variables (cost data, session mappings) are encrypted at rest using Nomad's built-in keyring. No additional encryption configuration is needed.

### Audit

- **Nomad event stream** captures all job lifecycle events (dispatch, start, complete, fail, stop) with timestamps and metadata. This provides a complete audit trail of what was run, when, on which node, and by whom.
- **run-agent.sh** logs all tool calls and agent output to stdout/stderr, which Nomad captures and retains. These logs are accessible via the API and the web UI.

---

## 9. Sandboxing with OpenShell

Running AI coding agents with full host access is a liability. An unconstrained agent can read sensitive files, exfiltrate data, or execute dangerous syscalls. The `runner` user's unprivileged status and USBGuard whitelists help, but they are coarse-grained. A compromised or misbehaving agent still has broad filesystem and network access.

[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) (Apache 2.0, Rust) provides kernel-level sandboxing designed specifically for AI coding agents. While its full stack runs on Kubernetes, the core sandbox binary (`openshell-sandbox`) runs standalone -- wrapping any process in Landlock + seccomp + network namespace isolation with declarative YAML policies. This is what we use.

### How It Fits

`run-agent.sh` wraps the coding agent CLI in `openshell-sandbox` instead of executing it directly:

```bash
# Instead of:
#   opencode run --quiet "$PROMPT"

# Wrap in sandbox:
openshell-sandbox \
  --policy-rules /opt/yeet/policies/agent.rego \
  --policy-data /opt/yeet/policies/${PROJECT}.yaml \
  -- opencode run --quiet --model "$CO_MODEL" "$PROMPT"
```

Nomad's `raw_exec` driver launches `run-agent.sh`, which launches `openshell-sandbox`, which launches the coding agent. The sandbox binary is a single compiled Rust artifact installed on each node via Ansible.

### Isolation Layers

| Layer | Mechanism | What It Does |
|-------|-----------|-------------|
| Filesystem | Landlock LSM | Kernel-enforced allowlists. Agent can only read/write declared paths. Locked at sandbox creation, immutable. |
| Syscalls | seccomp BPF | Blocks dangerous syscalls. Prevents privilege escalation, raw socket creation, kernel module loading. |
| Network | Linux network namespace + HTTP CONNECT proxy | Agent runs in an isolated network namespace. All traffic forced through a proxy that enforces per-binary, per-host, per-port policies via OPA/Rego. |
| SSRF | DNS-before-connect | Proxy resolves DNS first, blocks any result pointing to private IPs (RFC1918). Prevents SSRF even for allowed hostnames. |
| Binary integrity | SHA256 trust-on-first-use | First time a binary makes a network request, its hash is recorded. If the binary changes, requests are denied. |

### Per-Task Policies

Each task gets a policy scoped to exactly what it needs. The policy is generated by `run-agent.sh` based on the project, mode, and device requirements.

**Standard implementation task** (peer6, no devices):

```yaml
filesystem:
  read_only:
    - /usr
    - /lib
    - /etc
    - /opt/yeet/devices/
  read_write:
    - /opt/yeet/workspaces/peer6/
    - /tmp

network:
  allowed_hosts:
    - api.anthropic.com:443
    - api.openai.com:443
    - github.com:443
    - registry.npmjs.org:443
```

**Device-dependent task** (login2, needs YubiKey):

```yaml
filesystem:
  read_only:
    - /usr
    - /lib
    - /etc
    - /opt/yeet/devices/
  read_write:
    - /opt/yeet/workspaces/login2/
    - /tmp
    - /var/lock/yeet/
    - /dev/yubikey-1              # USB device passthrough via Landlock

network:
  allowed_hosts:
    - api.anthropic.com:443
    - github.com:443
```

**Read-only review task**:

```yaml
filesystem:
  read_only:
    - /usr
    - /lib
    - /etc
    - /opt/yeet/workspaces/rule1/  # read-only, not read_write
  read_write:
    - /tmp                         # agent scratch space only

network:
  allowed_hosts:
    - api.anthropic.com:443        # LLM API only, no GitHub push
```

### USB Device Passthrough

USB devices on Linux are files in `/dev/`. In standalone mode, `openshell-sandbox` runs directly on the host -- no container layer. Adding `/dev/yubikey-1` to the Landlock `read_write` allowlist grants the sandboxed agent access to that specific device and nothing else.

This is better than the unsandboxed design where the `runner` user has group-level access to all devices. With OpenShell policies, a task that declares `--needs yubikey` gets access to `/dev/yubikey-1`. A task that doesn't declare it cannot touch any device, even if it runs on the same node.

The flow:
1. `yeet run login2 "test FIDO2" --needs yubikey`
2. Nomad routes to a node with `device_yubikey=true`
3. `run-agent.sh` generates a policy YAML with `/dev/yubikey-1` in `read_write`
4. Agent runs inside `openshell-sandbox` -- can access the YubiKey, cannot access any other device

### Network Policy and API Key Scoping

The HTTP CONNECT proxy enables fine-grained network control:

- An OpenCode task using Anthropic models only needs `api.anthropic.com:443`
- A Claude Code task only needs `api.anthropic.com:443`
- `github.com:443` is allowed for git push and PR creation
- Package registries (`registry.npmjs.org`, `pypi.org`) are allowed per-project
- Everything else -- internal networks, other APIs, metadata endpoints -- is blocked by default

API keys are injected as environment variables by Nomad (from the job meta or node environment). They never appear in the policy file or on disk inside the sandbox.

### Rollout Plan

- **v1**: No sandbox. Agents run as the unprivileged `runner` user via `raw_exec`. USBGuard and device wrapper scripts provide basic safety.
- **v2**: Install `openshell-sandbox` binary on each node via Ansible. Wrap agent execution in `run-agent.sh`. Generate per-task policies from dispatch metadata. Filesystem and network isolation enforced.
- **v3**: Contribute USB device passthrough documentation upstream to NVIDIA OpenShell. Refine per-project policy templates based on operational experience.

---

## 10. Scaling Path

- **v1 (current target)**: Single Nomad server on yeet-01, unsandboxed agent execution, which also runs as a client. Two additional client-only nodes (yeet-02, yeet-03). Three nodes total. This handles the expected workload of dozens of concurrent agent dispatches.

- **v2 (sandboxing + capacity)**: OpenShell sandbox integration. Add more nodes as Nomad clients. Provisioning is: install Nomad via Ansible, join the server, set node metadata. A new node can go from unboxing to accepting jobs in under 30 minutes.

- **v3 (high availability)**: If the single server becomes a reliability concern, add two more server nodes (any two of the existing nodes can be promoted) to form a 3-node Raft cluster. Nomad handles leader election and state replication automatically.

- **v4 (observability)**: For richer dashboards beyond what the Nomad UI provides, build a lightweight web frontend that consumes the Nomad event stream API. Alternatively, the built-in Nomad UI may be sufficient indefinitely.

