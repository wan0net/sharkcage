---
name: dispatch
description: Dispatch a coding task to the yeet fleet
---

# Dispatch Coding Task

Dispatch a coding agent task to a worker node.

## When to use

User wants to run, implement, fix, review, test, or build something on a project.

## API

POST http://yeet-01.tailnet:4646/v1/job/run-coding-agent/dispatch

Request body:
```json
{
  "Payload": "<base64-encoded prompt>",
  "Meta": {
    "project": "<project name>",
    "runtime": "opencode",
    "model": "anthropic/claude-sonnet-4",
    "mode": "implement"
  }
}
```

## Defaults

- runtime: opencode
- model: anthropic/claude-sonnet-4
- mode: implement (use "review" for reviews, "test" for tests, "analyze" for analysis)

## Required

- project: must match a cloned repo on a worker (e.g., "peer6", "login2")
- prompt: the task description, base64-encoded in Payload

## Optional Meta

- budget: cost cap in USD (e.g., "0.50")
- session_id: resume a previous session
- needs_device: require a USB device (e.g., "yubikey")

## Response

Returns DispatchedJobID. Always tell the user the job ID and that you'll notify them when it completes.
