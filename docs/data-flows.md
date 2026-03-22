---
layout: doc
title: Data Flows
description: ASCII sequence diagrams for every operation in the system.
---

# Data Flows

Sequence diagrams and data flow descriptions for every major operation in the
yeet system. All orchestration flows through HashiCorp Nomad --
no custom API server, no Redis, no BullMQ. Nomad handles scheduling,
placement, execution, health, and state.

## Component Key

| Abbreviation | Component | Description |
|-------------|-----------|-------------|
| yeet CLI | `yeet` binary | Runs on user's laptop |
| Nomad Server | Nomad server agent | Runs on yeet-01, single-node server cluster |
| Nomad Client | Nomad client agent | Runs on each node (including yeet-01) |
| raw_exec | Nomad task driver | Spawns processes directly (no container isolation) |
| run-agent.sh | Runtime adapter | Shell script launched by raw_exec, manages git + runtime lifecycle |
| openshell-sandbox | Sandbox wrapper (v2) | NVIDIA OpenShell binary -- applies Landlock, seccomp, and network namespace isolation around the runtime |
| Runtime | Coding agent | OpenCode, Claude Code, or Aider -- spawned inside openshell-sandbox |
| Git | GitHub | Remote repository hosting |
| Ntfy | Ntfy server | Push notification service |
| Nomad Variables | Built-in KV store | Stores cost data, session IDs, task metadata |

---

## 1. Task Submission (Full Lifecycle)

User submits a task via CLI. The CLI dispatches a parameterized Nomad job.
Nomad evaluates constraints, places the allocation on a matching node, and
raw_exec launches run-agent.sh, which manages the full git + runtime lifecycle.

```
yeet run peer6 "implement feature X" --runtime opencode --category quick
```

### Dispatch Payload

The CLI sends a dispatch request with metadata and a base64-encoded payload:

```
POST /v1/job/run-coding-agent/dispatch

{
  "Meta": {
    "project":    "peer6",
    "runtime":    "opencode",
    "category":   "quick",
    "branch_base": "main",
    "pr_draft":   "true"
  },
  "Payload": "<base64-encoded prompt text>"
}
```

Nomad creates an evaluation, which triggers the scheduler.

### Sequence Diagram

```
  yeet CLI         Nomad Server       Nomad Client        run-agent.sh       Runtime (OpenCode)
   |                    |                  |                    |                    |
   |-- POST /v1/job/    |                  |                    |                    |
   |   run-coding-agent |                  |                    |                    |
   |   /dispatch ------>|                  |                    |                    |
   |                    |                  |                    |                    |
   |<-- 200 {           |                  |                    |                    |
   |  DispatchedJobID:  |                  |                    |                    |
   |  "run-coding-agent |                  |                    |                    |
   |   /dispatch-abc12",|                  |                    |                    |
   |  EvalID: "eval-789"|                  |                    |                    |
   | } ---------------  |                  |                    |                    |
   |                    |                  |                    |                    |
   |   (CLI prints job  |                  |                    |                    |
   |    ID and exits,   |                  |                    |                    |
   |    or follows logs)|                  |                    |                    |
   |                    |                  |                    |                    |
   |                    |-- evaluate ----->|                    |                    |
   |                    |   constraints:   |                    |                    |
   |                    |   - check node   |                    |                    |
   |                    |     meta matches |                    |                    |
   |                    |     job meta     |                    |                    |
   |                    |   - check node   |                    |                    |
   |                    |     is eligible  |                    |                    |
   |                    |   - bin-packing  |                    |                    |
   |                    |     by resources |                    |                    |
   |                    |                  |                    |                    |
   |                    |-- place alloc -->|                    |                    |
   |                    |   alloc-def456   |                    |                    |
   |                    |   on yeet-01  |                    |                    |
   |                    |                  |                    |                    |
   |                    |                  |-- raw_exec ------->|                    |
   |                    |                  |   run-agent.sh     |                    |
   |                    |                  |   (env: NOMAD_META_*                    |
   |                    |                  |    NOMAD_ALLOC_ID,  |                    |
   |                    |                  |    payload decoded) |                    |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- cd /repos/peer6   |
   |                    |                  |                    |-- git fetch origin  |
   |                    |                  |                    |-- git pull origin   |
   |                    |                  |                    |      main           |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- git worktree add  |
   |                    |                  |                    |   /tmp/yeet-abc12   |
   |                    |                  |                    |   -b yeet/peer6-abc12
   |                    |                  |                    |                    |
   |                    |                  |                    |-- generate policy   |
   |                    |                  |                    |   YAML from task    |
   |                    |                  |                    |   metadata (see     |
   |                    |                  |                    |   Flow 15)          |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- openshell-sandbox |
   |                    |                  |                    |   --policy-rules    |
   |                    |                  |                    |   --policy-data     |
   |                    |                  |                    |   /tmp/policy-      |
   |                    |                  |                    |   ${ALLOC_ID}.yaml  |
   |                    |                  |                    |   -- opencode       |
   |                    |                  |                    |   --prompt          |
   |                    |                  |                    |   "<decoded payload>"|
   |                    |                  |                    |   --model haiku     |
   |                    |                  |                    |   (cwd=/tmp/yeet-abc|
   |                    |                  |                    |                    |
   |                    |                  |                    |   [openshell-sandbox|
   |                    |                  |                    |    applies Landlock |
   |                    |                  |                    |    + seccomp +      |
   |                    |                  |                    |    network namespace|
   |                    |                  |                    |    then execs       |
   |                    |                  |                    |    runtime inside   |
   |                    |                  |                    |    sandbox]         |
   |                    |                  |                    |                    |
   |                    |                  |                    |                    |-- work...
   |                    |                  |                    |                    |-- writes files
   |                    |                  |                    |                    |-- runs tests
   |                    |                  |                    |                    |   (sandboxed)
   |                    |                  |                    |                    |
   |                    |                  |                    |<-- stdout/exit 0 ---|
   |                    |                  |                    |                    |
   |                    |                  |                    |-- git add -A        |
   |                    |                  |                    |-- git commit -m     |
   |                    |                  |                    |   "yeet: <summary>" |
   |                    |                  |                    |-- git push origin   |
   |                    |                  |                    |   yeet/peer6-abc12  |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- gh pr create      |
   |                    |                  |                    |   --draft           |
   |                    |                  |                    |   --title "..."     |
   |                    |                  |                    |   --body "..."      |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- extract cost from |
   |                    |                  |                    |   runtime output    |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- PUT /v1/var/      |
   |                    |                  |                    |   cost/abc12        |
   |                    |                  |                    |   {cost_usd, tokens,|
   |                    |                  |                    |    model, project,  |
   |                    |                  |                    |    runtime, ts}     |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- PUT /v1/var/      |
   |                    |                  |                    |   sessions/abc12    |
   |                    |                  |                    |   {session_id: "s1"}|
   |                    |                  |                    |                    |
   |                    |                  |                    |-- curl ntfy         |
   |                    |                  |                    |   "peer6: done,     |
   |                    |                  |                    |    PR #42 created"  |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- git worktree      |
   |                    |                  |                    |   remove            |
   |                    |                  |                    |   /tmp/yeet-abc12   |
   |                    |                  |                    |                    |
   |                    |                  |<-- task complete --|                    |
   |                    |<-- alloc done ---|                    |                    |
   |                    |   (exit code 0)  |                    |                    |
   |                    |                  |                    |                    |
```

