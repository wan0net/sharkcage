# sharkcage

OpenClaw, but you trust it.

Sharkcage runs the **entire OpenClaw binary inside a kernel-level sandbox** (outer ASRT). On top of that, every skill gets its own sandboxed process (inner ASRT). Capabilities approved once at install, enforced always at the kernel level. No permission prompts at runtime.

## Security Model

```
sc start (supervisor — the only unsandboxed process, ~200 lines)
  │
  ├── OUTER ASRT SANDBOX → OpenClaw (the entire binary)
  │   network: [signal-cli, openrouter.ai]  (init-locked, signed)
  │   filesystem: [~/.openclaw/data]
  │   deny: [~/.ssh, ~/.aws, ~/.gnupg]
  │
  │   On tool call → IPC to supervisor via unix socket
  │
  ├── INNER ASRT SANDBOX → meals skill
  │   network: [meals-api.example.com]
  │
  ├── INNER ASRT SANDBOX → home-assistant skill
  │   network: [homeassistant.local:8123]
  │
  └── INNER ASRT SANDBOX → any other skill
      scoped to its approved capabilities only
```

Two layers of kernel enforcement:

1. **Outer sandbox** — the entire OpenClaw process is contained. Init-locked and signed at setup. Cannot be widened without deliberate user action.
2. **Inner sandboxes** — each skill runs in a separate process with its own ASRT config derived from approved capabilities. Skills cannot reach each other's hosts or the gateway's hosts.

The supervisor mediates all communication via IPC. It is ~200 lines and auditable in 15 minutes.

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

See [INSTALL.md](INSTALL.md) for full installation instructions.

## CLI

```
sc start                            Start supervisor + sandboxed OpenClaw
sc stop                             Stop everything
sc init                             First-time setup wizard
sc status                           Show sandbox state, uptime, skill stats

sc plugin add <url|path>            Install a skill
sc plugin list                      List installed skills
sc plugin remove <name>             Remove a skill
sc approve <name>                   Review and approve skill capabilities

sc verify <path>                    Scan a skill for issues
sc sign <path>                      Sign a skill with your key

sc config show                      Show gateway sandbox config
sc config add-service <host>        Add a host to the outer sandbox
sc config remove-service <host>     Remove a host from the outer sandbox

sc audit                            Show recent audit log entries
sc audit --skill <name>             Filter by skill
sc audit --blocked                  Show only blocked calls
```

## Capability Model

Capabilities are approved once at install and enforced at the kernel level from then on. No runtime prompts. No fatigue. No `--dangerously-skip-permissions`.

When you install a skill, sharkcage:

1. Downloads it
2. Scans for dangerous patterns and missing fields
3. Generates a capability manifest (via AI inference if the skill has none)
4. Shows requested capabilities with risk levels
5. Asks you to approve

After approval, the skill runs in its own ASRT sandbox scoped to exactly what was approved. If it tries to reach a host outside its scope, the kernel blocks it silently and logs the attempt.

## Documentation

- [INSTALL.md](INSTALL.md) — Installation and setup
- [docs/unified-platform.md](docs/unified-platform.md) — Full design doc: architecture, capability model, sandbox enforcement, security model
