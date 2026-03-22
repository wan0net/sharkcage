# Data Flows

Sequence diagrams and data flow descriptions for every major operation in the
code-orchestration system. This is the definitive reference for how data moves
between components.

## Component Key

| Abbreviation | Component | Description |
|-------------|-----------|-------------|
| CLI | `co` binary | Runs on user's laptop |
| API | Hono app | Cloudflare Workers or self-hosted, backed by SQLite/D1 |
| Redis | Redis server | Message broker for BullMQ, pub/sub for streaming |
| Runner | Worker daemon | Runs on each Dell 5070 thin client |
| Runtime | Coding agent | Claude Code, Crush, Aider -- spawned by Runner |
| Git | GitHub | Remote repository hosting |
| Ntfy | Ntfy server | Push notification service |

---

## 1. Task Submission

User submits a task via CLI. The task is enqueued, picked up by a runner,
executed by a coding agent, and results in a branch + PR.

```
co run peer6 "implement feature X"
```

```
  CLI              API              Redis            Runner           Runtime          Git              Ntfy
   |                |                |                |                |                |                |
   |-- POST /tasks ----------------->|                |                |                |                |
   |   {                             |                |                |                |                |
   |     project: "peer6",          |                |                |                |                |
   |     prompt: "implement...",    |                |                |                |                |
   |     runtime: "claude-code",    |                |                |                |                |
   |     priority: "normal"         |                |                |                |                |
   |   }                             |                |                |                |                |
   |                                 |                |                |                |                |
   |                |-- INSERT INTO tasks (...) ----->|                |                |                |
   |                |   (SQLite: status='queued')     |                |                |                |
   |                |                |                |                |                |                |
   |                |-- LPUSH bull:peer6:wait ------->|                |                |                |
   |                |   (job payload: task_id,        |                |                |                |
   |                |    project, prompt, runtime)    |                |                |                |
   |                |                |                |                |                |                |
   |<-- 201 {task_id: "t_abc123"} ---|                |                |                |                |
   |                |                |                |                |                |                |
   |   (CLI prints task_id          |                |                |                |                |
   |    and exits)                   |                |                |                |                |
   |                |                |                |                |                |                |
   |                |                |-- BRPOPLPUSH ->|                |                |                |
   |                |                |   bull:peer6:wait               |                |                |
   |                |                |   -> bull:peer6:active          |                |                |
   |                |                |                |                |                |                |
   |                |                |                |-- git worktree add ------------>|                |
   |                |                |                |   /work/peer6/t_abc123          |                |
   |                |                |                |   (from main branch)            |                |
   |                |                |                |                |                |                |
   |                |                |                |-- git checkout -b ------------->|                |
   |                |                |                |   co/peer6-abc123               |                |
   |                |                |                |                |                |                |
   |                |<-- PUT /tasks/t_abc123 ---------|                |                |                |
   |                |   {status: "running",           |                |                |                |
   |                |    runner_id: "dell-01"}         |                |                |                |
   |                |-- UPDATE tasks SET status='running' -->|         |                |                |
   |                |                |                |                |                |                |
   |                |                |                |-- spawn ------>|                |                |
   |                |                |                |   claude -p "implement..."      |                |
   |                |                |                |   --output-format stream-json   |                |
   |                |                |                |   (cwd=/work/peer6/t_abc123)    |                |
   |                |                |                |                |                |                |
   |                |                |                |<-- stdout -----|                |                |
   |                |                |                |   (streaming JSON lines)        |                |
   |                |                |                |                |                |                |
   |                |                |<-- PUBLISH ----|                |                |                |
   |                |                |   task:t_abc123:output          |                |                |
   |                |                |   (each output line)            |                |                |
   |                |                |                |                |                |                |
   |                |                |                |   ... runtime works ...         |                |
   |                |                |                |                |                |                |
   |                |                |                |<-- exit 0 -----|                |                |
   |                |                |                |                |                |                |
   |                |                |                |-- git add -A ------------------>|                |
   |                |                |                |-- git commit -m "..." --------->|                |
   |                |                |                |-- git push origin co/peer6-abc123 ->|            |
   |                |                |                |                |                |                |
   |                |                |                |-- gh pr create --draft -------->|                |
   |                |                |                |   --title "co: implement..."    |                |
   |                |                |                |   --body "Task: t_abc123\n..."  |                |
   |                |                |                |                |                |                |
   |                |                |                |-- git worktree remove --------->|                |
   |                |                |                |   /work/peer6/t_abc123          |                |
   |                |                |                |                |                |                |
   |                |<-- PUT /tasks/t_abc123 ---------|                |                |                |
   |                |   {status: "completed",         |                |                |                |
   |                |    branch: "co/peer6-abc123",   |                |                |                |
   |                |    pr_url: "https://...",        |                |                |                |
   |                |    cost_usd: 0.42,              |                |                |                |
   |                |    session_id: "ses_xyz"}        |                |                |                |
   |                |                |                |                |                |                |
   |                |-- UPDATE tasks SET status='completed' -->|       |                |                |
   |                |                |                |                |                |                |
   |                |-- LREM bull:peer6:active ------>|                |                |                |
   |                |                |                |                |                |                |
   |                |-- POST ntfy/co-tasks --------------------------------------------->|
   |                |   {title: "Task completed",                                        |
   |                |    message: "peer6/t_abc123: implement feature X",                 |
   |                |    click: "https://github.com/.../pull/42"}                        |
   |                |                |                |                |                |                |
```

### Error Path: Runtime Fails

```
  Runner           Runtime          API              Redis            Ntfy
   |                |                |                |                |
   |-- spawn ------>|                |                |                |
   |                |                |                |                |
   |<-- exit 1 -----|                |                |                |
   |   (non-zero exit code)         |                |                |
   |                                 |                |                |
   |-- check retry policy           |                |                |
   |   (see Flow 13)                |                |                |
   |                                 |                |                |
   |   [if no retries remaining]    |                |                |
   |                                 |                |                |
   |-- git worktree remove -------->|                |                |
   |                                 |                |                |
   |-- PUT /tasks/t_abc123 -------->|                |                |
   |   {status: "failed",           |                |                |
   |    error: "exit code 1",       |                |                |
   |    stderr: "...last 50 lines"}  |                |                |
   |                                 |                |                |
   |                |-- UPDATE tasks SET status='failed' -->|         |
   |                |-- LREM bull:peer6:active ------------->|         |
   |                |                |                |                |
   |                |-- POST ntfy/co-tasks ---------------------------------------->|
   |                |   {title: "Task FAILED",        |                |             |
   |                |    priority: 4,                  |                |             |
   |                |    message: "peer6/t_abc123 failed: exit code 1"}              |
```

### Error Path: API Unreachable at Submission

```
  CLI              API
   |                |
   |-- POST /tasks ->
   |                X  (connection refused / timeout)
   |                |
   |   CLI retries 2x with exponential backoff
   |   (1s, then 3s)
   |                |
   |-- POST /tasks ->
   |                X  (still unreachable)
   |                |
   |   CLI prints error:
   |   "Error: API unreachable at https://co.link42.app
   |    after 3 attempts. Is the API running?"
   |   exit 1
```

---

## 2. Task Routing (Device-Aware)

User submits a task that requires a specific USB device. The API routes it
to a runner that has the device attached.

```
co run login2 "test FIDO2" --needs yubikey
```