### run-agent.sh Lifecycle Summary

1. Read environment: `NOMAD_META_project`, `NOMAD_META_runtime`, `NOMAD_META_category`, `NOMAD_ALLOC_ID`, decoded payload (prompt)
2. Set up signal traps (SIGTERM, SIGINT) for graceful shutdown
3. Acquire flock if device-specific (see Flow 2)
4. `git fetch && git pull` on the base branch
5. `git worktree add` with a branch named `yeet/<project>-<short-id>`
6. Generate sandbox policy YAML from task metadata (see Flow 15)
7. Spawn the runtime inside `openshell-sandbox` with the generated policy, working in the worktree
8. Wait for runtime exit (sandbox tears down automatically on process exit)
9. On success (exit 0): commit, push, create PR, store cost + session in Nomad Variables, notify via Ntfy
10. On failure (exit non-zero): store error info, notify via Ntfy, exit non-zero (triggers Nomad restart policy)
11. Clean up worktree and remove policy YAML

---

## 2. Task Routing (Device-Aware)

When a task requires specific hardware (e.g., a YubiKey for signing), the CLI
adds constraint metadata. Nomad evaluates node metadata to place the allocation
on a node that has the required device.

```
yeet run peer6 "sign release" --needs yubikey
```

### How Constraints Flow

The CLI translates `--needs yubikey` into job meta:

```
POST /v1/job/run-coding-agent/dispatch

{
  "Meta": {
    "project":       "peer6",
    "runtime":       "opencode",
    "device_yubikey": "true"
  },
  "Payload": "<base64>"
}
```

The parameterized job template includes a constraint block:

```hcl
constraint {
  attribute = "${meta.device_yubikey}"
  operator  = "="
  value     = "true"
}
```

This constraint is only evaluated when the dispatched job's meta includes
`device_yubikey`. Nomad checks each node's client meta block.

### Sequence Diagram

```
  yeet CLI         Nomad Server       yeet-01          yeet-02
                                      (no yubikey)        (has yubikey)
   |                    |                  |                    |
   |-- POST /v1/job/    |                  |                    |
   |   run-coding-agent |                  |                    |
   |   /dispatch ------>|                  |                    |
   |   Meta:            |                  |                    |
   |    device_yubikey  |                  |                    |
   |    = "true"        |                  |                    |
   |                    |                  |                    |
   |                    |-- evaluate       |                    |
   |                    |   constraint:    |                    |
   |                    |   meta.device_   |                    |
   |                    |   yubikey = true |                    |
   |                    |                  |                    |
   |                    |-- check          |                    |
   |                    |   yeet-01 --->|                    |
   |                    |   meta:          |                    |
   |                    |    device_       |                    |
   |                    |    yubikey       |                    |
   |                    |    NOT SET       |                    |
   |                    |   SKIP           |                    |
   |                    |                  |                    |
   |                    |-- check          |                    |
   |                    |   yeet-02 ------------------>     |
   |                    |   meta:                              |
   |                    |    device_yubikey                    |
   |                    |    = "true"                          |
   |                    |   MATCH                              |
   |                    |                                      |
   |                    |-- place alloc ---------------------->|
   |                    |   on yeet-02                      |
   |                    |                                      |
   |                    |                  |              raw_exec
   |                    |                  |              run-agent.sh
   |                    |                  |                    |
   |                    |                  |              flock /dev/yubikey
   |                    |                  |              (exclusive lock,
   |                    |                  |               prevents concurrent
   |                    |                  |               device access)
   |                    |                  |                    |
   |                    |                  |              policy YAML includes
   |                    |                  |              /dev/yubikey-1 in
   |                    |                  |              read_write allowlist
   |                    |                  |              (sandboxed agent can
   |                    |                  |               access device)
   |                    |                  |                    |
   |                    |                  |              openshell-sandbox
   |                    |                  |              wraps runtime with
   |                    |                  |              device access granted
   |                    |                  |                    |
   |                    |                  |              runtime works
   |                    |                  |              with yubikey
   |                    |                  |              (inside sandbox)...
   |                    |                  |                    |
```

### Node Client Config (yeet-02)

```hcl
client {
  enabled = true
  meta {
    "device_yubikey" = "true"
    "device_tpm"     = "true"
    "project_peer6"  = "true"
    "project_rule1"  = "true"
  }
}
```

### flock Mechanism

run-agent.sh acquires an exclusive flock on a device-specific lock file before
using the device. This prevents two concurrent allocations on the same node
from fighting over the same hardware:

```bash
exec 9>/var/lock/co-yubikey.lock
flock -n 9 || { echo "Device busy"; exit 1; }
```

---

## 3. Node Registration (Boot)

When a runner boots, systemd starts the Nomad client agent. The client
connects to the Nomad server and registers itself with its attributes and
metadata. The server adds the node to the scheduling pool.

### Sequence Diagram

```
  systemd            Nomad Client        Nomad Server
  (yeet-02)       (yeet-02)        (yeet-01)
   |                    |                    |
   |-- start            |                    |
   |   nomad.service -->|                    |
   |                    |                    |
   |                    |-- read config      |
   |                    |   /etc/nomad.d/    |
   |                    |   client.hcl       |
   |                    |                    |
   |                    |-- RPC connect ---->|
   |                    |   yeet-01:4647  |
   |                    |                    |
   |                    |-- Node.Register -->|
   |                    |   {                |
   |                    |     Name: "yeet-02",
   |                    |     Datacenter: "home",
   |                    |     Drivers: {     |
   |                    |       raw_exec: {  |
   |                    |         enabled: true
   |                    |       }            |
   |                    |     },             |
   |                    |     Meta: {        |
   |                    |       device_yubikey: "true",
   |                    |       project_peer6: "true",
   |                    |       project_rule1: "true"
   |                    |     },             |
   |                    |     Resources: {   |
   |                    |       CPU: 4000,   |
   |                    |       MemoryMB: 8192
   |                    |     }              |
   |                    |   }                |
   |                    |                    |
   |                    |<-- 200 OK ---------|
   |                    |   NodeID: "node-xyz"|
   |                    |                    |
   |                    |   (node now in     |
   |                    |    scheduling pool)|
   |                    |                    |
   |                    |-- begin heartbeat  |
   |                    |   loop (every ~30s)|
   |                    |                    |
```

