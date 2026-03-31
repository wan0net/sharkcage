---
layout: doc
title: Use Cases
description: Personas and the permission problem sharkcage solves
---

# Use Cases

## Personas

### Home User — "Alex"
Non-technical. Chat assistant via HA voice or Signal. "What's for dinner?" / "Turn off the lights." Installs from curated list. Capability approval in plain language.

### Power User — "Sam"
Runs a homelab. Installs community skills. Reviews scoped capabilities. May write simple SKILL.md files.

### Developer — "Jordan"
Software engineer. Uses `sc` CLI + coding agents. Writes and signs skills. 1-2 nodes.

### Platform Engineer — "Riley"
Multi-project, multi-model, multi-agent. CI scanning. Audit logs. Cost tracking.

### Feature Matrix

| Feature | Alex | Sam | Jordan | Riley |
|---------|:----:|:---:|:------:|:-----:|
| Chat (Signal/HA/Telegram/etc.) | Y | Y | Y | Y |
| Capability approval | plain language | scoped | manifest-level | CI strict |
| Write skills | - | Y | Y | Y |
| Sign/publish skills | - | - | Y | Y |
| Multi-agent coding | - | - | Y | Y |
| Audit logs | - | - | - | Y |

### Auditability Principle

- Skill code is readable: one SKILL.md, no build step
- Capabilities are explicit: approved by user, persisted as JSON
- Every tool call logged: timestamp, tool, args, result, skill, capability
- Scanner is deterministic: same findings every time
- No hidden network calls: kernel-enforced per-skill domain allowlists
- History is queryable: all data in audit.jsonl
- Dashboard shows provenance: which skill, which capability, when approved

---

## The Permission Problem

| Approach | Prompts | Security | UX |
|----------|---------|----------|----|
| Claude Code default | Every action | Good | Unusable — prompt fatigue |
| `--dangerously-skip-permissions` | Never | None | Where users end up |
| **Sharkcage** | Once at install | Kernel-enforced | Approve once, enforce always |
