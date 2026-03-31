---
layout: doc
title: Architecture
description: How sharkcage wraps OpenClaw with kernel-level sandboxing
---

# Architecture

## What This Is

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

## The Supervisor Model

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

## Data Flow

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
  6. Log to audit.jsonl
  7. Return result to OpenClaw via IPC
  │
  ▼
Sharkcage interceptor returns result to Pi Agent
  │
  ▼
Pi Agent formats response → OpenClaw → Signal → user
```

## Per-Tool Session Policies

Per-tool session policies are generated dynamically by the sandbox backend. Each session gets an ASRT config restricting filesystem and network access for all tool calls in that session.

```bash
# Session policy example (generated at session start):
/opt/sharkcage/var/sessions/<session-id>.json:
  network.allowedDomains: ["openrouter.ai"]
  filesystem.allowWrite: ["/opt/sharkcage/.openclaw/tmp", "/opt/sharkcage/.openclaw/workspace", "/opt/sharkcage/.openclaw/sandboxes"]
  filesystem.denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"]
```

Every AI tool call in that session is wrapped:
```bash
srt --settings /opt/sharkcage/var/sessions/<session-id>.json /bin/sh -c <cmd>
```

**Policy is scoped to the session** — the sandbox backend generates a fresh policy per session based on the active skill's approved capabilities. No session-wide config file is signed or locked; enforcement is per-invocation at the kernel level.

**Immutable audit trail:** every tool call appended to `audit.jsonl` with timestamp, tool, args, result, skill, and capability.

## Sharkcage Sits Above the Agent

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

## Integration Points (no OpenClaw fork)

| Hook | What sharkcage does |
|------|-------------------|
| **Interceptor `tool.before`** | Capability check + IPC to supervisor for out-of-process execution |
| **Interceptor `tool.after`** | Audit log |
| **Plugin `before_tool_call`** | First-time approval flow for new capabilities |
| **OpenClaw `registerTool`** | Register additional tools |
| **OpenClaw `registerHttpRoute`** | Webhook for results |
| **Process supervisor** | `sc start` owns all ASRT sandboxes |

---

## Repo Structure

### What Stays

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

### What Was Retired

| Repo | Why Retired |
|------|-----------|
| `yeet-core` | OpenClaw is the gateway. Custom Deno gateway was a stepping stone. Archived. |
| `yeet-sandbox` | Supervisor has ASRT integration built in. Redundant. Archived. |

### Skills (separate repos, each its own per-skill sandbox)

```
sharkcage-skill-meals/             # Meal planning (DONE, needs IPC refactor)
sharkcage-skill-ha/                # Home Assistant control (NOT STARTED)
sharkcage-skill-briefing/          # News briefing (NOT STARTED)
sharkcage-skill-composio/          # Multi-agent orchestration (NOT STARTED)
sharkcage-skill-godot/             # Godot game dev via MCP (NOT STARTED)
```

Any existing OpenClaw/ClawHub skill also works — AI infers capabilities automatically.
MCP servers run as sandboxed skills (supervisor spawns them in per-skill ASRT, stdio transport).

### Runtime

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

### Dependency Graph

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

### Line Counts

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