```
  CLI              API              Redis            Runner (dell-01)  Runner (dell-02)
   |                |                |                |  (has yubikey)   |  (no yubikey)
   |                |                |                |                  |
   |-- POST /tasks ----------------->|                |                  |
   |   {                             |                |                  |
   |     project: "login2",         |                |                  |
   |     prompt: "test FIDO2",      |                |                  |
   |     needs: ["yubikey"],        |                |                  |
   |     runtime: "claude-code"     |                |                  |
   |   }                             |                |                  |
   |                                 |                |                  |
   |                |-- SELECT * FROM runners ------->|                  |
   |                |   WHERE status = 'online'       |                  |
   |                |   AND 'yubikey' IN devices      |                  |
   |                |                |                |                  |
   |                |   Result: [dell-01]             |                  |
   |                |                |                |                  |
   |                |   [if no runners with device]   |                  |
   |                |   -> 409 {error: "No online     |                  |
   |                |      runners with yubikey"}     |                  |
   |                |   -> CLI shows error, exit 1    |                  |
   |                |                |                |                  |
   |                |-- INSERT INTO tasks             |                  |
   |                |   (assigned_runner='dell-01',   |                  |
   |                |    required_devices='yubikey')   |                  |
   |                |                |                |                  |
   |                |-- LPUSH bull:dell-01:wait ----->|                  |
   |                |   (device-specific queue)       |                  |
   |                |                |                |                  |
   |<-- 201 {task_id, assigned: "dell-01"} ----------|                  |
   |                |                |                |                  |
   |                |                |-- BRPOPLPUSH ->|                  |
   |                |                |   bull:dell-01:wait              |
   |                |                |   -> bull:dell-01:active          |
   |                |                |                |                  |
   |                |                |                |-- flock /dev/yubikey.lock
   |                |                |                |   (exclusive file lock)
   |                |                |                |                  |
   |                |                |                |   [if lock fails]
   |                |                |                |   -> delay task, retry after 5s
   |                |                |                |   (another task holds the device)
   |                |                |                |                  |
   |                |                |                |   [lock acquired]
   |                |                |                |                  |
   |                |                |                |-- spawn runtime
   |                |                |                |   (with device access)
   |                |                |                |                  |
   |                |                |                |   ... task runs ...
   |                |                |                |                  |
   |                |                |                |-- flock --unlock
   |                |                |                |   /dev/yubikey.lock
   |                |                |                |                  |
   |                |                |                |-- report completed
```

### Device Queue Selection Logic (API)

```
API receives POST /tasks with needs: ["yubikey"]

  1. Query: SELECT runner_id, devices FROM runners
            WHERE status = 'online'
            AND JSON_EACH(devices) INCLUDES 'yubikey'

  2. If 0 results:
     -> Return 409 "No runners with required device"

  3. If 1 result:
     -> Enqueue to bull:{runner_id}:wait

  4. If N results:
     -> Pick runner with fewest active tasks (load balancing)
     -> Enqueue to bull:{runner_id}:wait

  5. If needs is empty (no device requirement):
     -> Enqueue to bull:{project}:wait (any runner can pick it up)
```

---

## 3. Runner Registration (Boot)

A Dell 5070 boots and the runner daemon starts. It inventories its
hardware, registers with the API, and begins consuming task queues.

```
  Runner (dell-01)                  udev             API              Redis
   |                                 |                |                |
   |-- systemd starts co-runner.service              |                |
   |                                 |                |                |
   |-- read /etc/co-runner/config.yaml               |                |
   |   {                             |                |                |
   |     runner_id: "dell-01",      |                |                |
   |     api_url: "https://co.link42.app",           |                |
   |     projects: ["peer6","login2","rule1"],        |                |
   |     workspace: "/work",        |                |                |
   |     runtimes: ["claude-code","crush"]            |                |
   |   }                             |                |                |
   |                                 |                |                |
   |-- enumerate USB devices ------->|                |                |
   |   (udevadm info --export-db)   |                |                |
   |                                 |                |                |
   |<-- device list -----------------|                |                |
   |   [                             |                |                |
   |     {type: "yubikey",           |                |                |
   |      serial: "12345678",       |                |                |
   |      path: "/dev/hidraw0"},    |                |                |
   |   ]                             |                |                |
   |                                 |                |                |
   |-- check runtime availability   |                |                |
   |   (which claude, which crush)   |                |                |
   |                                 |                |                |
   |-- check git credentials        |                |                |
   |   (gh auth status)             |                |                |
   |                                 |                |                |
   |-- POST /runners --------------->|                |                |
   |   {                             |                |                |
   |     runner_id: "dell-01",      |                |                |
   |     hostname: "dell-01.tailnet",|                |                |
   |     status: "online",          |                |                |
   |     projects: ["peer6","login2","rule1"],        |                |
   |     devices: [                  |                |                |
   |       {type:"yubikey", serial:"12345678"}        |                |
   |     ],                          |                |                |
   |     runtimes: ["claude-code","crush"],           |                |
   |     capabilities: {             |                |                |
   |       max_concurrent: 2,       |                |                |
   |       cpu_cores: 4,            |                |                |
   |       ram_gb: 8                |                |                |
   |     },                          |                |                |
   |     version: "0.1.0"           |                |                |
   |   }                             |                |                |
   |                                 |                |                |
   |                |-- UPSERT runners SET ---------->|                |
   |                |   status='online', ...          |                |
   |                |                |                |                |
   |<-- 200 {registered: true,      |                |                |
   |     queues: [                   |                |                |
   |       "bull:peer6:wait",       |                |                |
   |       "bull:login2:wait",      |                |                |
   |       "bull:rule1:wait",       |                |                |
   |       "bull:dell-01:wait"      |                |                |
   |     ]}                          |                |                |
   |                                 |                |                |
   |-- connect to Redis --------------------------------------------->|
   |                                 |                |                |
   |-- BRPOPLPUSH on queues: ---------------------------------------->|
   |   bull:dell-01:wait (device-specific, highest priority)          |
   |   bull:peer6:wait                                                |
   |   bull:login2:wait                                               |
   |   bull:rule1:wait                                                |
   |   (blocks until a job arrives)                                   |
   |                                 |                |                |
   |-- start udev monitor ---------->|                |                |
   |   (inotify on /dev for hotplug) |                |                |
   |                                 |                |                |
   |-- start heartbeat loop         |                |                |
   |   (every 30s, see Flow 4)      |                |                |
   |                                 |                |                |
   |   [Runner is now ONLINE and     |                |                |
   |    consuming from queues]       |                |                |
```

### Error Path: API Unreachable at Boot

```
  Runner (dell-01)                  API
   |                                 |
   |-- POST /runners --------------->|
   |                                 X  (connection refused)
   |                                 |
   |   Runner retries with exponential backoff:
   |   attempt 1: wait 5s
   |   attempt 2: wait 15s
   |   attempt 3: wait 30s
   |   attempt 4: wait 60s
   |   ... (max backoff: 5 minutes)
   |                                 |
   |   Runner stays in UNREGISTERED state.
   |   Does NOT consume from any queues.
   |   Continues retry loop indefinitely.
   |                                 |
   |   (If API becomes reachable, normal
   |    registration proceeds)
```

---

## 4. Heartbeat / Health Check

Every 30 seconds, each runner sends a heartbeat to the API. If three
consecutive heartbeats are missed (90 seconds), the API marks the runner
offline and requeues any in-progress tasks.

### Normal Heartbeat

```
  Runner (dell-01)                  API              Redis
   |                                 |                |
   |   [every 30 seconds]           |                |
   |                                 |                |
   |-- check local state:           |                |
   |   - enumerate USB devices      |                |
   |   - check current task PID     |                |
   |   - measure CPU / memory       |                |
   |                                 |                |
   |-- PUT /runners/dell-01/heartbeat ->              |
   |   {                             |                |
   |     timestamp: "2026-03-22T10:00:30Z",           |
   |     status: "online",          |                |
   |     current_task: "t_abc123",  |                |
   |     task_status: "running",    |                |
   |     devices: [                  |                |
   |       {type:"yubikey", serial:"12345678"}        |
   |     ],                          |                |
   |     load: {                     |                |
   |       cpu_pct: 45,             |                |
   |       mem_pct: 62,             |                |
   |       disk_pct: 31             |                |
   |     }                           |                |
   |   }                             |                |
   |                                 |                |
   |                |-- UPDATE runners SET             |
   |                |   last_heartbeat = NOW(),       |
   |                |   load = {...},                 |
   |                |   devices = [...]               |
   |                |                |                |
   |<-- 200 {ack: true} ------------|                |
   |                                 |                |
```

