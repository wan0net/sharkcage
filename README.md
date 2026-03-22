# code-orchestration

An agent-agnostic autonomous coding orchestrator for physical runner fleets.

## What This Is

A system for running AI coding agents (Claude Code, Crush/OpenCode, Aider) autonomously on a fleet of physical Dell 5070 thin clients. Uses HashiCorp Nomad for orchestration -- no custom servers, databases, or message queues. The entire custom surface is a thin CLI and a set of job templates.

## The Problem

- Multiple projects running concurrently need AI coding assistance.
- Some work requires physical devices (USB security keys, dev boards, HSMs) that must be attached to a specific machine.
- Tying up a laptop as the execution environment blocks other work.
- You need control and visibility over agent sessions without being actively connected to each machine.

## Architecture

Nomad is the core orchestrator. It handles job scheduling, fleet management, log streaming, health checks, retries, and metadata storage natively. There are only two custom components: the `yeet` CLI and a set of parameterized HCL job templates.

```
┌──────────┐                ┌──────────────────────────────────┐
│ yeet CLI │─── Nomad API ─▶│  Nomad Server  (co-dell-01)      │
│  (laptop)│    :4646/v1    │                                  │
│          │◀── HTTP ───────│  Schedules onto:                 │
└──────────┘                │  ┌─────────┬─────────┬─────────┐ │
     │                      │  │dell-01  │dell-02  │dell-03  │ │
     │ Tailscale mesh       │  │client   │client   │client   │ │
     │                      │  │peer6    │login2   │patch8   │ │
     │                      │  │rule1    │         │threat10 │ │
     │                      │  │         │USB: YK  │USB: HSM │ │
     │                      │  └─────────┴─────────┴─────────┘ │
     │                      │                                  │
     │                      │  Built-in: scheduling, logs,     │
     │                      │  health, drain, retry, UI, ACLs  │
     └──────────────────────┴──────────────────────────────────┘
```

- The `yeet` CLI runs on your laptop and talks to the Nomad HTTP API (port 4646) over Tailscale.
- One Dell runs the Nomad server in single-server mode (`bootstrap_expect = 1`).
- All Dells (including the server) run Nomad clients.
- Each Dell has projects cloned locally and optionally has USB devices attached.
- No custom API, no Redis, no message queue -- just Nomad.

## How It Works

1. You run `yeet run peer6 "implement feature X"` from your laptop.
2. The `yeet` CLI templates a Nomad parameterized job dispatch with your parameters.
3. Nomad schedules it onto an available Dell that has `peer6` cloned (via node metadata constraints).
4. Nomad's `raw_exec` driver runs the coding agent CLI (Crush, Claude Code, etc.) directly on the host.
5. You stream logs with `yeet logs <job-id>` (wraps `nomad alloc logs -f`).
6. On completion, results are committed to a branch and optionally a draft PR is created.

## What Nomad Gives Us For Free

| Need | Before (Custom) | Now (Nomad) |
|------|-----------------|-------------|
| Task queue | BullMQ + Redis | Nomad job dispatch |
| Worker daemon | Custom TypeScript daemon | Nomad client (raw_exec) |
| Fleet health | Custom heartbeat | Nomad node health |
| Log streaming | Custom Redis pub/sub | `GET /v1/client/fs/logs?follow=true` |
| Job cancellation | Custom signal handling | `DELETE /v1/job/:id` |
| Retry/restart | Custom logic | Nomad restart policies |
| Fleet drain | Custom drain logic | `POST /v1/node/:id/drain` |
| Metadata storage | D1/SQLite | Nomad Variables (encrypted) |
| Monitoring UI | Bull Board | Nomad UI (:4646/ui) |
| Auth | CF Access / API keys | Nomad ACL tokens |
| Device routing | Custom queue-per-device | Node metadata + constraints |

## CLI Commands

```
yeet run <project> "<prompt>"     Submit a task
  --runtime crush|claude|aider  Runtime (default: crush)
  --model <provider/model>      Model (default: per-project config)
  --mode implement|test|review  Task mode
  --needs <device-type>         Require a USB device
  --budget <usd>                Cost cap
  --priority low|normal|high    Priority

yeet status                       List all active tasks
yeet logs <job-id>                Stream task output
yeet stop <job-id>                Cancel a running task
yeet continue <job-id> "<prompt>" Resume with new instructions
yeet runners                      Fleet overview
yeet drain <node>                 Drain a runner
yeet activate <node>              Reactivate a runner
yeet devices                      Device inventory
yeet cost [--period day|week|month] Cost report
```

The `yeet` CLI is roughly 200 lines of TypeScript -- a thin wrapper around Nomad's HTTP API with opinionated defaults.

## Supported Runtimes

| Runtime | Headless CLI | Structured Output | Session Resume | Multi-provider |
|---|---|---|---|---|
| Crush (OpenCode) | `crush run "..."` | JSON | `--session {id}` | 15+ providers |
| Claude Code | `claude -p "..."` | `--output-format stream-json` | `--resume {id}` | Anthropic only |
| Aider | `aider --message "..."` | Limited | Limited | Multi-provider |

## Key Design Principles

- **Agent-agnostic.** Runtime adapters normalize the interface across coding agents. Adding a new agent means writing one adapter script, not changing the orchestrator.
- **Device-aware.** Tasks can declare required USB devices (e.g., a YubiKey for signing, an HSM for key operations). Nomad routes tasks to nodes with matching metadata.
- **Off-the-shelf where possible.** Nomad for orchestration, Tailscale for networking, Ansible for provisioning, udev for device detection. Custom code is roughly 200 lines of CLI glue.
- **Fail-closed.** Runners stop accepting work if Nomad marks them unhealthy. No autonomous work without a functioning control plane.
- **Audit everything.** Every tool call, file write, and shell command executed by an agent is logged and attributable to a task via Nomad's allocation logs.

## Project Structure

```
code-orchestration/
  docs/
    architecture.md              # Component deep-dive, Nomad configuration
    use-cases.md                 # Concrete scenarios and workflows
    data-flows.md                # Sequence diagrams for every operation
    runtime-adapters.md          # How coding agents are integrated
    device-management.md         # USB devices, udev, locking, health checks
    deployment.md                # Dell 5070 setup, Ansible, networking
  jobs/
    run-coding-agent.nomad.hcl   # Parameterized job template
    scripts/
      run-agent.sh               # Runtime adapter entry point
  cli/                           # yeet CLI source
  ansible/                       # Fleet provisioning playbooks
  README.md
```

## Status

Design phase. See `docs/` for detailed architecture and data flows.
