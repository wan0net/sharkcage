# sharkcage

OpenClaw, but you trust it.

Sharkcage registers as OpenClaw's **sandbox backend**, wrapping every AI-directed tool call with `srt` (Anthropic Sandbox Runtime). Every bash command, file read/write, and skill execution is kernel-sandboxed. Capabilities approved once at install, enforced always.

## Security Model

```
OpenClaw + sharkcage plugin
  │
  ├── Per-tool ASRT sandboxing (sandbox backend)
  │   Every bash/exec/file tool call the AI makes:
  │     srt --settings <session-policy> /bin/sh -c <cmd>
  │   Kernel-enforced filesystem + network restrictions per command
  │
  ├── Per-skill ASRT sandboxing (supervisor)
  │   Each skill runs in its own srt sandbox:
  │     srt --settings <skill-policy> node <skill>
  │   Scoped to approved capabilities only
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

- **Per-tool sandboxing** — the sandbox backend wraps every AI-directed command with `srt`. The AI's bash commands and file operations run inside per-session ASRT policies with restricted filesystem and network access. The gateway process itself runs unsandboxed — it only serves deterministic chat server code.
- **Per-skill sandboxing** — each skill gets its own ASRT config derived from approved capabilities. Skills cannot reach each other's hosts or files.
- **Approval flow** — uses OpenClaw's native `requireApproval` so the human sees approval prompts in their chat channel but the AI never does.
- **Approve once, enforce always** — capabilities are approved at install time and enforced at the kernel level from then on. No runtime permission prompts, no fatigue.

## Quick Start

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash

# Then
sc init       # setup wizard (configures OpenClaw + sandbox mode)
sc start      # start everything
```

See [INSTALL.md](INSTALL.md) for full installation instructions.

## CLI

```
sc start                            Start supervisor + OpenClaw
sc stop                             Stop everything
sc init                             First-time setup wizard
sc status                           Show sandbox state, uptime, skill stats

sc skill add <url|path>             Install a skill
sc skill list                       List installed skills
sc skill remove <name>              Remove a skill
sc skill infer <name>             Infer capabilities from skill source
sc approve <name>                   Review and approve skill capabilities

sc verify <path>                    Scan a skill for issues
sc sign <path>                      Sign a skill with your key

sc config show                      Show sharkcage config
sc config add-service <host>        Add a host to the allowed services
sc config remove-service <host>     Remove a host from allowed services

sc audit                            Show recent audit log entries
sc audit --skill <name>             Filter by skill
sc audit --blocked                  Show only blocked calls
sc audit --tool <name>            Filter by tool name
sc audit --tail <n>               Show last N entries

sc user copy-in <path> [--mode]     Copy files into dedicated user's home
sc user shell                       Open shell as the dedicated user
sc user home                        Print dedicated user home directory
sc user info                        Show dedicated user details

sc trust <fingerprint>              Trust a skill signer
sc upgrade                          Safely upgrade OpenClaw with rollback
```

## Capability Model

Capabilities are approved once at install and enforced at the kernel level from then on. No runtime prompts. No fatigue. No `--dangerously-skip-permissions`.

When you install a skill, sharkcage:

1. Downloads it
2. Scans for dangerous patterns and missing fields
3. Generates a capability manifest (via static analysis if the skill has none)
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
