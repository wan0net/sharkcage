# Installing sharkcage

> OpenClaw, but you trust it.

Sharkcage adds per-tool kernel-level sandboxing to OpenClaw. Every AI-directed tool call runs
in its own [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
with only the capabilities the user approved. The gateway process itself is not sandboxed —
enforcement is at the individual tool call level. No permission prompts at runtime.

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org/)
- **Git** — for cloning and updating
- **macOS or Linux** — ASRT uses Seatbelt (macOS) or bubblewrap (Linux)

> OpenClaw and srt are installed automatically by the install script. You do not need to install them separately.

## Quick Start

```bash
# 1. Install to /opt/sharkcage
curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash

# 2. Set your API key
export OPENROUTER_API_KEY=your-key-here

# 3. Run the setup wizard
sc init

# 4. Start
sc start
```

The install script handles everything: cloning, dependency installation (including OpenClaw and srt),
creating a dedicated system user, setting up directory layout, and adding `sc` to your PATH.

## Directory Layout

```
/opt/sharkcage/
├── bin/            # sc CLI (added to PATH)
├── etc/            # configuration (sharkcage.json, policies)
├── var/            # runtime data (audit logs, skill state)
├── skills/         # installed skills
├── bootstrap.sh    # dependency installer
└── ...             # source code
```

## Dedicated User

The install script creates a dedicated `sharkcage` system user. AI-directed commands run as this
user inside their sandbox, providing an additional isolation layer beyond kernel-enforced sandboxing.

```bash
# Copy files into the dedicated user's home
sc user copy-in ./my-data.json

# Open a shell as the dedicated user
sc user shell

# Show user details
sc user info
```

## Systemd Service (Linux)

After installation, enable sharkcage as a system service:

```bash
sudo cp /opt/sharkcage/etc/sharkcage.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sharkcage
```

## Network configuration

By default, OpenClaw binds to `127.0.0.1` (localhost only). For remote access via Tailscale or a reverse proxy:

```bash
# After sc init, update the bind address:
jq '.gateway.bind = "lan"' /opt/sharkcage/etc/openclaw.json > /tmp/oc.json && mv /tmp/oc.json /opt/sharkcage/etc/openclaw.json

# Allow all origins (if terminating TLS at a reverse proxy):
jq '.gateway.controlUi.allowedOrigins = ["*"]' /opt/sharkcage/etc/openclaw.json > /tmp/oc.json && mv /tmp/oc.json /opt/sharkcage/etc/openclaw.json
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
sc skill add https://github.com/wan0net/sharkcage-plugin-meals

# From a local path (creates a symlink)
sc skill add ./my-skill

# List installed skills
sc skill list

# Remove
sc skill remove meals
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

## Updating

```bash
cd /opt/sharkcage
sudo git fetch --tags
sudo git checkout v1.1.0        # or the version you want
sudo bash bootstrap.sh          # reinstall dependencies
sc stop && sc start             # restart with the new version
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
