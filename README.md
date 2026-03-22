# code-orchestration

An agent-agnostic autonomous coding orchestrator for physical runner fleets.

## What This Is

A system for running AI coding agents (Claude Code, Crush/OpenCode, Aider, etc.) autonomously on a fleet of physical machines, with centralized task routing, device-aware scheduling, and remote control. Tasks are submitted via CLI or API, routed to available runners based on device requirements and capacity, and executed without human presence.

## The Problem

- Multiple projects running concurrently need AI coding assistance.
- Some work requires physical devices (USB security keys, dev boards, HSMs) that must be attached to a specific machine.
- Tying up a laptop as the execution environment blocks other work.
- You need control and visibility over agent sessions without being actively connected to each machine.

## Architecture

```
                          +---------------------+
                          |        API          |
                          |  Hono / CF Workers  |
                          |  BullMQ + Redis     |
                          |  Device Registry    |
                          |  CF Access (auth)   |
                          +--------+------------+
                                   |
                            Tailscale mesh
                   +---------------+---------------+
                   |               |               |
           +-------+---+   +------+----+   +------+----+
           | Runner 01 |   | Runner 02 |   | Runner 03 |
           | Dell 5070 |   | Dell 5070 |   | Dell 5070 |
           |           |   |           |   |           |
           | worker    |   | worker    |   | worker    |
           | daemon    |   | daemon    |   | daemon    |
           |           |   |           |   |           |
           | USB: YK5  |   | USB: HSM  |   | (none)   |
           +-----------+   +-----------+   +-----------+

    +-------+
    |  CLI  |  <-- submit tasks, monitor, approve, manage fleet
    +-------+
```

Three components:

1. **API** -- Hono on Cloudflare Workers (or self-hosted). Task queue backed by BullMQ/Redis. Device registry tracks which runners have which hardware attached. Cloudflare Access handles authentication.

2. **Runner fleet** -- Dell 5070 thin clients running Linux. Each runs a worker daemon that polls for tasks, spawns coding agent CLIs (Claude Code, Crush, etc.), and manages USB devices. Connected via Tailscale mesh VPN.

3. **CLI** -- Local tool for submitting tasks, monitoring progress, approving actions, and managing the fleet.

## Key Design Principles

- **Agent-agnostic.** Runtime adapters normalize the interface across Claude Code, Crush, Aider, and others. Adding a new agent means writing one adapter, not changing the orchestrator.
- **Device-aware.** Tasks can declare required USB devices (e.g., a YubiKey for signing, an HSM for key operations). The scheduler routes tasks to runners that have the hardware attached.
- **Off-the-shelf where possible.** BullMQ for queuing, Tailscale for networking, Ansible for provisioning, udev for device detection, flock for locking. Custom code is roughly 500 lines of glue.
- **Fail-closed.** Runners pause execution if they lose contact with the API. No autonomous work without a functioning control plane.
- **Audit everything.** Every tool call, file write, and shell command executed by an agent is logged and attributable to a task.

## Supported Runtimes

| Runtime            | Headless CLI           | Structured Output              | Session Resume       | Multi-provider |
|--------------------|------------------------|--------------------------------|----------------------|----------------|
| Crush (OpenCode)   | `crush run "..."`      | JSON                           | `--session {id}`     | 15+ providers  |
| Claude Code        | `claude -p "..."`      | `--output-format stream-json`  | `--resume {id}`      | Anthropic only |
| Aider              | `aider --message "..."` | Limited                       | Limited              | Multi-provider |

## Project Structure

```
code-orchestration/
  docs/
    architecture.md        # Component deep-dive, technology choices
    use-cases.md           # Concrete scenarios and workflows
    data-flows.md          # Sequence diagrams for every operation
    runtime-adapters.md    # How coding agents are integrated
    device-management.md   # USB devices, udev, locking, health checks
    deployment.md          # Dell 5070 setup, Ansible, networking
  src/
    runner/                # Worker daemon
    api/                   # Hono API
    cli/                   # CLI tool
    adapters/              # Runtime adapters
  ansible/                 # Fleet provisioning playbooks
  README.md
```

## Status

Design phase. The architecture is documented and the component boundaries are defined. See `docs/` for detailed architecture, data flows, and deployment plans. No implementation code yet.