### Missed Heartbeat / Runner Goes Offline

```
  API (background cron / interval)  Redis            Runner (dell-01)  Ntfy
   |                                 |                |                 |
   |   [every 30 seconds, API checks for stale runners]                |
   |                                 |                |                 |
   |-- SELECT * FROM runners         |                |                 |
   |   WHERE last_heartbeat          |                |                 |
   |     < NOW() - INTERVAL 90s     |                |                 |
   |   AND status = 'online'         |                |                 |
   |                                 |                |                 |
   |   Result: [dell-01]            |                |                 |
   |   (last heartbeat 95 seconds ago)                |                 |
   |                                 |                |                 |
   |-- UPDATE runners SET           |                X  (runner is     |
   |   status = 'offline'           |                |   unreachable)  |
   |   WHERE runner_id = 'dell-01'  |                |                 |
   |                                 |                |                 |
   |-- SELECT * FROM tasks           |                |                 |
   |   WHERE runner_id = 'dell-01'  |                |                 |
   |   AND status = 'running'       |                |                 |
   |                                 |                |                 |
   |   Result: [t_abc123]           |                |                 |
   |                                 |                |                 |
   |-- UPDATE tasks SET             |                |                 |
   |   status = 'queued',           |                |                 |
   |   runner_id = NULL,            |                |                 |
   |   requeue_count = requeue_count + 1              |                 |
   |                                 |                |                 |
   |-- LPUSH bull:peer6:wait ------->|                |                 |
   |   (re-enqueue the task)         |                |                 |
   |                                 |                |                 |
   |-- POST ntfy/co-fleet -------------------------------------------------------->|
   |   {title: "Runner OFFLINE",     |                |                |            |
   |    message: "dell-01 missed 3 heartbeats. Task t_abc123 requeued.",            |
   |    priority: 4,                 |                |                |            |
   |    tags: "warning"}             |                |                |            |
   |                                 |                |                |            |
```

### Runner Recovers After Going Offline

```
  Runner (dell-01)                  API              Redis
   |                                 |                |
   |   (network restored / runner restarted)          |
   |                                 |                |
   |-- PUT /runners/dell-01/heartbeat ->              |
   |   {status: "online", ...}      |                |
   |                                 |                |
   |                |-- UPDATE runners SET             |
   |                |   status = 'online',            |
   |                |   last_heartbeat = NOW()         |
   |                |                |                |
   |<-- 200 {ack: true,             |                |
   |     missed_heartbeats: 4,      |                |
   |     was_offline: true}          |                |
   |                                 |                |
   |-- check if previous task's worktree still exists |
   |   (if so, clean it up)          |                |
   |                                 |                |
   |-- resume consuming queues ----------------------------->|
```

---

## 5. Approval Gate

A runtime attempts a sensitive operation (git push, CI config edit,
secrets access). The runtime adapter intercepts the call, pauses the task,
and requests human approval.

### Approval Flow (APPROVED)

```
  Runtime          Runner           API              Redis            Ntfy             CLI
   |                |                |                |                |                |
   |-- attempt:     |                |                |                |                |
   |   git push     |                |                |                |                |
   |                |                |                |                |                |
   |   [adapter hook intercepts     |                |                |                |
   |    before execution]            |                |                |                |
   |                |                |                |                |                |
   |-- SIGSTOP ---->|                |                |                |                |
   |   (runtime     |                |                |                |                |
   |    paused)     |                |                |                |                |
   |                |                |                |                |                |
   |                |-- POST /tasks/t_abc123/approvals ->              |                |
   |                |   {                             |                |                |
   |                |     action: "git push",        |                |                |
   |                |     target: "origin/co/peer6-abc123",           |                |
   |                |     risk_level: "medium",      |                |                |
   |                |     context: "Pushing 3 commits, 142 lines changed",             |
   |                |     files_affected: ["src/auth.ts","src/auth.test.ts"]            |
   |                |   }                             |                |                |
   |                |                |                |                |                |
   |                |                |-- INSERT INTO approvals ------>|                |
   |                |                |   (id='apr_001',               |                |
   |                |                |    task_id='t_abc123',         |                |
   |                |                |    status='pending')           |                |
   |                |                |                |                |                |
   |                |                |-- POST ntfy/co-approvals ----->|                |
   |                |                |   {title: "Approval needed",  |                |
   |                |                |    message: "git push on peer6/t_abc123",       |
   |                |                |    actions: [                  |                |
   |                |                |      {action:"view", label:"Details",           |
   |                |                |       url: "https://co.link42.app/..."}          |
   |                |                |    ]}                          |                |
   |                |                |                |                |                |
   |                |<-- 201 {approval_id: "apr_001"} |                |                |
   |                |                |                |                |                |
   |                |-- SUBSCRIBE task:t_abc123:approval ------------>|                |
   |                |   (block waiting for decision)  |                |                |
   |                |                |                |                |                |
   |                |                |                |                |    (user sees  |
   |                |                |                |                |     Ntfy push) |
   |                |                |                |                |                |
   |                |                |                |                |                |-- co approve apr_001
   |                |                |                |                |                |
   |                |                |<-- PUT /approvals/apr_001 -----|<---------------|
   |                |                |   {decision: "approved",       |                |
   |                |                |    approved_by: "iain"}        |                |
   |                |                |                |                |                |
   |                |                |-- UPDATE approvals SET         |                |
   |                |                |   status='approved',           |                |
   |                |                |   decided_at=NOW()             |                |
   |                |                |                |                |                |
   |                |                |-- PUBLISH ----->|                |                |
   |                |                |   task:t_abc123:approval       |                |
   |                |                |   {decision: "approved"}       |                |
   |                |                |                |                |                |
   |                |<-- message ----|<---------------|                |                |
   |                |   {decision: "approved"}        |                |                |
   |                |                |                |                |                |
   |<-- SIGCONT ----|                |                |                |                |
   |   (runtime     |                |                |                |                |
   |    resumed)    |                |                |                |                |
   |                |                |                |                |                |
   |-- git push     |                |                |                |                |
   |   (proceeds)   |                |                |                |                |
```

### Approval Flow (DENIED)

```
  Runtime          Runner           API              Redis            CLI
   |                |                |                |                |
   |   (runtime paused, approval pending)             |                |
   |                |                |                |                |
   |                |                |                |                |-- co deny apr_001
   |                |                |                |                |   --reason "don't push yet"
   |                |                |                |                |
   |                |                |<-- PUT /approvals/apr_001 -----|
   |                |                |   {decision: "denied",         |
   |                |                |    reason: "don't push yet"}   |
   |                |                |                |                |
   |                |                |-- UPDATE approvals SET         |
   |                |                |   status='denied'              |
   |                |                |                |                |
   |                |                |-- PUBLISH ----->|                |
   |                |                |   task:t_abc123:approval       |
   |                |                |   {decision: "denied",         |
   |                |                |    reason: "don't push yet"}   |
   |                |                |                |                |
   |                |<-- message ----|                |                |
   |                |                |                |                |
   |<-- SIGCONT ----|                |                |                |
   |   (runtime     |                |                |                |
   |    resumed)    |                |                |                |
   |                |                |                |                |
   |-- adapter injects denial       |                |                |
   |   "Action denied by operator:  |                |                |
   |    don't push yet.             |                |                |
   |    Skip this action and        |                |                |
   |    continue working."          |                |                |
   |                |                |                |                |
   |   (runtime continues without   |                |                |
   |    performing the push)        |                |                |
```

### Approval Timeout

