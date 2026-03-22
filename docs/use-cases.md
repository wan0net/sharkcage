# Use Cases

Concrete scenarios showing how code-orchestration works from the user's perspective. Each use case includes the exact CLI command, what Nomad does under the hood, and what the user gets back.

Throughout these examples, the CLI tool is called `yeet`. The user's laptop is not a runner -- it only runs the CLI, which wraps Nomad's HTTP API over Tailscale. The runners are Dell 5070 thin clients registered as Nomad clients on the same Tailscale mesh. There is no custom API server -- Nomad is the control plane.

The core Nomad job is a parameterized job called `run-coding-agent`. When the user runs `yeet run`, the CLI dispatches this job with metadata (project, prompt, model, runtime, etc.). Nomad schedules it to a Dell based on constraints and node metadata. The job's `raw_exec` task runs `run-agent.sh`, which sets up the environment and executes the chosen coding agent.

---

## 1. Basic Implementation Task

### Scenario

You want to implement the notification system described in PLAN.md phase 2 for the peer6 mentoring platform. You want a coding agent to do the work on a Dell runner while you keep your laptop free.

### Command

```bash
yeet run peer6 "Implement the notification system from PLAN.md phase 2. \
  This covers in-app notifications for session requests, approvals, \
  and cancellations. Follow the existing patterns in src/routes for \
  SvelteKit pages and src/api/routes for Hono endpoints. \
  Run 'pnpm test' when done to confirm nothing is broken."
```

### Under the Hood

1. The `yeet` CLI calls Nomad's job dispatch API:
   ```
   POST /v1/job/run-coding-agent/dispatch
   ```
   with metadata:
   ```json
   {
     "Meta": {
       "project": "peer6",
       "runtime": "crush",
       "model": "anthropic/claude-sonnet-4",
       "mode": "implement",
       "prompt": "Implement the notification system from PLAN.md phase 2..."
     }
   }
   ```
2. Nomad evaluates placement. The `run-coding-agent` job spec includes a constraint `${meta.project}` that matches against node meta. All three Dells have `project_peer6 = true` in their client config. Nomad picks the Dell with the most available resources (or least recently allocated).
3. On the chosen Dell (say `co-dell-01`), Nomad starts the `raw_exec` task. The task's command is `run-agent.sh`, which receives the metadata as environment variables: `NOMAD_META_project=peer6`, `NOMAD_META_runtime=crush`, `NOMAD_META_prompt=...`, etc.
4. `run-agent.sh` does the following:
   - Pulls the latest code from the peer6 repo into the Dell's local workspace.
   - Checks out a working branch (`yeet/<dispatch-id>`).
   - Launches the Crush coding agent (or Claude Code, depending on `runtime`) with the prompt.
   - Streams structured output to stdout, which Nomad captures in its alloc logs.
5. The agent reads PLAN.md, implements the notification system across multiple files, runs `pnpm test`. All 79 existing tests pass plus the new ones.
6. `run-agent.sh` commits all changes on the working branch, pushes it, and creates a draft PR.
7. The script writes results (cost, duration, files changed, test results) to Nomad Variables at `yeet/results/<dispatch-id>`.
8. The Nomad allocation completes. The user receives an Ntfy push notification.

### Result

```bash
$ yeet status <dispatch-id>
Job:      run-coding-agent/dispatch-a1b2c3d4
Node:     co-dell-01
Status:   complete
Duration: 14m 32s
Cost:     $2.18
Branch:   yeet/dispatch-a1b2c3d4
PR:       https://github.com/link42/peer6/pull/47 (draft)
Files:    12 changed, 847 insertions, 23 deletions
Tests:    94 passed, 0 failed
```

The user reviews the draft PR, merges it if satisfied, or submits a follow-up (see Use Case 8).

---

## 2. Multi-Project Parallel Work

### Scenario

You want to add a feature to peer6 and write tests for login2 at the same time. These are independent tasks across two different projects, so they should run on separate Dells in parallel.

### Command

```bash
yeet run peer6 "Add the mentor availability calendar component. \
  Use the existing DatePicker from @peer6/shared as a base. \
  Render a weekly grid view. Follow Svelte 5 runes patterns."

yeet run login2 "Write comprehensive tests for the auth session validation flow. \
  Cover: valid session, expired session, missing cookie, malformed token, \
  and rate limiting. Use Vitest. Run 'pnpm test' to confirm they pass."
```

Two separate commands, fired one after the other (or backgrounded with `&`). Each is an independent `yeet run`, which means each is an independent Nomad job dispatch.

### Under the Hood

1. Each `yeet run` calls `POST /v1/job/run-coding-agent/dispatch` with its respective metadata. Two dispatches, two evaluations.
2. Nomad schedules them independently. If `co-dell-01` and `co-dell-03` are both idle, each dispatch lands on a different Dell. If only one Dell is idle, both may land on the same Dell (Nomad allows concurrent allocations if resources permit -- the job spec uses `count = 1` per dispatch, not per Dell).
3. Each Dell independently pulls its respective repo, checks out a branch, and runs the agent. The two agents have no awareness of each other.
4. Both allocations stream logs independently. Both write their results to Nomad Variables under separate dispatch IDs.

