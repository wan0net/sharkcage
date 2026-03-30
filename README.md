# sharkcage

OpenClaw, but you trust it.

Sharkcage registers as OpenClaw's **sandbox backend**, replacing Docker with kernel-level ASRT isolation. Every bash command, file read/write, and skill execution goes through `srt`. Capabilities approved once at install, enforced always at the kernel level.

## Security Model

```
OpenClaw + sharkcage plugin
  │
  ├── ASRT sandbox backend (registered via registerSandboxBackend)
  │   Every exec/bash call → srt --settings <policy> /bin/sh -c <cmd>
  │   Every file read/write → srt --settings <policy> /bin/sh -c <script>
  │   Per-session policy: workspace access, deny ~/.ssh etc.
  │
  ├── Capability enforcement (before_tool_call hook)
  │   Unapproved skill? → native channel approval (AI cannot see it)
  │   Approved? → route to supervisor for sandboxed execution
  │
  ├── Localhost proxy (SOCKS5 on :18800)
  │   Per-skill tokens, blocks unapproved localhost access
  │
  └── Audit log
      Every tool call logged, blocked or allowed
```

- **Sandbox backend** — OpenClaw calls sharkcage's `buildExecSpec` for every command and `runShellCommand` for every file operation. All go through `srt` with per-session ASRT policies.
- **Skill sandboxing** — each skill gets its own ASRT config derived from approved capabilities. Skills cannot reach each other's hosts.
- **Approval flow** — uses OpenClaw's native `requireApproval` so the human sees approval prompts in their chat channel but the AI never does.

## Quick Start

```bash
# 1. Clone
# One-line install
curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash

# Then
sc init       # setup wizard (configures OpenClaw + sandbox mode)
sc start      # start everything

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

## Platform Support

| Platform | Sandbox | How |
|----------|---------|-----|
| macOS | Seatbelt (sandbox-exec) | Native via `srt` |
| Linux | bubblewrap + seccomp | Native via `srt` |
| Windows | bubblewrap + seccomp | Via WSL2 — run OpenClaw inside WSL2 |

`srt` (Anthropic Sandbox Runtime) provides kernel-level enforcement on all three. On Windows, WSL2 gives you a real Linux kernel, so the same bubblewrap+seccomp sandbox works identically.

## Documentation

- [INSTALL.md](INSTALL.md) — Installation and setup
- [docs/unified-platform.md](docs/unified-platform.md) — Full design doc: architecture, capability model, sandbox enforcement, security model