```
  Runner           API              Ntfy
   |                |                |
   |   (waiting for approval decision for 15 minutes)
   |                |                |
   |   [approval_timeout exceeded]  |
   |                |                |
   |-- treat as DENIED              |
   |                                 |
   |-- PUT /tasks/t_abc123 -------->|
   |   {status: "failed",           |
   |    error: "approval timeout    |
   |    for action: git push"}      |
   |                                 |
   |                |-- POST ntfy -->|
   |                |   "Task failed: approval timeout"
```

---

## 6. Session Continuation

A task completes (or partially completes). The user reviews output, then
submits a follow-up task that continues in the same agent session context.

```
co logs t_abc123                    # review what happened
co continue t_abc123 "also fix the edge case"
```

```
  CLI              API              Redis            Runner           Runtime
   |                |                |                |                |
   |-- GET /tasks/t_abc123 -------->|                |                |
   |                |                |                |                |
   |<-- 200 {                       |                |                |
   |     status: "completed",       |                |                |
   |     session_id: "ses_xyz",     |                |                |
   |     runtime: "claude-code",    |                |                |
   |     project: "peer6",          |                |                |
   |     branch: "co/peer6-abc123", |                |                |
   |     ...                         |                |                |
   |   }                             |                |                |
   |                                 |                |                |
   |-- POST /tasks ----------------->|                |                |
   |   {                             |                |                |
   |     project: "peer6",          |                |                |
   |     prompt: "also fix the edge case",           |                |
   |     runtime: "claude-code",    |                |                |
   |     parent_task_id: "t_abc123",|                |                |
   |     session_id: "ses_xyz",     |                |                |
   |     branch: "co/peer6-abc123"  |                |                |
   |   }                             |                |                |
   |                                 |                |                |
   |                |-- INSERT INTO tasks             |                |
   |                |   (id='t_def456',               |                |
   |                |    parent_task_id='t_abc123',   |                |
   |                |    session_id='ses_xyz',        |                |
   |                |    status='queued')              |                |
   |                |                |                |                |
   |                |-- LPUSH bull:peer6:wait ------->|                |
   |                |   (job payload includes          |                |
   |                |    session_id and branch)        |                |
   |                |                |                |                |
   |<-- 201 {task_id: "t_def456"} --|                |                |
   |                                 |                |                |
   |                |                |-- BRPOPLPUSH ->|                |
   |                |                |                |                |
   |                |                |                |-- git worktree add
   |                |                |                |   /work/peer6/t_def456
   |                |                |                |   (from branch co/peer6-abc123,
   |                |                |                |    NOT from main -- preserves
   |                |                |                |    previous changes)
   |                |                |                |                |
   |                |                |                |-- spawn ------>|
   |                |                |                |   claude -p "also fix..."
   |                |                |                |   --resume ses_xyz
   |                |                |                |   (cwd=/work/peer6/t_def456)
   |                |                |                |                |
   |                |                |                |   [Runtime has full context
   |                |                |                |    from previous session]
   |                |                |                |                |
   |                |                |                |<-- stdout -----|
   |                |                |                |                |
   |                |                |                |   ... continues working ...
   |                |                |                |                |
   |                |                |                |   (completion follows same
   |                |                |                |    path as Flow 1: commit,
   |                |                |                |    push, update PR, notify)
```

### Session Continuation Per Runtime

```
Runtime-specific continuation flags:

  Claude Code:    claude -p "prompt" --resume {session_id}
  Crush:          crush run "prompt" --session {session_id}
  Aider:          (no native session resume -- adapter replays
                   conversation from stored log as system prompt)
```

---

## 7. Live Output Streaming

User requests live output from a running task. The CLI opens a WebSocket
connection to the API, which subscribes to the Redis pub/sub channel
for that task.

```
co logs t_abc123 --follow
```

```
  CLI              API              Redis            Runner           Runtime
   |                |                |                |                |
   |-- GET /tasks/t_abc123 -------->|                |                |
   |                |                |                |                |
   |<-- 200 {status: "running"} ----|                |                |
   |                                 |                |                |
   |-- WS UPGRADE ------------------>|                |                |
   |   /ws/tasks/t_abc123/output    |                |                |
   |                                 |                |                |
   |<-- 101 Switching Protocols -----|                |                |
   |                                 |                |                |
   |                |-- SUBSCRIBE --->|                |                |
   |                |   task:t_abc123:output           |                |
   |                |                |                |                |
   |                |                |                |   [runtime is producing output]
   |                |                |                |                |
   |                |                |                |<-- stdout -----|
   |                |                |                |   {"type":"text",              |
   |                |                |                |    "content":"Reading file..."}|
   |                |                |                |                |
   |                |                |<-- PUBLISH ----|                |
   |                |                |   task:t_abc123:output          |
   |                |                |   {"type":"text",               |
   |                |                |    "content":"Reading file...", |
   |                |                |    "ts":"2026-03-22T10:01:05Z"} |
   |                |                |                |                |
   |                |<-- message ----|                |                |
   |                |                |                |                |
   |<-- WS frame ---|                |                |                |
   |   {"type":"text",               |                |                |
   |    "content":"Reading file...", |                |                |
   |    "ts":"2026-03-22T10:01:05Z"} |                |                |
   |                                 |                |                |
   |   [CLI renders in terminal]    |                |                |
   |                                 |                |                |
   |                |                |                |<-- stdout -----|
   |                |                |                |   {"type":"tool_use",          |
   |                |                |                |    "tool":"read_file",         |
   |                |                |                |    "path":"src/auth.ts"}       |
   |                |                |                |                |
   |                |                |<-- PUBLISH ----|                |
   |<-- WS frame ---|<-- message ----|                |                |
   |                                 |                |                |
   |   ... continues until task completes ...         |                |
   |                                 |                |                |
   |                |                |<-- PUBLISH ----|                |
   |                |                |   task:t_abc123:output          |
   |                |                |   {"type":"status",             |
   |                |                |    "status":"completed"}        |
   |                |                |                |                |
   |<-- WS frame ---|<-- message ----|                |                |
   |   {"type":"status",             |                |                |
   |    "status":"completed"}        |                |                |
   |                                 |                |                |
   |-- WS CLOSE ---->|                |                |                |
   |                |-- UNSUBSCRIBE ->|                |                |
   |                |   task:t_abc123:output           |                |
```

### Catching Up on Buffered Output

When a user connects to a task that is already in progress, they need
the output produced before they connected.

```
  CLI              API              Redis
   |                |                |
   |-- WS UPGRADE ------------------>|
   |   /ws/tasks/t_abc123/output    |
   |                                 |
   |                |-- LRANGE ------>|
   |                |   task:t_abc123:log
   |                |   0 -1  (get all buffered lines)
   |                |                |
   |                |<-- [line1, line2, ..., lineN] ---|
   |                |                |
   |   [API sends buffered lines first]
   |<-- WS frame (line1) -----------|
   |<-- WS frame (line2) -----------|
   |<-- WS frame (...) -------------|
   |<-- WS frame (lineN) -----------|
   |                                 |
   |                |-- SUBSCRIBE --->|
   |                |   task:t_abc123:output
   |                |   (now live)   |
   |                                 |
   |   [continues with live output] |
```

### Non-Follow Mode (Historical Logs)

```
co logs t_abc123     # no --follow flag
```

```
  CLI              API              Redis
   |                |                |
   |-- GET /tasks/t_abc123/logs ---->|
   |                                 |
   |                |-- LRANGE ------>|
   |                |   task:t_abc123:log
   |                |   0 -1         |
   |                |                |
   |<-- 200 [                       |
   |     {"ts":"...","type":"text","content":"..."},
   |     {"ts":"...","type":"tool_use",...},
   |     ...                         |
   |   ]                             |
   |                                 |
   |   [CLI renders all lines and exits]
```

---

## 8. Task Cancellation

User cancels a running task. The API signals the runner, which terminates
the runtime process.

```
co cancel t_abc123
```

