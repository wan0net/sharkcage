# Release Checklist

Use this before cutting a Sharkcage release.

## Code + CI

- `npm run check`
- `npm test`
- GitHub Actions `CI` green on the release branch

## Install + Update

- Clean install on a fresh Linux VM
- Re-run install over an existing install on the same VM
- Validate:
  - `--ref main`
  - `--ref <tag>`
  - `--ref latest-tag`
- Confirm the install worktree stays clean after install/update
- Confirm `etc/install.json` records the installed ref, commit, and runtime node path

## Setup Paths

- Interactive setup:
  - `sc init`
- Non-interactive/server setup:
  - `install.sh --configure ...`
  - `sc init --non-interactive ...`

Validate:
- gateway config written
- dedicated runtime user creation works
- runtime node path stays executable after handoff to the dedicated user

## Runtime Validation

- `sc start`
- `sc status`
- `/api/status`
- dashboard loads

Confirm:
- supervisor starts
- OpenClaw starts
- plugin registration happens
- ASRT sandbox backend is enabled
- audit health is healthy

## Sandbox Reality Check

- Validate that startup passes the sandbox smoke preflight on the target host
- If startup fails, record the exact host error and do not cut a “secure” release for that environment

Examples of host-level blockers:
- missing `bubblewrap`
- missing `socat`
- missing `ripgrep`
- `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`

## Approval + Audit Flow

- Install a fixture skill
- Unapproved request blocks
- Approved request executes
- Violation request is blocked and audited
- `sc audit` and `/api/status` reflect the same health/state

## Docs + Website

- README matches current guarantees
- install docs match the real installer behavior
- website warning / development status copy is current
- avoid stronger language than the code guarantees

## Rollback

- Previous release ref noted
- Rollback command tested on staging/VM:
  - `bash install.sh --dir /opt/sharkcage --ref <previous-ref>`
- Restart path tested after rollback
