---
layout: doc
title: Security
description: Sandbox enforcement, skill signing, threat model, and defence in depth
---

# Security

## Sandbox Enforcement

### ASRT (Anthropic Sandbox Runtime)

`@anthropic-ai/sandbox-runtime`. Apache-2.0. OS-level primitives:

| Platform | Filesystem | Network | Subprocess |
|----------|-----------|---------|-----------|
| macOS | sandbox-exec (Seatbelt) | Seatbelt + proxy | Seatbelt |
| Linux | bubblewrap (bind mounts) | Network namespace + proxy | seccomp BPF |

Kernel-enforced. Wraps any process — not just JS/TS.

### Per-Tool srt Sandboxing

Every AI-directed tool call is wrapped by the sandbox backend using `srt --settings <session-policy>`. The session policy is derived from the active skill's approved capabilities and enforced at the kernel level for each invocation.

```
Session policy (generated dynamically per session):
  network.allowedDomains: ["openrouter.ai"]
  filesystem.allowWrite: ["/opt/sharkcage/.openclaw/tmp", "/opt/sharkcage/.openclaw/workspace", "/opt/sharkcage/.openclaw/sandboxes"]
  filesystem.denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"]
```

The gateway process itself is not sandboxed — it runs deterministic server code. Only AI-directed operations (bash commands, file reads/writes passed through the sandbox backend) go through srt.

### Per-Skill ASRT Configuration

Each skill gets its own ASRT config derived from approved capabilities:

```
Skill "meals" approved for:
  network.external: ["meals-api.wan0.cloud"]
  data.meals

→ Per-skill ASRT config:
  network.allowedDomains: ["meals-api.wan0.cloud"]
  filesystem.allowWrite: []
  filesystem.denyRead: ["~/.ssh", "~/.aws"]
```

```
Skill "coding-agent" approved for:
  system.exec: ["git", "npm", "node"]
  system.files.write: ["./workspace"]
  network.external: ["github.com", "registry.npmjs.org"]

→ Per-skill ASRT config:
  network.allowedDomains: ["github.com", "registry.npmjs.org"]
  filesystem.allowWrite: ["./workspace"]
  filesystem.denyRead: ["~/.ssh", "~/.aws"]
```

### Silent Enforcement

No prompts at runtime. Violations are logged, not prompted:

```
[sharkcage] network violation: skill "meals" → evil.com (BLOCKED)
            allowed: meals-api.wan0.cloud
            logged to audit.jsonl
```

### Process Isolation

Skills run as separate processes in their own per-skill sandboxes. OpenClaw and skills cannot see each other's network scope or filesystem access. The supervisor mediates all communication via IPC.

---

## Skill Scanning and Signing

### The Scanner

```bash
sc verify ./my-skill

  Y [PLUGIN_001] Manifest valid
  ! [PLUGIN_002] Skill is unsigned
  . [PLUGIN_OK] Found 8 tool(s)
  . [PLUGIN_OK] External Network: meals-api.wan0.cloud (medium)
  . [PLUGIN_OK] Meal Data (low)

  PASS with 1 warning(s)
```

Checks: manifest validation, signature verification, capability risk assessment, static analysis (subprocess, filesystem, FFI patterns), tool definition completeness.

### Signing

Ed25519. Trust levels: `full` (auto-load), `prompt` (ask before loading), `audit` (load but log everything).

### Install Flow

```bash
sc skill add https://github.com/user/some-skill

  Cloning... Scanning...
  No manifest found — running AI capability inference...

  This skill appears to need:
    External Network: api.github.com (medium, AI-inferred)
    Run Programs: git, gh (high, AI-inferred)

  Allow? [Y/n/details/edit]
```

---

## Security Model

### Defence in Depth (6 Layers)

```
Layer 1: Session policy (per-tool srt sandboxing — all AI tool calls)
Layer 2: OpenClaw tool policy (deny groups, exec security)
Layer 3: Sharkcage capability gate (interceptor — check approval)
Layer 4: Sharkcage approval flow (first-time dangerous ops → confirm once)
Layer 5: Per-skill ASRT sandbox (kernel-enforced, out-of-process)
Layer 6: Supervisor audit logging (every tool call recorded)
```

### Threat Matrix

| Threat | Mitigation |
|--------|-----------|
| Skill reads ~/.ssh | ASRT mandatory deny — always blocked via per-tool session policy |
| Skill exfiltrates to unknown host | Per-skill ASRT: only approved hosts. Per-tool session policy: only approved hosts. Kernel-enforced. |
| Skill writes outside workspace | Per-skill ASRT: allowWrite scoped. Kernel-enforced. |
| Skill runs destructive commands | Capability gate blocks unless system.exec approved. ASRT scopes to allowed binaries. |
| AI-directed tool call escapes sandbox | srt wraps every tool call — gateway runs no AI-directed operations unsandboxed. |
| Skill accesses another skill's service | Out-of-process isolation. Meals worker can't reach HA. HA worker can't reach meals API. |
| New skill widens tool sandbox | Skills run in their own per-skill sandboxes. Installing skills never changes other sandbox configs. |
| Supply chain: malicious ClawHub skill | AI inference + scanner + user approval before any code runs. |
| Prompt injection via tool results | Capability gate applies to subsequent calls. Cross-skill tool calls checked against originating skill. |

### Remaining Gaps

**Gap 1: User approves too broadly.** Scanner warns. Possible improvement: require scoping for dangerous capabilities.

**Gap 2: Cross-skill context leakage in shared Pi session.** Skills share conversation context. A malicious skill could read other skills' tool results. Mitigation: out-of-process execution limits data exposure, but Pi session is still shared. Improvement: per-skill session isolation.

**Gap 3: Prompt injection causing cross-skill tool calls.** Mitigated by capability gate checking tool ownership. Improvement: track originating skill per turn.

**Gap 4: No runtime cost enforcement.** Audit log tracks usage. Improvement: budget caps per skill.

**Gap 5: srt overhead per tool call.** Every AI tool call forks a new srt process. For high-frequency tool use this adds latency. Improvement: reuse sandboxed worker processes per session.

**Gap 6: AI inference accuracy.** AI might over-infer or under-infer capabilities. Mitigated by user review + edit capability. Improves with audit log feedback.

**Gap 7: Supervisor is unsandboxed.** The supervisor process has full access. It's ~200 lines of code, does nothing except spawn sandboxed processes and shuttle IPC. Attack surface is minimal but exists. Mitigated by code simplicity and signing.

### Philosophy

Make the risk visible. Make the boundaries enforceable. Let the user decide once, enforce always. Don't nag on every action.
