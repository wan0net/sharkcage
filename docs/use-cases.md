# Use Cases

Concrete scenarios showing how code-orchestration works from the user's perspective. Each use case includes the exact CLI command, what the system does internally, and what the user gets back.

Throughout these examples, the CLI tool is called `orch`. The user's laptop is not a runner -- it only runs the CLI, which talks to the API over Tailscale. The runners are Dell 5070 thin clients on the same Tailscale mesh.

---

## 1. Basic Implementation Task

### Scenario

You want to implement the notification system described in PLAN.md phase 2 for the peer6 mentoring platform. The code lives in `~/workspace/mentor`. You want Claude Code to do the work on a runner while you keep your laptop free.

### Command

```bash
orch task submit \
  --project peer6 \
  --runtime claude-code \
  --model claude-opus-4 \
  --prompt "Implement the notification system from PLAN.md phase 2. \
    This covers in-app notifications for session requests, approvals, \
    and cancellations. Follow the existing patterns in src/routes for \
    SvelteKit pages and src/api/routes for Hono endpoints. \
    Run 'pnpm test' when done to confirm nothing is broken."
```

### What Happens

1. The CLI sends the task to the API with metadata: project=peer6, runtime=claude-code, model=claude-opus-4, no device requirements.
2. The API validates the request, authenticates the user via Cloudflare Access, and enqueues the task in BullMQ with priority `normal`.
3. The scheduler evaluates available runners. All three Dell 5070s are idle and have no device constraints for this task. It picks Runner 01 (least recently used).
4. Runner 01's worker daemon picks up the task. It pulls the latest commit from peer6's repo, checks out a working branch (`orch/task-<id>`), and spawns Claude Code:
   ```
   claude -p "Implement the notification system from PLAN.md phase 2..." \
     --output-format stream-json \
     --model claude-opus-4
   ```
5. The runtime adapter captures Claude Code's streaming JSON output, forwarding structured events (tool calls, file writes, shell commands) to the API for logging.
6. Claude Code reads PLAN.md, implements the notification system across multiple files, and runs `pnpm test`. All 79 existing tests pass plus the new ones.
7. The agent exits. The worker daemon commits all changes on the working branch and reports `completed` to the API.
8. The CLI receives a push notification (or the user polls with `orch task status <id>`).

### Result

```bash
$ orch task status abc123
Task:     abc123
Project:  peer6
Runner:   runner-01
Status:   completed
Duration: 14m 32s
Cost:     $2.18
Branch:   orch/task-abc123
Files:    12 changed, 847 insertions, 23 deletions
Tests:    94 passed, 0 failed
Log:      https://orch.link42.dev/tasks/abc123/log
```

The user reviews the diff on the branch, merges it if satisfied, or submits a follow-up (see Use Case 8).

---

## 2. Multi-Project Parallel Work

### Scenario

You want to implement a feature in peer6 and write tests for login2 at the same time. These are independent tasks across two different projects, so they can run on separate runners in parallel.

### Command

```bash
orch task submit \
  --project peer6 \
  --runtime crush \
  --model claude-sonnet-4 \
  --prompt "Add the mentor availability calendar component. \
    Use the existing DatePicker from @peer6/shared as a base. \
    Render a weekly grid view. Follow Svelte 5 runes patterns." &

orch task submit \
  --project login2 \
  --runtime claude-code \
  --model claude-sonnet-4 \
  --prompt "Write comprehensive tests for the auth session validation flow. \
    Cover: valid session, expired session, missing cookie, malformed token, \
    and rate limiting. Use Vitest. See peer6's test patterns for reference. \
    Run 'pnpm test' to confirm they pass."
```

Or, in a single command:

```bash
orch task submit --batch tasks.json
```

Where `tasks.json` contains both task definitions.

### What Happens

1. Both tasks arrive at the API within milliseconds of each other.
2. The scheduler assigns them to different runners -- Runner 01 gets the peer6 task, Runner 03 gets the login2 task.
3. Each runner independently clones/pulls the relevant repo, spawns its designated runtime (Crush for peer6, Claude Code for login2), and begins execution.
4. The API tracks both tasks concurrently. Progress events from both runners stream into the log store.
5. The login2 task finishes first (12 minutes). The peer6 task finishes shortly after (18 minutes). Both report results independently.

### Result