### Nomad Client Config (/etc/nomad.d/client.hcl)

```hcl
datacenter = "home"

client {
  enabled = true

  servers = ["yeet-01:4647"]

  meta {
    "device_yubikey" = "true"
    "project_peer6"  = "true"
    "project_rule1"  = "true"
  }

  options {
    "driver.raw_exec.enable" = "1"
  }
}
```

---

## 4. Health / Heartbeat

Nomad clients send periodic heartbeats to the server. If heartbeats are missed,
the server marks the node as down and handles any running allocations.

### Sequence Diagram

```
  Nomad Client        Nomad Server
  (yeet-02)        (yeet-01)
   |                    |
   |-- heartbeat ------>|   (every ~30s, via RPC)
   |<-- ack ------------|
   |                    |
   |-- heartbeat ------>|
   |<-- ack ------------|
   |                    |
   |   (network issue   |
   |    or node crash)  |
   |                    |
   |   X  heartbeat     |   (missed)
   |                    |-- wait threshold
   |                    |   (default: ~3 missed
   |                    |    heartbeats, ~90s)
   |                    |
   |                    |-- mark node
   |                    |   yeet-02
   |                    |   status: "down"
   |                    |
   |                    |-- for each running
   |                    |   alloc on yeet-02:
   |                    |   mark alloc "lost"
   |                    |
   |                    |-- check job's
   |                    |   reschedule stanza:
   |                    |
   |                    |   reschedule {
   |                    |     attempts  = 1
   |                    |     interval  = "1h"
   |                    |     delay     = "30s"
   |                    |     unlimited = false
   |                    |   }
   |                    |
   |                    |-- create new eval
   |                    |   for lost alloc
   |                    |
   |                    |-- place replacement
   |                    |   alloc on healthy
   |                    |   node (yeet-01
   |                    |   or yeet-03)
   |                    |
   |   ...later...      |
   |                    |
   |-- heartbeat ------>|   (node recovers)
   |                    |-- mark node
   |                    |   yeet-02
   |                    |   status: "ready"
   |                    |
   |                    |   (node back in
   |                    |    scheduling pool)
   |                    |
```

### Key Thresholds

- Heartbeat interval: ~30 seconds (server-controlled, can vary based on cluster size)
- Node down detection: after missing heartbeats for the configured threshold
- Reschedule delay: configurable per job (default in our job spec: 30s)

---

## 5. Log Streaming

The CLI streams logs from a running task's allocation. It first resolves the
allocation ID from the job, then opens a streaming HTTP connection to the
Nomad client's filesystem API.

```
yeet logs abc12
```

### Sequence Diagram

```
  yeet CLI         Nomad Server       Nomad Client
   |                    |                  |
   |-- GET /v1/job/     |                  |
   |   run-coding-agent |                  |
   |   /dispatch-abc12  |                  |
   |   /allocations --->|                  |
   |                    |                  |
   |<-- 200 [           |                  |
   |  {                 |                  |
   |    ID: "alloc-def",|                  |
   |    TaskStates: {   |                  |
   |      execute: {    |                  |
   |        State:      |                  |
   |        "running"   |                  |
   |      }             |                  |
   |    }               |                  |
   |  }                 |                  |
   | ] -----------------                  |
   |                    |                  |
   |-- GET /v1/client/  |                  |
   |   fs/logs/         |                  |
   |   alloc-def        |                  |
   |   ?task=execute    |                  |
   |   &type=stdout     |                  |
   |   &follow=true     |                  |
   |   &plain=true -----|----------------->|
   |                    |                  |
   |<========== streaming HTTP response ===|
   |   (chunked         |                  |
   |    transfer,       |                  |
   |    line by line)   |                  |
   |                    |                  |
   |   | runtime output appears           |
   |   | in terminal as it happens         |
   |   |                                   |
   |   v                                   |
   |                    |                  |
   |   (user can also   |                  |
   |    stream stderr): |                  |
   |                    |                  |
   |-- GET /v1/client/  |                  |
   |   fs/logs/         |                  |
   |   alloc-def        |                  |
   |   ?task=execute    |                  |
   |   &type=stderr     |                  |
   |   &follow=true     |                  |
   |   &plain=true -----|----------------->|
   |                    |                  |
   |<========== streaming HTTP response ===|
   |                    |                  |
```

### CLI Implementation Notes

- The CLI opens two parallel HTTP connections: one for stdout, one for stderr
- stdout is printed to the terminal's stdout
- stderr is printed to the terminal's stderr (different color or prefix)
- When the allocation completes, the streaming connections close naturally
- `--follow` keeps the connection open; without it, returns existing logs and exits

---

## 6. Session Continuation

When a user wants to continue a previous task (e.g., fixing an edge case the
runtime missed), the CLI reads the stored session ID from Nomad Variables and
dispatches a new job that resumes the runtime's context.

```
yeet continue abc12 "fix the edge case in error handling"
```

### Sequence Diagram