```
  CLI              API              Redis            Runner           Runtime
   |                |                |                |                |
   |-- PUT /tasks/t_abc123/cancel -->|                |                |
   |                                 |                |                |
   |                |-- SELECT status FROM tasks      |                |
   |                |   WHERE id = 't_abc123'         |                |
   |                |                |                |                |
   |                |   [if status != 'running']      |                |
   |                |   -> 409 "Task is not running"  |                |
   |                |                |                |                |
   |                |   [if status == 'running']      |                |
   |                |                |                |                |
   |                |-- UPDATE tasks SET              |                |
   |                |   status = 'cancelling'         |                |
   |                |                |                |                |
   |                |-- PUBLISH ----->|                |                |
   |                |   task:t_abc123:control         |                |
   |                |   {action: "cancel"}            |                |
   |                |                |                |                |
   |<-- 200 {status: "cancelling"} -|                |                |
   |                                 |                |                |
   |                |                |-- message ---->|                |
   |                |                |   (runner is   |                |
   |                |                |    subscribed to                |
   |                |                |    task:t_abc123:control)       |
   |                |                |                |                |
   |                |                |                |-- SIGTERM ---->|
   |                |                |                |   (PID of runtime process)
   |                |                |                |                |
   |                |                |                |   [wait up to 10 seconds
   |                |                |                |    for graceful shutdown]
   |                |                |                |                |
   |                |                |                |   --- CASE A: Runtime exits gracefully ---
   |                |                |                |                |
   |                |                |                |<-- exit 143 ---|
   |                |                |                |   (SIGTERM received)
   |                |                |                |                |
   |                |                |                |   --- CASE B: Runtime does not exit ---
   |                |                |                |                |
   |                |                |                |   [10s timeout]
   |                |                |                |                |
   |                |                |                |-- SIGKILL ---->|
   |                |                |                |   (force kill) |
   |                |                |                |                |
   |                |                |                |<-- killed -----|
   |                |                |                |                |
   |                |                |                |   --- Both cases continue here ---
   |                |                |                |                |
   |                |                |                |-- git worktree remove
   |                |                |                |   /work/peer6/t_abc123
   |                |                |                |   (clean up, discard partial work)
   |                |                |                |                |
   |                |<-- PUT /tasks/t_abc123 ---------|                |
   |                |   {status: "cancelled",         |                |
   |                |    cancelled_at: "...",          |                |
   |                |    partial_output_lines: 247}    |                |
   |                |                |                |                |
   |                |-- UPDATE tasks SET              |                |
   |                |   status = 'cancelled'          |                |
   |                |                |                |                |
   |                |-- LREM bull:peer6:active ------>|                |
   |                |                |                |                |
   |                |-- PUBLISH ----->|                |                |
   |                |   task:t_abc123:output           |                |
   |                |   {"type":"status",              |                |
   |                |    "status":"cancelled"}         |                |
```

---

## 9. Device Disconnection Mid-Task

A USB device is unplugged while a task that requires it is running.
The runner's udev monitor detects the event and pauses the task.

### Device Disconnected and Reconnected

```
  udev             Runner           Runtime          API              Ntfy
   |                |                |                |                |
   |   [USB device physically unplugged]              |                |
   |                |                |                |                |
   |-- remove event ->              |                |                |
   |   (ACTION=remove,              |                |                |
   |    SUBSYSTEM=usb,              |                |                |
   |    ID_VENDOR=Yubico)           |                |                |
   |                |                |                |                |
   |                |-- check: does current task      |                |
   |                |   require this device?          |                |
   |                |                |                |                |
   |                |   task t_abc123 requires: yubikey                |
   |                |   disconnected device: yubikey  |                |
   |                |   -> YES, task affected          |                |
   |                |                |                |                |
   |                |-- SIGSTOP ---->|                |                |
   |                |   (pause runtime process)       |                |
   |                |                |                |                |
   |                |-- PUT /tasks/t_abc123 --------->|                |
   |                |   {status: "paused",            |                |
   |                |    reason: "device_disconnected",|               |
   |                |    device: "yubikey"}            |                |
   |                |                |                |                |
   |                |                |                |-- POST ntfy -->|
   |                |                |                |   {title: "Device disconnected",
   |                |                |                |    message: "YubiKey unplugged on dell-01.
   |                |                |                |     Task t_abc123 paused.
   |                |                |                |     Reconnect within 5 minutes or task fails.",
   |                |                |                |    priority: 5}
   |                |                |                |                |
   |                |-- start reconnection timer      |                |
   |                |   (300 seconds / 5 minutes)     |                |
   |                |                |                |                |
   |                |                |                |                |
   |   ... time passes ...          |                |                |
   |                |                |                |                |
   |   [USB device physically plugged back in]        |                |
   |                |                |                |                |
   |-- add event --->                |                |                |
   |   (ACTION=add,                  |                |                |
   |    SUBSYSTEM=usb,              |                |                |
   |    ID_VENDOR=Yubico)           |                |                |
   |                |                |                |                |
   |                |-- verify device matches         |                |
   |                |   expected serial number        |                |
   |                |                |                |                |
   |                |-- cancel reconnection timer     |                |
   |                |                |                |                |
   |                |-- SIGCONT ---->|                |                |
   |                |   (resume runtime process)      |                |
   |                |                |                |                |
   |                |-- PUT /tasks/t_abc123 --------->|                |
   |                |   {status: "running",           |                |
   |                |    reason: "device_reconnected"} |                |
   |                |                |                |                |
   |                |                |                |-- POST ntfy -->|
   |                |                |                |   "YubiKey reconnected. Task resumed."
   |                |                |                |                |
   |                |                |-- continues -->|                |
```

### Device Not Reconnected (Timeout)

```
  Runner           Runtime          API              Ntfy
   |                |                |                |
   |   (runtime paused, waiting for reconnection)    |
   |                |                |                |
   |   [300 second timeout expires]  |                |
   |                |                |                |
   |-- SIGTERM ---->|                |                |
   |                |                |                |
   |   [wait 10s for graceful exit] |                |
   |                |                |                |
   |<-- exit / kill -|                |                |
   |                |                |                |
   |-- git worktree remove          |                |
   |                                 |                |
   |-- PUT /tasks/t_abc123 -------->|                |
   |   {status: "failed",           |                |
   |    error: "Required device 'yubikey' disconnected.
   |     Not reconnected within 300s timeout."}       |
   |                                 |                |
   |                |-- POST ntfy ------------------>|
   |                |   "Task t_abc123 FAILED: YubiKey
   |                |    not reconnected within timeout."
```

### Device Disconnected But Task Does Not Require It

```
  udev             Runner           Runtime
   |                |                |
   |-- remove event ->              |
   |   (yubikey unplugged)          |
   |                |                |
   |                |-- check: does current task
   |                |   require this device?
   |                |                |
   |                |   task t_def456 requires: (none)
   |                |   -> NO, task not affected
   |                |                |
   |                |-- update device inventory only
   |                |   (next heartbeat will report
   |                |    updated device list)
   |                |                |
   |                |   [task continues uninterrupted]
```

---

## 10. Runner Drain

Operator drains a runner -- it finishes current work, then stops accepting
new tasks. Used before maintenance, shutdown, or reboot.

```
co runner dell-02 drain
```