### Result

```bash
$ yeet ps
DISPATCH      PROJECT  NODE         RUNTIME  MODEL                      ELAPSED
dispatch-e5f6 peer6    co-dell-01   crush    anthropic/claude-sonnet-4  6m 12s
dispatch-g7h8 login2   co-dell-03   crush    anthropic/claude-sonnet-4  6m 12s

# Later:
$ yeet ps --done --since 1h
DISPATCH      PROJECT  COST    DURATION  STATUS
dispatch-g7h8 login2   $0.94   12m 08s   complete
dispatch-e5f6 peer6    $1.37   18m 41s   complete
```

Both branches are ready for review. No runner contention, no wasted laptop time.

---

## 3. Code Review (Read-Only)

### Scenario

You want an AI to review the ISM data import pipeline in rule1 for security issues. It should not modify any files.

### Command

```bash
yeet run rule1 "Review the ISM data import pipeline for security issues. \
  Focus on: input validation, XML parsing (XXE risks), file path handling, \
  privilege escalation vectors, and any hardcoded credentials or secrets. \
  Produce a structured report with severity ratings." \
  --mode review
```

### Under the Hood

1. The `yeet` CLI dispatches the job with `mode=review` in the metadata:
   ```
   POST /v1/job/run-coding-agent/dispatch
   Meta: { "project": "rule1", "mode": "review", ... }
   ```
2. Nomad schedules the dispatch to an available Dell with `project_rule1 = true`.
3. `run-agent.sh` reads `NOMAD_META_mode=review` and configures the coding agent accordingly:
   - For Crush: passes `--plan` flag or equivalent read-only configuration.
   - For Claude Code: launches with `--allowedTools` restricted to read-only tools (Read, Grep, Glob, Bash with a read-only wrapper that rejects write commands).
4. The agent reads through the import pipeline code, analyzes it, and produces findings as structured text output to stdout.
5. No files are modified. No branches are created. No PR is opened. The task output is the report itself, stored in Nomad Variables and captured in alloc logs.

### Result

```bash
$ yeet logs <dispatch-id>
--- Security Review: ISM Data Import Pipeline ---

CRITICAL:
1. XML External Entity (XXE) in ism-parser.ts:47
   The XML parser is initialized without disabling external entities.
   An attacker supplying a crafted ISM XML could read arbitrary files.
   Recommendation: Set { noent: false, dtdload: false } on parser init.

HIGH:
2. Path traversal in import-handler.ts:83
   User-supplied filenames are joined to the data directory without sanitization.
   Use path.resolve() and verify the result is within the expected directory.

MEDIUM:
3. ...

Files analyzed: 14
No files were modified.
```

The user gets actionable security findings without any risk of the agent modifying code.

---

## 4. Device-Dependent Testing

### Scenario

You need to test the FIDO2 authentication flow end-to-end, which requires a physical YubiKey plugged into one of the Dells. Only `co-dell-01` has a YubiKey attached.

### Command

```bash
yeet run login2 "Run the FIDO2 WebAuthn registration and authentication integration tests. \
  The YubiKey is available at the USB device path provided in the environment. \
  Use the libfido2 CLI tools to interact with the key. \
  Run the full FIDO2 test suite and report pass/fail for each test case." \
  --needs yubikey
```

### Under the Hood

1. The `yeet` CLI dispatches with an additional constraint in the metadata:
   ```
   Meta: { "project": "login2", "device": "yubikey", ... }
   ```
2. The `run-coding-agent` job spec includes a dynamic constraint that, when `device` metadata is set, requires the target node to have matching device metadata. In the Nomad job spec:
   ```hcl
   constraint {
     attribute = "${node.meta.device_yubikey}"
     operator  = "="
     value     = "true"
   }
   ```
   Only `co-dell-01` has `device_yubikey = true` in its Nomad client config. Nomad schedules the allocation there.
3. On `co-dell-01`, `run-agent.sh` sees `NOMAD_META_device=yubikey`. Before launching the agent, it:
   - Acquires an exclusive lock on the YubiKey device file using `flock /var/lock/device-yubikey`. This prevents concurrent tasks from fighting over the same physical device.
   - Sets `FIDO2_DEVICE_PATH=/dev/hidraw2` in the agent's environment.
4. The agent runs the FIDO2 integration tests. The tests interact with the physical YubiKey for cryptographic operations.
5. When the task completes (or fails), `run-agent.sh` releases the `flock`. The device is available for other tasks.

### Result