```
  yeet CLI         Nomad Server       Nomad Client        run-agent.sh       Runtime
   |                    |                  |                    |                |
   |-- GET /v1/var/     |                  |                    |                |
   |   sessions/abc12 ->|                  |                    |                |
   |                    |                  |                    |                |
   |<-- 200 {           |                  |                    |                |
   |  Items: {          |                  |                    |                |
   |    session_id:     |                  |                    |                |
   |    "s_prev123",    |                  |                    |                |
   |    runtime:        |                  |                    |                |
   |    "opencode",        |                  |                    |                |
   |    project:        |                  |                    |                |
   |    "peer6",        |                  |                    |                |
   |    branch:         |                  |                    |                |
   |    "yeet/peer6-abc12"|                  |                    |                |
   |  }                 |                  |                    |                |
   | } -----------------                  |                    |                |
   |                    |                  |                    |                |
   |-- POST /v1/job/    |                  |                    |                |
   |   run-coding-agent |                  |                    |                |
   |   /dispatch ------>|                  |                    |                |
   |   Meta:            |                  |                    |                |
   |    project: peer6  |                  |                    |                |
   |    runtime: opencode  |                  |                    |                |
   |    session_id:     |                  |                    |                |
   |     s_prev123      |                  |                    |                |
   |    branch:         |                  |                    |                |
   |     yeet/peer6-abc12|                 |                    |                |
   |   Payload:         |                  |                    |                |
   |    "fix the edge..."                  |                    |                |
   |                    |                  |                    |                |
   |                    |-- evaluate +     |                    |                |
   |                    |   place alloc -->|                    |                |
   |                    |                  |                    |                |
   |                    |                  |-- raw_exec ------->|                |
   |                    |                  |                    |                |
   |                    |                  |                    |-- git fetch     |
   |                    |                  |                    |-- git worktree  |
   |                    |                  |                    |   add /tmp/yeet-|
   |                    |                  |                    |   xyz99 using   |
   |                    |                  |                    |   existing      |
   |                    |                  |                    |   branch        |
   |                    |                  |                    |   yeet/peer6-abc12|
   |                    |                  |                    |                |
   |                    |                  |                    |-- spawn ------->|
   |                    |                  |                    |   opencode         |
   |                    |                  |                    |   --resume      |
   |                    |                  |                    |   s_prev123     |
   |                    |                  |                    |   --prompt      |
   |                    |                  |                    |   "fix edge..." |
   |                    |                  |                    |                |
   |                    |                  |                    |                |-- resume
   |                    |                  |                    |                |   context
   |                    |                  |                    |                |-- work...
   |                    |                  |                    |                |
   |                    |                  |                    |<-- exit 0 -----|
   |                    |                  |                    |                |
   |                    |                  |                    |-- commit, push  |
   |                    |                  |                    |   (to same     |
   |                    |                  |                    |    branch)      |
   |                    |                  |                    |                |
   |                    |                  |                    |-- PUT /v1/var/ |
   |                    |                  |                    |   sessions/    |
   |                    |                  |                    |   xyz99        |
   |                    |                  |                    |   {session_id: |
   |                    |                  |                    |    "s_new456"} |
   |                    |                  |                    |                |
   |                    |                  |                    |-- ntfy         |
   |                    |                  |                    |                |
```

### Key Behaviors

- The CLI reuses the same git branch from the previous run
- The runtime receives `--resume <session_id>` (OpenCode/Claude Code) or equivalent flag
- The runtime loads its previous conversation context and continues from where it left off
- A new session ID is stored for subsequent continuations
- Commits are pushed to the same branch, updating the existing PR

---

## 7. Task Cancellation

User stops a running task. The CLI can either deregister the entire job or stop
a specific allocation.

```
yeet stop abc12
```

### Sequence Diagram (Job Deregister)

```
  yeet CLI         Nomad Server       Nomad Client        run-agent.sh       Runtime
   |                    |                  |                    |                |
   |-- DELETE /v1/job/  |                  |                    |                |
   |   run-coding-agent |                  |                    |                |
   |   /dispatch-abc12  |                  |                    |                |
   |   ?purge=false --->|                  |                    |                |
   |                    |                  |                    |                |
   |<-- 200 {           |                  |                    |                |
   |  EvalID: "eval-x"  |                  |                    |                |
   | } -----------------                  |                    |                |
   |                    |                  |                    |                |
   |                    |-- stop alloc --->|                    |                |
   |                    |                  |                    |                |
   |                    |                  |-- SIGTERM -------->|                |
   |                    |                  |                    |                |
   |                    |                  |                    |-- trap SIGTERM  |
   |                    |                  |                    |                |
   |                    |                  |                    |-- SIGTERM ----->|
   |                    |                  |                    |   (to runtime  |
   |                    |                  |                    |    child proc) |
   |                    |                  |                    |                |
   |                    |                  |                    |<-- exit 143 ---|
   |                    |                  |                    |                |
   |                    |                  |                    |-- cleanup:     |
   |                    |                  |                    |   git worktree |
   |                    |                  |                    |   remove       |
   |                    |                  |                    |   (branch kept |
   |                    |                  |                    |    for resume) |
   |                    |                  |                    |                |
   |                    |                  |                    |-- exit 143     |
   |                    |                  |                    |                |
   |                    |                  |<-- task stopped ---|                |
   |                    |<-- alloc dead ---|                    |                |
   |                    |                  |                    |                |
```

### Sequence Diagram (Allocation Stop)

For stopping a specific allocation without deregistering the job:

```
  yeet CLI         Nomad Server       Nomad Client
   |                    |                  |
   |-- POST /v1/       |                  |
   |   allocation/      |                  |
   |   alloc-def/       |                  |
   |   stop ----------->|                  |
   |                    |                  |
   |                    |-- stop alloc --->|
   |                    |                  |-- SIGTERM -> run-agent.sh
   |                    |                  |   (same flow as above)
   |                    |                  |
```

### Kill Timeout

The job spec defines `kill_timeout`:

```hcl
task "execute" {
  kill_timeout = "10s"
}
```

- Nomad sends SIGTERM first
- Waits up to `kill_timeout` (10s) for the process to exit gracefully
- If still running after 10s, Nomad sends SIGKILL (unblockable)
- Allocation is marked as stopped/dead regardless

---

## 8. Device Disconnection Mid-Task

If a required hardware device is unplugged during a task, run-agent.sh detects
the failure and Nomad's restart policy governs retry behavior.

### Sequence Diagram

```
  Hardware           run-agent.sh       Runtime            Nomad Client        Nomad Server
   |                    |                  |                    |                    |
   |   (YubiKey         |                  |                    |                    |
   |    connected)      |                  |                    |                    |
   |                    |-- holding flock  |                    |                    |
   |                    |   /dev/yubikey   |                    |                    |
   |                    |                  |-- work...         |                    |
   |                    |                  |   signing...       |                    |
   |                    |                  |                    |                    |
   |   USER UNPLUGS     |                  |                    |                    |
   |   YUBIKEY          |                  |                    |                    |
   |                    |                  |                    |                    |
   |                    |                  |-- device error! ---|                    |
   |                    |                  |   "device not      |                    |
   |                    |                  |    found"          |                    |
   |                    |                  |                    |                    |
   |                    |<-- exit 1 -------|                    |                    |
   |                    |                  |                    |                    |
   |                    |-- cleanup        |                    |                    |
   |                    |   worktree       |                    |                    |
   |                    |                  |                    |                    |
   |                    |-- exit 1 --------|                    |                    |
   |                    |                  |              raw_exec reports           |
   |                    |                  |              exit code 1                |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- restart policy:  |
   |                    |                  |                    |   attempts = 2     |
   |                    |                  |                    |   delay = 30s      |
   |                    |                  |                    |   mode = "fail"    |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- wait 30s...      |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- restart          |
   |                    |                  |                    |   run-agent.sh     |
   |                    |                  |                    |   (attempt 1/2)    |
   |                    |                  |                    |                    |
   |   (still           |<----------- raw_exec --------------|                    |
   |    unplugged)      |                  |                    |                    |
   |                    |-- flock fails    |                    |                    |
   |                    |   OR device      |                    |                    |
   |                    |   check fails    |                    |                    |
   |                    |-- exit 1         |                    |                    |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- wait 30s...      |
   |                    |                  |                    |-- restart          |
   |                    |                  |                    |   (attempt 2/2)    |
   |                    |                  |                    |                    |
   |   (still           |<----------- raw_exec --------------|                    |
   |    unplugged)      |                  |                    |                    |
   |                    |-- exit 1         |                    |                    |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- all retries      |
   |                    |                  |                    |   exhausted        |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- alloc marked  -->|
   |                    |                  |                    |   "failed"         |
   |                    |                  |                    |                    |
   |                    |                  |                    |-- curl ntfy:       |
   |                    |                  |                    |   "FAILED: peer6   |
   |                    |                  |                    |    abc12, device   |
   |                    |                  |                    |    not found,      |
   |                    |                  |                    |    exit code 1"    |
   |                    |                  |                    |                    |
```

