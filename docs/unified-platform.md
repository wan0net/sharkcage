---
layout: doc
title: Unified Platform Design
description: Design doc for merging shellcode-server, food, and yeet into a single conversational gateway with multi-agent coding, HA integration, and sandboxed execution.
---

# Unified Platform Design

Single conversational gateway that replaces OpenClaw/NemoClaw. Connects all personal services (meals, briefing, home automation, coding fleet) behind one AI agent accessible from Signal, Home Assistant, iOS, and webhooks.

Version: 0.2.0
Date: 2026-03-29

---

## Table of Contents

1. [Personas](#1-personas)
2. [Problem Statement](#2-problem-statement)
3. [Architecture Overview](#3-architecture-overview)
4. [The Unified Gateway](#4-the-unified-gateway)
5. [Tool Definitions](#5-tool-definitions)
6. [Multi-Agent Coding](#6-multi-agent-coding)
7. [Data Flows](#7-data-flows)
8. [Security Model](#8-security-model)
9. [Plugin System](#9-plugin-system)
10. [Dashboard](#10-dashboard)
11. [Migration Plan](#11-migration-plan)

---

## 1. Personas

Four user personas guide all UX decisions — from setup wizard behaviour to capability approval language to which features are visible.

### 1.1 Home User — "Alex"

**Profile:** Non-technical. Wants a personal assistant for daily life. Talks via HA voice or Signal on their phone.

**Typical interactions:**
- "What's for dinner tonight?"
- "Turn off the bedroom lights"
- "Add milk to the shopping list"
- "What's the weather tomorrow?"

**Platform experience:**
- `yeet init` walks through everything in plain language
- Installs plugins from a curated list — never touches config files
- Capability approval is simple: "Meal Planner wants to see your fridge contents. Allow?"
- Dashboard shows: chat interface, meal suggestions, home controls
- Never sees: terminals, Nomad, Deno, fleet, worktrees, code, logs

**Technical footprint:**
- Gateway runs on a single machine (HA box, Raspberry Pi, or NAS)
- 1-3 plugins (meals, HA, weather)
- Signal or HA voice as primary channel
- No fleet, no coding agents

### 1.2 Power User — "Sam"

**Profile:** Tech-comfortable, runs a homelab. Uses Home Assistant, may self-host other services. Not a software developer.

**Typical interactions:**
- Everything Alex does, plus:
- "Check my NAS storage"
- "What's the status of my backups?"
- "Install the calendar plugin"
- Reviews plugin capabilities before approving

**Platform experience:**
- `yeet init` offers more configuration options (custom API endpoints, webhook setup)
- Installs community plugins, understands scoping ("this plugin can only reach calendar.google.com")
- Capability approval shows scope: "Calendar plugin requests External Network access to calendar.google.com. Allow?"
- Dashboard shows: chat, home controls, meals, monitoring widgets
- May write simple skills (SKILL.md) for domain-specific behaviour
- Never sees: code, Deno flags, gVisor config, Nomad internals

**Technical footprint:**
- Gateway on homelab hardware
- 3-8 plugins
- Multiple channels (Signal + HA voice + maybe web chat)
- No fleet, no coding agents

### 1.3 Developer — "Jordan"

**Profile:** Software engineer. Uses yeet for personal projects. Runs coding agents occasionally on a spare machine or two.

**Typical interactions:**
- Everything Sam does, plus:
- "Run the auth feature on peer6"
- "What's the build status?"
- "Continue that last session with the new API design"

**Platform experience:**
- Uses `yeet` CLI alongside the chat interface
- Writes custom plugins in Deno/TypeScript
- Signs and publishes plugins
- Understands the capability model at the manifest level
- Dashboard shows: chat, agents, PRs, logs, cost tracking
- Comfortable with: `yeet verify`, `yeet sign`, `plugin.json` editing

**Technical footprint:**
- Gateway on homelab
- 5-15 plugins (meals, HA, fleet, briefing, custom integrations)
- 1-2 fleet nodes (laptop + spare machine)
- Single coding agent per task, may use different models
- Uses `yeet run` and `yeet status` regularly

### 1.4 Platform Engineer — "Riley"

**Profile:** Runs multiple projects across a fleet of machines. Multi-model, multi-agent orchestration. Cares about cost, security, and throughput.

**Typical interactions:**
- Everything Jordan does, plus:
- "Build the physics system — use gemini for engine code and claude for tests"
- "Drain yeet-03, it's running hot"
- "What's the cost breakdown this week?"
- "Verify the new Jira plugin before deploying it"

**Platform experience:**
- Full manual configuration (gateway.json, Nomad HCL, Ansible, policies)
- Maintains plugin library for the team
- Runs `yeet verify --strict` in CI pipelines
- Reviews audit logs, sandbox policies, permission broker output
- Dashboard shows: everything — agents, fleet, PRs, costs, audit, per-model spend
- Uses Composio for multi-agent task decomposition

**Technical footprint:**
- Gateway on dedicated homelab node
- 10+ plugins including custom integrations
- 3+ fleet nodes with diverse hardware (GPU, USB devices)
- Multi-agent coding: Composio orchestrator + OpenCode workers with different models
- gVisor sandboxing, GitHub bot account, branch protection
- Full audit trail, cost alerting, CI-integrated plugin scanning

### 1.5 Feature Matrix

| Feature | Alex | Sam | Jordan | Riley |
|---------|:----:|:---:|:------:|:-----:|
| Chat (Signal/HA voice) | ✓ | ✓ | ✓ | ✓ |
| Web dashboard | simple | full | full | full + audit |
| Plugin install | curated | community | community + custom | custom + CI |
| Capability approval | plain language | scoped | manifest-level | `yeet verify --strict` |
| Write skills (SKILL.md) | — | ✓ | ✓ | ✓ |
| Write plugins | — | — | ✓ | ✓ |
| Sign/publish plugins | — | — | ✓ | ✓ |
| CLI usage | — | light | regular | heavy |
| Fleet management | — | — | basic | full |
| Coding agents | — | — | single-model | multi-model, multi-agent |
| Composio orchestration | — | — | — | ✓ |
| GPU/device routing | — | — | — | ✓ |
| Audit logs | — | — | — | ✓ |
| CI scanning | — | — | — | ✓ |
| Permission broker | — | — | — | ✓ |

### 1.6 How Personas Guide Implementation

**Setup (`yeet init`):**
```
Welcome to yeet! What best describes you?

  1. I want a personal assistant (chat, meals, home control)
  2. I run a homelab and want to extend it
  3. I'm a developer who wants coding agents
  4. I manage a fleet of machines
```

Selection determines:
- Which config questions are asked (Alex never sees Nomad config)
- Which plugins are suggested (Alex gets meals + HA, Riley gets fleet + composio)
- How much detail is shown in output (Alex: "Installed!", Riley: manifest + scan results)
- Dashboard layout (Alex: chat-first, Riley: fleet-first)

**Capability approval adapts:**
- Alex: "Meal Planner wants to see your fridge. Allow? [Yes / No]"
- Sam: "Meal Planner requests: Meal Data (low risk), External Network to meals-api.wan0.cloud (medium). Allow? [Yes / No / Details]"
- Jordan: reviews `plugin.json` capabilities array directly
- Riley: `yeet verify --strict` in CI, auto-approve trusted signers

**Dashboard adapts:**
- Alex: chat window + meal card + home controls. No sidebar.
- Sam: chat + home + meals + monitoring. Simple sidebar.
- Jordan: chat + agents + PRs + logs + costs. Full sidebar.
- Riley: everything + fleet topology + audit log + per-model spend. Tabbed layout.

**Error messages adapt:**
- Alex: "Something went wrong with the meal suggestions. Try again in a moment."
- Riley: "meals_suggest failed: 502 from meals-api.wan0.cloud, upstream timeout after 30s. Last successful call: 2m ago."

### 1.7 Auditability Principle

The platform must be easy to understand and audit at every level:

- **Plugin code is readable**: A plugin is one `plugin.json` manifest + one `mod.ts` entry point. No build step, no transpilation, no hidden dependencies. Anyone can read a plugin's source and understand what it does.
- **Capabilities are explicit**: Every permission a plugin has was approved by the user. Approvals are persisted in `~/.config/yeet/approvals/` as JSON — auditable by any text editor.
- **Every tool call is logged**: The gateway logs every tool invocation with timestamp, tool name, args, and result. Deno's audit logging (`DENO_AUDIT_PERMISSIONS`) captures every permission check.
- **The scanner is deterministic**: `yeet verify` produces the same findings every time for the same plugin. No heuristics that sometimes pass, sometimes fail.
- **No hidden network calls**: Plugins can only reach hosts declared in their capabilities. Undeclared network access is denied at the Deno runtime level and logged.
- **History is queryable**: Conversation history, tool call logs, and capability approvals are all in SQLite — queryable with standard tools.
- **Dashboard shows provenance**: Every action in the dashboard shows which plugin performed it, which capability it used, and when it was approved.

---

## 2. Problem Statement

Three separate projects, three separate AI loops, fragmented interfaces:

| Project | What | Interface | AI Provider | Storage |
|---------|------|-----------|-------------|---------|
| shellcode-server | Personal AI assistant, personas, memory, news briefings | PalChat iOS via OpenAI-compat API | OpenRouter | CF KV |
| food | Meal planning, pantry tracking, fridge state, receipt parsing | iOS SwiftUI + HA dashboard + email | Workers AI | Notion |
| yeet | Coding agent orchestration across hardware fleet | Signal (gateway) + CLI | OpenRouter | SQLite + Nomad |

NemoClaw attempted to unify food and the gateway via a skill-based sandbox model (SKILL.md files executed via curl inside Landlock/seccomp sandboxes). It was fragile -- kernel-level sandboxing was complex to debug, skill execution was brittle, and it only worked over Signal.

### Goals

- **Single conversational entry point** for everything: meals, briefing, home control, coding tasks.
- **Multiple channels**: Signal, Home Assistant Assist, OpenAI-compatible HTTP (PalChat/iOS), webhooks.
- **Targeted apps keep working**: iOS meal planner and yeet CLI talk to backends directly; the AI layer is additive.
- **Sandboxing that works**: Deno permission policies for the gateway, gVisor for coding agent containers. No kernel gymnastics.
- **Multi-agent coding**: Multiple models (Gemini, Codex, Claude) collaborating on the same project via Composio Agent Orchestrator, dispatched by Nomad to fleet hardware (including GPU nodes).
- **Existing backends untouched**: CF Workers keep running. Nomad keeps running. The gateway is a new layer on top.

---

## 3. Architecture Overview

```
 You
  |
  |-- Signal ──────────────────────┐
  |-- HA Assist (voice/text) ──────┤
  |-- PalChat / iOS ───────────────┤  OpenAI-compat
  |-- Webhook ─────────────────────┤
                                   |
                     ┌─────────────▼──────────────┐
                     │      Unified Gateway        │
                     │  Deno runtime on homelab    │
                     │                             │
                     │  Channels → Agent Loop      │
                     │  Agent Loop → Tool Router   │
                     │  Tool Router → Backends     │
                     │                             │
                     │  SQLite: history, memory     │
                     │  Deno permissions: sandbox   │
                     └──────────┬──────────────────┘
                                │
          ┌─────────┬───────────┼───────────┬───────────┐
          │         │           │           │           │
   ┌──────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌────▼───┐ ┌────▼────┐
   │ Meals API│ │Briefing│ │  HA    │ │ Nomad  │ │Composio │
   │CF Worker │ │CF Work.│ │REST API│ │  API   │ │  AO     │
   │meals-api.│ │ai.wan0.│ │ :8123  │ │ :4646  │ │(on node)│
   │wan0.cloud│ │cloud   │ │        │ │        │ │         │
   └──────────┘ └────────┘ └────────┘ └────────┘ └─────────┘
```

Three layers:

1. **Unified Gateway** (Deno, runs on homelab) -- the single AI brain. Accepts messages from all channels, runs an agent loop with tool calling, persists conversation history and long-term memory. Replaces both shellcode-server's routing layer and the NemoClaw skill executor.

2. **Backend Services as Tools** -- each existing service is exposed as a tool definition. The gateway calls them via HTTP. No changes to the backends.

3. **Multi-Agent Coding** (Nomad + Composio AO) -- for coding tasks, Nomad dispatches a Composio Agent Orchestrator instance to a fleet node. Composio manages multiple agents (OpenCode with different models) in git worktrees. Results flow back as PRs and webhook notifications.

---

## 4. The Unified Gateway

Evolution of the existing yeet gateway (`~/yeet/gateway/`). The current gateway already implements: Signal channel, AI agent loop (OpenRouter), tool calling, SQLite conversation persistence, Nomad event polling, webhook server.

### What Changes

| Component | Current (yeet gateway) | Unified Gateway |
|-----------|----------------------|-----------------|
| Runtime | Node.js | Deno (for permission sandbox) |
| Channels | Signal only | Signal + OpenAI-compat HTTP + HA webhook + generic webhook |
| Tools | 7 yeet/Nomad tools | 7 yeet tools + 7 meal tools + 2 briefing tools + 3 HA tools + Composio tools |
| System prompt | Fleet operator only | Unified persona with context-aware routing |
| Memory | None (history only) | Long-term fact extraction (ported from shellcode-server) |
| Personas | None | Ported from shellcode-server (general, cyber, deep) |
| Config | `~/.config/yeet/gateway.json` | `~/.config/yeet/gateway.json` (extended) |

### Channel Implementations

**Signal** (existing): SSE listener on signal-cli REST API. Allowlist of phone numbers. No changes needed beyond porting to Deno's `fetch`.

**OpenAI-compatible HTTP**: New endpoint at `POST /v1/chat/completions`. Accepts the same request format PalChat currently sends to shellcode-server. Bearer token auth (existing key system from shellcode-server). Supports streaming (SSE). PalChat switches its base URL from `ai.wan0.cloud` to the gateway.

**Home Assistant**: New endpoint at `POST /ha/conversation`. HA's custom conversation agent integration sends user text, receives assistant text. Hooks into the Assist pipeline for voice: wake word -> STT -> gateway -> TTS.

**Webhook**: Existing webhook server (`POST /webhook`). Used by Composio AO to push job completion events, CI results, PR status. Also available for Nomad event forwarding.

### Agent Loop

The agent loop (`agent/loop.ts`) is unchanged in structure. It already implements the correct pattern:

1. Build messages array: system prompt + history + user message
2. Call OpenRouter with tool definitions
3. If tool calls returned, execute them, append results, loop (max 5 rounds)
4. Return final text response

The system prompt expands to cover all domains. Tool definitions expand to include all backend tools. The loop itself stays the same.

### Persona Routing

The gateway supports multiple personas via the `model` field in OpenAI-compat requests (same mechanism shellcode-server uses):

- `persona-general` -- default conversational assistant
- `persona-cyber` -- cybersecurity advisor
- `persona-deep` -- extended thinking (Claude Sonnet 4.6 via OpenRouter)
- `persona-meals` -- meal planning specialist (same base agent, meals tools prioritised in system prompt)

Signal messages default to `persona-general`. PalChat selects persona via the model dropdown. HA always uses `persona-general`.

### Memory

Ported from shellcode-server's `memory.ts`:

- After each conversation turn, a background task extracts facts using a cheap model (Haiku)
- Facts stored in SQLite per-persona namespace
- Facts injected into system prompt on subsequent turns
- Consolidation runs when facts exceed 100 items (dedup + merge)
- Memory shared across channels for the same user (Signal user = PalChat user = HA user)

---

## 5. Tool Definitions

All tools are HTTP calls to APIs the gateway controls. Defined as OpenAI-style function definitions (same format as the existing `tools.ts`).

### Meal Tools

Source: `meals-api.wan0.cloud` (CF Worker, unchanged)

| Tool | Method | Endpoint | What it does |
|------|--------|----------|-------------|
| `meals_suggest` | POST | `/suggest` | Get meal suggestions based on mood, portion mode, guests |
| `meals_fridge` | GET | `/fridge` | Current fridge state grouped by priority |
| `meals_storage` | GET | `/storage` | All zones (fridge/freezer/pantry) |
| `meals_ate` | POST | `/ate` | Log a meal, decrement servings |
| `meals_cooked` | POST | `/cooked` | Add prepared food to storage |
| `meals_pantry_add` | POST | `/pantry/add` | Add items to pantry |
| `meals_shopping` | POST | `/shopping` | Generate shopping list |
| `meals_move` | POST | `/move` | Move items between storage zones |

Auth: Bearer token via `MEALS_API_TOKEN` env var.

### Briefing Tools

Source: `ai.wan0.cloud` (CF Worker, unchanged -- only the briefing/memory endpoints are used)

| Tool | Method | Endpoint | What it does |
|------|--------|----------|-------------|
| `briefing_get` | GET | `/briefing` | Get latest or date-specific news briefing |
| `briefing_rate` | POST | `/v1/chat/completions` | Rate a story (via `/rate` command in chat) |

Auth: Bearer token via `BRIEFING_API_TOKEN` env var.

### Home Assistant Tools

Source: HA REST API at `homeassistant.local:8123`

| Tool | Method | Endpoint | What it does |
|------|--------|----------|-------------|
| `ha_get_states` | GET | `/api/states` or `/api/states/{entity_id}` | Read entity states (lights, sensors, climate) |
| `ha_call_service` | POST | `/api/services/{domain}/{service}` | Call HA services (turn on/off, set temp, trigger automation) |
| `ha_fire_event` | POST | `/api/events/{event_type}` | Fire custom events |

Auth: Long-lived access token via `HA_TOKEN` env var.

**Scoping**: The gateway does NOT get full HA admin access. The HA token is scoped to a specific user account with limited entity access. Sensitive entities (locks, alarms, cameras) are excluded from the token's permissions. The tool definitions include a hardcoded entity allowlist in the system prompt -- the LLM only knows about entities it's allowed to control.

### Yeet / Nomad Tools

Source: Nomad API at `10.42.10.1:4646` (existing, unchanged from current `tools.ts`)

| Tool | Endpoint | What it does |
|------|----------|-------------|
| `dispatch_task` | `POST /v1/job/run-coding-agent/dispatch` | Dispatch a coding agent task |
| `fleet_status` | `GET /v1/jobs` + `GET /v1/nodes` | Active jobs and fleet health |
| `read_logs` | `GET /v1/client/fs/logs` | Stream task output |
| `stop_job` | `DELETE /v1/job/:id` | Cancel a running task |
| `continue_session` | `POST /v1/job/run-coding-agent/dispatch` | Resume with session ID |
| `manage_node` | `POST /v1/node/:id/drain` | Drain/activate fleet nodes |
| `cost_report` | `GET /v1/vars` | Cost breakdown by project |

Auth: Nomad ACL token via `NOMAD_TOKEN` env var.

### Composio Tools

Source: Composio AO REST API on fleet nodes (port 3000)

| Tool | Method | Endpoint | What it does |
|------|--------|----------|-------------|
| `composio_spawn` | POST | `/api/spawn` | Start a new agent session |
| `composio_status` | GET | `/api/sessions` | List active agent sessions |
| `composio_send` | POST | `/api/sessions/:id/send` | Send message to running agent |
| `composio_kill` | POST | `/api/sessions/:id/kill` | Kill an agent session |
| `composio_merge` | POST | `/api/prs/:id/merge` | Merge a PR |

These are called indirectly -- when the gateway dispatches a coding task via Nomad, the Nomad job starts Composio AO on the target node. The gateway then interacts with Composio via its REST API for status updates and control. Composio pushes completion events back via the webhook notifier.

---

## 6. Multi-Agent Coding

For coding tasks that benefit from multiple agents working in parallel on the same project.

### Dispatch Flow

```
User: "implement auth system for peer6, use gemini for the API
       and claude for the tests"

Gateway agent loop:
  1. Parses intent: multi-agent coding task
  2. Calls dispatch_task tool with:
     project=peer6, prompt="implement auth system",
     mode=composio, agents=[{role: api, model: gemini}, {role: tests, model: claude}]

Nomad:
  3. Schedules Composio AO job onto a node with project=peer6
  4. Constraint: meta.project_peer6 = true
  5. If task specifies --needs gpu, adds device constraint

Fleet node (e.g., yeet-02):
  6. Composio AO starts, reads agent-orchestrator.yaml
  7. Orchestrator agent (OpenCode + Claude) decomposes task
  8. Spawns Worker A (OpenCode + Gemini) in worktree-a -> API code
  9. Spawns Worker B (OpenCode + Claude) in worktree-b -> test code
  10. Each worker: code -> commit -> push -> PR
  11. Lifecycle: auto-retry on CI failure, auto-address review comments
  12. Webhook notification -> gateway -> Signal: "auth PRs ready for review"
```

### Composio on Fleet Nodes

Each fleet node that runs multi-agent tasks has Composio AO installed via Ansible. The `agent-orchestrator.yaml` is templated per-node with:

- Available projects (from Nomad node metadata)
- Default agent: OpenCode (provider-agnostic)
- Orchestrator model: Claude (for task decomposition)
- Worker models: configurable per-dispatch (Gemini, Codex, Claude, DeepSeek)
- Webhook notifier: points back to gateway webhook endpoint

### GPU and Device Routing

Uses Nomad's native device plugin and constraint system:

```hcl
# Task that needs GPU
constraint {
  attribute = "${meta.project}"
  operator  = "set_contains"
  value     = "game"
}

device "nvidia/gpu" {
  count = 1
}
```

Nomad handles device fingerprinting, VRAM accounting, bin-packing, and preemption. A game build task requesting GPU only gets scheduled to nodes with available GPU resources. Existing workloads (Ollama, ComfyUI) declare their GPU resource usage -- Nomad won't over-commit.

The yeet CLI already supports `--needs <device>`. This extends to `--needs gpu` via Nomad device blocks rather than metadata constraints.

---

## 7. Data Flows

### Flow 1: "What's for dinner?" (Signal)

```
Signal message: "what's for dinner? something quick"
  |
  v
Gateway: SignalChannel.onMessage()
  |
  v
Agent loop: loads history (20 turns) + memory facts + system prompt
  |
  v
OpenRouter: LLM decides to call meals_suggest tool
  tool_call: meals_suggest({mood: "quick", portion_mode: "normal", guests: 0})
  |
  v
Gateway: executeTool("meals_suggest", ...)
  HTTP POST https://meals-api.wan0.cloud/suggest
  Authorization: Bearer $MEALS_API_TOKEN
  |
  v
CF Worker: queries Notion (fridge + pantry + history), runs LLM suggestion
  returns: {suggestions: [{name: "Butter Chicken", type: "reheat", urgency: "eat_today", ...}]}
  |
  v
Agent loop: LLM formats response from tool result
  "The butter chicken needs eating today -- 2 servings left, quick reheat.
   Otherwise there's leftover pasta in the fridge, good for a couple more days."
  |
  v
SignalChannel.send() -> signal-cli -> your phone
  |
  v (async, non-blocking)
Memory extraction: Haiku extracts facts ("user asked for quick meal on Saturday evening")
SQLite: save conversation turn + any new facts
```

**Security boundary**: Gateway can only reach `meals-api.wan0.cloud:443` (Deno `--allow-net`). The CF Worker validates the bearer token. Notion API key lives in the CF Worker's secrets, never in the gateway.

### Flow 2: "Turn off the living room lights" (HA Assist / Voice)

```
Voice: "Hey Nabu, turn off the living room lights"
  |
  v
HA Assist pipeline: wake word -> Whisper STT -> text
  |
  v
HA custom conversation agent: POST http://gateway:8787/ha/conversation
  {text: "turn off the living room lights", language: "en"}
  |
  v
Gateway: HAChannel receives message
  |
  v
Agent loop: LLM decides to call ha_call_service tool
  tool_call: ha_call_service({domain: "light", service: "turn_off",
             data: {entity_id: "light.living_room"}})
  |
  v
Gateway: executeTool("ha_call_service", ...)
  HTTP POST http://homeassistant.local:8123/api/services/light/turn_off
  Authorization: Bearer $HA_TOKEN
  Body: {entity_id: "light.living_room"}
  |
  v
HA: turns off the light, returns 200
  |
  v
Agent loop: LLM responds "Done, living room lights are off."
  |
  v
HA Assist pipeline: Piper TTS -> speaker
```

**Security boundary**: The HA token is a long-lived access token scoped to a dedicated "AI Agent" user in HA. This user has access to lights, climate, media, and sensors only. No access to locks, alarms, cameras, or admin functions. The gateway's Deno permissions restrict network access to `homeassistant.local:8123`. The system prompt includes an entity allowlist -- the LLM doesn't know about entities outside its scope.

### Flow 3: "Build the physics system for the game" (Coding Task)

```
Signal message: "build a basic physics system for the game,
                 use gemini for the engine code and claude for tests"
  |
  v
Gateway agent loop:
  LLM calls dispatch_task({
    project: "game",
    prompt: "implement basic physics system - gravity, collision detection, rigid body",
    mode: "composio",
    needs_device: "gpu"
  })
  |
  v
Gateway: executeTool("dispatch_task", ...)
  HTTP POST http://10.42.10.1:4646/v1/job/run-coding-agent/dispatch
  Nomad ACL token scoped to: job:dispatch, job:read, node:read
  |
  v
Nomad scheduler:
  - Constraint: meta.project_game = true
  - Device: nvidia/gpu available
  - Selects yeet-02 (homelab box, RTX 4090)
  |
  v
yeet-02: Nomad starts Composio AO via Docker (gVisor runtime)
  |
  v
Composio AO:
  1. Orchestrator agent (OpenCode + Claude Sonnet) reads task
  2. Decomposes into subtasks:
     - "Physics engine: gravity, collision detection" -> Worker A
     - "Rigid body dynamics + integration" -> Worker B
     - "Test suite for physics system" -> Worker C
  3. ao spawn: Worker A (OpenCode + Gemini) in worktree-a
     ao spawn: Worker B (OpenCode + Gemini) in worktree-b
     ao spawn: Worker C (OpenCode + Claude) in worktree-c
  |
  v
Workers execute in parallel:
  - Each in isolated git worktree
  - Each pushes to a feature branch
  - Each creates a draft PR via gh
  |
  v
Composio lifecycle:
  - CI runs on each PR
  - If CI fails: sends logs back to worker, worker fixes (max 2 retries)
  - If review requested: worker addresses comments
  - When all PRs green: webhook -> gateway
  |
  v
Gateway receives webhook:
  Looks up dispatch mapping (job_id -> Signal channel)
  |
  v
Signal: "Physics system PRs ready:
  - #42 Engine core (Gemini) -- CI green
  - #43 Rigid body (Gemini) -- CI green
  - #44 Test suite (Claude) -- CI green
  Merge them?"
  |
  v
User: "merge all"
  |
  v
Gateway: calls composio_merge for each PR
```

**Security boundary**: See [Section 7.4](#74-coding-agent-isolation) for the full sandboxing model.

### Flow 4: "What's the news?" (Briefing via PalChat)

```
PalChat (iOS): POST /v1/chat/completions
  model: "persona-general"
  messages: [{role: "user", content: "what's the news?"}]
  Authorization: Bearer sk-palchat-key
  |
  v
Gateway: OpenAIChannel receives request
  Validates bearer token (SHA-256 hash lookup in SQLite)
  |
  v
Agent loop: LLM recognises briefing request
  tool_call: briefing_get({})
  |
  v
Gateway: executeTool("briefing_get", ...)
  HTTP GET https://ai.wan0.cloud/briefing
  Authorization: Bearer $BRIEFING_API_TOKEN
  |
  v
CF Worker: returns latest briefing from KV
  {date: "2026-03-29", stories: [...], summary: "..."}
  |
  v
Agent loop: LLM formats briefing conversationally
  Streams response back via SSE (OpenAI streaming format)
  |
  v
PalChat: renders streamed response
```

### Flow 5: Cross-Domain (Signal)

```
Signal: "I cooked a big batch of bolognese, 8 servings.
         Also, what's running on the fleet?"
  |
  v
Agent loop: LLM makes two tool calls in one round:
  1. meals_cooked({recipe_name: "Bolognese", servings: 8,
                   actual_servings_per_eat: 2, best_before_days: 4})
  2. fleet_status({filter: "all"})
  |
  v
Gateway: executes both tools (sequential, same round):
  1. POST meals-api.wan0.cloud/cooked -> {status: "created", iain_meals: 4}
  2. GET 10.42.10.1:4646/v1/jobs + /v1/nodes -> {jobs: [...], runners: [...]}
  |
  v
Agent loop: LLM combines results:
  "Logged the bolognese -- 4 meals in the fridge, marked eat this week.

   Fleet: 2 jobs running (peer6 review on yeet-01, game build on yeet-02).
   All 3 nodes healthy."
```

---

## 8. Security Model

### 8.1 Gateway Sandbox (Deno Permissions)

The gateway runs under Deno with a declarative permission policy in `deno.json`:

```jsonc
{
  "permissions": {
    "gateway": {
      "read": ["./data", "./config", "./SYSTEM.md"],
      "write": ["./data"],
      "net": [
        "meals-api.wan0.cloud:443",
        "ai.wan0.cloud:443",
        "homeassistant.local:8123",
        "10.42.10.1:4646",
        "openrouter.ai:443",
        "127.0.0.1:7583"
      ],
      "env": [
        "OPENROUTER_API_KEY",
        "MEALS_API_TOKEN",
        "BRIEFING_API_TOKEN",
        "HA_TOKEN",
        "NOMAD_TOKEN",
        "SIGNAL_ACCOUNT",
        "SIGNAL_CLI_URL",
        "GATEWAY_DATA_DIR",
        "WEBHOOK_TOKEN"
      ],
      "run": false,
      "ffi": false,
      "sys": false
    }
  }
}
```

Run with: `deno run -P=gateway src/index.ts`

**What this prevents:**

| Threat | Mitigation |
|--------|-----------|
| Gateway shells out to run arbitrary commands | `run: false` -- subprocess creation denied at runtime level |
| Gateway reads files outside its data dir | `read` restricted to `./data`, `./config`, `./SYSTEM.md` |
| Gateway writes anywhere on filesystem | `write` restricted to `./data` only |
| Gateway reaches unexpected network hosts | `net` allowlist -- only your APIs, OpenRouter, and signal-cli |
| Gateway accesses sensitive env vars | `env` allowlist -- only named vars accessible |
| LLM hallucinates a tool that deletes files | No filesystem tool exists. Tools are HTTP-only. Even if the LLM fabricated a tool name, `executeTool()` has a hardcoded switch statement that returns "Unknown tool" for anything not defined |
| Prompt injection via tool results | Tool results are inserted as `tool` role messages. The LLM treats them as data, not instructions. Additionally, tool results are truncated to prevent context stuffing |

**Audit logging**: `DENO_AUDIT_PERMISSIONS=./data/audit.jsonl` logs every permission check. Review periodically or alert on denied attempts.

**Permission broker** (optional, future): For dynamic policy decisions, Deno supports delegating all permission checks to an external broker process via `DENO_PERMISSION_BROKER_PATH`. This could enforce per-tool or per-conversation policies managed by a central policy engine.

### 8.2 Filesystem Protection

**The gateway cannot delete files.** Here's why, layer by layer:

1. **No filesystem tools**: The gateway's tool definitions are all HTTP calls. There is no tool that touches the local filesystem. The LLM cannot request file operations because no such tool exists.

2. **No shell access**: `run: false` in Deno permissions. The gateway cannot spawn subprocesses. Even if a tool tried to call `Deno.Command()`, it would throw `PermissionDenied`.

3. **Write-restricted**: Deno only allows writes to `./data/` (the SQLite database and audit logs). All other paths are denied at the runtime level.

4. **Read-restricted**: The gateway can only read its own config, system prompt, and data directory. It cannot read your home directory, project repos, or system files.

5. **No FFI**: Foreign function interface disabled. Cannot load native libraries to bypass Deno's sandbox.

**For coding agents** (which DO need filesystem access), see Section 7.4.

### 8.3 GitHub Account Scoping

Concern: giving AI agents access to your personal GitHub account.

**Recommendation: Dedicated bot account.**

Create a GitHub account (e.g., `wan0-bot`) with:

- **Fine-grained personal access tokens** scoped to specific repos only
- **Repository permissions**: Contents (read/write), Pull Requests (read/write), Issues (read). No admin, no settings, no secrets access.
- **No org-level permissions**: The bot account is a collaborator on specific repos, not an org member.
- **Token rotation**: Tokens stored in Nomad encrypted variables, rotated via Ansible.

The token flows:

```
Nomad dispatch -> Composio AO -> OpenCode agent -> gh CLI
                                                    |
                                                    uses GH_TOKEN from
                                                    Nomad encrypted variable
                                                    scoped to wan0-bot account
```

**What the bot account CAN do**: Push branches, create PRs, comment on PRs, read issues. On repos you've explicitly granted access to.

**What it CANNOT do**: Delete repos, modify settings, access secrets, push to protected branches (branch protection rules enforce PR-only merges), access repos not in its collaborator list.

**Branch protection on all repos**:
- `main` requires PR with at least 1 approval (you)
- No force push
- No branch deletion by bot account
- Status checks required before merge

This means even if an agent goes completely off the rails, the worst it can do is create junk PRs on repos you've allowed. It cannot merge to main, delete branches, or touch repos outside its scope.

### 8.4 Coding Agent Isolation

Coding agents execute arbitrary code. This is the highest-risk component. Defence in depth:

**Layer 1: Nomad Job Isolation**

Each coding task runs as a Nomad batch job. Nomad provides:
- **Resource limits**: CPU, memory, disk capped per job
- **Job ACLs**: The gateway's Nomad token can only dispatch and read jobs, not modify the Nomad cluster itself
- **Allocation lifecycle**: Jobs have a `max_client_disconnect` and `kill_timeout`. Runaway tasks get killed.

**Layer 2: gVisor Container Runtime**

Coding agent containers run under gVisor (`runsc`) instead of the default `runc`:

```hcl
task "agent" {
  driver = "docker"
  config {
    runtime = "runsc"
  }
}
```

gVisor intercepts all syscalls in userspace. The agent process thinks it's talking to a Linux kernel but is actually sandboxed. This prevents:
- Container escape exploits
- Direct kernel syscall abuse
- `/proc` and `/sys` information leaks

**Layer 3: Filesystem Mount Restrictions**

The Nomad job template bind-mounts only the project workspace:

```hcl
config {
  volumes = [
    "/opt/yeet/workspaces/${meta.project}:/workspace:rw"
  ]
}
```

The agent can only see and modify `/workspace`. It cannot access:
- Other project workspaces
- The host filesystem
- Nomad configuration
- Other containers' filesystems

**Layer 4: Network Policy**

The gVisor container has restricted network access:
- Outbound: GitHub API, package registries (npm, pip, cargo), OpenRouter (for the agent's LLM calls)
- Denied: local network (no access to Nomad API, HA, signal-cli, other services on the Tailscale mesh)
- Cloud metadata endpoints blocked (169.254.169.254)

Implemented via Docker network policy or gVisor's network stack configuration.

**Layer 5: Git Worktree Isolation**

Composio AO creates a separate git worktree per agent worker. Workers cannot see each other's changes until merge. If an agent corrupts its worktree, only that worktree is affected -- the main repo and other worktrees are untouched.

**Layer 6: GitHub Branch Protection**

Even after all the above, the agent can only create PRs. It cannot merge to main without your approval. This is the final human gate.

### 8.5 API Token Isolation

No token has broader access than it needs:

| Token | Scope | Stored In |
|-------|-------|-----------|
| `OPENROUTER_API_KEY` | OpenRouter API only | Deno env allowlist |
| `MEALS_API_TOKEN` | meals-api.wan0.cloud bearer auth | Deno env allowlist |
| `BRIEFING_API_TOKEN` | ai.wan0.cloud bearer auth | Deno env allowlist |
| `HA_TOKEN` | HA REST API, scoped to "AI Agent" user (no locks/alarms/cameras) | Deno env allowlist |
| `NOMAD_TOKEN` | Nomad ACL: job:dispatch, job:read, node:read only | Deno env allowlist |
| `GH_TOKEN` (wan0-bot) | Fine-grained PAT: specific repos, contents + PRs only | Nomad encrypted variables |
| `WEBHOOK_TOKEN` | Validates inbound webhooks to gateway | Deno env allowlist |

The gateway process cannot access any env var not in the allowlist. `Deno.env.get("GH_TOKEN")` would return `undefined` because it's not in the gateway's `env` permission list -- that token only exists inside Nomad-dispatched containers.

### 8.6 Signal Channel Auth

The existing `signal_allowed_numbers` allowlist in `gateway.json` restricts who can send messages. Messages from unknown numbers are dropped with a log entry. No response is sent (don't confirm the gateway exists to unauthorized senders).

### 8.7 Threat Summary

| Threat | Mitigated By |
|--------|-------------|
| LLM deletes files on host | No filesystem tools; Deno `write` restricted to `./data`; `run: false` |
| LLM accesses wrong GitHub repos | Bot account with fine-grained PAT, repo-level collaborator access |
| LLM merges bad code to main | Branch protection: PR required, 1 approval, status checks |
| LLM controls HA locks/alarms | HA token scoped to "AI Agent" user, no security entity access |
| Coding agent escapes container | gVisor userspace kernel, no direct host syscalls |
| Coding agent accesses other projects | Bind-mount only target project workspace, no host filesystem |
| Coding agent reaches internal services | Network policy: only GitHub + registries + OpenRouter |
| Prompt injection via tool results | Tool results are `tool` role messages, not system prompts; truncated |
| Unauthorized Signal messages | Allowlist of phone numbers, unknown numbers silently dropped |
| Gateway process compromised | Deno sandbox: no shell, no FFI, restricted net/read/write/env |
| Token leakage | Each token scoped to one service; env allowlist prevents cross-access |

---

## 9. Plugin System

The gateway must be extensible. New tools, channels, and skills should be addable without modifying core gateway code. Plugins must be signed to prevent untrusted code execution.

### 9.1 Plugin Types

| Type | What it adds | Interface | Example |
|------|-------------|-----------|---------|
| **Tool** | New tool the LLM can call | HTTP endpoint + tool definition JSON | A weather tool, a calendar tool, a Jira tool |
| **Channel** | New input/output channel | `Channel` interface (onMessage, send, start, stop) | Telegram, Matrix, Discord, iMessage |
| **Skill** | A bundled persona + tools + system prompt for a domain | `SKILL.md` manifest (Outworked-compatible format) | "Home electrician" skill with HA tools + electrical knowledge |
| **Runtime** | New agent runtime for Composio | `Runtime` plugin interface | A custom agent CLI, a WASM-based agent |
| **Notifier** | New notification sink | `Notifier` interface (send) | Email, ntfy, Pushover, Slack |

### 9.2 Plugin Manifest

Each plugin is a directory with a `plugin.json` manifest:

```jsonc
{
  "name": "weather",
  "version": "1.0.0",
  "type": "tool",
  "description": "Weather forecasts via Open-Meteo API",
  "author": "wan0",
  "homepage": "https://github.com/wan0/gateway-plugin-weather",

  // What the plugin needs from the gateway
  "permissions": {
    "net": ["api.open-meteo.com:443"],
    "env": ["WEATHER_LATITUDE", "WEATHER_LONGITUDE"],
    "read": false,
    "write": false,
    "run": false
  },

  // Entry point (TypeScript/JavaScript)
  "main": "mod.ts",

  // Signature (see 8.4)
  "signature": "sha256:abc123..."
}
```

**Key principle**: plugins declare their own permissions. The gateway merges plugin permissions into the Deno permission set at load time. A plugin that requests `run: true` would be flagged and rejected unless explicitly trusted.

### 9.3 Tool Plugin Interface

A tool plugin exports:

```typescript
// mod.ts
import type { ToolPlugin } from "@wan0/gateway-sdk";

export default {
  // OpenAI-style tool definition (same format as existing tools.ts)
  definition: {
    type: "function",
    function: {
      name: "weather_forecast",
      description: "Get weather forecast for a location",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Forecast days (1-7)" },
        },
      },
    },
  },

  // Execution handler
  async execute(args: Record<string, unknown>): Promise<string> {
    const days = Number(args.days ?? 3);
    const lat = Deno.env.get("WEATHER_LATITUDE");
    const lon = Deno.env.get("WEATHER_LONGITUDE");
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&forecast_days=${days}`
    );
    return await res.text();
  },
} satisfies ToolPlugin;
```

The gateway loads the plugin, registers the tool definition in the LLM's tool array, and routes `executeTool("weather_forecast", ...)` to the plugin's `execute()` function.

**Sandboxing**: The plugin runs inside the same Deno process as the gateway. Its permissions are the union of the gateway's base permissions and the plugin's declared permissions. A plugin cannot exceed its declared permissions because Deno enforces them at runtime. If a plugin declares `"net": ["api.open-meteo.com:443"]` but tries to fetch `evil.com`, Deno throws `PermissionDenied`.

### 9.4 Plugin Signing

Plugins are signed to verify authorship and integrity. Unsigned or tampered plugins are rejected at load time.

**Signing flow:**

```
Developer:
  1. Write plugin code + plugin.json
  2. deno run gateway-cli sign ./my-plugin/
     - Computes SHA-256 hash of all plugin files (deterministic, sorted)
     - Signs the hash with the developer's Ed25519 private key
     - Writes signature to plugin.json "signature" field
     - Writes public key fingerprint to plugin.json "signer" field
  3. Publish (git repo, tarball, registry)

Gateway (load time):
  1. Read plugin.json
  2. Check "signer" fingerprint against trusted signers list
     (~/.config/yeet/trusted-signers.json)
  3. Recompute SHA-256 hash of all plugin files
  4. Verify signature against signer's public key
  5. If valid: load plugin, merge permissions
  6. If invalid: reject, log warning, do not load
```

**Trusted signers**: A list of Ed25519 public keys you trust. Your own key is always trusted. Adding a third-party signer is an explicit opt-in:

```jsonc
// ~/.config/yeet/trusted-signers.json
{
  "signers": [
    {
      "name": "wan0",
      "fingerprint": "sha256:...",
      "public_key": "ed25519:...",
      "trust": "full"          // load any plugin from this signer
    },
    {
      "name": "community-user",
      "fingerprint": "sha256:...",
      "public_key": "ed25519:...",
      "trust": "prompt"        // ask before loading, show permissions
    }
  ]
}
```

**Trust levels:**
- `full` -- load silently (your own plugins)
- `prompt` -- show the plugin's requested permissions and ask for confirmation before loading
- `audit` -- load but log every permission check from this plugin to a separate audit file

### 9.5 Plugin Discovery and Installation

```bash
# Install from git
gateway plugin add https://github.com/wan0/gateway-plugin-weather

# Install from local path
gateway plugin add ./my-plugin/

# List installed plugins
gateway plugin list

# Remove
gateway plugin remove weather

# Verify signature without installing
gateway plugin verify ./my-plugin/
```

Plugins are stored in `~/.config/yeet/plugins/`. Each plugin gets its own directory. The gateway scans this directory at startup and loads all valid, signed plugins.

### 9.6 SKILL.md Compatibility

Skill-type plugins use the `SKILL.md` format (compatible with Outworked and NemoClaw):

```markdown
---
name: electrician
description: Home electrical assistant with HA integration
version: 1.0.0
metadata: {"emoji": "⚡", "requires": {"env": ["HA_TOKEN"]}}
---

# Home Electrician

You are an electrical systems assistant for a home in Canberra, Australia.
You help diagnose electrical issues, monitor power usage, and control
circuits via Home Assistant.

## Tools Available

You have access to ha_get_states and ha_call_service tools.
Focus on entities in the electrical domain: switches, sensors
with "power" or "energy" in their name, and automation triggers
for load shedding.

## Safety Rules

- NEVER suggest the user work on live circuits
- ALWAYS recommend a licensed electrician for any wiring work
- Monitor-only for high-voltage entities
```

The gateway loads the SKILL.md as a persona variant. When the user activates the skill (via command, keyword, or explicit persona selection), the SKILL.md content is injected into the system prompt alongside the available tools. The `requires` field in metadata maps to the plugin permission model.

### 9.7 MCP Server Plugins

Tool plugins can also be MCP servers. The gateway acts as an MCP client, connecting to the server via stdio or HTTP transport:

```jsonc
{
  "name": "linear-mcp",
  "version": "1.0.0",
  "type": "tool",
  "description": "Linear issue tracking via MCP",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@linear/mcp-server"],
    "env": {
      "LINEAR_API_KEY": "${LINEAR_API_KEY}"
    }
  },
  "permissions": {
    "net": ["api.linear.app:443"],
    "env": ["LINEAR_API_KEY"],
    "run": ["npx"]
  },
  "signature": "sha256:..."
}
```

The gateway spawns the MCP server process, discovers its tools via `tools/list`, and registers them in the LLM's tool array. Tool calls are forwarded to the MCP server via `tools/call`. The server process inherits only the permissions declared in the plugin manifest.

**Note**: MCP server plugins require `run` permission (to spawn the server process). This is flagged in the signing/trust flow -- plugins requesting `run` get extra scrutiny.

### 9.8 Plugin Permissions Escalation Protection

A plugin cannot escalate beyond its declared permissions:

1. **Declaration is a ceiling**: `plugin.json` permissions are the maximum the plugin can use. Deno enforces this at runtime.
2. **Gateway permissions are a ceiling**: Even if a plugin declares `"net": true`, the gateway only grants the intersection of the plugin's request and the gateway's own permission policy.
3. **Dangerous permissions are flagged**: `run`, `ffi`, `write` (to paths outside `./data`) trigger a warning at load time and require `trust: "full"` or explicit confirmation.
4. **Runtime enforcement**: Deno's permission system is the final arbiter. Even if a bug in the plugin loader grants too much, Deno itself blocks unauthorized access.

## 10. Dashboard

A web dashboard that aggregates status from the gateway, Nomad fleet, and Composio AO instances. Accessible on the Tailscale mesh from any device (laptop, phone, HA tablet).

### Features

- **Active agents**: Cards showing each running agent (name, model, project, status, elapsed time)
- **Log streaming**: Live terminal output per agent (xterm.js or similar)
- **PR status**: Table of open PRs from agent work, CI status, review state
- **Merge controls**: One-click merge for approved+green PRs
- **Fleet overview**: Node health, resource usage, GPU allocation
- **Cost tracking**: Spend by project/model/day (from Nomad variables + Composio)
- **Conversation log**: Recent gateway conversations (optional, privacy-sensitive)

### Tech Stack

- **Framework**: Next.js (same as Composio AO's dashboard -- potential to extend it)
- **Real-time**: SSE from gateway webhook endpoint + Composio AO `/api/events`
- **Aggregation**: Gateway exposes `/api/dashboard` endpoint that combines:
  - Nomad job/node status (already available via `fleet_status` tool)
  - Composio session status (via REST API to each AO instance)
  - Cost data (from Nomad variables)
- **Auth**: Tailscale-only access (no public exposure). Optional: Tailscale funnel with SSO.

### Visual Office (Future)

Outworked-style pixel art office as an optional dashboard skin. Agents visualised as characters at desks, status reflected in animations. Not a priority -- functional dashboard first, visual skin later.

---

## 11. Migration Plan

### Phase 1: Gateway Foundation

Port the yeet gateway from Node.js to Deno. Add Deno permission policy. Add meals tools (HTTP calls to meals-api.wan0.cloud). Test via Signal: "what's for dinner?" works alongside "run pagination on peer6".

**Deliverables**: Deno gateway with Signal channel + yeet tools + meal tools. `deno.json` permission policy.

**Validates**: Deno sandbox works, meals tools work, existing yeet functionality preserved.

### Phase 2: All Channels

Add OpenAI-compatible HTTP endpoint. Add HA conversation webhook endpoint. Port shellcode-server's persona system and memory extraction. Switch PalChat to point at gateway.

**Deliverables**: PalChat works via gateway. HA voice commands work. Personas and memory functional.

**Validates**: Multi-channel input works. Can retire shellcode-server's routing layer (keep the briefing cron worker).

### Phase 3: HA Tools + Briefing

Add HA tools (get_states, call_service). Add briefing tools. Create dedicated HA user with scoped token. Wire up HA custom conversation agent integration.

**Deliverables**: "Turn off the lights" works from Signal and HA voice. "What's the news?" works from all channels.

**Validates**: Cross-domain conversations work. HA integration is safe.

### Phase 4: Multi-Agent Coding

Install Composio AO on fleet nodes via Ansible. Create Nomad job template for Composio dispatch. Configure OpenCode as the agent runtime with per-worker model selection. Add Composio tools to gateway. Set up webhook notifications.

**Deliverables**: "Implement auth for peer6 with gemini and claude" dispatches multi-agent task. PRs appear, webhook notifications arrive on Signal.

**Validates**: Nomad -> Composio -> OpenCode multi-model pipeline works end-to-end.

### Phase 5: Coding Agent Sandboxing

Switch agent containers from `runc` to `runsc` (gVisor). Configure network policies. Set up GitHub bot account with fine-grained tokens. Add branch protection to all repos.

**Deliverables**: Coding agents run in gVisor containers with restricted network. GitHub access via bot account only.

**Validates**: Agents cannot escape container, cannot reach internal services, cannot push to main.

### Phase 6: Dashboard

Build web dashboard. Aggregate Nomad + Composio + gateway data. Deploy on homelab, accessible via Tailscale.

**Deliverables**: Web UI showing active agents, PRs, fleet status, costs.

### Phase 7: Polish

- Deno permission broker for dynamic policies
- Syrin CLI for MCP tool validation in CI
- Budget tracking and alerts
- Outworked-style visual office skin (optional)
- Additional channels (Telegram, Matrix -- if needed)
