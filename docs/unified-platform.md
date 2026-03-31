---
layout: doc
title: Sharkcage Documentation
description: Trust layer for OpenClaw — kernel-level sandboxing, capability model, and AI-driven ecosystem compatibility.
---

# Sharkcage Documentation

A trust and sandboxing layer for OpenClaw. Every AI-directed tool call runs through kernel-level sandboxing via `srt`. Every skill runs in its own kernel-enforced sandbox. Capabilities approved once at install.

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash
sc init
sc start
```

---

## Documentation

### [Architecture](architecture)
How sharkcage wraps OpenClaw with kernel-level sandboxing. The supervisor model, data flow, integration points, and repo structure.

[![Architecture diagram](https://excalidraw.com/og/a4eFKV7D6RKHhztFJWEdX)](architecture)

### [Use Cases](use-cases)
Personas and the permission problem sharkcage solves — from home users to platform engineers.

### [Data Flows](data-flows)
Step-by-step traces of tool calls through the sandboxing pipeline. Four scenarios: meals, home automation, skill install, and malicious skill blocked.

[![Data flow diagram](https://excalidraw.com/og/Pjay1ZaXKluwDfHuEIOEa)](data-flows)

### [Capabilities](capabilities)
The capability model, 19 named capabilities across 7 categories, AI-driven inference for existing skills, and the approval workflow.

### [Security](security)
Sandbox enforcement via ASRT, skill scanning and Ed25519 signing, 6-layer defence in depth, threat matrix, and remaining gaps.

### [Deployment](deployment)
Installation, dedicated user setup, systemd service, directory layout, and the implementation roadmap.

[![Deployment diagram](https://excalidraw.com/og/sr0_CC3Ns6EJPqYeRQP5r)](deployment)

---

## Diagrams

Interactive versions (click to edit):

- [Architecture Overview](https://excalidraw.com/#json=a4eFKV7D6RKHhztFJWEdX,Ky4IDEVVijaDlFRp-0wOgw)
- [Tool Call Data Flow](https://excalidraw.com/#json=Pjay1ZaXKluwDfHuEIOEa,xDGbxFNyY4N4sje81uApWA)
- [Install & Deployment](https://excalidraw.com/#json=sr0_CC3Ns6EJPqYeRQP5r,76H21m5Tzooy77sIi9lfJg)