```
  CLI              API              Redis            Runner (dell-02)  Ntfy
   |                |                |                |                |
   |-- PUT /runners/dell-02/drain -->|                |                |
   |                                 |                |                |
   |                |-- UPDATE runners SET             |                |
   |                |   status = 'draining'           |                |
   |                |   WHERE runner_id = 'dell-02'   |                |
   |                |                |                |                |
   |                |-- PUBLISH ----->|                |                |
   |                |   runner:dell-02:control        |                |
   |                |   {action: "drain"}             |                |
   |                |                |                |                |
   |<-- 200 {status: "draining",    |                |                |
   |     current_task: "t_ghi789",  |                |                |
   |     message: "Draining. Will   |                |                |
   |      complete current task."}  |                |                |
   |                                 |                |                |
   |                |                |-- message ---->|                |
   |                |                |                |                |
   |                |                |                |-- stop BRPOPLPUSH
   |                |                |                |   (unsubscribe from
   |                |                |                |    all :wait queues)
   |                |                |                |                |
   |                |                |                |   [if task is running,
   |                |                |                |    let it complete normally]
   |                |                |                |                |
   |                |                |                |   ... task t_ghi789 finishes ...
   |                |                |                |                |
   |                |                |                |-- report task completed
   |                |                |                |   (same as Flow 1 completion)
   |                |                |                |                |
   |                |<-- PUT /runners/dell-02 --------|                |
   |                |   {status: "drained",           |                |
   |                |    current_task: null}           |                |
   |                |                |                |                |
   |                |-- UPDATE runners SET             |                |
   |                |   status = 'drained'            |                |
   |                |                |                |                |
   |                |-- POST ntfy/co-fleet ------------------------------>|
   |                |   {title: "Runner drained",    |                |  |
   |                |    message: "dell-02 is now idle and drained.   |  |
   |                |     Safe to shut down."}       |                |  |
   |                |                |                |                |
```

### Drain When Runner Is Idle

```
  CLI              API              Redis            Runner (dell-02)  Ntfy
   |                |                |                |                |
   |-- PUT /runners/dell-02/drain -->|                |                |
   |                                 |                |                |
   |                |-- check: current_task for dell-02?               |
   |                |   -> NULL (no task running)     |                |
   |                |                |                |                |
   |                |-- UPDATE runners SET status = 'drained'          |
   |                |                |                |                |
   |                |-- PUBLISH ----->|                |                |
   |                |   runner:dell-02:control        |                |
   |                |   {action: "drain"}             |                |
   |                |                |                |                |
   |                |                |-- message ---->|                |
   |                |                |                |-- stop BRPOPLPUSH
   |                |                |                |                |
   |<-- 200 {status: "drained",     |                |                |
   |     message: "Already idle.    |                |                |
   |      Drained immediately."}    |                |                |
   |                                 |                |                |
   |                |-- POST ntfy ---------------------------------------->|
   |                |   "dell-02 drained (was idle)." |                |   |
```

### Undrain (Resume)

```
co runner dell-02 resume
```

```
  CLI              API              Redis            Runner (dell-02)
   |                |                |                |
   |-- PUT /runners/dell-02/resume ->|                |
   |                                 |                |
   |                |-- UPDATE runners SET             |
   |                |   status = 'online'             |
   |                |                |                |
   |                |-- PUBLISH ----->|                |
   |                |   runner:dell-02:control        |
   |                |   {action: "resume"}            |
   |                |                |                |
   |                |                |-- message ---->|
   |                |                |                |
   |                |                |                |-- resume BRPOPLPUSH
   |                |                |                |   on all :wait queues
   |                |                |                |
   |<-- 200 {status: "online"} -----|                |
```

---

## 11. Cost Tracking Flow

Cost data flows from the runtime's output through the runner to the API,
where it is aggregated and checked against budget limits.

### Cost Extraction During Task Execution

```
  Runtime          Runner           API              Redis
   |                |                |                |
   |-- stdout ----->|                |                |
   |   (stream-json output includes  |                |
   |    cost metadata at end)        |                |
   |                |                |                |
   |   Claude Code example:         |                |
   |   {"type":"result",             |                |
   |    "total_cost_usd": 0.42,     |                |
   |    "input_tokens": 15230,      |                |
   |    "output_tokens": 3891}      |                |
   |                |                |                |
   |   Crush example:               |                |
   |   {"session_cost": 0.38,       |                |
   |    "provider": "anthropic",    |                |
   |    "model": "claude-sonnet-4-20250514"}    |                |
   |                |                |                |
   |   Aider example:               |                |
   |   (parsed from stderr:         |                |
   |    "Tokens: 12k sent, 3k received. Cost: $0.35")|
   |                |                |                |
   |<-- exit 0 -----|                |                |
   |                |                |                |
   |                |-- extract cost from output      |
   |                |   (runtime adapter parses       |
   |                |    runtime-specific format)     |
   |                |                |                |
   |                |-- PUT /tasks/t_abc123 --------->|
   |                |   {status: "completed",         |
   |                |    cost: {                      |
   |                |      total_usd: 0.42,          |
   |                |      input_tokens: 15230,      |
   |                |      output_tokens: 3891,      |
   |                |      model: "claude-sonnet-4-20250514",     |
   |                |      runtime: "claude-code"    |
   |                |    }}                           |
   |                |                |                |
   |                |                |-- UPDATE tasks SET             |
   |                |                |   cost_usd = 0.42,            |
   |                |                |   cost_details = '{...}'      |
```

### Budget Check After Each Task

```
  API (post-task hook)              SQLite
   |                                 |
   |-- SELECT SUM(cost_usd) FROM tasks
   |   WHERE DATE(completed_at) = DATE('now')
   |   AND status = 'completed'
   |                                 |
   |   Result: daily_total = $14.58  |
   |                                 |
   |-- SELECT daily_budget FROM config
   |                                 |
   |   Result: daily_budget = $20.00 |
   |                                 |
   |   [if daily_total >= daily_budget]
   |                                 |
   |   --- BUDGET EXCEEDED ---       |
   |                                 |
   |-- UPDATE config SET             |
   |   budget_paused = true          |
   |                                 |
   |-- PUBLISH to Redis:            |
   |   system:budget:paused          |
   |   {reason: "Daily budget $20.00 exceeded",
   |    spent: 14.58}               |
   |                                 |
   |   (All runners receive this message
   |    and stop consuming new tasks
   |    from :wait queues. Running
   |    tasks continue to completion.)
   |                                 |
   |-- POST ntfy/co-alerts          |
   |   {title: "BUDGET LIMIT",      |
   |    message: "Daily spend $14.58 has reached
   |     $20.00 cap. New task processing paused.",
   |    priority: 5}                 |
```

### Budget Check Detail: Runner Receives Pause Signal

```
  Redis            Runner (all)
   |                |
   |-- message ---->|
   |   system:budget:paused
   |   {reason: "Daily budget exceeded"}
   |                |
   |                |-- stop BRPOPLPUSH on :wait queues
   |                |   (do NOT cancel running tasks)
   |                |
   |                |-- log: "Budget paused. Stopped
   |                |   accepting new tasks."
   |                |
   |                |-- continue heartbeats normally
   |                |   (include budget_paused: true)
   |                |
   |   [Next day at midnight UTC, API resets budget]
   |   OR
   |   [User runs: co budget reset]
   |                |
   |-- message ---->|
   |   system:budget:resumed
   |                |
   |                |-- resume BRPOPLPUSH on :wait queues
```

### Cost Query

```
co cost                              # today's summary
co cost --project peer6 --days 7     # per-project, last 7 days
```

```
  CLI              API              SQLite
   |                |                |
   |-- GET /cost?project=peer6&days=7 ->              |
   |                                 |                |
   |                |-- SELECT                        |
   |                |   project,                      |
   |                |   DATE(completed_at) as day,   |
   |                |   SUM(cost_usd) as total,      |
   |                |   COUNT(*) as tasks,            |
   |                |   AVG(cost_usd) as avg_cost    |
   |                |   FROM tasks                    |
   |                |   WHERE project = 'peer6'      |
   |                |   AND completed_at >= DATE('now', '-7 days')
   |                |   GROUP BY day                  |
   |                |   ORDER BY day DESC             |
   |                |                |                |
   |<-- 200 {                       |                |
   |     project: "peer6",          |                |
   |     period: "7d",              |                |
   |     total_usd: 8.42,           |                |
   |     daily_budget: 20.00,       |                |
   |     today_spent: 2.15,         |                |
   |     breakdown: [               |                |
   |       {day:"2026-03-22", total:2.15, tasks:5},  |
   |       {day:"2026-03-21", total:1.87, tasks:4},  |
   |       ...                       |                |
   |     ]                           |                |
   |   }                             |                |
   |                                 |                |
   |   [CLI renders table]          |                |
```