### Restart Policy in Job Spec

```hcl
restart {
  attempts = 2
  delay    = "30s"
  mode     = "fail"
}
```

- `attempts = 2`: try 2 more times after the first failure
- `delay = 30s`: wait 30 seconds between retries (gives time to replug device)
- `mode = "fail"`: after exhausting retries, mark the allocation as failed (do not keep retrying forever)

---

## 9. Runner Drain

When performing maintenance on a node, the operator drains it first. Nomad
stops scheduling new work to the node and optionally waits for current
allocations to finish.

```
yeet drain yeet-02
```

### Sequence Diagram

```
  yeet CLI         Nomad Server       yeet-02          yeet-01
   |                    |                  |                    |
   |-- look up node ID  |                  |                    |
   |   GET /v1/nodes    |                  |                    |
   |   ?filter=         |                  |                    |
   |   Name==           |                  |                    |
   |   yeet-02 ----->|                  |                    |
   |                    |                  |                    |
   |<-- [{ID:           |                  |                    |
   |  "node-xyz"}] -----|                  |                    |
   |                    |                  |                    |
   |-- POST /v1/node/   |                  |                    |
   |   node-xyz/        |                  |                    |
   |   drain ---------->|                  |                    |
   |   {                |                  |                    |
   |     DrainSpec: {   |                  |                    |
   |       Deadline:    |                  |                    |
   |       "1h"         |                  |                    |
   |     }              |                  |                    |
   |   }                |                  |                    |
   |                    |                  |                    |
   |                    |-- mark node      |                    |
   |                    |   "draining"     |                    |
   |                    |                  |                    |
   |                    |-- stop new       |                    |
   |                    |   scheduling  -->|                    |
   |                    |   to this node   |                    |
   |                    |                  |                    |
   |                    |-- wait for       |                    |
   |                    |   running allocs |                    |
   |                    |   to complete    |                    |
   |                    |   (or deadline)  |                    |
   |                    |                  |                    |
   |                    |   ...allocs      |                    |
   |                    |   finish...      |                    |
   |                    |                  |                    |
   |                    |-- migrate any    |                    |
   |                    |   remaining   ---|---------------->   |
   |                    |   allocs to      |                    |
   |                    |   other nodes    |                    |
   |                    |                  |                    |
   |                    |-- node fully     |                    |
   |                    |   drained        |                    |
   |                    |                  |                    |
   |   (operator does   |                  |                    |
   |    maintenance)    |                  |                    |
   |                    |                  |                    |
```

### Re-activating a Node

```
yeet activate yeet-02
```

```
  yeet CLI         Nomad Server       yeet-02
   |                    |                  |
   |-- POST /v1/node/   |                  |
   |   node-xyz/        |                  |
   |   eligibility ---->|                  |
   |   {                |                  |
   |     Eligibility:   |                  |
   |     "eligible"     |                  |
   |   }                |                  |
   |                    |                  |
   |                    |-- mark node      |
   |                    |   eligible for   |
   |                    |   scheduling     |
   |                    |                  |
   |                    |   (node back in  |
   |                    |    scheduling    |
   |                    |    pool)         |
   |                    |                  |
```

---

## 10. Cost Tracking

run-agent.sh extracts cost information from the runtime's output and stores it
in Nomad Variables. The CLI reads and aggregates these for reporting.

### Storage (run-agent.sh -> Nomad Variables)

```
  run-agent.sh       Nomad Server
   |                    |
   |-- parse runtime    |
   |   output for cost  |
   |   info             |
   |                    |
   |-- PUT /v1/var/     |
   |   cost/abc12 ----->|
   |   {                |
   |     Namespace:     |
   |     "default",     |
   |     Path:          |
   |     "cost/abc12",  |
   |     Items: {       |
   |       cost_usd:    |
   |       "0.42",      |
   |       tokens_in:   |
   |       "15230",     |
   |       tokens_out:  |
   |       "3841",      |
   |       model:       |
   |       "haiku",     |
   |       project:     |
   |       "peer6",     |
   |       runtime:     |
   |       "opencode",     |
   |       timestamp:   |
   |       "2026-03-22T |
   |       10:15:00Z"   |
   |     }              |
   |   }                |
   |                    |
   |<-- 200 OK ---------|
   |                    |
```

### Retrieval (yeet cost)

```
yeet cost --project peer6 --period 7d
```

```
  yeet CLI         Nomad Server
   |                    |
   |-- GET /v1/vars     |
   |   ?prefix=cost/ -->|
   |                    |
   |<-- 200 [           |
   |  {Path: "cost/abc12", ...},
   |  {Path: "cost/def34", ...},
   |  {Path: "cost/ghi56", ...},
   |  ...               |
   | ] -----------------|
   |                    |
   |-- for each var:    |
   |   GET /v1/var/     |
   |   cost/abc12 ----->|
   |                    |
   |<-- 200 {Items: {   |
   |  cost_usd, tokens, |
   |  model, project,   |
   |  runtime, ts}} ----|
   |                    |
   |   (repeat for each |
   |    var in prefix)   |
   |                    |
   |-- aggregate by     |
   |   project, period, |
   |   model            |
   |                    |
   |-- display table:   |
   |                    |
   |   Project  Model   Cost     Tokens
   |   -------  ------  -------  ------
   |   peer6    haiku   $1.23    45,230
   |   peer6    sonnet  $8.41    12,100
   |   rule1    haiku   $0.56    18,900
   |   -------  ------  -------  ------
   |   Total            $10.20   76,230
   |                    |
```

