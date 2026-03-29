# Installing yeet

> OpenClaw, but you trust it.

yeet adds per-skill kernel sandboxing to OpenClaw. Every skill runs in its own
[Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
(ASRT) with only the capabilities the user approved. No permission prompts at runtime.

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org/)
- **Git** — for cloning skills
- **macOS or Linux** — ASRT uses Seatbelt (macOS) or bubblewrap (Linux)

## Quick Start

```bash
# 1. Clone
git clone --recursive https://github.com/wan0net/yeet.git
cd yeet

# 2. Bootstrap (installs packages, optionally installs OpenClaw + srt)
./bootstrap.sh

# 3. Add yeet to PATH
export PATH="$PWD/bin:$PATH"

# 4. Set your API key
export OPENROUTER_API_KEY=your-key-here

# 5. Run the setup wizard
yeet init

# 6. Start
yeet start
```

## What `yeet start` does

1. Checks dependencies — installs OpenClaw and srt if missing
2. Runs the setup wizard if no config exists
3. Generates a signed gateway sandbox config (outer ASRT)
4. Registers the yeet plugin with OpenClaw
5. Starts the supervisor (IPC, audit log, skill sandbox spawning)
6. Starts OpenClaw inside the outer ASRT sandbox
7. Monitors both processes

## Installing skills

```bash
# From a git URL
yeet plugin add https://github.com/wan0net/yeet-plugin-meals

# From a local path (creates a symlink)
yeet plugin add ./my-skill

# List installed skills
yeet plugin list

# Remove
yeet plugin remove meals
```

When you install a skill, yeet:
1. Downloads it
2. Scans for issues (dangerous patterns, missing fields)
3. Shows the requested capabilities with risk levels
4. Asks you to approve

## Approving capabilities

```bash
yeet approve meals
```

Shows each capability the skill requests:

```
Skill: meals v0.3.0

Requested capabilities:

  [.] data.meals (low)
     Read and update fridge, freezer, pantry, recipes

  [~] network.external (medium)
     Call the meals API backend
     Scope: meals-api.wan0.cloud:443

  [~] cost.api (medium)
     Meal suggestions use LLM inference
     Scope: workers-ai

Approve all capabilities? [Y/n/edit]
```

After approval, the skill runs without prompts. ASRT enforces the boundaries
at the kernel level. If the skill tries to reach a host outside its scope,
the kernel blocks it silently and the attempt is logged to the audit trail.

## Dashboard

Open `http://127.0.0.1:18789/yeet/` in your browser. Shows:

- **Status** — ASRT state, uptime, skill counts, tool call stats
- **Skills** — installed skills with approval status
- **Audit Log** — every tool call with timestamps, blocks, durations
- **Config** — gateway sandbox config (read-only)

## Audit log

```bash
# Show recent entries
yeet audit

# Filter by skill
yeet audit --skill meals

# Show only blocked calls
yeet audit --blocked

# Show all
yeet audit --all
```

## Managing the gateway sandbox

```bash
# Show current config
yeet config show

# Add a service host to the outer sandbox allowlist
yeet config add-service api.telegram.org

# Remove a service
yeet config remove-service api.telegram.org
```

Changes require confirmation and restart.

## Stopping

```bash
yeet stop
```

## Architecture

See [docs/unified-platform.md](docs/unified-platform.md) for the full design doc,
or [docs/architecture.svg](docs/architecture.svg) for the diagram.

**TL;DR:** yeet is a supervisor process that owns all ASRT sandboxes. OpenClaw runs
inside one sandbox. Each skill runs inside its own. The supervisor is the only
unsandboxed process (~200 lines, auditable in 15 minutes).

## Security Model

- **Fail closed** — if the supervisor is unreachable, all tool calls are blocked
- **Per-skill sandboxing** — each skill gets its own ASRT config (kernel-enforced)
- **Init-locked gateway** — outer sandbox only allows init-configured services
- **No runtime prompts** — approve once at install, enforce always
- **Audit trail** — every tool call logged with full provenance
- **Mandatory denies** — ~/.ssh, ~/.aws, ~/.gnupg always blocked regardless of capabilities