---

## 12. Git Branch / PR Flow

Detailed view of how the runner manages git worktrees, branches, commits,
and pull request creation around each task.

### Setup (Before Runtime Spawns)

```
  Runner                            Git (local)      Git (remote)
   |                                 |                |
   |-- check: does bare repo exist?  |                |
   |   /work/peer6.git              |                |
   |                                 |                |
   |   [if not]                      |                |
   |-- git clone --bare ------------>|                |
   |   git@github.com:org/peer6.git  |                |
   |   /work/peer6.git              |                |
   |                                 |                |
   |   [if yes]                      |                |
   |-- git fetch origin ------------>|<-- fetch ------|
   |   (in /work/peer6.git)          |   (from remote)|
   |                                 |                |
   |-- git worktree add ------------>|                |
   |   /work/peer6/t_abc123         |                |
   |   -b co/peer6-abc123           |                |
   |   origin/main                   |                |
   |                                 |                |
   |   [worktree is now at HEAD of main              |
   |    on branch co/peer6-abc123]  |                |
   |                                 |                |
   |   Resulting directory structure:|                |
   |   /work/                        |                |
   |     peer6.git/      (bare repo) |                |
   |     peer6/                      |                |
   |       t_abc123/     (worktree)  |                |
   |         src/                    |                |
   |         package.json            |                |
   |         ...                     |                |
```

### Completion (After Runtime Exits Successfully)

```
  Runner                            Git (local)      Git (remote)     GitHub API
   |                                 |                |                |
   |-- cd /work/peer6/t_abc123      |                |                |
   |                                 |                |                |
   |-- git status ------------------>|                |                |
   |<-- modified: src/auth.ts       |                |                |
   |    new file: src/auth.test.ts  |                |                |
   |                                 |                |                |
   |   [if no changes]              |                |                |
   |   -> skip branch/PR creation   |                |                |
   |   -> report completed with     |                |                |
   |      no_changes: true           |                |                |
   |                                 |                |                |
   |   [if changes exist]           |                |                |
   |                                 |                |                |
   |-- git add -A ------------------>|                |                |
   |                                 |                |                |
   |-- git commit -m "..." --------->|                |                |
   |   "co(peer6): implement feature X                |                |
   |                                 |                |                |
   |    Task: t_abc123               |                |                |
   |    Runtime: claude-code         |                |                |
   |    Runner: dell-01              |                |                |
   |    Cost: $0.42"                 |                |                |
   |                                 |                |                |
   |-- git push origin ------------->|-- push ------->|                |
   |   co/peer6-abc123              |                |                |
   |                                 |                |                |
   |-- gh pr create --draft -------->|                |--------------->|
   |   --title "co(peer6): implement feature X"       |                |
   |   --body "## Task                |                |                |
   |     - ID: t_abc123              |                |                |
   |     - Prompt: implement feature X                |                |
   |     - Runtime: claude-code      |                |                |
   |     - Runner: dell-01           |                |                |
   |     - Cost: $0.42              |                |                |
   |     - Session: ses_xyz          |                |                |
   |                                 |                |                |
   |     ## Changes                  |                |                |
   |     - src/auth.ts (modified)   |                |                |
   |     - src/auth.test.ts (new)   |                |                |
   |                                 |                |                |
   |     ## Continue                 |                |                |
   |     \`co continue t_abc123 \"...\"\`"             |                |
   |                                 |                |                |
   |<-- PR URL: https://github.com/org/peer6/pull/42  |                |
   |                                 |                |                |
   |-- git worktree remove --------->|                |                |
   |   /work/peer6/t_abc123         |                |                |
   |                                 |                |                |
   |-- git branch -D --------------->|                |                |
   |   co/peer6-abc123              |                |                |
   |   (local branch only -- remote |                |                |
   |    branch preserved for PR)    |                |                |
```

### Branch Naming Convention

```
Format:  co/{project}-{short_id}

Examples:
  co/peer6-abc123
  co/login2-def456
  co/rule1-ghi789

For continuation tasks (Flow 6), reuse the original branch:
  Task t_abc123: co/peer6-abc123    (created)
  Task t_def456: co/peer6-abc123    (reused, new commits pushed)
```

---

## 13. Error / Retry Flow

When a runtime crashes or returns a non-zero exit code, the runner checks
the retry policy and either retries or marks the task as failed.

### Retry Decision Tree

```
  Runner
   |
   |<-- exit code from runtime
   |
   |-- classify error:
   |
   |   exit 1 (general error)
   |     -> check: is error transient?
   |        (timeout, rate limit, network error)
   |     -> if transient AND retries < max_retries (2):
   |          RETRY with backoff
   |     -> if not transient OR retries exhausted:
   |          FAIL
   |
   |   exit 137 (SIGKILL / OOM)
   |     -> FAIL (no retry -- likely OOM or resource issue)
   |
   |   exit 143 (SIGTERM)
   |     -> CANCELLED (not an error -- we sent the signal)
   |
   |   "budget exceeded" in output
   |     -> FAIL (no retry -- intentional stop)
   |
   |   "rate limited" in output
   |     -> RETRY after 60s (if retries remaining)
   |
   |   "context window exceeded" in output
   |     -> FAIL (no retry -- fundamental limit)
```

### Retry Flow (Transient Error)

```
  Runner           Runtime (attempt 1)   Runtime (attempt 2)   API              Redis
   |                |                     |                     |                |
   |-- spawn ------>|                     |                     |                |
   |                |                     |                     |                |
   |<-- exit 1 -----|                     |                     |                |
   |   stderr: "API rate limit exceeded" |                     |                |
   |                |                     |                     |                |
   |-- classify: transient (rate limit)  |                     |                |
   |-- retries: 0 of 2 remaining        |                     |                |
   |                                      |                     |                |
   |-- PUT /tasks/t_abc123 ---------------------------------------->|           |
   |   {status: "retrying",              |                     |                |
   |    retry_count: 1,                  |                     |                |
   |    retry_reason: "rate_limited",    |                     |                |
   |    next_retry_at: "+60s"}           |                     |                |
   |                                      |                     |                |
   |-- PUBLISH to Redis: ----------------------------------------------------------->|
   |   task:t_abc123:output              |                     |                |
   |   {"type":"system",                  |                     |                |
   |    "message":"Rate limited. Retrying in 60s (attempt 2/3)"}                |
   |                                      |                     |                |
   |   [wait 60 seconds]                 |                     |                |
   |                                      |                     |                |
   |-- spawn (with --resume) ------------>|                     |                |
   |   claude -p "..." --resume ses_xyz   |                     |                |
   |   (cwd stays the same worktree)     |                     |                |
   |                                      |                     |                |
   |                                      |<-- exit 0 ----------|                |
   |                                      |                     |                |
   |   [success on retry -- proceed with normal completion flow]                 |
```

### Retry Flow (Exhausted)

```
  Runner           Runtime (attempt 3)   API              Ntfy
   |                |                     |                |
   |-- spawn ------>|                     |                |
   |                |                     |                |
   |<-- exit 1 -----|                     |                |
   |   stderr: "API rate limit exceeded" |                |
   |                |                     |                |
   |-- classify: transient (rate limit)  |                |
   |-- retries: 2 of 2 -- EXHAUSTED     |                |
   |                                      |                |
   |-- git worktree remove              |                |
   |                                      |                |
   |-- PUT /tasks/t_abc123 ------------->|                |
   |   {status: "failed",                |                |
   |    error: "rate_limited",           |                |
   |    retries_attempted: 2,            |                |
   |    final_stderr: "...last 50 lines"}|                |
   |                                      |                |
   |                |-- POST ntfy ----------------------->|
   |                |   {title: "Task FAILED (after 3 attempts)",
   |                |    message: "peer6/t_abc123: rate limited.
   |                |     All 2 retries exhausted.",
   |                |    priority: 4}    |                |
```