---

## 11. Git Branch / PR Flow

run-agent.sh manages the full git lifecycle: worktree creation, branching,
committing, pushing, and PR creation.

### Sequence Diagram

```
  run-agent.sh       Git (local)        GitHub Remote       gh CLI
   |                    |                    |                  |
   |-- cd /repos/peer6  |                    |                  |
   |                    |                    |                  |
   |-- git fetch ------>|                    |                  |
   |   origin           |-- fetch --------->|                  |
   |                    |<-- refs updated --|                  |
   |                    |                    |                  |
   |-- git worktree     |                    |                  |
   |   add              |                    |                  |
   |   /tmp/yeet-abc12  |                    |                  |
   |   -b yeet/peer6-   |                    |                  |
   |   abc12 ---------->|                    |                  |
   |                    |-- create worktree  |                  |
   |                    |   at /tmp/yeet-abc12|                 |
   |                    |-- create branch    |                  |
   |                    |   yeet/peer6-abc12 |                  |
   |                    |   from origin/main |                  |
   |                    |                    |                  |
   |   [runtime works in /tmp/co-abc12]      |                  |
   |   [files modified, tests pass]          |                  |
   |                    |                    |                  |
   |-- git add -A ----->|                    |                  |
   |                    |-- stage all        |                  |
   |                    |   changes          |                  |
   |                    |                    |                  |
   |-- git commit -m    |                    |                  |
   |   "yeet: implement |                    |                  |
   |    feature X" ---->|                    |                  |
   |                    |-- create commit    |                  |
   |                    |                    |                  |
   |-- git push origin  |                    |                  |
   |   yeet/peer6-abc12->|-- push ---------->|                  |
   |                    |                    |-- branch created |
   |                    |                    |                  |
   |-- gh pr create ----|--------------------|----- ---------->|
   |   --draft          |                    |                  |
   |   --title          |                    |                  |
   |   "yeet: implement |                    |                  |
   |    feature X"      |                    |                  |
   |   --body           |                    |                  |
   |   "Job: abc12      |                    |                  |
   |    Runtime: opencode   |                    |                  |
   |    Model: haiku     |                    |                  |
   |    Cost: $0.42" -->|                    |<-- API create PR |
   |                    |                    |                  |
   |<-- PR #42 URL -----|--------------------|----- -----------|
   |                    |                    |                  |
   |-- git worktree     |                    |                  |
   |   remove           |                    |                  |
   |   /tmp/yeet-abc12 ->|                    |                  |
   |                    |-- remove worktree  |                  |
   |                    |   (branch ref      |                  |
   |                    |    preserved)      |                  |
   |                    |                    |                  |
```

### Branch Naming Convention

```
yeet/<project>-<short-id>
```

Examples:
- `yeet/peer6-abc12`
- `yeet/rule1-def34`
- `yeet/login2-ghi56`

### Worktree Paths

```
/tmp/yeet-<short-id>
```

Worktrees are in /tmp so they are cleaned up on reboot. The branch reference
survives in the main repo's `.git` directory even after worktree removal.

---

## 12. Error / Retry Flow

When a runtime exits non-zero, Nomad's restart policy governs retry behavior.
run-agent.sh can use session continuation on retries to preserve context.

### Sequence Diagram

```
  Nomad Client        run-agent.sh       Runtime            Nomad Server        Ntfy
   |                    |                  |                    |                  |
   |-- raw_exec ------->|                  |                    |                  |
   |                    |-- spawn -------->|                    |                  |
   |                    |                  |-- work...         |                  |
   |                    |                  |-- ERROR!          |                  |
   |                    |<-- exit 1 -------|                    |                  |
   |                    |                  |                    |                  |
   |                    |-- store session  |                    |                  |
   |                    |   PUT /v1/var/   |                    |                  |
   |                    |   sessions/abc12 |------------------->|                  |
   |                    |   {session_id}   |                    |                  |
   |                    |                  |                    |                  |
   |                    |-- cleanup        |                    |                  |
   |                    |   worktree       |                    |                  |
   |                    |                  |                    |                  |
   |<-- exit 1 ---------|                  |                    |                  |
   |                    |                  |                    |                  |
   |-- restart policy:  |                  |                    |                  |
   |   attempt 1/2      |                  |                    |                  |
   |   delay 30s        |                  |                    |                  |
   |                    |                  |                    |                  |
   |   ...30s...        |                  |                    |                  |
   |                    |                  |                    |                  |
   |-- raw_exec ------->|                  |                    |                  |
   |   (retry)          |                  |                    |                  |
   |                    |-- check for      |                    |                  |
   |                    |   session_id     |                    |                  |
   |                    |   GET /v1/var/   |                    |                  |
   |                    |   sessions/abc12 |------------------->|                  |
   |                    |                  |                    |                  |
   |                    |<-- {session_id:  |                    |                  |
   |                    |    "s_prev123"}  |--------------------|                  |
   |                    |                  |                    |                  |
   |                    |-- spawn -------->|                    |                  |
   |                    |   --resume       |                    |                  |
   |                    |   s_prev123      |                    |                  |
   |                    |                  |-- resume context   |                  |
   |                    |                  |-- work...         |                  |
   |                    |                  |-- SUCCESS          |                  |
   |                    |<-- exit 0 -------|                    |                  |
   |                    |                  |                    |                  |
   |                    |-- commit, push,  |                    |                  |
   |                    |   create PR      |                    |                  |
   |                    |-- store cost     |                    |                  |
   |                    |-- ntfy --------->|--------------------|----- ---------->|
   |                    |                  |                    |                  |
   |<-- exit 0 ---------|                  |                    |                  |
   |                    |                  |                    |                  |
```

### If All Retries Exhausted

```
  Nomad Client        run-agent.sh       Nomad Server        Ntfy
   |                    |                  |                    |
   |   (attempt 2/2     |                  |                    |
   |    also fails)     |                  |                    |
   |                    |                  |                    |
   |<-- exit 1 ---------|                  |                    |
   |                    |                  |                    |
   |-- all retries      |                  |                    |
   |   exhausted        |                  |                    |
   |                    |                  |                    |
   |-- report alloc  --|----------------->|                    |
   |   status: failed   |                  |                    |
   |   exit code: 1     |                  |                    |
   |                    |                  |                    |
   |                    |-- curl ntfy:  ---|-------- --------->|
   |                    |   "FAILED:       |                    |
   |                    |    peer6 abc12   |                    |
   |                    |    exit code 1   |                    |
   |                    |    stderr:       |                    |
   |                    |    <last 5 lines>"|                   |
   |                    |                  |                    |
```