```bash
$ orch task list --status running
ID       PROJECT  RUNNER     RUNTIME      MODEL           ELAPSED
def456   peer6    runner-01  crush        claude-sonnet-4  6m 12s
ghi789   login2   runner-03  claude-code  claude-sonnet-4  6m 12s

# Later:
$ orch task list --status completed --since 1h
ID       PROJECT  RUNTIME      COST    DURATION  STATUS
ghi789   login2   claude-code  $0.94   12m 08s   completed
def456   peer6    crush        $1.37   18m 41s   completed
```

Both branches are ready for review. No runner contention, no wasted laptop time.

---

## 3. Code Review (Read-Only)

### Scenario

You want an AI to review the ISM data import pipeline in rule1 for security issues, but you do not want it to change any files. This is a read-only analysis task.

### Command

```bash
orch task submit \
  --project rule1 \
  --runtime claude-code \
  --model claude-opus-4 \
  --mode read-only \
  --prompt "Review the ISM data import pipeline for security issues. \
    Focus on: input validation, XML parsing (XXE risks), file path handling, \
    privilege escalation vectors, and any hardcoded credentials or secrets. \
    Produce a structured report with severity ratings (critical/high/medium/low) \
    for each finding."
```

### What Happens

1. The CLI sends the task with `mode: read-only`. This flag is critical.
2. The API enqueues it with the `read-only` constraint. When the scheduler assigns it to a runner, the worker daemon configures the runtime adapter to block all write operations.
3. For Claude Code, the adapter launches with `--allowedTools` restricted to read-only tools (Read, Grep, Glob, Bash with a read-only wrapper that rejects write commands). For Crush, the equivalent tool restrictions are applied via its configuration.
4. The agent reads through the import pipeline code, analyzes it, and produces its findings as structured text output.
5. No files are modified. No branches are created. The task output is the report itself.

### Result

```bash
$ orch task output jkl012
Task:     jkl012
Project:  rule1
Mode:     read-only
Status:   completed

--- Report ---
## Security Review: ISM Data Import Pipeline

### Critical
1. XML External Entity (XXE) in ism-parser.ts:47
   The XML parser is initialized without disabling external entities.
   An attacker supplying a crafted ISM XML could read arbitrary files.
   Recommendation: Set `{ noent: false, dtdload: false }` on parser init.

### High
2. Path traversal in import-handler.ts:83
   User-supplied filenames are joined to the data directory without sanitization.
   Use path.resolve() and verify the result is within the expected directory.

### Medium
3. ...

Files analyzed: 14
No files were modified.
```

The user gets actionable security findings without any risk of the agent accidentally modifying production code.

---

## 4. Device-Dependent Testing

### Scenario

You need to test the FIDO2 authentication flow end-to-end, which requires a physical YubiKey 5 plugged into one of the Dell runners. Not all runners have a YubiKey attached.

### Command

```bash
orch task submit \
  --project login2 \
  --runtime claude-code \
  --model claude-sonnet-4 \
  --device yubikey \
  --prompt "Run the FIDO2 WebAuthn registration and authentication integration tests. \
    The YubiKey is available at the USB device path provided in the environment. \
    Use the libfido2 CLI tools to interact with the key. \
    Run the full FIDO2 test suite and report pass/fail for each test case."
```

### What Happens

1. The CLI sends the task with `device: yubikey`. The API looks up the device registry.
2. The device registry knows that Runner 01 currently has a YubiKey 5 NFC attached (detected via udev rules, serial number YK-5284903). Runner 02 has an HSM. Runner 03 has no devices.
3. The scheduler constrains assignment to Runner 01 only. It checks that the YubiKey is not currently locked by another task (via flock-based device locking).
4. Runner 01 picks up the task. The worker daemon acquires an exclusive lock on the YubiKey device, sets the `FIDO2_DEVICE_PATH=/dev/hidraw2` environment variable, and spawns the runtime.
5. The agent runs the FIDO2 integration tests. The tests interact with the physical YubiKey for cryptographic operations (key generation, assertion signing).
6. When the task completes (or fails), the worker daemon releases the device lock.

### Result

