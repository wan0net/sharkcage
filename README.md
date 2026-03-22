# yeet

Yeet your code tasks at whatever hardware you have lying around and walk away.

## What This Is

An agent-agnostic autonomous coding orchestrator built on HashiCorp Nomad. Point it at a fleet of machines -- old laptops, thin clients, rack servers, whatever -- and dispatch AI coding tasks to them from the comfort of your actual workstation.

Two custom components, everything else off-the-shelf:

- **`yeet` CLI** -- TypeScript, ~220 lines. Thin wrapper around the Nomad HTTP API with opinionated defaults.
- **`run-agent.sh`** -- Bash, 538 lines. Runtime adapter that normalizes the interface across coding agents (OpenCode, Claude Code, Aider).

No custom servers, databases, or message queues.

## Architecture

```
┌──────────┐                ┌──────────────────────────────────┐
│ yeet CLI │─── Nomad API ──▶  Nomad Server  (yeet-01)         │
│  (laptop)│    :4646/v1    │                                  │
│          │◀── HTTP ───────│  Schedules onto:                 │
└──────────┘                │  ┌─────────┬─────────┬─────────┐ │
     │                      │  │yeet-01  │yeet-02  │yeet-03  │ │
     │ Tailscale mesh       │  │client   │client   │client   │ │
     │                      │  │projectA │projectB │projectC │ │
     │                      │  │         │USB: YK  │USB: HSM │ │
     │                      │  └─────────┴─────────┴─────────┘ │
     │                      │                                  │
     │                      │  Built-in: scheduling, logs,     │
     │                      │  health, drain, retry, UI, ACLs  │
     └──────────────────────┴──────────────────────────────────┘
```

The CLI runs on your laptop and talks to Nomad over Tailscale. One node runs the Nomad server; all nodes (including the server) run Nomad clients. Each node has projects cloned locally and optionally has USB devices attached.

## How It Works

1. You run `yeet run myproject "implement feature X"` from your laptop.
2. The CLI templates a Nomad parameterized job dispatch with your parameters.
3. Nomad schedules it onto an available node that has `myproject` cloned (via node metadata constraints).
4. Nomad's `raw_exec` driver runs `run-agent.sh`, which invokes the chosen coding agent directly on the host.
5. You stream logs with `yeet logs <job-id>` or check progress in the Nomad UI.
6. On completion, results are committed to a branch and optionally a draft PR is created.

## CLI Commands

```
yeet run <project> "<prompt>"       Submit a task
  --runtime opencode|claude|aider   Runtime (default: opencode)
  --model <provider/model>          Model override
  --mode implement|test|review      Task mode
  --needs <device-type>             Require a USB device
  --budget <usd>                    Cost cap
  --priority low|normal|high        Priority

yeet status                         List all active tasks
yeet logs <job-id>                  Stream task output
yeet stop <job-id>                  Cancel a running task
yeet continue <job-id> "<prompt>"   Resume with new instructions
yeet runners                        Fleet overview
yeet drain <node>                   Drain a node
yeet activate <node>                Reactivate a node
yeet devices                        Device inventory
yeet cost [--period day|week|month] Cost report
yeet policy <name>                  Apply a sandbox policy
```

## Supported Runtimes

| Runtime | CLI invocation | Structured Output | Session Resume | Multi-provider |
|---|---|---|---|---|
| OpenCode | `opencode run "..."` | JSON | `--session {id}` | 15+ providers |
| Claude Code | `claude -p "..."` | `--output-format stream-json` | `--resume {id}` | Anthropic only |
| Aider | `aider --message "..."` | Limited | Limited | Multi-provider |

## Sandboxing

Integration with NVIDIA's OpenShell for per-task sandboxing (v2 feature). Each agent runs inside a restricted environment using Landlock (filesystem), seccomp (syscalls), and network namespaces. USB device access controlled via allowlists in sandbox policies.

Policies are defined in `policies/` as YAML. See the [architecture docs, section 9](https://wan0.net/yeet/architecture#9-sandboxing) for the full design.

## What Nomad Gives Us

| Need | Without Nomad | With Nomad |
|------|---------------|------------|
| Task queue | BullMQ + Redis | Nomad job dispatch |
| Worker daemon | Custom daemon | Nomad client (raw_exec) |
| Fleet health | Custom heartbeat | Nomad node health |
| Log streaming | Custom pub/sub | `GET /v1/client/fs/logs?follow=true` |
| Job cancellation | Custom signal handling | `DELETE /v1/job/:id` |
| Retry/restart | Custom logic | Nomad restart policies |
| Fleet drain | Custom drain logic | `POST /v1/node/:id/drain` |
| Metadata storage | SQLite/D1 | Nomad Variables (encrypted) |
| Monitoring UI | Custom dashboard | Nomad UI (:4646/ui) |
| Auth | API keys | Nomad ACL tokens |
| Device routing | Custom queue-per-device | Node metadata + constraints |

## Project Structure

```
yeet/
  cli/                              # yeet CLI (TypeScript)
    src/
      index.ts                      # CLI entry point -- 11 commands
      config.ts                     # Config loader
      nomad.ts                      # Nomad API client
  jobs/
    run-coding-agent.nomad.hcl      # Parameterized job template
    scripts/
      run-agent.sh                  # Runtime adapter (538 lines)
  ansible/                          # Fleet provisioning (9 roles)
  policies/                         # OpenShell sandbox policies
  docs/                             # Design documentation + site
```

## Quick Start

```bash
# 1. Install Nomad on a machine
# 2. Run in dev mode for local testing
nomad agent -dev

# 3. Register the job template
nomad job run jobs/run-coding-agent.nomad.hcl

# 4. Build the CLI
cd cli && npm install && npm run build

# 5. Dispatch a task
yeet run myproject "hello world"
```

## Design Principles

- **Agent-agnostic.** Runtime adapters normalize the interface across coding agents. Adding a new agent means writing one adapter function in `run-agent.sh`.
- **Device-aware.** Tasks can declare required USB devices (YubiKeys, HSMs, dev boards). Nomad routes tasks to nodes with matching metadata.
- **Off-the-shelf where possible.** Nomad for orchestration, Tailscale for networking, Ansible for provisioning, udev for device detection. Custom code is minimal.
- **Fail-closed.** Nodes stop accepting work if Nomad marks them unhealthy. No autonomous work without a functioning control plane.
- **Audit everything.** Every tool call, file write, and shell command executed by an agent is logged and attributable to a task via Nomad's allocation logs.

## Status

Implementation complete. All core components built. Not yet deployed to physical hardware. See `docs/` for the full design, or [wan0.net/yeet](https://wan0.net/yeet) for the project page.

**Links:** [wan0.net/yeet](https://wan0.net/yeet) | [architecture](https://wan0.net/yeet/architecture) | [data flows](https://wan0.net/yeet/data-flows) | [deployment](https://wan0.net/yeet/deployment)