### Restart Policy Reference

```hcl
restart {
  attempts = 2       # retry up to 2 times after initial failure
  delay    = "30s"   # wait 30s between retries
  mode     = "fail"  # after exhausting retries, mark as failed
}
```

---

## 13. Nomad Event Stream (Monitoring)

Nomad provides a server-sent event stream for real-time monitoring of job and
allocation lifecycle events. This can be consumed by the CLI, a dashboard, or a
notification script.

### Sequence Diagram

```
  Consumer           Nomad Server
  (yeet watch /      (yeet-01)
   dashboard /
   script)
   |                    |
   |-- GET /v1/event/   |
   |   stream           |
   |   ?topic=Job       |
   |   &topic=          |
   |   Allocation ----->|
   |                    |
   |<== streaming ndjson response ==
   |                    |
   |   {"Topic":"Allocation",
   |    "Type":"AllocationUpdated",
   |    "Payload":{
   |      "Allocation":{
   |        "JobID":"run-coding-agent/dispatch-abc12",
   |        "TaskStates":{
   |          "execute":{
   |            "State":"running"
   |          }
   |        }
   |      }
   |    }}
   |                    |
   |   ...time passes...|
   |                    |
   |   {"Topic":"Allocation",
   |    "Type":"AllocationUpdated",
   |    "Payload":{
   |      "Allocation":{
   |        "JobID":"run-coding-agent/dispatch-abc12",
   |        "TaskStates":{
   |          "execute":{
   |            "State":"dead",
   |            "Failed":false
   |          }
   |        }
   |      }
   |    }}
   |                    |
   |   (consumer can    |
   |    filter and      |
   |    trigger ntfy    |
   |    notifications)  |
   |                    |
```

### Example: Notification Script

A simple script that watches for completed or failed allocations and sends
Ntfy notifications:

```bash
curl -s -N "http://yeet-01:4646/v1/event/stream?topic=Allocation" | \
  while read -r line; do
    state=$(echo "$line" | jq -r '.Payload.Allocation.TaskStates.execute.State // empty')
    job=$(echo "$line" | jq -r '.Payload.Allocation.JobID // empty')
    failed=$(echo "$line" | jq -r '.Payload.Allocation.TaskStates.execute.Failed // empty')
    if [ "$state" = "dead" ]; then
      if [ "$failed" = "true" ]; then
        curl -d "FAILED: $job" ntfy.sh/yeet-tasks
      else
        curl -d "DONE: $job" ntfy.sh/yeet-tasks
      fi
    fi
  done
```

---

## 14. Scheduled / Periodic Tasks

Nomad's periodic job scheduler can run tasks on a cron schedule, such as
nightly test suites or daily code quality checks.

### Job Spec

```hcl
job "nightly-tests" {
  type = "batch"

  periodic {
    crons            = ["0 7 * * *"]
    prohibit_overlap = true
    time_zone        = "Australia/Sydney"
  }

  parameterized {
    meta_optional = ["project"]
  }

  group "test" {
    task "execute" {
      driver = "raw_exec"

      config {
        command = "/opt/yeet/run-agent.sh"
      }

      meta {
        project = "peer6"
        runtime = "opencode"
        prompt  = "Run the full test suite. Report results."
      }
    }
  }
}
```

### Sequence Diagram

```
  Nomad Scheduler     Nomad Server       Nomad Client        run-agent.sh
  (internal)          (yeet-01)       (yeet-01)
   |                    |                  |                    |
   |-- cron trigger     |                  |                    |
   |   0 7 * * *        |                  |                    |
   |   (7am AEST) ----->|                  |                    |
   |                    |                  |                    |
   |                    |-- check:         |                    |
   |                    |   prohibit_      |                    |
   |                    |   overlap        |                    |
   |                    |   (no existing   |                    |
   |                    |    run active)   |                    |
   |                    |                  |                    |
   |                    |-- create child   |                    |
   |                    |   job: nightly-  |                    |
   |                    |   tests/periodic-|                    |
   |                    |   2026-03-22T    |                    |
   |                    |   07:00:00Z      |                    |
   |                    |                  |                    |
   |                    |-- evaluate +     |                    |
   |                    |   place alloc -->|                    |
   |                    |                  |                    |
   |                    |                  |-- raw_exec ------->|
   |                    |                  |                    |
   |                    |                  |                    |-- run test suite
   |                    |                  |                    |-- store results
   |                    |                  |                    |   PUT /v1/var/
   |                    |                  |                    |   tests/peer6/
   |                    |                  |                    |   2026-03-22
   |                    |                  |                    |
   |                    |                  |                    |-- if failure:
   |                    |                  |                    |   curl ntfy
   |                    |                  |                    |   "TESTS FAILED:
   |                    |                  |                    |    peer6, 3/47
   |                    |                  |                    |    failing"
   |                    |                  |                    |
   |                    |                  |<-- exit 0/1 -------|
   |                    |<-- alloc done ---|                    |
   |                    |                  |                    |
```

### Periodic Job Behaviors

- `prohibit_overlap = true`: if a previous run is still active, the cron trigger is skipped
- Child jobs are named with a timestamp suffix for identification
- Results are stored in Nomad Variables under a date-keyed path
- Failed runs trigger Ntfy notifications; successful runs are silent (or summary-only)

---

## 15. Sandbox Policy Generation (v2)

> **Note:** This flow applies from v2 onwards. OpenShell sandboxing is not present in v1.

run-agent.sh generates a per-task sandbox policy YAML from dispatch metadata and
environment variables. The policy is passed to `openshell-sandbox`, which enforces
Landlock filesystem allowlists, seccomp syscall filtering, and network namespace +
HTTP proxy isolation around the agent runtime.

### Sequence Diagram

