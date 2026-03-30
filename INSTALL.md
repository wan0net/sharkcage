# Installing sharkcage

> OpenClaw, but you trust it.

Sharkcage adds per-tool kernel-level sandboxing to OpenClaw. Every AI-directed tool call runs
in its own [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
with only the capabilities the user approved. The gateway process itself is not sandboxed —
enforcement is at the individual tool call level. No permission prompts at runtime.

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org/)
- **Git** — for cloning skills
- **macOS or Linux** — ASRT uses Seatbelt (macOS) or bubblewrap (Linux)

### Linux-specific prerequisites

```bash
# Required packages (Ubuntu/Debian)
sudo apt-get install -y ripgrep bubblewrap socat

# AppArmor profile for bubblewrap (Ubuntu 24.04+ / Noble)
# Without this, bwrap fails with "Permission denied" on user namespaces
echo 'abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}' | sudo tee /etc/apparmor.d/bwrap
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

## Quick Start

```bash
# 1. Clone
git clone --recursive https://github.com/wan0net/sharkcage.git
cd sharkcage

# 2. Bootstrap (installs packages, optionally installs OpenClaw + srt)
./bootstrap.sh

# 3. Add sc to PATH
export PATH="$PWD/bin:$PATH"

# 4. Set your API key
export OPENROUTER_API_KEY=your-key-here

# 5. Run the setup wizard
sc init

# 6. Start
sc start
```

## Network configuration

By default, OpenClaw binds to `127.0.0.1` (localhost only). For remote access via Tailscale or a reverse proxy:

```bash
# After sc init, update the bind address:
jq '.gateway.bind = "lan"' ~/.openclaw/openclaw.json > /tmp/oc.json && mv /tmp/oc.json ~/.openclaw/openclaw.json

# Allow all origins (if terminating TLS at a reverse proxy):
jq '.gateway.controlUi.allowedOrigins = ["*"]' ~/.openclaw/openclaw.json > /tmp/oc.json && mv /tmp/oc.json ~/.openclaw/openclaw.json
```

If accessing via HTTPS (recommended), configure your reverse proxy (Traefik, Caddy, nginx) to terminate TLS and forward to `http://localhost:18789`.

## What `sc start` does

1. Checks dependencies — installs OpenClaw and srt if missing
2. Runs the setup wizard if no config exists
3. Configures per-tool ASRT sandboxing for all AI-directed commands
4. Registers the sharkcage plugin with OpenClaw
5. Starts the supervisor (IPC, audit log, skill sandbox spawning)
6. Starts OpenClaw with the sharkcage sandbox backend active
7. Monitors both processes

## Installing skills

```bash
# From a git URL
sc plugin add https://github.com/wan0net/sharkcage-plugin-meals

# From a local path (creates a symlink)
sc plugin add ./my-skill

# List installed skills
sc plugin list

# Remove
sc plugin remove meals
```

When you install a skill, sharkcage:
1. Downloads it
2. Scans for issues (dangerous patterns, missing fields)
3. Shows the requested capabilities with risk levels
4. Asks you to approve

## Approving capabilities

```bash
sc approve meals
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

Open `http://127.0.0.1:18789/sharkcage/` in your browser. Shows:

- **Status** — ASRT state, uptime, skill counts, tool call stats
- **Skills** — installed skills with approval status
- **Audit Log** — every tool call with timestamps, blocks, durations
- **Config** — sharkcage configuration (read-only)

## Audit log

```bash
# Show recent entries
sc audit

# Filter by skill
sc audit --skill meals

# Show only blocked calls
sc audit --blocked

# Show all
sc audit --all
```

## Managing the gateway sandbox

```bash
# Show current config
sc config show

# Add a service host to the allowed services
sc config add-service api.telegram.org

# Remove a service
sc config remove-service api.telegram.org
```

Changes require confirmation and restart.

## Stopping

```bash
sc stop
```

## Architecture

See [docs/unified-platform.md](docs/unified-platform.md) for the full design doc,
or [docs/architecture.svg](docs/architecture.svg) for the diagram.

**TL;DR:** sharkcage is a supervisor process that owns all ASRT sandboxes. Each skill runs
inside its own sandbox. Every individual tool call is sandboxed — the gateway process itself
is not. The supervisor is the only unsandboxed process (~200 lines, auditable in 15 minutes).

## Security Model

- **Per-tool sandboxing** — every individual tool call runs in its own ASRT sandbox; the gateway process itself is not sandboxed
- **Fail closed** — if the supervisor is unreachable, all tool calls are blocked
- **Per-skill sandboxing** — each skill gets its own ASRT config (kernel-enforced)
- **No runtime prompts** — approve once at install, enforce always
- **Audit trail** — every tool call logged with full provenance
- **Mandatory denies** — ~/.ssh, ~/.aws, ~/.gnupg always blocked regardless of capabilities