```bash
$ orch task status mno345
Task:     mno345
Project:  login2
Runner:   runner-01
Device:   yubikey (YK-5284903)
Status:   completed
Duration: 3m 17s

Tests:
  [PASS] WebAuthn registration with resident key
  [PASS] WebAuthn authentication with UV
  [PASS] WebAuthn authentication without UV
  [FAIL] WebAuthn registration with non-resident key
    Error: Device returned CTAP2_ERR_KEY_STORE_FULL
    Note: YubiKey resident key slots may be full. Run `ykman fido credentials list` to check.
```

The user gets precise test results that could only be obtained with real hardware, not mocks.

---

## 5. Firmware/Hardware Work

### Scenario

You need to flash new firmware to an ESP32 dev board connected to Runner 02, then run integration tests that communicate with it over the serial console. This is for a future threat10 sensor prototype.

### Command

```bash
orch task submit \
  --project threat10 \
  --runtime crush \
  --model claude-sonnet-4 \
  --device esp32 \
  --prompt "Flash the firmware in firmware/sensor-v2.3.bin to the ESP32 using esptool.py. \
    After flashing, open the serial console at 115200 baud and verify the boot message \
    contains 'sensor-v2.3 ready'. Then run the integration test suite in tests/integration/ \
    which sends commands over serial and validates responses. \
    The serial device path is in the ESP32_SERIAL_PORT environment variable."
```

### What Happens

1. The task arrives with `device: esp32`. The device registry shows Runner 02 has an ESP32 DevKit v4 on `/dev/ttyUSB0`.
2. The scheduler assigns the task to Runner 02 exclusively. The worker daemon acquires the device lock on the ESP32's serial port.
3. The runtime adapter spawns Crush with the `ESP32_SERIAL_PORT=/dev/ttyUSB0` environment variable. The agent has shell access to the runner.
4. The agent runs `esptool.py --port $ESP32_SERIAL_PORT write_flash 0x0 firmware/sensor-v2.3.bin`. The firmware flashes to the device.
5. The agent opens the serial console, reads boot output, confirms the version string.
6. The agent executes the integration test suite, which sends structured commands over serial and validates the ESP32's responses.
7. On completion, the device lock is released and the serial port is available for other tasks.

### Result

```bash
$ orch task output pqr678
Task:     pqr678
Project:  threat10
Runner:   runner-02
Device:   esp32 (/dev/ttyUSB0)
Status:   completed
Duration: 7m 44s

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

Physical hardware interaction handled entirely by the runner fleet, no need to walk over to the device.

---

## 6. Long-Running Analysis

### Scenario

You want a deep architectural analysis of the entire peer6 codebase overnight. This is expensive and time-consuming, so you set a cost cap. Results should be waiting in the morning.

### Command

```bash
orch task submit \
  --project peer6 \
  --runtime claude-code \
  --model claude-opus-4 \
  --mode read-only \
  --cost-cap 15.00 \
  --priority low \
  --prompt "Perform a comprehensive architectural analysis of the peer6 codebase. \
    Cover: \
    1. Dependency graph between packages (apps/api, apps/web, packages/shared) \
    2. API endpoint inventory with auth requirements \
    3. Database schema analysis and migration history \
    4. Frontend component tree and state management patterns \
    5. Test coverage gaps \
    6. Dead code and unused exports \
    7. Performance concerns (N+1 queries, unnecessary re-renders, bundle size) \
    8. Security posture (input validation, auth checks, CORS, CSP) \
    Produce a structured report with actionable recommendations prioritized by impact."
```

### What Happens

1. The task is enqueued with `priority: low` and `cost-cap: $15.00`. Low-priority tasks yield to normal and high-priority tasks in the queue.
2. The scheduler waits until a runner is idle with no higher-priority work pending. At 6:47 PM, Runner 03 becomes free and picks up the task.
3. The worker daemon starts Claude Code in read-only mode. The runtime adapter tracks token usage in real time, translating it to estimated cost via the model's pricing.
4. The agent methodically reads through the entire codebase -- hundreds of files across three packages. It builds up its analysis iteratively.
5. At the $12.30 mark, the adapter logs a cost warning. At $14.50, it logs a cost alert. If the task hits $15.00, the adapter sends a graceful termination signal, giving the agent 60 seconds to produce a partial report before hard-killing the process.
6. The agent finishes its report at $11.87, well under the cap. Task completes at 2:14 AM.

### Result

The next morning:

```bash
$ orch task list --status completed --since 12h
ID       PROJECT  RUNTIME      COST     DURATION   STATUS
stu901   peer6    claude-code  $11.87   7h 27m     completed