```
  run-agent.sh                         openshell-sandbox          Runtime
   |                                        |                        |
   |-- read env:                            |                        |
   |   CO_PROJECT (from NOMAD_META_project) |                        |
   |   CO_RUNTIME (from NOMAD_META_runtime) |                        |
   |   CO_MODE (from NOMAD_META_category)   |                        |
   |   CO_NEEDS_DEVICE (from               |                        |
   |     NOMAD_META_device_*)               |                        |
   |                                        |                        |
   |-- build policy YAML:                   |                        |
   |                                        |                        |
   |   filesystem:                          |                        |
   |     read_write:                        |                        |
   |       - /tmp/yeet-<alloc-id>/          |                        |
   |         (project workspace)            |                        |
   |       - /tmp/                          |                        |
   |       - /var/lock/yeet/                |                        |
   |     read_only:                         |                        |
   |       - /usr/                          |                        |
   |       - /lib/                          |                        |
   |       - /etc/                          |                        |
   |       - /opt/yeet/devices/             |                        |
   |                                        |                        |
   |   [if CO_NEEDS_DEVICE set]:            |                        |
   |     filesystem.read_write +=           |                        |
   |       - /dev/<device>                  |                        |
   |         (e.g. /dev/yubikey-1)          |                        |
   |                                        |                        |
   |   [if CO_MODE == review|analyze]:      |                        |
   |     move workspace from                |                        |
   |     read_write -> read_only            |                        |
   |     (agent cannot modify files)        |                        |
   |                                        |                        |
   |   network:                             |                        |
   |     allowed_hosts:                     |                        |
   |       - api.anthropic.com              |                        |
   |         (or openai.com, etc.           |                        |
   |          based on CO_RUNTIME)          |                        |
   |       - github.com                     |                        |
   |       - npm registry / pypi / etc.     |                        |
   |         (based on project type)        |                        |
   |                                        |                        |
   |-- write policy to                      |                        |
   |   /tmp/policy-${NOMAD_ALLOC_ID}.yaml   |                        |
   |                                        |                        |
   |-- exec: openshell-sandbox ------------>|                        |
   |   --policy-rules /opt/yeet/sandbox.rego|                        |
   |   --policy-data                        |                        |
   |   /tmp/policy-${NOMAD_ALLOC_ID}.yaml   |                        |
   |   -- opencode --prompt "..."           |                        |
   |                                        |                        |
   |                                        |-- apply Landlock:      |
   |                                        |   filesystem allowlists|
   |                                        |   from policy YAML     |
   |                                        |                        |
   |                                        |-- apply seccomp:       |
   |                                        |   syscall filter       |
   |                                        |   (block dangerous     |
   |                                        |    syscalls)           |
   |                                        |                        |
   |                                        |-- create network       |
   |                                        |   namespace +          |
   |                                        |   HTTP proxy           |
   |                                        |   (only allowed_hosts  |
   |                                        |    reachable)          |
   |                                        |                        |
   |                                        |-- exec runtime ------->|
   |                                        |   (inside sandbox)     |
   |                                        |                        |
   |                                        |                        |-- work...
   |                                        |                        |-- fs writes
   |                                        |                        |   restricted
   |                                        |                        |   to allowlist
   |                                        |                        |-- network
   |                                        |                        |   restricted
   |                                        |                        |   to proxy
   |                                        |                        |
   |                                        |<-- exit code ---------|
   |                                        |                        |
   |<-- exit code (passthrough) ------------|                        |
   |                                        |                        |
   |-- cleanup:                             |                        |
   |   rm /tmp/policy-${NOMAD_ALLOC_ID}.yaml|                        |
   |                                        |                        |
```

### Policy YAML Structure

```yaml
# /tmp/policy-${NOMAD_ALLOC_ID}.yaml
filesystem:
  read_write:
    - /tmp/yeet-abc12/    # project workspace (read_only if review/analyze mode)
    - /tmp/
    - /var/lock/yeet/
    # - /dev/yubikey-1    # added if CO_NEEDS_DEVICE=yubikey
  read_only:
    - /usr/
    - /lib/
    - /etc/
    - /opt/yeet/devices/

network:
  allowed_hosts:
    - api.anthropic.com   # varies by CO_RUNTIME
    - github.com
    - registry.npmjs.org  # varies by project type
```

### Mode-Based Policy Differences

| Mode | Workspace Access | Device Access | Network |
|------|-----------------|---------------|---------|
| `quick`, `deep`, `unspecified-low` | read_write | if needed | LLM + git + packages |
| `review`, `analyze` | read_only | if needed | LLM + git (no packages) |

### Lifecycle

1. Policy YAML is generated before runtime spawn
2. Written to `/tmp/policy-${NOMAD_ALLOC_ID}.yaml` (unique per allocation)
3. Passed to `openshell-sandbox --policy-data`
4. Sandbox enforced for entire runtime lifetime
5. On task completion (success or failure), policy file is removed during cleanup

---

## Summary Reference

### Key Nomad API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/job/run-coding-agent/dispatch` | Dispatch a new coding task |
| GET | `/v1/job/:id` | Get job details |
| GET | `/v1/job/:id/allocations` | List allocations for a job |
| DELETE | `/v1/job/:id` | Stop/deregister a job |
| GET | `/v1/client/fs/logs/:alloc_id` | Stream allocation logs |
| POST | `/v1/allocation/:alloc_id/stop` | Stop a specific allocation |
| GET | `/v1/nodes` | List all nodes |
| POST | `/v1/node/:id/drain` | Enable drain on a node |
| POST | `/v1/node/:id/eligibility` | Set node scheduling eligibility |
| PUT | `/v1/var/:path` | Write a Nomad Variable |
| GET | `/v1/var/:path` | Read a Nomad Variable |
| GET | `/v1/vars?prefix=:prefix` | List variables by prefix |
| GET | `/v1/event/stream?topic=:topic` | Stream cluster events |

### Nomad Variable Paths

| Path Pattern | Contents | Written By |
|-------------|----------|------------|
| `cost/<job-short-id>` | `{cost_usd, tokens_in, tokens_out, model, project, runtime, timestamp}` | run-agent.sh |
| `sessions/<job-short-id>` | `{session_id, runtime, project, branch}` | run-agent.sh |
| `tests/<project>/<date>` | `{passed, failed, total, details}` | run-agent.sh (periodic) |

### Nomad Meta Keys Convention

Node-level metadata keys follow a prefix convention:

| Prefix | Example | Purpose |
|--------|---------|---------|
| `device_` | `device_yubikey = "true"` | Hardware device availability |
| `device_` | `device_tpm = "true"` | Hardware device availability |
| `project_` | `project_peer6 = "true"` | Project repo available on this node |

Job-level metadata (set at dispatch time):

| Key | Example | Purpose |
|-----|---------|---------|
| `project` | `"peer6"` | Target project/repo |
| `runtime` | `"opencode"` | Which coding agent to use |
| `category` | `"quick"` | Task sizing category |
| `session_id` | `"s_prev123"` | Resume from previous session |
| `branch` | `"yeet/peer6-abc12"` | Use existing branch (for continue) |
| `branch_base` | `"main"` | Base branch for new worktree |
| `pr_draft` | `"true"` | Whether to create PR as draft |
| `device_yubikey` | `"true"` | Constraint: requires YubiKey |

### Nomad Client Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 4646 | HTTP | API (server + client) |
| 4647 | RPC | Internal server communication |
| 4648 | Serf | Gossip protocol (server-to-server, not used in single-server) |
