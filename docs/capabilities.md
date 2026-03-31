---
layout: doc
title: Capabilities
description: The capability model, AI inference, and approval workflow
---

# Capabilities

## Capability Model

### Named Capabilities

19 capabilities across 7 categories:

| Category | Capabilities | Risk |
|----------|-------------|------|
| Network | `network.external`, `network.internal` | medium |
| Home | `home.read`, `home.control`, `home.automation` | low-medium |
| Data | `data.meals`, `data.history`, `data.memory`, `data.preferences` | low-medium |
| Notify | `notify.signal`, `notify.push` | low-high |
| System | `system.files.read`, `system.files.write`, `system.exec`, `system.env` | high-dangerous |
| Cost | `cost.api` | medium |

### Manifest Format

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

### Scope Narrows Risk

`network.external` with `scope: ["meals-api.wan0.cloud"]` is fundamentally different from `network.external` with no scope. Unscoped dangerous capabilities are flagged loudly during scanning.

### Approval Persistence

Stored in `/opt/sharkcage/var/approvals/{skill-name}.json`. Version-pinned. New version with new capabilities → user prompted for new ones only.

### Approval UX Adapts to Persona

- **Alex**: "Meal Planner wants to see your fridge. Allow?"
- **Sam**: "Meal Planner requests: Meal Data (low), External Network to meals-api.wan0.cloud (medium). Allow?"
- **Jordan**: reviews manifest directly
- **Riley**: `sc verify --strict` in CI

---

## AI Capability Inference

Existing OpenClaw skills and ClawHub skills don't have capability manifests. Sharkcage generates them automatically.

### How It Works

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

### User Can Edit Inferred Manifests

If the AI over-infers (requests too much) or under-infers (misses something), the user can edit:

```bash
sc skill capabilities edit some-skill
# Opens manifest in editor
# Changes are validated by scanner
# Re-signed if user has signing key
```

### Author Manifests Override AI

If a skill author provides a `plugin.json` with capabilities, the AI inference is skipped. Author manifests are more accurate and carry the author's signature.

### Inference Improves Over Time

The AI sees: skill code + what actually got blocked at runtime (from audit logs). On skill update, the AI can refine the manifest based on observed behaviour.