```bash
$ yeet status <dispatch-id>
Job:      run-coding-agent/dispatch-m3n4o5
Node:     co-dell-01
Device:   yubikey (locked for duration)
Status:   complete
Duration: 3m 17s

Tests:
  [PASS] WebAuthn registration with resident key
  [PASS] WebAuthn authentication with UV
  [PASS] WebAuthn authentication without UV
  [FAIL] WebAuthn registration with non-resident key
    Error: Device returned CTAP2_ERR_KEY_STORE_FULL
    Note: YubiKey resident key slots may be full.
```

Real hardware interaction, scheduled to the correct Dell, with device locking to prevent contention.

---

## 5. Firmware/Hardware Work

### Scenario

You need to flash new firmware to an ESP32 dev board connected to `co-dell-02`, then run integration tests that communicate with it over the serial console. This is for a future threat10 sensor prototype.

### Command

```bash
yeet run threat10 "Flash the firmware in firmware/sensor-v2.3.bin to the ESP32 using esptool.py. \
  After flashing, open the serial console at 115200 baud and verify the boot message \
  contains 'sensor-v2.3 ready'. Then run the integration test suite in tests/integration/ \
  which sends commands over serial and validates responses. \
  The serial device path is in the ESP32_SERIAL_PORT environment variable." \
  --needs esp32
```

### Under the Hood

1. Dispatch includes `device=esp32` in metadata. The job constraint requires `node.meta.device_esp32 = true`. Only `co-dell-02` matches.
2. On `co-dell-02`, `run-agent.sh` acquires `flock /var/lock/device-esp32`, sets `ESP32_SERIAL_PORT=/dev/ttyUSB0`, and launches the agent.
3. The agent runs `esptool.py --port $ESP32_SERIAL_PORT write_flash 0x0 firmware/sensor-v2.3.bin`. The firmware flashes.
4. The agent opens the serial console, reads boot output, confirms the version string.
5. The integration test suite runs, sending commands over serial and validating responses.
6. On completion, the flock is released and the serial port is available.

### Result

```bash
$ yeet logs <dispatch-id>
Flash:    sensor-v2.3.bin written successfully (438,272 bytes)
Boot:     "threat10 sensor-v2.3 ready [heap: 245760]"

Integration Tests:
  [PASS] Heartbeat ping/pong
  [PASS] Sensor data read (temperature, humidity)
  [PASS] Configuration update over serial
  [PASS] Watchdog timer reset
  [PASS] OTA update preparation
  5/5 passed
```

Physical hardware interaction handled entirely by the runner fleet. No need to walk over to the device.

---

## 6. Long-Running Overnight Analysis

### Scenario

You want a deep architectural analysis of the entire peer6 codebase overnight. This is expensive and time-consuming. Results should be waiting in the morning.

### Command

```bash
yeet run peer6 "Perform a comprehensive architectural analysis of the peer6 codebase. \
  Cover: \
  1. Dependency graph between packages (apps/api, apps/web, packages/shared) \
  2. API endpoint inventory with auth requirements \
  3. Database schema analysis and migration history \
  4. Frontend component tree and state management patterns \
  5. Test coverage gaps \
  6. Dead code and unused exports \
  7. Performance concerns (N+1 queries, unnecessary re-renders, bundle size) \
  8. Security posture (input validation, auth checks, CORS, CSP) \
  Produce a structured report with actionable recommendations prioritized by impact." \
  --mode review \
  --budget 15
```

### Under the Hood