$ orch task output stu901
--- Architectural Analysis: peer6 ---

## 1. Dependency Graph
apps/web depends on @peer6/shared (12 imports)
apps/api depends on @peer6/shared (8 imports)
No circular dependencies detected.
...

## 5. Test Coverage Gaps
- apps/web: 0 component tests (all 79 tests are API-level)
- No tests for: mentor matching algorithm, session scheduling conflicts,
  timezone conversion, email template rendering
- Recommended: Add Vitest + Testing Library for critical Svelte components
...

## 8. Security Posture
- CRITICAL: Rate limiting not implemented on /api/auth/* endpoints
- HIGH: CORS allows wildcard origin in development mode, but the env check
  uses NODE_ENV which is not set in the Cloudflare Workers runtime
...

Files analyzed: 247
Estimated cost: $11.87
```

A full architectural review was completed autonomously overnight for less than $12.

---

## 7. Approval Gate

### Scenario

A task tries to modify the CI/CD pipeline configuration, which is classified as a risky operation. The system pauses and waits for explicit user approval before proceeding.

### Command

The user submitted a normal implementation task:

```bash
orch task submit \
  --project peer6 \
  --runtime claude-code \
  --model claude-sonnet-4 \
  --prompt "Set up GitHub Actions to run the test suite on every PR. \
    Create the workflow file and configure it for the pnpm monorepo."
```

### What Happens

1. The task starts normally on Runner 01. Claude Code begins working.
2. The agent attempts to create `.github/workflows/ci.yml`. The runtime adapter detects that this path matches the approval-required rule for CI/CD configuration files (configured in the orchestrator's policy).
3. The worker daemon pauses the agent's execution. It reports `awaiting-approval` to the API with details of what the agent wants to do.
4. The user receives a notification (webhook to Slack, push notification, or the CLI polls and sees it):
   ```
   $ orch task list --status awaiting-approval
   ID       PROJECT  RUNNER     AWAITING
   vwx234   peer6    runner-01  File write: .github/workflows/ci.yml
   ```
5. The user reviews the proposed content:
   ```bash
   $ orch task approval vwx234 --show
   Task vwx234 wants to create:
     .github/workflows/ci.yml

   Proposed content:
   ---
   name: CI
   on:
     pull_request:
       branches: [main]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: pnpm/action-setup@v4
         - run: pnpm install --frozen-lockfile
         - run: pnpm test
   ---

   [approve / reject / modify]
   ```
6. The user approves:
   ```bash
   $ orch task approval vwx234 --approve
   ```
7. The worker daemon resumes the agent. The file write proceeds. The task continues to completion.

### Result

```bash
$ orch task status vwx234
Task:     vwx234
Project:  peer6
Runner:   runner-01
Status:   completed
Duration: 4m 12s (includes 22m approval wait)
Approvals: 1 (ci.yml creation approved by iain@link42.app)
```

Risky operations never happen silently. The user maintains control over changes to CI, deployment configs, secrets, and other sensitive files. The approval policy is configurable per project.

---

## 8. Session Continuation

### Scenario

A task completed 80% of the work -- it implemented the notification API endpoints but did not wire up the frontend components. You want to give follow-up instructions to finish the remaining 20%, keeping the full session context (the agent remembers what it already did).

### Command

```bash
# First, check what the task did:
$ orch task output abc123
...
Session: session_abc123_claude
Branch:  orch/task-abc123
Note:    Implemented notification API endpoints (GET /notifications, POST /notifications/read,
         WebSocket /notifications/stream). Frontend components not yet created.

# Continue the session:
$ orch task continue abc123 \
  --prompt "Good work on the API endpoints. Now create the frontend components: \
    1. NotificationBell.svelte - icon in the header that shows unread count \
    2. NotificationPanel.svelte - dropdown panel listing recent notifications \
    3. Wire up the WebSocket connection in a Svelte store for real-time updates \
    Follow the existing component patterns in src/lib/components/. \
    Run 'pnpm test' and 'pnpm check' when done."
```

### What Happens

1. The CLI sends a continuation request referencing task `abc123`. The API looks up the original task's session ID and runner assignment.
2. The scheduler routes the continuation to the same runner (Runner 01) that ran the original task. The working branch `orch/task-abc123` is still checked out with all the previous changes.
3. The worker daemon spawns Claude Code with the session resume flag:
   ```
   claude -p "Good work on the API endpoints. Now create the frontend..." \
     --resume session_abc123_claude \
     --output-format stream-json
   ```
4. Claude Code resumes with full context of the previous session -- it knows which files it created, what patterns it followed, and what remains. It implements the three frontend components and wires up the store.
5. It runs `pnpm test` (all tests pass) and `pnpm check` (no type errors).
6. The worker daemon commits the new changes to the same branch and reports completion.

### Result

```bash
$ orch task status abc123-cont-1
Task:     abc123-cont-1
Parent:   abc123
Project:  peer6
Runner:   runner-01
Session:  session_abc123_claude (resumed)
Status:   completed
Duration: 8m 55s
Cost:     $1.42 (session total: $3.60)
Branch:   orch/task-abc123
Files:    5 changed, 312 insertions, 8 deletions
Tests:    97 passed, 0 failed
```

The branch now contains the complete notification system -- API and frontend -- ready for a single PR. Session context preserved seamlessly.

---

## 9. Model/Runtime Switching

### Scenario

You have a complex refactoring task and you want to compare how different runtimes and models handle it. Run the same task twice with different configurations and compare the results.

### Command

```bash
# Attempt 1: Claude Code with Opus
orch task submit \
  --project peer6 \
  --runtime claude-code \
  --model claude-opus-4 \
  --tag refactor-comparison \
  --prompt "Refactor the mentor matching algorithm in src/lib/matching.ts. \
    Currently it's a single 200-line function. Break it into: \
    1. A scoring module that weights different match criteria \
    2. A filtering module that eliminates incompatible pairs \
    3. A ranking module that sorts candidates \
    Each module should be independently testable. \
    Write tests for each module. Run 'pnpm test' to confirm."

# Attempt 2: Crush with Gemini 2.5 Pro
orch task submit \
  --project peer6 \
  --runtime crush \
  --model gemini-2.5-pro \
  --tag refactor-comparison \
  --prompt "Refactor the mentor matching algorithm in src/lib/matching.ts. \
    Currently it's a single 200-line function. Break it into: \
    1. A scoring module that weights different match criteria \
    2. A filtering module that eliminates incompatible pairs \
    3. A ranking module that sorts candidates \
    Each module should be independently testable. \
    Write tests for each module. Run 'pnpm test' to confirm."
```

### What Happens

1. Both tasks are enqueued simultaneously with the same tag `refactor-comparison`. The scheduler assigns them to different runners so they execute in parallel.
2. Each runner checks out a separate branch: `orch/task-yz1234` and `orch/task-yz5678`.
3. Both agents work on the same refactoring task independently, each using their respective model and runtime.
4. Results are tagged so they can be compared side by side.

### Result

```bash
$ orch task list --tag refactor-comparison
ID       RUNTIME      MODEL             COST    DURATION  TESTS    FILES
yz1234   claude-code  claude-opus-4     $3.41   22m 18s  12 pass  8 changed
yz5678   crush        gemini-2.5-pro    $1.89   15m 03s  10 pass  6 changed

$ orch task diff yz1234 yz5678
Comparing branches: orch/task-yz1234 vs orch/task-yz5678

Structural differences:
- yz1234 created 3 separate files (scoring.ts, filtering.ts, ranking.ts)
  yz5678 kept everything in matching.ts with exported sub-functions
- yz1234 wrote 12 tests covering edge cases
  yz5678 wrote 10 tests, missed the "no matching mentors" edge case
- yz1234 added JSDoc comments to all public functions
  yz5678 did not add documentation
```

The user can pick the better result, or cherry-pick the best parts of each. The comparison helps calibrate which model/runtime combination works best for different task types.

---

## 10. Scheduled/Recurring Work

### Scenario

You want the peer6 test suite to run every morning at 6:00 AM AEST and notify you if anything fails. This acts as a continuous health check driven by the orchestrator, not a CI system.

### Command

```bash
orch schedule create \
  --name "peer6-morning-tests" \
  --project peer6 \
  --runtime crush \
  --model claude-haiku-4 \
  --cron "0 6 * * * Australia/Sydney" \
  --mode read-only \
  --cost-cap 0.50 \
  --notify-on failure \
  --notify-channel slack:#link42-alerts \
  --prompt "Pull the latest main branch. Run 'pnpm install' then 'pnpm test'. \
    Report the results. If any tests fail, analyze the failure and suggest a fix. \
    Do not modify any files."
```

### What Happens

1. The API stores the schedule definition. A cron evaluator checks it every minute.
2. At 6:00 AM AEST each day, the scheduler creates a new task from the schedule template and enqueues it at `normal` priority.
3. An available runner picks it up, pulls the latest code, runs the test suite.
4. If all tests pass: the task completes silently. The result is logged but no notification is sent (the user configured `--notify-on failure`).
5. If a test fails: the agent analyzes the failure, writes a diagnostic report, and the API fires a Slack webhook to `#link42-alerts`.

### Result

On a good day -- nothing. Silence means the tests pass.

On a bad day:

```
#link42-alerts
[orch] peer6-morning-tests FAILED (task: sched-20260322-0600)

3 tests failed:
- POST /api/sessions - 500: D1 binding not found (migration 014 added a new table
  but the D1 binding name changed in wrangler.toml and tests weren't updated)

Suggested fix: Update vitest.config.ts D1 binding from "DB" to "PEER6_DB"
to match the wrangler.toml change in commit a3f8e21.

Full log: https://orch.link42.dev/tasks/sched-20260322-0600/log
Cost: $0.23
```

The user wakes up informed, with a diagnosis and suggested fix, rather than discovering the break mid-afternoon.

---

## 11. Cross-Project Coordination

### Scenario

You have updated the auth middleware in login2 to add a new session field (`organization_id`). Now peer6's auth client SDK needs to be updated to expect and use this field. The second task should only start after the first one is confirmed complete and correct.

### Command

```bash
# Step 1: Make the change in login2
TASK_ID=$(orch task submit \
  --project login2 \
  --runtime claude-code \
  --model claude-sonnet-4 \
  --output id \
  --prompt "Add 'organization_id' to the session response in the auth middleware. \
    Update the session type in types.ts, the session creation in auth.ts, \
    and the GET /api/auth/get-session endpoint to include the org ID from the user record. \
    Run tests to confirm.")

# Step 2: Update peer6's client, triggered after step 1 completes
orch task submit \
  --project peer6 \
  --runtime claude-code \
  --model claude-sonnet-4 \
  --depends-on $TASK_ID \
  --prompt "The login2 auth service now returns 'organization_id' in the session response. \
    Update peer6's auth client in src/lib/auth/client.ts to: \
    1. Add organization_id to the Session type \
    2. Store it in the auth store \
    3. Use it in the API middleware to scope queries to the user's org \
    4. Update existing tests and add new ones for org-scoped behavior \
    Run 'pnpm test' to confirm."
```

### What Happens

1. Task 1 (login2) is enqueued and begins executing immediately on an available runner.
2. Task 2 (peer6) is enqueued with `depends-on: <task-1-id>`. The scheduler holds it in `pending-dependency` state.
3. Task 1 completes successfully. The API evaluates the dependency graph and promotes Task 2 to `queued`.
4. If Task 1 had failed, Task 2 would be moved to `blocked` status with a notification to the user, rather than proceeding with stale assumptions.
5. Task 2 picks up on a runner, implements the peer6 side of the change.

### Result

```bash
$ orch task list --group "org-id-rollout"
ID       PROJECT  STATUS     DEPENDS-ON  DURATION
ab1111   login2   completed  -           9m 33s
ab2222   peer6    completed  ab1111      11m 07s

# Both branches are ready for coordinated PRs
```

The dependency chain ensures that cross-project changes happen in the right order and that downstream tasks do not start until upstream work is verified.

---

## 12. Fleet Management

### Scenario

Runner 02 needs a kernel update and reboot. You want to drain its current tasks gracefully, take it offline, perform maintenance, and bring it back.

### Command

```bash
# Check current fleet status
$ orch fleet status
RUNNER      STATUS   TASKS  DEVICES         UPTIME    LOAD
runner-01   online   1      yubikey(YK5)    14d 3h    0.42
runner-02   online   2      hsm(Luna7)      14d 3h    0.87
runner-03   online   0      (none)          14d 3h    0.11

# Drain runner-02: stop accepting new tasks, wait for current ones to finish
$ orch fleet drain runner-02
Runner runner-02 draining. 2 tasks in progress.
New tasks will not be routed to this runner.

# Monitor the drain
$ orch fleet status runner-02
RUNNER      STATUS     TASKS  NOTE
runner-02   draining   1      Task cd3333 completed. Task cd4444 running (est. 8m remaining).

# Once drained:
$ orch fleet status runner-02
RUNNER      STATUS     TASKS
runner-02   drained    0

# Take it offline
$ orch fleet offline runner-02 --reason "Kernel update"
Runner runner-02 marked offline.

# ... perform maintenance via SSH ...

# Bring it back
$ orch fleet online runner-02
Runner runner-02 online. Health check passed.
Devices detected: hsm (Luna SA 7, serial LUN-40982)
Ready to accept tasks.
```

### What Happens

1. `fleet drain` sets the runner's state to `draining` in the API. The scheduler immediately stops routing new tasks to it.
2. Tasks already running on the runner continue to completion. The drain command does not kill them.
3. Once all tasks finish, the state transitions to `drained`.
4. `fleet offline` marks the runner as unavailable. The worker daemon on the runner enters standby (or the user SSHs in and does maintenance).
5. `fleet online` triggers a health check: the worker daemon on the runner confirms it can reach the API, reports its device inventory, and the scheduler begins routing tasks to it again.

### Result

Zero task disruption. The two tasks running on Runner 02 completed normally. During the maintenance window (say, 20 minutes), the fleet operated at 2/3 capacity. Once Runner 02 came back online, full capacity was restored.

---

## 13. Cost Monitoring

### Scenario

You want to see how much you have spent today, this week, and this month across all projects, and identify which tasks or projects are the most expensive.

### Command

```bash
# Summary
$ orch cost summary
Period       Total     Tasks   Avg/Task
Today        $4.82     3       $1.61
This week    $31.47    22      $1.43
This month   $127.93   89      $1.44

# By project
$ orch cost breakdown --by project --period month
PROJECT   TOTAL     TASKS   PCT
peer6     $68.41    47      53%
login2    $31.22    23      24%
rule1     $18.90    12      15%
threat10  $9.40     7       8%

# By model
$ orch cost breakdown --by model --period month
MODEL              TOTAL     TASKS
claude-opus-4      $72.18    31
claude-sonnet-4    $41.90    42
claude-haiku-4     $8.15     12
gemini-2.5-pro     $5.70     4

# Most expensive single task
$ orch cost top --period month --limit 5
ID       PROJECT  MODEL           COST     DURATION  DESCRIPTION
stu901   peer6    claude-opus-4   $11.87   7h 27m   Architectural analysis
fg6789   peer6    claude-opus-4   $8.23    4h 12m   Test coverage expansion
...
```

### What Happens

1. The CLI queries the API's cost tracking endpoints. Every task records its token usage and maps it to the model's pricing at the time of execution.
2. Costs are attributed to projects, models, runners, and time periods.
3. The API stores costs per-task, and aggregation is computed on query.

### Result

Full visibility into spend. The user can identify cost trends, set per-project budgets, and adjust model choices (e.g., switching routine tasks from Opus to Sonnet) based on real data. The `--cost-cap` flag on individual tasks (see Use Case 6) provides guardrails at the task level, while `orch cost` provides the portfolio view.

---

## 14. Emergency Stop

### Scenario

Something is going wrong -- an agent is writing unexpected files, costs are spiking, or a task is behaving erratically. You need to stop everything immediately.

### Command

```bash
# Stop all running tasks across all runners
$ orch stop --all
WARNING: This will terminate 3 running tasks on 2 runners.
Confirm? [y/N]: y

Sending SIGTERM to runner-01 task ef4444... terminated
Sending SIGTERM to runner-01 task ef5555... terminated
Sending SIGTERM to runner-03 task ef6666... terminated

All tasks terminated. Runners idle.
```

Or, to stop a single task:

```bash
$ orch stop ef4444
Task ef4444 terminated on runner-01.
```

Or, to stop all tasks for a specific project:

```bash
$ orch stop --project peer6
Terminated 2 tasks for project peer6.
```

### What Happens

1. `orch stop --all` sends a broadcast termination command to the API.
2. The API sends a `terminate` signal to every runner with active tasks via the Tailscale mesh.
3. Each runner's worker daemon sends SIGTERM to the running agent process. The runtime adapter logs the termination event with full context (what the agent was doing when killed, which files were modified).
4. If the agent does not exit within 10 seconds of SIGTERM, SIGKILL is sent.
5. Any file changes made by the terminated agents are left on their working branches (not committed), so nothing is lost but nothing is merged either.
6. All terminated tasks are marked `terminated` in the API with a record of who initiated the stop and when.

### Result

```bash
$ orch task list --status terminated --since 1h
ID       PROJECT  RUNNER     TERMINATED-BY   REASON
ef4444   peer6    runner-01  iain@link42.app  manual stop --all
ef5555   peer6    runner-01  iain@link42.app  manual stop --all
ef6666   login2   runner-03  iain@link42.app  manual stop --all
```

Full control is restored within seconds. The user can inspect the partial work on the branches, decide what to keep, and resubmit tasks if appropriate. The audit log records every detail of what happened.

---

## 15. Device Disconnection

### Scenario

A task is queued that requires a YubiKey, but the YubiKey has been unplugged from Runner 01 (someone borrowed it, or the USB cable came loose). The system needs to handle this gracefully rather than silently failing.

### Command

The user submits a device-dependent task:

```bash
orch task submit \
  --project login2 \
  --runtime claude-code \
  --model claude-sonnet-4 \
  --device yubikey \
  --prompt "Run the FIDO2 credential management tests."
```

### What Happens

1. The task arrives with `device: yubikey`. The scheduler queries the device registry.
2. The device registry's last health check (run every 60 seconds via udev monitoring) shows that Runner 01's YubiKey was disconnected 4 minutes ago. No other runner has a YubiKey.
3. The scheduler cannot assign the task to any runner. It moves the task to `waiting-device` state.
4. The user is notified immediately:
   ```
   $ orch task status gh7890
   Task:     gh7890
   Project:  login2
   Status:   waiting-device
   Required: yubikey
   Issue:    No runner has a YubiKey connected.
             Last seen: runner-01, disconnected 4m ago.
   Action:   Plug a YubiKey into any runner, or cancel this task.
   ```
5. The notification also fires via the configured channel (Slack, webhook, etc.):
   ```
   #link42-alerts
   [orch] Task gh7890 waiting for device: yubikey
   No runner has a YubiKey connected. Last seen on runner-01 (disconnected 4m ago).
   Plug in a YubiKey or cancel the task.
   ```
6. Twenty minutes later, the user plugs the YubiKey back into Runner 01. The udev monitor detects it, the worker daemon reports the device to the API, and the device registry updates.
7. The scheduler sees the device is now available, assigns the task to Runner 01, and execution begins automatically.

### Result

```bash
$ orch task status gh7890
Task:     gh7890
Project:  login2
Status:   completed
Duration: 3m 08s (waited 20m 14s for device)
Device:   yubikey (YK-5284903) on runner-01
Tests:    4 passed, 0 failed
```

The task was never lost or silently failed. It waited for the required hardware, executed as soon as the device was available, and reported the wait time transparently. If the user had decided the device would not be available, they could have cancelled with `orch stop gh7890`.

---

## Summary

These fifteen use cases cover the primary interaction patterns with code-orchestration:

| # | Use Case | Key Feature |
|---|----------|-------------|
| 1 | Basic implementation | Task submission, agent execution, branch output |
| 2 | Multi-project parallel | Concurrent tasks across runners |
| 3 | Code review | Read-only mode, structured reports |
| 4 | Device-dependent testing | Device registry, hardware routing, device locking |
| 5 | Firmware/hardware | Serial console access, physical device flashing |
| 6 | Long-running analysis | Cost caps, low priority, overnight execution |
| 7 | Approval gate | Policy-based pause, human-in-the-loop |
| 8 | Session continuation | Context preservation, follow-up prompts |
| 9 | Model/runtime switching | A/B comparison, tagged results |
| 10 | Scheduled/recurring | Cron-based execution, failure-only notifications |
| 11 | Cross-project coordination | Task dependencies, ordered execution |
| 12 | Fleet management | Drain, offline, online lifecycle |
| 13 | Cost monitoring | Per-project, per-model, per-period aggregation |
| 14 | Emergency stop | Immediate termination, audit trail |
| 15 | Device disconnection | Graceful degradation, auto-retry on reconnect |