### Non-Retriable Failure

```
  Runner           Runtime          API              Ntfy
   |                |                |                |
   |-- spawn ------>|                |                |
   |                |                |                |
   |<-- exit 137 ---|                |                |
   |   (killed by OOM)              |                |
   |                |                |                |
   |-- classify: OOM (non-retriable)|                |
   |                                 |                |
   |-- git worktree remove          |                |
   |                                 |                |
   |-- PUT /tasks/t_abc123 -------->|                |
   |   {status: "failed",           |                |
   |    error: "oom_killed",        |                |
   |    retries_attempted: 0,       |                |
   |    message: "Runtime killed by OOM (exit 137).
   |     Consider reducing context or using a smaller model."}
   |                                 |                |
   |                |-- POST ntfy ------------------>|
   |                |   {title: "Task FAILED (OOM)", |
   |                |    priority: 5}                |
```

---

## 14. Multi-Runtime Comparison

User runs the same task with two different runtimes to compare quality,
speed, and cost. These are independent tasks -- no special coordination
needed beyond user-initiated comparison.

```
co run peer6 "implement feature X" --runtime claude-code --tag compare-1
co run peer6 "implement feature X" --runtime crush --tag compare-1
```

```
  CLI              API              Redis            Runner (dell-01)  Runner (dell-02)
   |                |                |                |                 |
   |-- POST /tasks ----------------->|                |                 |
   |   {project: "peer6",           |                |                 |
   |    prompt: "implement...",     |                |                 |
   |    runtime: "claude-code",     |                |                 |
   |    tag: "compare-1"}           |                |                 |
   |                                 |                |                 |
   |                |-- INSERT task t_aaa             |                 |
   |                |-- LPUSH bull:peer6:wait ------->|                 |
   |                                 |                |                 |
   |<-- 201 {task_id: "t_aaa"} -----|                |                 |
   |                                 |                |                 |
   |-- POST /tasks ----------------->|                |                 |
   |   {project: "peer6",           |                |                 |
   |    prompt: "implement...",     |                |                 |
   |    runtime: "crush",           |                |                 |
   |    tag: "compare-1"}           |                |                 |
   |                                 |                |                 |
   |                |-- INSERT task t_bbb             |                 |
   |                |-- LPUSH bull:peer6:wait ------->|                 |
   |                                 |                |                 |
   |<-- 201 {task_id: "t_bbb"} -----|                |                 |
   |                                 |                |                 |
   |                |                |                |                 |
   |                |                |-- BRPOPLPUSH ->|                 |
   |                |                |   (dell-01 picks up t_aaa)      |
   |                |                |                |                 |
   |                |                |-- BRPOPLPUSH ----------------->|
   |                |                |   (dell-02 picks up t_bbb)     |
   |                |                |                |                 |
   |                |                |                |-- spawn          |-- spawn
   |                |                |                |   claude -p ... |   crush run ...
   |                |                |                |                 |
   |   (Both tasks proceed independently through Flow 1)               |
   |   (Each creates its own branch and PR)                            |
   |                |                |                |                 |
   |                |                |                |-- completed     |
   |                |                |                |   branch: co/peer6-aaa          |
   |                |                |                |   cost: $0.42  |
   |                |                |                |   time: 3m12s  |
   |                |                |                |                 |
   |                |                |                |                 |-- completed
   |                |                |                |                 |   branch: co/peer6-bbb
   |                |                |                |                 |   cost: $0.38
   |                |                |                |                 |   time: 2m45s
```

### Comparison Query

```
co tasks --tag compare-1
```

```
  CLI              API              SQLite
   |                |                |
   |-- GET /tasks?tag=compare-1 ---->|
   |                                 |
   |                |-- SELECT * FROM tasks
   |                |   WHERE tag = 'compare-1'
   |                |   ORDER BY completed_at
   |                |                |
   |<-- 200 [                       |
   |     {task_id: "t_aaa",         |
   |      runtime: "claude-code",   |
   |      status: "completed",      |
   |      cost_usd: 0.42,           |
   |      duration_s: 192,          |
   |      pr_url: "...pull/42",     |
   |      files_changed: 3,         |
   |      lines_added: 87,          |
   |      lines_removed: 12},       |
   |     {task_id: "t_bbb",         |
   |      runtime: "crush",         |
   |      status: "completed",      |
   |      cost_usd: 0.38,           |
   |      duration_s: 165,          |
   |      pr_url: "...pull/43",     |
   |      files_changed: 2,         |
   |      lines_added: 95,          |
   |      lines_removed: 8}         |
   |   ]                             |
   |                                 |
   |   CLI renders comparison table: |
   |                                 |
   |   Tag: compare-1               |
   |   +-------------+---------+-------+--------+---------+
   |   | Runtime     | Status  | Cost  | Time   | Changes |
   |   +-------------+---------+-------+--------+---------+
   |   | claude-code | done    | $0.42 | 3m12s  | +87/-12 |
   |   | crush       | done    | $0.38 | 2m45s  | +95/-8  |
   |   +-------------+---------+-------+--------+---------+
```

---

## Summary: Redis Key Space

All Redis keys used by the system, for reference.

```
Key Pattern                          Type       Purpose
---------------------------------------------------------------------
bull:{project}:wait                  List       BullMQ pending jobs (per-project)
bull:{project}:active                List       BullMQ active jobs (per-project)
bull:{runner_id}:wait                List       BullMQ pending jobs (device-specific)
bull:{runner_id}:active              List       BullMQ active jobs (device-specific)
bull:{project}:completed             List       BullMQ completed jobs
bull:{project}:failed                List       BullMQ failed jobs

task:{task_id}:output                Channel    Pub/sub for live output streaming
task:{task_id}:log                   List       Buffered output lines (append-only)
task:{task_id}:control               Channel    Pub/sub for cancel/pause signals
task:{task_id}:approval              Channel    Pub/sub for approval decisions

runner:{runner_id}:control           Channel    Pub/sub for drain/resume signals

system:budget:paused                 Channel    Pub/sub for budget pause/resume
system:budget:status                 String     "paused" or "active"
```

## Summary: HTTP Endpoints

All API endpoints referenced in the flows above.

```
Method   Path                              Description
---------------------------------------------------------------------
POST     /tasks                            Submit a new task
GET      /tasks/:id                        Get task details
PUT      /tasks/:id                        Update task (runner reports status)
PUT      /tasks/:id/cancel                 Cancel a running task
GET      /tasks/:id/logs                   Get buffered output
WS       /ws/tasks/:id/output              Live output stream (WebSocket)

POST     /tasks/:id/approvals              Create approval request
PUT      /approvals/:id                    Approve or deny

POST     /runners                          Register a runner
PUT      /runners/:id/heartbeat            Runner heartbeat
PUT      /runners/:id/drain                Drain a runner
PUT      /runners/:id/resume               Resume a drained runner

GET      /cost                             Query cost data
GET      /tasks?tag=:tag                   Query tasks by tag
```

## Summary: SQLite Tables Referenced

```
Table        Key Columns
---------------------------------------------------------------------
tasks        id, project, prompt, runtime, status, runner_id,
             parent_task_id, session_id, branch, pr_url, tag,
             cost_usd, cost_details, retry_count, requeue_count,
             created_at, started_at, completed_at

runners      runner_id, hostname, status, projects, devices,
             runtimes, capabilities, last_heartbeat, load

approvals    id, task_id, action, target, risk_level, context,
             status, decided_by, reason, created_at, decided_at

config       key, value (includes daily_budget, budget_paused)
```