1. The `yeet` CLI dispatches with `mode=review` and `budget=15` in the metadata.
2. Nomad schedules it to an available Dell. There is no built-in priority in Nomad's batch scheduler for this -- it just runs when a Dell is free. If all Dells are busy, it queues until one becomes available.
3. `run-agent.sh` reads `NOMAD_META_budget=15` and configures cost tracking. The script monitors token usage in real time (via the agent's streaming output or a sidecar cost tracker). If the estimated cost approaches $15, the script sends a graceful termination signal, giving the agent 60 seconds to produce a partial report before killing it.
4. The agent methodically reads through the entire codebase -- hundreds of files across three packages. It builds up its analysis iteratively.
5. The agent finishes its report at $11.87, well under the cap. The allocation completes at 2:14 AM. Results are written to Nomad Variables under `yeet/results/<dispatch-id>`.
6. An Ntfy notification fires on completion.

### Result

The next morning:

```bash
$ yeet ps --done --since 12h
DISPATCH      PROJECT  COST     DURATION  STATUS
dispatch-s9t0 peer6    $11.87   7h 27m    complete

$ yeet logs dispatch-s9t0
--- Architectural Analysis: peer6 ---

1. Dependency Graph
   apps/web depends on @peer6/shared (12 imports)
   apps/api depends on @peer6/shared (8 imports)
   No circular dependencies detected.
...

5. Test Coverage Gaps
   - apps/web: 0 component tests (all 79 tests are API-level)
   - No tests for: mentor matching algorithm, session scheduling conflicts,
     timezone conversion, email template rendering
   - Recommended: Add Vitest + Testing Library for critical Svelte components
...

8. Security Posture
   - CRITICAL: Rate limiting not implemented on /api/auth/* endpoints
   - HIGH: CORS allows wildcard origin in development mode, but the env check
     uses NODE_ENV which is not set in the Cloudflare Workers runtime
...

Files analyzed: 247
Estimated cost: $11.87
```

A full architectural review completed autonomously overnight for less than $12.

---

## 7. Approval Gate

### Scenario

A task tries to modify the CI/CD pipeline configuration. The `run-agent.sh` wrapper detects this as a risky operation and pauses, waiting for the user to approve.

### Command

The user submitted a normal implementation task:

```bash
yeet run peer6 "Set up GitHub Actions to run the test suite on every PR. \
  Create the workflow file and configure it for the pnpm monorepo."
```

### Under the Hood

1. The task starts normally on `co-dell-01`. The agent begins working.
2. The agent attempts to create `.github/workflows/ci.yml`. `run-agent.sh` has a file-watch or hook that detects writes to paths matching `*.github/workflows/*`, `*wrangler.toml`, `*.env*`, and other patterns defined in its risky-paths config.
3. The script pauses the agent process (SIGSTOP or equivalent). It writes a pending approval record to Nomad Variables at `yeet/approvals/<dispatch-id>`:
   ```json
   {
     "action": "file_write",
     "path": ".github/workflows/ci.yml",
     "content": "name: CI\non:\n  pull_request:\n    branches: [main]\n...",
     "status": "pending"
   }
   ```
4. The script sends an Ntfy notification:
   ```
   Task dispatch-v1w2 wants to write: .github/workflows/ci.yml
   Approve: yeet approve dispatch-v1w2
   Reject:  yeet reject dispatch-v1w2
   Stop:    yeet stop dispatch-v1w2
   ```
5. The Nomad allocation remains running (the process is paused, not exited). Nomad's `max_client_disconnect` or a generous `kill_timeout` keeps it alive during the wait.
6. The user reviews and approves:
   ```bash
   $ yeet approve dispatch-v1w2
   ```
   This writes `"status": "approved"` to the Nomad Variable. The script polls the variable, sees the approval, resumes the agent (SIGCONT), and the file write proceeds.
7. If the user runs `yeet stop dispatch-v1w2` instead, the script kills the agent and the allocation fails.
8. If the user runs `yeet reject dispatch-v1w2`, the script tells the agent to skip that file and continue (or terminates, depending on config).

### Result

```bash
$ yeet status dispatch-v1w2
Job:      run-coding-agent/dispatch-v1w2
Node:     co-dell-01
Status:   complete
Duration: 4m 12s (includes 22m approval wait)
Approvals: 1 (ci.yml creation)
```

Risky operations never happen silently. The user maintains control over changes to CI, deployment configs, secrets, and other sensitive files. The approval mechanism lives entirely in `run-agent.sh` and Nomad Variables -- no custom API needed.

---

## 8. Session Continuation

### Scenario

A task completed 80% of the work -- it implemented the notification API endpoints but did not wire up the frontend components. You want to give follow-up instructions, and the agent should resume with full session context.

### Command

```bash
# Check what the previous job did:
$ yeet logs dispatch-a1b2c3d4
...
Session: session_a1b2c3d4
Branch:  yeet/dispatch-a1b2c3d4
Note:    Implemented notification API endpoints. Frontend components not yet created.

# Continue the session:
$ yeet continue dispatch-a1b2c3d4 "Good work on the API endpoints. Now create the frontend: \
  1. NotificationBell.svelte - icon in the header that shows unread count \
  2. NotificationPanel.svelte - dropdown listing recent notifications \
  3. Wire up the WebSocket connection in a Svelte store for real-time updates \
  Follow the existing component patterns in src/lib/components/. \
  Run 'pnpm test' and 'pnpm check' when done."
```

### Under the Hood

1. The `yeet continue` command reads the `session_id` from Nomad Variables at `yeet/results/dispatch-a1b2c3d4`. It finds `session_id = session_a1b2c3d4`.
2. The CLI dispatches a new job:
   ```
   POST /v1/job/run-coding-agent/dispatch
   Meta: {
     "project": "peer6",
     "session_id": "session_a1b2c3d4",
     "parent_dispatch": "dispatch-a1b2c3d4",
     "prompt": "Good work on the API endpoints. Now create the frontend..."
   }
   ```
3. Nomad schedules this to any Dell with `project_peer6 = true`. Ideally the same Dell that ran the original task (so the branch and session state are local), but it works on any Dell since the branch was pushed to the remote.
4. `run-agent.sh` reads `NOMAD_META_session_id`. It checks out the existing branch `yeet/dispatch-a1b2c3d4`, pulls the latest, and launches the agent with the session resume flag:
   - For Claude Code: `claude --resume session_a1b2c3d4 -p "..."`
   - For Crush: equivalent session continuation mechanism
5. The agent resumes with full context of the previous session. It implements the three frontend components, wires up the store, runs tests and type checks.
6. The script commits the new changes to the same branch, updates the draft PR, and writes updated results to Nomad Variables.

### Result

```bash
$ yeet status <new-dispatch-id>
Job:      run-coding-agent/dispatch-x3y4z5
Node:     co-dell-01
Parent:   dispatch-a1b2c3d4
Session:  session_a1b2c3d4 (resumed)
Status:   complete
Duration: 8m 55s
Cost:     $1.42 (session total: $3.60)
Branch:   yeet/dispatch-a1b2c3d4
PR:       https://github.com/link42/peer6/pull/47 (updated)
Files:    5 changed, 312 insertions, 8 deletions
Tests:    97 passed, 0 failed
```

The branch now contains the complete notification system -- API and frontend -- ready for review. Session context preserved across separate Nomad job dispatches.

---

## 9. Model/Runtime Switching

### Scenario

You have a complex refactoring task and want to compare how different runtimes and models handle it. Run the same task twice with different configurations.

### Command

```bash
yeet run peer6 "Refactor the mentor matching algorithm in src/lib/matching.ts. \
  Currently it's a single 200-line function. Break it into: \
  1. A scoring module that weights different match criteria \
  2. A filtering module that eliminates incompatible pairs \
  3. A ranking module that sorts candidates \
  Each module should be independently testable. Write tests." \
  --runtime crush --model anthropic/claude-sonnet-4

yeet run peer6 "Refactor the mentor matching algorithm in src/lib/matching.ts. \
  Currently it's a single 200-line function. Break it into: \
  1. A scoring module that weights different match criteria \
  2. A filtering module that eliminates incompatible pairs \
  3. A ranking module that sorts candidates \
  Each module should be independently testable. Write tests." \
  --runtime claude --model opus
```

### Under the Hood

1. Two independent dispatches to Nomad, each with different `runtime` and `model` metadata.
2. Nomad schedules them to different Dells (or the same Dell if one is idle and can handle both). Each gets its own allocation.
3. Each Dell checks out a separate branch: `yeet/dispatch-<id-1>` and `yeet/dispatch-<id-2>`.
4. The first runs Crush with Claude Sonnet. The second runs Claude Code with Opus. Both work on the same refactoring task independently.
5. Both produce separate branches, separate draft PRs, and separate results in Nomad Variables.

### Result

```bash
$ yeet ps --done --since 1h
DISPATCH      RUNTIME  MODEL                      COST    DURATION  STATUS
dispatch-r1s2 crush    anthropic/claude-sonnet-4   $1.89   15m 03s  complete
dispatch-t3u4 claude   opus                        $3.41   22m 18s  complete
```

The user compares the two PRs side by side. The Sonnet run was cheaper and faster but wrote fewer tests. The Opus run was more thorough but cost more. The user picks the better result or cherry-picks from both.

---

## 10. Scheduled/Recurring Work

### Scenario

You want the peer6 test suite to run every morning at 6:00 AM AEST and notify you if anything fails.

### Command

Option A -- Use Nomad's periodic job type:

```bash
yeet schedule peer6 "Pull the latest main branch. Run 'pnpm install' then 'pnpm test'. \
  Report the results. If any tests fail, analyze the failure and suggest a fix. \
  Do not modify any files." \
  --every "0 7 * * *" \
  --mode review
```

Under the hood, the `yeet schedule` command creates (or updates) a separate Nomad job called `scheduled-peer6-tests` with a `periodic` stanza:

```hcl
periodic {
  crons            = ["0 7 * * *"]
  prohibit_overlap = true
  time_zone        = "Australia/Sydney"
}
```

Each morning at 7:00 AM AEST (6:00 UTC+11 maps to this depending on DST), Nomad automatically dispatches an instance of this job.

Option B -- Simple cron on a Dell:

```bash
# In the crontab of co-dell-03:
0 20 * * * /usr/local/bin/yeet run peer6 "Pull latest main. Run pnpm test. Report results." --mode review
```

This is simpler but less visible to Nomad (it shows up as a regular dispatch, not a periodic job).

### Under the Hood (Option A)

1. Nomad's periodic scheduler evaluates the cron expression every minute.
2. At the scheduled time, Nomad creates a child job dispatch. This appears in `nomad job status scheduled-peer6-tests` as a periodic instance.
3. An available Dell picks up the allocation, runs the tests.
4. `run-agent.sh` checks results. If tests fail, it sends an Ntfy notification with the failure analysis.
5. If all tests pass, it completes silently (or sends a brief "all clear" notification, depending on config).

### Result

On a good day -- nothing. Silence means the tests pass.

On a bad day:

```
[Ntfy] peer6 tests FAILED
3 tests failed in scheduled run scheduled-peer6-tests/periodic-20260322

POST /api/sessions - 500: D1 binding not found
  Migration 014 added a new table but the D1 binding name changed
  in wrangler.toml. Tests weren't updated.

Suggested fix: Update vitest.config.ts D1 binding from "DB" to "PEER6_DB"
to match the wrangler.toml change in commit a3f8e21.

View logs: yeet logs scheduled-peer6-tests/periodic-20260322
Cost: $0.23
```

The user wakes up informed, with a diagnosis and a suggested fix.

---

## 11. Cross-Project Coordination

### Scenario

You updated the auth middleware in login2 to add a new session field (`organization_id`). Now peer6's auth client needs to be updated to match. The second task depends on reviewing the first task's output.

### Command

This is manual coordination. There is no built-in dependency chain in Nomad's job dispatch model.

```bash
# Step 1: Make the change in login2
yeet run login2 "Add 'organization_id' to the session response in the auth middleware. \
  Update the session type in types.ts, the session creation in auth.ts, \
  and the GET /api/auth/get-session endpoint to include the org ID. \
  Run tests to confirm."

# Wait for it to complete, review the result:
$ yeet logs <dispatch-id-1>
# ... looks good ...

# Step 2: Update peer6, referencing what was done in step 1
yeet run peer6 "The login2 auth service now returns 'organization_id' in the session response. \
  Update peer6's auth client in src/lib/auth/client.ts to: \
  1. Add organization_id to the Session type \
  2. Store it in the auth store \
  3. Use it in the API middleware to scope queries to the user's org \
  4. Update existing tests and add new ones for org-scoped behavior \
  Run 'pnpm test' to confirm."
```

### Under the Hood

1. Each `yeet run` is a standard Nomad job dispatch. There is no `depends-on` flag. The user is the orchestrator for cross-project work.
2. The user reviews the first task's output before triggering the second. This is intentional -- cross-project changes need human review at the boundary.
3. Future enhancement: `run-agent.sh` could support dispatching a follow-up job from within a task (by calling `yeet run` itself), enabling automated chains. But for now, the human reviews and triggers.

### Result

```bash
$ yeet ps --done --since 2h
DISPATCH      PROJECT  STATUS    DURATION
dispatch-ab11 login2   complete  9m 33s
dispatch-ab22 peer6    complete  11m 07s
```

Both branches are ready for coordinated PRs. The user ensures the changes are compatible before merging.

---

## 12. Fleet Management

### Scenario

You want to see the state of your Dell fleet, drain a node for maintenance, and bring it back.

### Command

```bash
# See all nodes
$ yeet runners
```

### Under the Hood

The `yeet runners` command calls:
```
GET /v1/nodes
```

It filters nodes by a naming convention or metadata tag (e.g., `role = coding-runner`) and formats the response.

### Result

```bash
$ yeet runners
NODE          STATUS    ALLOCS  DEVICES          PROJECTS                UPTIME
co-dell-01    ready     1       yubikey          peer6,login2,rule1      14d 3h
co-dell-02    ready     2       esp32,hsm        peer6,threat10,patch8   14d 3h
co-dell-03    ready     0       (none)           peer6,login2,rule1      14d 3h
```

To drain a node for maintenance:

```bash
$ yeet drain co-dell-02
```

This calls:
```
POST /v1/node/co-dell-02-node-id/drain
Body: { "DrainSpec": { "Deadline": 3600000000000 }, "MarkEligible": false }
```

Nomad stops scheduling new allocations to `co-dell-02`. Existing allocations are given up to 1 hour to complete (the deadline). Once drained:

```bash
$ yeet runners
NODE          STATUS     ALLOCS  DEVICES          PROJECTS
co-dell-01    ready      1       yubikey          peer6,login2,rule1
co-dell-02    draining   1       esp32,hsm        peer6,threat10,patch8
co-dell-03    ready      0       (none)           peer6,login2,rule1

# After allocations finish:
co-dell-02    ineligible 0       esp32,hsm        peer6,threat10,patch8
```

Perform maintenance (SSH in, update kernel, reboot). Then bring it back:

```bash
$ yeet activate co-dell-02
```

This calls:
```
POST /v1/node/co-dell-02-node-id/eligibility
Body: { "Eligibility": "eligible" }
```

The node becomes schedulable again:

```bash
$ yeet runners
NODE          STATUS    ALLOCS  DEVICES          PROJECTS
co-dell-01    ready     1       yubikey          peer6,login2,rule1
co-dell-02    ready     0       esp32,hsm        peer6,threat10,patch8
co-dell-03    ready     0       (none)           peer6,login2,rule1
```

Zero task disruption throughout the maintenance window.

---

## 13. Cost Monitoring

### Scenario

You want to see how much you have spent on AI coding tasks across projects and time periods.

### Command

```bash
$ yeet cost
```

### Under the Hood

The `yeet cost` command reads Nomad Variables stored under the `yeet/cost/` prefix. Every completed task writes its cost to a variable like `yeet/cost/2026-03/dispatch-a1b2c3d4`:

```json
{
  "project": "peer6",
  "model": "anthropic/claude-sonnet-4",
  "runtime": "crush",
  "cost_usd": 1.37,
  "tokens_in": 45000,
  "tokens_out": 12000,
  "duration_seconds": 1121,
  "timestamp": "2026-03-22T10:15:00Z"
}
```

The `yeet cost` CLI reads all variables under the prefix, aggregates them by project, model, and time period, and formats the output.

```
GET /v1/var?prefix=yeet/cost/2026-03
```

### Result

```bash
$ yeet cost
Period       Total     Tasks   Avg/Task
Today        $4.82     3       $1.61
This week    $31.47    22      $1.43
This month   $127.93   89      $1.44

$ yeet cost --by project
PROJECT   TOTAL     TASKS   PCT
peer6     $68.41    47      53%
login2    $31.22    23      24%
rule1     $18.90    12      15%
threat10  $9.40     7       8%

$ yeet cost --by model
MODEL                       TOTAL     TASKS
anthropic/claude-opus-4     $72.18    31
anthropic/claude-sonnet-4   $41.90    42
anthropic/claude-haiku-4    $8.15     12
google/gemini-2.5-pro       $5.70     4
```

Full visibility into spend. The user can adjust model choices based on real data -- switching routine tasks from Opus to Sonnet, for example, or identifying which projects consume the most budget.

---

## 14. Emergency Stop

### Scenario

Something is going wrong -- an agent is writing unexpected files, costs are spiking, or a task is behaving erratically. You need to stop it immediately.

### Command

Stop a single job:

```bash
$ yeet stop dispatch-ef44
```

Stop all running jobs:

```bash
$ yeet stop --all
WARNING: This will terminate 3 running allocations on 2 nodes.
Confirm? [y/N]: y

Stopping dispatch-ef44 on co-dell-01... stopped
Stopping dispatch-ef55 on co-dell-01... stopped
Stopping dispatch-ef66 on co-dell-03... stopped

All tasks stopped.
```

### Under the Hood

For a single stop, the CLI calls:
```
DELETE /v1/job/run-coding-agent/dispatch-ef44?purge=false
```

This tells Nomad to stop the job. Nomad sends a kill signal to the allocation. The `run-agent.sh` process receives SIGTERM, which it traps to:
1. Kill the coding agent subprocess.
2. Log the termination event (what the agent was doing when killed, which files were modified).
3. Write partial results to Nomad Variables.
4. Exit.

If the process does not exit within the `kill_timeout` (configured in the job spec, e.g., 30 seconds), Nomad sends SIGKILL.

For `yeet stop --all`, the CLI:
1. Lists all running allocations: `GET /v1/allocations?filter=JobID==run-coding-agent&filter=ClientStatus==running`
2. For each, stops the parent dispatch job: `DELETE /v1/job/<dispatch-job-id>`

Any uncommitted file changes are left on the working branches (not pushed). Nothing is lost, but nothing is merged either.

### Result

```bash
$ yeet ps --done --since 1h
DISPATCH      PROJECT  NODE         STATUS      STOPPED-BY
dispatch-ef44 peer6    co-dell-01   stopped     manual
dispatch-ef55 peer6    co-dell-01   stopped     manual
dispatch-ef66 login2   co-dell-03   stopped     manual
```

Full control restored within seconds. The user can inspect partial work on the branches and resubmit if appropriate.

---

## 15. Device Disconnection

### Scenario

A task is running on `co-dell-01` that requires the YubiKey. Mid-task, the USB cable comes loose and the YubiKey disconnects.

### Command

No user command -- this is an automatic failure handling scenario.

### Under the Hood

1. The task is running. The agent attempts to interact with the YubiKey via `/dev/hidraw2`.
2. The device is gone. The libfido2 call fails with a device error.
3. `run-agent.sh` detects the device error (either the agent exits with a non-zero code, or the script's device health check -- a background loop that polls the device file -- fires).
4. The script writes the error to Nomad Variables:
   ```json
   {
     "status": "failed",
     "error": "device_disconnected",
     "device": "yubikey",
     "message": "YubiKey disconnected mid-task. /dev/hidraw2 no longer present."
   }
   ```
5. The script sends an Ntfy notification:
   ```
   [yeet] Task dispatch-m3n4 FAILED: YubiKey disconnected
   The YubiKey was unplugged from co-dell-01 while the FIDO2 tests were running.
   Reconnect the device and re-run: yeet run login2 "..." --needs yubikey
   ```
6. The Nomad allocation exits with a non-zero status. Nomad's restart policy in the job spec determines what happens next:
   - If `restart { attempts = 2, delay = "30s" }`, Nomad will restart the task. `run-agent.sh` checks for the device on startup -- if the YubiKey was reconnected within 30 seconds, the retry succeeds.
   - If the device is still missing after all retries, the allocation moves to `failed` state.

### Result

```bash
$ yeet status dispatch-m3n4
Job:      run-coding-agent/dispatch-m3n4
Node:     co-dell-01
Status:   failed
Error:    YubiKey disconnected mid-task
Retries:  2/2 (both failed - device not reconnected)
Duration: 1m 44s (before failure)
```

The task was never silently lost. The user gets a clear notification of what happened and can re-run once the hardware issue is resolved.

---

## 16. Using Nomad Directly

### Scenario

The `yeet` CLI covers the common workflows, but Nomad's own CLI and UI are always available for anything `yeet` does not cover. Since there is no custom API -- just Nomad -- you can always fall back to the standard Nomad tooling.

### Command Examples

View detailed allocation info:
```bash
$ nomad alloc status <alloc-id>
ID                  = a1b2c3d4
Eval ID             = e5f6g7h8
Name                = run-coding-agent/dispatch-xyz/execute[0]
Node ID             = i9j0k1l2
Node Name           = co-dell-01
Job ID              = run-coding-agent/dispatch-xyz
Client Status       = running
Created             = 2026-03-22T10:15:00+11:00

Task "execute" is "running"
  Resources:    CPU: 100/2000 MHz, Memory: 512/4096 MB
  Started At:   2026-03-22T10:15:02+11:00
  Meta:
    project = peer6
    runtime = crush
    model   = anthropic/claude-sonnet-4
```

Stream live logs from a running task:
```bash
$ nomad alloc logs -f <alloc-id> execute
[2026-03-22 10:15:03] Cloning peer6 repo...
[2026-03-22 10:15:08] Checking out branch yeet/dispatch-xyz
[2026-03-22 10:15:10] Starting crush with model anthropic/claude-sonnet-4
[2026-03-22 10:15:11] Agent reading PLAN.md...
...
```

View full node details:
```bash
$ nomad node status -verbose <node-id>
ID              = i9j0k1l2
Name            = co-dell-01
Class           = <none>
DC              = dc1
Drain           = false
Eligibility     = eligible
Status          = ready

Meta
  device_yubikey  = true
  project_peer6   = true
  project_login2  = true
  project_rule1   = true
  role            = coding-runner
```

Inspect the parameterized job spec:
```bash
$ nomad job inspect run-coding-agent
{
  "Job": {
    "ID": "run-coding-agent",
    "Type": "batch",
    "ParameterizedJob": {
      "MetaRequired": ["project", "prompt"],
      "MetaOptional": ["runtime", "model", "mode", "device", "budget", "session_id"]
    },
    "TaskGroups": [{
      "Name": "agent",
      "Tasks": [{
        "Name": "execute",
        "Driver": "raw_exec",
        "Config": {
          "command": "/opt/co/run-agent.sh"
        }
      }]
    }]
  }
}
```

Open the Nomad web UI:
```bash
$ nomad ui
Opening http://localhost:4646/ui in browser...
```

The Nomad UI shows all jobs, allocations, nodes, and logs in a web dashboard. Useful for visual monitoring and debugging without needing the CLI.

### Under the Hood

There is no "under the hood" here. These are direct Nomad API calls. The `yeet` CLI is a convenience wrapper, not a gatekeeper. Everything it does maps to documented Nomad HTTP API endpoints. If you need something `yeet` does not support, use `nomad` directly.

### Result

Full transparency into the system. The user is never locked out of the underlying infrastructure. Nomad's mature tooling (CLI, API, UI, Consul integration) is available without modification.

---

## Summary

These sixteen use cases cover the primary interaction patterns with code-orchestration:

| # | Use Case | Key Feature |
|---|----------|-------------|
| 1 | Basic implementation | `yeet run` dispatches parameterized Nomad job, agent executes, branch + PR created |
| 2 | Multi-project parallel | Independent dispatches, Nomad schedules to available Dells |
| 3 | Code review | `--mode review` restricts agent to read-only, report output only |
| 4 | Device-dependent testing | Node metadata constraints, `flock` device locking |
| 5 | Firmware/hardware | Serial device routing via Nomad constraints + environment variables |
| 6 | Long-running analysis | Budget caps in `run-agent.sh`, overnight execution |
| 7 | Approval gate | Script-level pause/resume, Nomad Variables for approval state |
| 8 | Session continuation | `yeet continue` reads session_id from Nomad Variables, dispatches with resume |
| 9 | Model/runtime switching | Multiple dispatches with different metadata, compare results |
| 10 | Scheduled/recurring | Nomad periodic jobs or cron-triggered `yeet run` |
| 11 | Cross-project coordination | Manual sequencing by user, future: in-script dispatch chaining |
| 12 | Fleet management | `yeet runners/drain/activate` wrapping Nomad node API |
| 13 | Cost monitoring | Nomad Variables as cost store, CLI aggregation |
| 14 | Emergency stop | `DELETE /v1/job/:id` for each running dispatch |
| 15 | Device disconnection | Script-level detection, Nomad restart policy, Ntfy notification |
| 16 | Using Nomad directly | Full access to `nomad` CLI, API, and UI for anything `yeet` does not cover |
