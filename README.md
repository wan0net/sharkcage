# sharkcage

OpenClaw, but you trust it.

Sharkcage registers as OpenClaw's **sandbox backend**, wrapping every AI-directed tool call with `srt` (Anthropic Sandbox Runtime). Every bash command, file read/write, and skill execution is sandboxed using built-in OS kernel primitives. Capabilities approved once at install become the baseline policy, and later scope expansion is explicit and audited.

> **No new sandboxing tech.** Sharkcage uses the same battle-tested OS primitives that Flatpak, Snap, and Chrome have relied on for years: [bubblewrap](https://github.com/containers/bubblewrap) + seccomp on Linux, Seatbelt (sandbox-exec) on macOS. Wrapped by Anthropic's [srt](https://github.com/anthropic-experimental/sandbox-runtime). These are proven, kernel-enforced boundaries — not a custom sandbox or a JS shim.
>
> Built by an unprofessional security engineer who got tired of `--dangerously-skip-permissions`. Vibe coded with AI, hardened by a human who kept asking "but what if..." until the sandbox actually held up. Three automated security review passes, Trivy and Semgrep on every build, every finding discussed before fixing. The security model wasn't designed top-down — it was discovered bottom-up by trying things, watching them break, and deciding what actually matters.

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
      Hash-chained local audit log, rotated and health-checked
```

- **Per-tool sandboxing** — the sandbox backend wraps every AI-directed command with `srt`. The AI's bash commands and file operations run inside per-session ASRT policies with restricted filesystem and network access. The gateway process itself runs unsandboxed — it only serves deterministic chat server code.
- **Per-skill sandboxing** — each skill gets its own ASRT config derived from approved capabilities. Skills cannot reach each other's hosts or files.
- **Approval flow** — uses OpenClaw's native `requireApproval` so the human sees approval prompts in their chat channel but the AI never does.
- **Approve once, enforce always** — install-time approvals become the baseline policy, and later scope expansion is explicit, persisted, and audited. No per-action runtime nagging.
- **Tamper-evident local audit trail** — tool and proxy events are written to a hash-chained local log with rotation and integrity checks.

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

## How This Was Built

Yes, this was vibe coded. An AI wrote most of the implementation while a human who understands security kept asking "but what if..." until the answers were honest. Multiple automated security review passes, Trivy and Semgrep on every build, every finding discussed before fixing — some were real vulnerabilities, some were the sandbox already doing its job, and knowing the difference mattered more than fixing everything blindly.

The security model wasn't designed top-down. It was discovered bottom-up by trying things, watching them break, understanding why, and deciding what actually matters. The original design had a full outer sandbox wrapping the entire OpenClaw binary. In practice it broke inbound connections, IPC, and FD inheritance. The per-tool model was already doing the real work. That's not a bug in the process — that's how you find out what works.

## Documentation

- [INSTALL.md](INSTALL.md) — Installation and setup
- [docs/unified-platform.md](docs/unified-platform.md) — Full design doc: architecture, capability model, sandbox enforcement, security model
