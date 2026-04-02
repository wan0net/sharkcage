---
layout: doc
title: Deployment
description: Installation, configuration, and running sharkcage in production
---

# Deployment

## Installation

### Quick Start
```bash
curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash
sc init
sc start
```

### Server Quick Start
```bash
OPENROUTER_API_KEY=your-key-here \
  curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | \
  bash -s -- --configure --mode full --service-user openclaw
```

### What install.sh does
1. Checks prerequisites (Node.js 22+, npm, git)
2. Clones the requested git ref to `/opt/sharkcage` (`main` by default, `latest-tag` optionally)
3. Installs locked dependencies from `package-lock.json`
4. Copies a local runtime `node` binary into `/opt/sharkcage/bin/node`
5. Builds the plugin
6. Generates the `bin/sc` CLI wrapper
7. Writes the install manifest to `etc/install.json`
8. Optionally runs `sc init --non-interactive` when `--configure` is passed

To pin a specific ref during install:

```bash
curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash -s -- --ref v1.2.0
```

### Directory Layout
```
/opt/sharkcage/
  bin/sc                    # CLI entry point
  node_modules/.bin/        # openclaw, srt, tsx
  src/                      # TypeScript source (run via tsx)
  dist/sharkcage/           # compiled plugin
  etc/
    install.json            # install manifest
    gateway.json            # runtime config
  var/
    supervisor.sock         # IPC socket
    sharkcage.pid           # PID file
    audit.jsonl             # audit log
    sessions/               # per-session srt policies
    plugins/                # installed skills
    approvals/              # capability approvals
```

### Dedicated User (Linux servers)
`sc init` offers to create a dedicated `openclaw` system user whose home is `/opt/sharkcage`. The entire install directory is owned by this user. `sc start` re-executes as the dedicated user via sudo.

### Host Compatibility
`sc start` now runs a real sandbox smoke test before startup completes. If the host can resolve `srt` but cannot actually launch sandboxed workers, Sharkcage fails closed with the underlying host error instead of waiting for the first skill invocation to explode.

On Ubuntu 24.04+, a common blocker is:

```bash
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
```

If that returns `1`, AppArmor is still restricting the unprivileged namespace path `bubblewrap` needs. The installer now warns about this explicitly, but it does not change the sysctl automatically because that is a host policy decision.

Temporary fix:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

Persistent fix:

```bash
printf 'kernel.apparmor_restrict_unprivileged_userns=0\n' | \
  sudo tee /etc/sysctl.d/99-sharkcage-userns.conf
sudo sysctl --system
```

### Systemd Service
`sc init` can install a systemd service that runs sharkcage on boot:
```bash
systemctl status sharkcage
systemctl stop sharkcage
```

---

## Implementation Plan

### Immediate Priority: Test Harness + Trust Guarantees

Before expanding features, the roadmap should harden the promises Sharkcage already makes around auditability, security, and usability. The first milestone is a real automated test harness with these priorities:

1. Path consistency tests
   Prove the plugin, supervisor, CLI, and dashboard all read and write the same approvals and audit locations.
2. Approval flow tests
   Prove an unapproved skill blocks, an approved skill runs, and runtime scope expansion updates the correct approval record.
3. Audit behavior tests
   Prove allowed, blocked, and error cases all produce consistent audit entries that operators can rely on.
4. Sandbox availability tests
   Prove startup fails closed, or enters an explicit insecure mode, when `srt` is unavailable.

This test-first phase should land before broadening the roadmap further because it gives every later security or UX claim an executable safety net.

### Phase 1: Supervisor + Sandbox — DONE

- [x] `sharkcage-sdk`: capability types, ASRT config mapper, scanning, testing
- [x] `sharkcage-supervisor`: unix socket IPC, approval store, ASRT sandbox spawning, audit log
- [x] `sharkcage-openclaw-plugin`: tool.before/after interceptors, IPC client, skill mapping
- [x] `sharkcage-cli`: init wizard (persona-driven), verify scanner
- [x] `sharkcage-skill-meals`: 8 tools with capability manifest
- [ ] Test: manually create approval, supervisor spawns sandboxed process

### Phase 2: End-to-End Integration

- [ ] Add `npm test` and a first-party test runner for supervisor, plugin, CLI, and dashboard integration flows
- [ ] Test priority 1: path consistency across approvals, deny lists, audit logs, and dashboard/API reads
- [ ] Test priority 2: approval lifecycle from first block through approval update and re-execution
- [ ] Test priority 3: audit lifecycle for allowed, blocked, and errored tool calls
- [ ] Test priority 4: startup behavior when `srt` is missing or sandbox backend registration fails
- [ ] `sc start` command: starts supervisor + OpenClaw gateway (unsandboxed) + sandbox backend
- [ ] Install OpenClaw locally, register sharkcage plugin
- [ ] Test: Signal message → OpenClaw → sharkcage interceptor → supervisor → sandboxed skill → result
- [ ] Test: skill tries to reach unapproved host → ASRT blocks → audit log entry

### Phase 3: Homelab Skills

- [ ] Refactor `sharkcage-skill-meals` for out-of-process IPC model (stdin/stdout JSON)
- [ ] `sharkcage-skill-ha`: Home Assistant (state reading, service calls, automations)
- [ ] `sharkcage-skill-briefing`: news digest from existing CF Worker
- [ ] Test: "what's for dinner?" and "turn off the lights" via Signal

### Phase 4: AI Capability Inference

- [ ] `sharkcage-inference`: read SKILL.md, send to LLM, extract capabilities
- [ ] `sc skill add`: clone → infer → scan → approve → install
- [ ] Test with 5 popular ClawHub skills
- [ ] Validates day-one OpenClaw ecosystem compatibility

### Phase 5: CLI Completion

- [ ] `sc approve`: review and modify capability approvals
- [ ] `sc config`: add/remove services, re-sign gateway config
- [ ] `sc audit`: query audit log
- [ ] `sc sign`: Ed25519 signing
- [ ] `sc skill list/remove`: plugin management
- [ ] SSH and AWS as opt-in capabilities (controlled access, not blanket deny)

### Phase 6: Dashboard + Signing

- [ ] Dashboard additions to OpenClaw's web UI
- [ ] Capability approval management UI
- [ ] Trust store management
- [ ] CI integration: `sc verify --strict`

### Phase 7: Advanced (ongoing)

- [ ] Budget enforcement per skill
- [ ] Per-skill session isolation
- [ ] Godot plugin (MCP bridge to GPU node)
- [ ] SSH/AWS controlled access capabilities
- [ ] Runtime cost alerting
- [ ] Community skill curation tooling
