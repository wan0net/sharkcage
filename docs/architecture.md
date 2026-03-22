# code-orchestration Architecture

Agent-agnostic autonomous coding orchestrator for physical runner fleets.

Version: 0.1.0 (draft)
Last updated: 2026-03-22

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [API / Control Plane](#2-api--control-plane)
3. [Runner / Worker Daemon](#3-runner--worker-daemon)
4. [CLI](#4-cli)
5. [Technology Choices](#5-technology-choices)
6. [Security Model](#6-security-model)
7. [Cost Control](#7-cost-control)
8. [Scaling Path](#8-scaling-path)

---

## 1. System Overview

The system consists of three components:

- **API (Control Plane)** -- accepts work, manages state, routes tasks to runners.
- **Runner Fleet (Execution)** -- Dell 5070 thin clients that pull tasks, execute coding agents, and report results.
- **CLI (Human Interface)** -- command-line tool for submitting tasks, monitoring progress, and managing the fleet.

### Architecture Diagram

```
                          +---------------------------+
                          |       Human Operator      |
                          +---------------------------+
                                      |
                                      | co run / co status / co logs
                                      v
+-----------------------------------------------------------------------+
|                          CLI  (co)                                     |
|  TypeScript, npx code-orchestration or global install                 |
|  Talks to API over HTTPS. Streams logs via WebSocket.                 |
+-----------------------------------------------------------------------+
            |                    |                    |
            | POST /tasks       | GET /tasks/:id     | WS /tasks/:id/stream
            | POST /approve     | GET /runners       |
            v                    v                    v
+-----------------------------------------------------------------------+
|                     API / Control Plane                                |
|                                                                       |
|  Hono (Cloudflare Workers or self-hosted Node on Dell)                |
|                                                                       |
|  +-------------------+  +------------------+  +-------------------+   |
|  |   REST Endpoints  |  |   Bull Board UI  |  |  Audit / Cost DB  |   |
|  |   (task, runner,  |  |   :3001/queues   |  |  (D1 or SQLite)   |   |
|  |    device mgmt)   |  |                  |  |                   |   |
|  +-------------------+  +------------------+  +-------------------+   |
|           |                      |                      |             |
|           +----------+-----------+----------------------+             |
|                      |                                                |
|              +-------v--------+                                       |
|              |  BullMQ + Redis |                                      |
|              |  Task Queues   |                                       |
|              |  Pub/Sub       |                                       |
|              +-------+--------+                                       |
+-----------------------------------------------------------------------+
                       |
                       | Queue consumption (outbound poll)
                       | Heartbeat POST every 30s
                       | Result POST on completion
                       | Redis pub/sub for live streaming
                       |
         +-------------+-------------+
         |             |             |
         v             v             v
+----------------+ +----------------+ +----------------+
|   Runner 01    | |   Runner 02    | |   Runner 03    |
|   Dell 5070    | |   Dell 5070    | |   Dell 5070    |
|                | |                | |                |
| systemd daemon | | systemd daemon | | systemd daemon |
| BullMQ worker  | | BullMQ worker  | | BullMQ worker  |
|                | |                | |                |
| Projects:      | | Projects:      | | Projects:      |
|  - peer6       | |  - rule1       | |  - peer6       |
|  - login2      | |  - threat10    | |  - login2      |
|                | |                | |                |
| Devices:       | | Devices:       | | Devices:       |
|  - YubiKey 5   | |  - (none)      | |  - Arduino Uno |
|  - Flipper Zero| |                | |  - Bus Pirate  |
+----------------+ +----------------+ +----------------+
        |                                     |
        | /dev/ttyUSB0 (udev named)           | /dev/ttyUSB0
        v                                     v
  +-----------+                         +-----------+
  | YubiKey 5 |                         |Arduino Uno|
  | Flipper   |                         |Bus Pirate |
  +-----------+                         +-----------+
```

### Data Flow

```
1. Human runs:       co run peer6 "add rate limiting to API" --budget 2.00

2. CLI sends:        POST /tasks
                     {project: "peer6", prompt: "...", budget: 2.00, runtime: "crush"}

3. API:              Validates budget against caps
                     Enqueues to BullMQ queue "tasks:peer6"
                     Returns task ID to CLI

4. Runner 01:        Consuming queue "tasks:peer6"
                     Picks up task
                     git pull peer6 repo
                     git worktree add .worktrees/task-abc123
                     Spawns: crush --prompt "..." --max-budget-usd 2.00
                     Streams stdout -> Redis pub/sub channel "task:abc123:output"

5. CLI (streaming):  WS /tasks/abc123/stream
                     API subscribes to Redis pub/sub "task:abc123:output"
                     Forwards frames to CLI over WebSocket

6. Runner 01:        Agent completes
                     git add -A && git commit
                     git push origin task/abc123
                     POST /tasks/abc123/result {status: "complete", cost: 1.47, branch: "task/abc123"}

7. API:              Updates task record
                     Sends notification via ntfy.sh
                     CLI shows: "Task abc123 complete. Cost: $1.47. Branch: task/abc123"
```

### Network Topology

```
+------------------------------------------------------------------+
|                        Tailscale Mesh                            |
|                                                                  |
|  dell-01.ts.net  <------>  dell-02.ts.net  <------>  dell-03.ts.net  |
|       |                        |                        |        |
|       +------------------------+------------------------+        |
|                                |                                 |
|                        redis.ts.net:6379                         |
|                        (runs on dell-01)                         |
|                                                                  |
|  Operator laptop:  operator.ts.net                               |
|       SSH to any runner, CLI to API                              |
+------------------------------------------------------------------+
                                |
                                | HTTPS (outbound only)
                                v
                   +------------------------+
                   |   API on Cloudflare    |
                   |   Workers (or on a     |
                   |   Dell via Tailscale)  |
                   +------------------------+
```

---

## 2. API / Control Plane

### Runtime

Two deployment options (choose one):

1. **Cloudflare Workers** -- zero ops, global edge, free tier covers low volume. D1 for storage.
2. **Self-hosted on Dell** -- Node.js 22 LTS, runs on one of the fleet Dells. SQLite for storage. Lower latency to Redis (same machine or same Tailscale mesh).

For v1, self-hosted on Dell is simpler: everything on the same Tailscale network, no CORS issues, Redis is local.

### Framework

Hono 4.x. Already in use across peer6 (apps/api) and login2. Runs identically on Workers and Node.

```typescript
// src/api.ts
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";

const app = new Hono();

app.use("/api/*", bearerAuth({ token: process.env.API_KEY }));

// Mount route groups
app.route("/api/tasks", taskRoutes);
app.route("/api/runners", runnerRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/audit", auditRoutes);
```

### Task Queue

BullMQ 5.x with Redis 7.x (or Valkey). Named queues per project and per capability:

```
tasks:peer6          -- tasks targeting the peer6 project
tasks:login2         -- tasks targeting login2
tasks:rule1          -- tasks targeting rule1
tasks:needs-yubikey  -- tasks requiring a YubiKey
tasks:needs-serial   -- tasks requiring any serial device
tasks:general        -- catch-all
```

Queue configuration:

```typescript
import { Queue } from "bullmq";

const taskQueue = new Queue("tasks:peer6", {
  connection: { host: "redis.ts.net", port: 6379 },
  defaultJobOptions: {
    attempts: 1,           // coding tasks are not idempotent -- no auto-retry
    backoff: undefined,
    removeOnComplete: 100, // keep last 100 completed for inspection
    removeOnFail: 200,     // keep last 200 failed for debugging
  },
});
```

Priority levels map to BullMQ's numeric priorities (lower number = higher priority):

```typescript
const PRIORITY_MAP = {
  critical: 1,
  high: 2,
  normal: 3,
  low: 4,
} as const;
```

### Queue Monitoring

Bull Board 6.x mounted on the API:

```typescript
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";

const serverAdapter = new HonoAdapter("/ui/queues");

createBullBoard({
  queues: [
    new BullMQAdapter(peer6Queue),
    new BullMQAdapter(login2Queue),
    new BullMQAdapter(generalQueue),
  ],
  serverAdapter,
});

app.route("/ui", serverAdapter.registerPlugin());
```

Accessible at `https://api.ts.net:3000/ui/queues`. Protected by the same auth layer as the API.

### Persistent Storage

D1 (if on Workers) or SQLite via better-sqlite3 (if self-hosted). Schema:

```sql
-- Runner registry
CREATE TABLE runners (
  id            TEXT PRIMARY KEY,         -- hostname, e.g. "dell-01"
  tailscale_ip  TEXT NOT NULL,
  projects      TEXT NOT NULL,            -- JSON array: ["peer6", "login2"]
  devices       TEXT NOT NULL DEFAULT '[]', -- JSON array of attached devices
  tags          TEXT NOT NULL DEFAULT '[]', -- JSON array of capability tags
  status        TEXT NOT NULL DEFAULT 'active', -- active | draining | maintenance
  last_heartbeat INTEGER NOT NULL,        -- unix timestamp
  current_task  TEXT,                     -- task ID or null
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Task log
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,         -- ulid
  project       TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  runtime       TEXT NOT NULL DEFAULT 'crush',
  model         TEXT,
  mode          TEXT NOT NULL DEFAULT 'implement',
  runner_id     TEXT,
  queue         TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 3,
  status        TEXT NOT NULL DEFAULT 'queued',
    -- queued | running | paused | complete | failed | cancelled
  budget_usd    REAL,
  cost_usd      REAL,
  branch        TEXT,
  pr_url        TEXT,
  error         TEXT,
  output        TEXT,                     -- final output (truncated if large)
  started_at    INTEGER,
  completed_at  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Audit log (append-only)
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     INTEGER NOT NULL DEFAULT (unixepoch()),
  runner_id     TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  event_type    TEXT NOT NULL,            -- tool_call | approval_request | completion | error
  tool_name     TEXT,
  input         TEXT,                     -- JSON, truncated at 4KB
  output        TEXT,                     -- JSON, truncated at 4KB
  cost_usd      REAL
);

-- Cost tracking (materialized from tasks, updated on completion)
CREATE TABLE cost_daily (
  date          TEXT NOT NULL,            -- YYYY-MM-DD
  project       TEXT NOT NULL,
  runner_id     TEXT NOT NULL,
  total_usd     REAL NOT NULL DEFAULT 0,
  task_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, project, runner_id)
);

-- Device inventory
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,         -- "dell-01:yubikey-5"
  runner_id     TEXT NOT NULL,
  device_type   TEXT NOT NULL,            -- yubikey | flipper | arduino | bus-pirate | serial
  dev_path      TEXT NOT NULL,            -- /dev/yubikey0, /dev/flipper0
  udev_serial   TEXT,                     -- USB serial for stable identification
  status        TEXT NOT NULL DEFAULT 'available', -- available | in-use | disconnected
  last_seen     INTEGER NOT NULL,
  FOREIGN KEY (runner_id) REFERENCES runners(id)
);

CREATE INDEX idx_tasks_project ON tasks(project);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_runner ON tasks(runner_id);
CREATE INDEX idx_audit_task ON audit_log(task_id);
CREATE INDEX idx_audit_runner ON audit_log(runner_id);
CREATE INDEX idx_cost_date ON cost_daily(date);
```

### API Endpoints

#### Tasks

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tasks` | Submit a new task |
| `GET` | `/api/tasks` | List tasks (query: `?project=peer6&status=running&runner=dell-01&limit=50&offset=0`) |
| `GET` | `/api/tasks/:id` | Task detail including output |
| `GET` | `/api/tasks/:id/stream` | WebSocket: live output stream |
| `POST` | `/api/tasks/:id/approve` | Approve a paused agent action |
| `POST` | `/api/tasks/:id/deny` | Deny a paused agent action |
| `POST` | `/api/tasks/:id/cancel` | Cancel a running task (sends SIGTERM to agent process) |
| `POST` | `/api/tasks/:id/continue` | Resume a completed session with a new prompt (body: `{prompt}`) |

**POST /tasks request body:**

```json
{
  "project": "peer6",
  "prompt": "Add rate limiting middleware to the Hono API using sliding window algorithm",
  "runtime": "crush",
  "model": "anthropic/claude-sonnet-4-20250514",
  "mode": "implement",
  "runner": null,
  "needs": null,
  "budget": 2.00,
  "priority": "normal"
}
```

**POST /tasks response:**

```json
{
  "id": "01J5K9XYZABC123",
  "status": "queued",
  "queue": "tasks:peer6",
  "position": 3,
  "estimatedStart": null
}
```

#### Runners

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/runners` | List all runners with status, current task, devices |
| `GET` | `/api/runners/:id` | Runner detail: projects, devices, load, recent tasks |
| `POST` | `/api/runners/:id/drain` | Stop accepting new tasks (finish current) |
| `POST` | `/api/runners/:id/maintenance` | Mark offline for maintenance |
| `POST` | `/api/runners/:id/activate` | Return to active status |

#### Devices

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/devices` | All devices across fleet (query: `?type=yubikey&status=available`) |
| `GET` | `/api/devices/:id` | Device detail |

#### Operational

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/audit` | Audit log (query: `?task=X&runner=Y&from=ts&to=ts&limit=100`) |
| `GET` | `/api/cost` | Cost summary (query: `?period=day&project=peer6&from=2026-03-01`) |
| `GET` | `/api/health` | API health check |

#### Internal (Runner-to-API)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/internal/runners/register` | Runner self-registration on boot |
| `POST` | `/internal/runners/:id/heartbeat` | Heartbeat with status update |
| `POST` | `/internal/tasks/:id/started` | Runner reports task pickup |
| `POST` | `/internal/tasks/:id/result` | Runner reports task completion |
| `POST` | `/internal/tasks/:id/audit` | Runner pushes audit events |

Internal endpoints use a separate runner API key, distinct from the operator API key.

### Live Output Streaming

```
Runner                     Redis                      API                       CLI
  |                          |                          |                        |
  | PUBLISH task:abc:output  |                          |                        |
  | "line of agent stdout"   |                          |                        |
  |------------------------->|                          |                        |
  |                          | SUBSCRIBE task:abc:output|                        |
  |                          |<-------------------------|                        |
  |                          |                          |                        |
  |                          | message                  |                        |
  |                          |------------------------->|                        |
  |                          |                          | WS frame               |
  |                          |                          |----------------------->|
  |                          |                          |                        |
```

The API subscribes to the Redis pub/sub channel when a WebSocket client connects. When the client disconnects, the subscription is dropped. Output is also buffered to a Redis list (`task:abc:buffer`) for late joiners who need to catch up.

---

## 3. Runner / Worker Daemon

### Process Model

Each Dell 5070 runs a single TypeScript daemon process managed by systemd:

```ini
# /etc/systemd/system/code-orchestration-runner.service
[Unit]
Description=code-orchestration runner daemon
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=runner
Group=runner
WorkingDirectory=/opt/code-orchestration
ExecStart=/usr/bin/node --import tsx/esm src/runner/daemon.ts
Restart=on-failure
RestartSec=10
TimeoutStopSec=300
# Give 5 minutes for current task to finish on stop
KillSignal=SIGTERM

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/code-orchestration /home/runner/projects
PrivateTmp=true

# Environment
EnvironmentFile=/opt/code-orchestration/.env

[Install]
WantedBy=multi-user.target
```

### Daemon Lifecycle

```
                          Boot
                           |
                           v
                  +------------------+
                  |  Load config     |
                  |  (.env, runner   |
                  |   manifest)      |
                  +--------+---------+
                           |
                           v
                  +------------------+
                  |  Self-register   |
                  |  POST /internal/ |
                  |  runners/register|
                  +--------+---------+
                           |
                           v
                  +------------------+
                  |  Connect Redis   |
                  |  Start BullMQ    |
                  |  Worker          |
                  +--------+---------+
                           |
                           v
            +--------------+--------------+
            |                             |
            v                             v
   +------------------+        +------------------+
   |  Consume tasks   |        |  Heartbeat loop  |
   |  from subscribed |        |  every 30s       |
   |  queues          |        |                  |
   +--------+---------+        +------------------+
            |                             |
            v                             v
   +------------------+        +------------------+
   |  Process task    |        |  Device health   |
   |  (see below)     |        |  check every 60s |
   +--------+---------+        +------------------+
            |
            v
   +------------------+
   |  Report result   |
   |  POST /internal/ |
   |  tasks/:id/result|
   +------------------+
            |
            v
   (back to consume)


   SIGTERM received:
            |
            v
   +------------------+
   |  Stop consuming  |
   |  new tasks       |
   +------------------+
            |
            v
   +------------------+
   |  Wait for current|
   |  task to finish  |
   |  (up to 5 min)   |
   +------------------+
            |
            v
   +------------------+
   |  Deregister      |
   |  Disconnect      |
   |  Exit 0          |
   +------------------+
```

### Runner Configuration

Each runner has a manifest file declaring what it can do:

```yaml
# /opt/code-orchestration/runner.yaml
runner:
  id: dell-01
  hostname: dell-01.ts.net

projects:
  peer6:
    repo: git@github.com:link42/peer6.git
    path: /home/runner/projects/peer6
    branch: main
  login2:
    repo: git@github.com:link42/login2.git
    path: /home/runner/projects/login2
    branch: main

queues:
  - tasks:peer6
  - tasks:login2
  - tasks:needs-yubikey    # because this runner has a YubiKey
  - tasks:general

devices:
  - type: yubikey
    udev_name: yubikey0     # /dev/yubikey0 via udev rule
    serial: "12345678"
  - type: flipper
    udev_name: flipper0
    serial: "FLIP-ABCD"

concurrency: 1              # one task at a time (thin client constraint)

runtimes:
  crush:
    command: crush
    args: ["--non-interactive"]
  claude:
    command: claude
    args: ["--dangerously-skip-permissions"]
  aider:
    command: aider
    args: ["--yes-always"]
```

### Task Execution Flow

When the BullMQ worker picks up a task:

```typescript
async function processTask(job: Job<TaskPayload>): Promise<TaskResult> {
  const { project, prompt, runtime, model, mode, budget } = job.data;
  const config = loadProjectConfig(project);

  // 1. Ensure latest code
  await execAsync(`git -C ${config.path} fetch origin`);
  await execAsync(`git -C ${config.path} reset --hard origin/${config.branch}`);

  // 2. Create isolated worktree
  const worktreePath = `${config.path}/.worktrees/${job.id}`;
  const branchName = `task/${job.id}`;
  await execAsync(
    `git -C ${config.path} worktree add ${worktreePath} -b ${branchName}`
  );

  try {
    // 3. Select runtime adapter
    const adapter = getAdapter(runtime); // crush | claude | aider

    // 4. Spawn agent process
    const result = await adapter.run({
      cwd: worktreePath,
      prompt,
      model,
      mode,
      budget,
      onOutput: (line: string) => {
        // Stream to Redis pub/sub
        redis.publish(`task:${job.id}:output`, line);
        // Buffer for late joiners
        redis.rpush(`task:${job.id}:buffer`, line);
      },
      onApprovalNeeded: async (action: string) => {
        // Pause and wait for human approval via API
        await requestApproval(job.id, action);
      },
    });

    // 5. Commit and push
    await execAsync(`git -C ${worktreePath} add -A`);
    await execAsync(
      `git -C ${worktreePath} commit -m "task(${job.id}): ${truncate(prompt, 72)}" --allow-empty`
    );
    await execAsync(`git -C ${worktreePath} push origin ${branchName}`);

    // 6. Optionally create draft PR
    if (result.filesChanged > 0) {
      const prUrl = await createDraftPR(config, branchName, prompt, job.id);
      result.prUrl = prUrl;
    }

    return result;
  } finally {
    // 7. Clean up worktree
    await execAsync(`git -C ${config.path} worktree remove ${worktreePath} --force`);
  }
}
```

### Runtime Adapters

Each coding agent CLI has an adapter that normalizes the interface:

```typescript
interface RuntimeAdapter {
  name: string;
  run(opts: RunOptions): Promise<RunResult>;
  cancel(): Promise<void>;
}

interface RunOptions {
  cwd: string;
  prompt: string;
  model?: string;
  mode: "implement" | "test" | "review" | "analyze";
  budget?: number;
  onOutput: (line: string) => void;
  onApprovalNeeded: (action: string) => Promise<boolean>;
}

interface RunResult {
  status: "complete" | "failed" | "cancelled";
  cost: number;
  filesChanged: number;
  summary: string;
  prUrl?: string;
}
```

**Crush adapter** (example):

```typescript
class CrushAdapter implements RuntimeAdapter {
  name = "crush";
  private proc?: ChildProcess;

  async run(opts: RunOptions): Promise<RunResult> {
    const args = [
      "--non-interactive",
      "--prompt", opts.prompt,
    ];

    if (opts.model) args.push("--model", opts.model);
    if (opts.budget) args.push("--max-budget-usd", String(opts.budget));

    this.proc = spawn("crush", args, { cwd: opts.cwd });

    // Stream stdout and stderr
    this.proc.stdout.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (line) opts.onOutput(line);
      }
    });
    this.proc.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (line) opts.onOutput(`[stderr] ${line}`);
      }
    });

    const exitCode = await new Promise<number>((resolve) => {
      this.proc!.on("exit", (code) => resolve(code ?? 1));
    });

    return {
      status: exitCode === 0 ? "complete" : "failed",
      cost: await this.extractCost(),
      filesChanged: await this.countChangedFiles(opts.cwd),
      summary: await this.extractSummary(),
    };
  }

  async cancel(): Promise<void> {
    this.proc?.kill("SIGTERM");
  }
}
```

### Heartbeat

Every 30 seconds, the runner POSTs to the API:

```json
{
  "runner_id": "dell-01",
  "status": "busy",
  "current_task": "01J5K9XYZABC123",
  "uptime_seconds": 86400,
  "load_avg": [0.5, 0.3, 0.2],
  "memory_used_mb": 1200,
  "memory_total_mb": 8192,
  "disk_used_pct": 45,
  "devices": [
    {"type": "yubikey", "path": "/dev/yubikey0", "status": "available"},
    {"type": "flipper", "path": "/dev/flipper0", "status": "in-use"}
  ]
}
```

If the API receives no heartbeat for 90 seconds (3 missed intervals), the runner is marked `unresponsive`. After 5 minutes, any task assigned to it is marked `failed` with error `runner_timeout`.

### Device Health Monitoring

Every 60 seconds, the runner checks that expected USB devices are still connected:

```typescript
async function checkDevices(manifest: RunnerManifest): DeviceStatus[] {
  return manifest.devices.map((device) => {
    const devPath = `/dev/${device.udev_name}`;
    const exists = existsSync(devPath);
    return {
      type: device.type,
      path: devPath,
      status: exists ? "available" : "disconnected",
    };
  });
}
```

If a device disappears, the runner updates the API immediately (does not wait for next heartbeat). If a task requires that device, it is paused with `device_disconnected` status.

---

## 4. CLI

### Installation

```bash
# Global install
npm install -g code-orchestration

# Or run via npx
npx code-orchestration run peer6 "add rate limiting"
```

### Configuration

```yaml
# ~/.config/code-orchestration/config.yaml
api:
  url: https://api.ts.net:3000
  # or: http://dell-01.ts.net:3000
  key: co_live_abc123...

defaults:
  runtime: crush
  priority: normal
  mode: implement
```

### Commands

#### `co run <project> "<prompt>"`

Submit a task to the fleet.

```
co run peer6 "Add rate limiting middleware using sliding window. 100 req/min per IP."

Options:
  --runtime <name>        Agent runtime: crush, claude, aider       [default: crush]
  --model <provider/model> Model to use                             [default: per-project]
  --mode <mode>           Task mode: implement, test, review, analyze [default: implement]
  --runner <id>           Target specific runner                     [optional]
  --needs <device>        Require a device type (e.g., yubikey)      [optional]
  --budget <usd>          Maximum cost in USD                        [optional]
  --priority <level>      low, normal, high, critical                [default: normal]
  --no-stream             Submit and exit (don't stream output)      [default: false]

Examples:
  co run peer6 "fix the auth middleware bug" --budget 1.00
  co run login2 "add GitHub OAuth" --runtime claude --model anthropic/claude-sonnet-4-20250514
  co run rule1 "write tests for parser" --mode test --priority high
  co run peer6 "test YubiKey FIDO2 flow" --needs yubikey --runner dell-01
```

Default behavior: submits the task, then streams output until completion. Use `--no-stream` for fire-and-forget.

#### `co status`

Show all active tasks across the fleet.

```
$ co status

ID                STATUS    PROJECT  RUNNER    RUNTIME  COST     AGE
01J5K9XYZ123      running   peer6    dell-01   crush    $1.23    4m
01J5K9XYZ456      queued    login2   -         claude   -        2m
01J5K9XYZ789      paused    rule1    dell-02   crush    $0.45    12m
                            (awaiting approval: "delete migrations/")
```

#### `co logs <task-id|project>`

Stream or tail logs.

```
co logs 01J5K9XYZ123           # stream specific task
co logs peer6                  # stream latest task for project
co logs 01J5K9XYZ123 --tail 50 # last 50 lines
```

#### `co approve <task-id>` / `co deny <task-id>`

Handle approval requests from paused tasks.

```
$ co approve 01J5K9XYZ789
Approved action for task 01J5K9XYZ789: "delete migrations/"
Task resumed.
```

#### `co cancel <task-id>`

Cancel a running or queued task.

```
$ co cancel 01J5K9XYZ123
Task 01J5K9XYZ123 cancelled. Agent process terminated.
```

#### `co continue <task-id> "<prompt>"`

Resume a completed session with new instructions. Reuses the same worktree/branch.

```
$ co continue 01J5K9XYZ123 "also add tests for the rate limiter"
Resuming task 01J5K9XYZ123 on dell-01...
```

#### `co runners`

Fleet overview.

```
$ co runners

RUNNER    STATUS    TASK              PROJECTS        DEVICES          UPTIME
dell-01   busy      01J5K9XYZ123     peer6, login2   YubiKey, Flipper 3d 4h
dell-02   idle      -                rule1, threat10 (none)           7d 12h
dell-03   maint     -                peer6, login2   Arduino, BusPir  0s
```

#### `co runner <id> [action]`

Manage individual runners.

```
co runner dell-01 drain        # finish current task, stop accepting new ones
co runner dell-01 maintenance  # mark offline
co runner dell-01 activate     # return to service
```

#### `co devices`

Device inventory across all runners.

```
$ co devices

DEVICE         TYPE       RUNNER    PATH             STATUS
dell-01:yubi   yubikey    dell-01   /dev/yubikey0    available
dell-01:flip   flipper    dell-01   /dev/flipper0    in-use
dell-03:ardu   arduino    dell-03   /dev/arduino0    disconnected
dell-03:busp   bus-pirate dell-03   /dev/buspirate0  available
```

#### `co cost`

Cost reporting.

```
$ co cost --period week

Period: 2026-03-16 to 2026-03-22

PROJECT   TASKS   TOTAL COST   AVG COST
peer6     23      $34.12       $1.48
login2    8       $11.45       $1.43
rule1     15      $18.90       $1.26
------    ----    ----------   --------
TOTAL     46      $64.47       $1.40

Daily cap: $50.00 (current today: $12.34 = 25%)
Monthly cap: $500.00 (current month: $187.22 = 37%)
```

---

## 5. Technology Choices

### Decision Records

Each technology choice is documented with rationale and rejected alternatives.

#### Task Queue: BullMQ + Redis

**Choice:** BullMQ 5.x on Redis 7.x (or Valkey 8.x)

**Why:**
- TypeScript-native with first-class types. No codegen, no protobuf, no foreign function calls.
- Named queues with per-queue concurrency, priorities, and rate limiting -- maps directly to our per-project, per-capability routing model.
- Built-in pub/sub via Redis for live output streaming. No additional infrastructure needed.
- Battle-tested: 15M+ npm weekly downloads. Used at scale by GitLab, Automattic, and others.
- Redis also serves as the pub/sub transport for output streaming and the buffer store for late joiners. One dependency, three use cases.
- Bull Board provides a free monitoring dashboard that plugs in directly.

**Rejected alternatives:**

| Alternative | Why rejected |
|-------------|-------------|
| Temporal | Excellent for complex multi-step workflows with compensation logic. Overkill for v1 where tasks are fire-and-forget with simple status tracking. Earmarked for v3 when we need inter-project coordination and multi-step workflows. |
| pg-boss | Good PostgreSQL-based queue. We do not run PostgreSQL anywhere in our stack. Redis is faster for pub/sub streaming, which is a core requirement. |
| Inngest | Event-driven, good DX. Self-hosted story is less mature. Adds a dependency we would need to operate. |
| RabbitMQ | Proven, but requires a separate service with its own operational burden (Erlang runtime). BullMQ piggybacking on Redis is simpler for a 3-node fleet. |
| AWS SQS / GCP Pub/Sub | We are not on cloud. These are physical machines on a Tailscale mesh. |

---

#### API Framework: Hono

**Choice:** Hono 4.x

**Why:**
- Already the standard across link42 projects (peer6 apps/api, login2). Team familiarity is high.
- Runs on Cloudflare Workers, Node.js, Deno, and Bun with zero code changes. If we start self-hosted and later move to Workers, no rewrite needed.
- Middleware ecosystem covers our needs: bearer auth, CORS, logger, WebSocket upgrade.
- Tiny bundle (~14KB). Matters for Workers (which have a 1MB limit after compression).

**Rejected:** Express (heavier, no edge runtime support), Fastify (good but less portable to Workers), Elysia (Bun-only in practice).

---

#### Fleet Networking: Tailscale

**Choice:** Tailscale (managed WireGuard mesh)

**Why:**
- Zero-config WireGuard mesh. Each Dell gets a stable hostname (`dell-01.ts.net`) and IP. No port forwarding, no dynamic DNS, no firewall rules.
- SSH access to any runner from any authorized device without exposing SSH to the public internet.
- ACLs in the Tailscale admin console control which machines can talk to which services. Runners can reach Redis and the API; the API can reach runners for management; nothing else.
- MagicDNS means we reference `redis.ts.net` in config, not IP addresses that change.
- Free tier covers up to 100 devices. We have 3-10.

**Rejected:** Headscale (self-hosted Tailscale coordination server -- good but more ops burden for no gain at our scale), plain WireGuard (manual key exchange, no MagicDNS, no ACLs dashboard), ZeroTier (similar but less mature ACL story).

---

#### Fleet Provisioning: Ansible

**Choice:** Ansible 2.16+ (community edition)

**Why:**
- Agentless. Uses SSH (which we already have via Tailscale). No daemon to install or maintain on the thin clients.
- Industry standard. The Dell 5070s run Ubuntu 22.04 LTS -- Ansible's bread and butter.
- YAML playbooks are version-controlled alongside this repo. Infrastructure as code without a separate tool.
- Idempotent by design. Run the playbook 10 times, get the same result. Safe for iterative provisioning.
- Covers our provisioning needs: install packages, configure systemd, set up udev rules, distribute SSH keys, manage environment files.

**Rejected:** Salt (requires a minion agent on each node), Chef/Puppet (heavier, agent-based, more suited to hundreds of machines), plain bash scripts (not idempotent, hard to maintain).

---

#### Device Naming: udev rules

**Choice:** Custom udev rules for stable device paths.

**Why:**
- Linux-native, zero dependencies. Part of systemd/udev which is already on every Ubuntu machine.
- Solves the `/dev/ttyUSB0` vs `/dev/ttyUSB1` ordering problem. Devices get stable symlinks like `/dev/yubikey0`, `/dev/flipper0`, `/dev/arduino0`.
- Rules are simple text files, version-controlled, deployed via Ansible.

```
# /etc/udev/rules.d/99-code-orchestration.rules
# YubiKey 5
SUBSYSTEM=="usb", ATTR{idVendor}=="1050", ATTR{idProduct}=="0407", \
  SYMLINK+="yubikey0", MODE="0660", GROUP="plugdev"

# Flipper Zero
SUBSYSTEM=="tty", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", \
  SYMLINK+="flipper0", MODE="0660", GROUP="plugdev"

# Arduino Uno
SUBSYSTEM=="tty", ATTRS{idVendor}=="2341", ATTRS{idProduct}=="0043", \
  SYMLINK+="arduino0", MODE="0660", GROUP="dialout"

# Bus Pirate v4
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", \
  ATTRS{serial}=="BUSPIR-ABCD", \
  SYMLINK+="buspirate0", MODE="0660", GROUP="dialout"
```

**Rejected:** Custom daemon to poll `/dev` (unnecessary when udev does this natively), labgrid (full lab automation framework -- powerful but massive overkill for device naming).

---

#### Device Locking: flock(1)

**Choice:** POSIX `flock(1)` advisory file locks.

**Why:**
- POSIX standard, available on every Linux system. Zero dependencies.
- Prevents two tasks from accessing the same device simultaneously.
- Automatically released when the process exits (even on crash). No stale locks.
- Wrapper scripts use `flock --nonblock /var/lock/dev-yubikey0.lock <command>`. If the lock is held, the command fails immediately with a clear error.

```bash
#!/bin/bash
# /opt/code-orchestration/bin/yubikey-tool
# Wrapper that agents call instead of accessing /dev/yubikey0 directly
exec flock --nonblock /var/lock/dev-yubikey0.lock \
  ykman --device /dev/yubikey0 "$@"
```

**Rejected:** labgrid (full lab automation with resource locking -- overkill for <10 devices), custom lock service (unnecessary when `flock` exists), database locks (network round-trip for something that should be local).

---

#### Git Isolation: git worktree

**Choice:** `git worktree` for per-task isolation.

**Why:**
- Native git feature. No additional tools, no overhead.
- Each task gets its own worktree with its own branch. Tasks running in parallel on the same project (on different runners) do not interfere with each other.
- Both Claude Code and Crush support working in a subdirectory. The agent sees a normal git repo.
- Cleanup is one command: `git worktree remove`.
- No Docker overhead. The Dell 5070s have 8GB RAM and quad-core Pentium J5005 CPUs. Docker's memory overhead matters on these machines.

**Rejected:** Docker (adds 200-500MB memory overhead per container, complex device passthrough for USB), chroot (complex setup, brittle), separate full clones (wastes disk and network bandwidth).

---

#### Monitoring: Bull Board

**Choice:** Bull Board 6.x

**Why:**
- Free and open-source. MIT licensed.
- Plugs directly into BullMQ with zero configuration. `new BullMQAdapter(queue)` and it works.
- Shows queue depth, job status, job data, retry history, and processing times.
- Mounts as a middleware on our existing Hono server. No separate process.
- Good enough for v1. We need to see what is queued, what is running, what failed. Bull Board does this.

**Rejected:** Grafana (requires Prometheus, adds two services to operate), custom dashboard (unnecessary for v1), Datadog/New Relic (paid, cloud-hosted, we are on a private mesh).

---

#### Notifications: ntfy.sh

**Choice:** ntfy.sh (self-hosted or public instance)

**Why:**
- Dead simple. Send a push notification to a phone with a single HTTP POST:
  ```bash
  curl -d "Task abc123 complete ($1.47)" ntfy.sh/code-orchestration
  ```
- Self-hostable (single Go binary) or use the free public instance.
- Native apps for Android and iOS. Web UI available.
- No webhook configuration, no bot tokens, no OAuth flows. Just HTTP POST to a topic.
- Supports priority levels, tags, actions, and click URLs.

Also supported: Discord webhooks (for team channels), configured per-project.

**Rejected:** Slack (requires app registration, OAuth, heavier API), PagerDuty (overkill, paid), email (too slow for real-time notifications).

---

#### Serial Access: ser2net

**Choice:** ser2net 4.x for network-accessible serial ports.

**Why:**
- Lightweight daemon that maps serial ports to TCP sockets. Other machines on the Tailscale mesh can access a serial device on `dell-01.ts.net:3001` as if it were local.
- Standard tool, packaged in Ubuntu repos (`apt install ser2net`).
- Supports connection parameters (baud rate, parity, stop bits) in config.
- Useful when a task needs a serial device but is routed to a runner that does not have it physically attached.

```yaml
# /etc/ser2net.yaml
connection: &arduino
  accepter: tcp,3001
  connector: serialdev,/dev/arduino0,115200n81,local
  options:
    kickolduser: true
```

**Rejected:** USB/IP (higher latency, less reliable for serial, exposes raw USB which is a security concern), custom WebSocket bridge (unnecessary when ser2net exists).

---

#### HSM Remote Access: p11-kit PKCS#11

**Choice:** p11-kit with PKCS#11 forwarding for remote HSM/YubiKey access.

**Why:**
- Forwards the PKCS#11 cryptographic API, not the raw USB device. The YubiKey's private keys never leave the machine it is physically connected to.
- Standard interface: any application that speaks PKCS#11 (OpenSSL, GnuTLS, Firefox, ssh-agent) can use the remote token transparently.
- p11-kit supports remoting via Unix socket forwarding over SSH (which we have via Tailscale).

```bash
# On the machine that needs the YubiKey (remote):
export P11_KIT_SERVER_ADDRESS=unix:path=/tmp/p11-kit-remote.sock
ssh -L /tmp/p11-kit-remote.sock:/run/p11-kit/pkcs11 dell-01.ts.net

# Now local PKCS#11 calls are forwarded to dell-01's YubiKey
pkcs11-tool --module p11-kit-proxy.so --list-objects
```

**Rejected:** USB/IP (exposes raw USB device over network -- the YubiKey's private keys could theoretically be extracted by a malicious host), direct USB passthrough (requires physical proximity).

---

## 6. Security Model

### Principles

1. **No inbound ports on runners.** Runners poll outbound to Redis for tasks and POST outbound to the API for results. The only inbound access is Tailscale SSH for maintenance, which is authenticated via Tailscale's identity system.

2. **Zero-trust API access.** The API is behind Cloudflare Access (if on Workers) or requires a bearer token (if self-hosted). Two token types: operator tokens (for the CLI) and runner tokens (for the daemon).

3. **Least-privilege git access.** Each project uses a deploy key (read-write) scoped to that single repository. No personal access tokens, no blanket SSH keys. If a runner is compromised, only the repos it is configured for are exposed.

4. **Comprehensive audit logging.** Every tool call the coding agent makes is logged to the audit table: timestamp, runner ID, task ID, tool name, input (truncated), output (truncated), cost. This is non-negotiable for security-sensitive environments.

5. **Secrets isolation.** API keys, deploy keys, and service credentials live in `/opt/code-orchestration/.env` on each runner, deployed via Ansible vault. They are never included in task prompts or passed through the queue. The agent process inherits them from the systemd environment.

6. **Device access mediation.** Coding agents never access `/dev/*` directly. They call wrapper scripts (e.g., `/opt/code-orchestration/bin/yubikey-tool`) which:
   - Acquire a file lock (`flock`)
   - Validate the command against an allowlist
   - Execute with appropriate permissions
   - Log the interaction to the audit trail

7. **USB device whitelisting.** USBGuard runs on each runner with a strict whitelist policy. Only known devices (by vendor ID, product ID, and serial number) are allowed. Unknown USB devices are blocked at the kernel level.

```ini
# /etc/usbguard/rules.conf
# Allow only known devices
allow id 1050:0407 serial "12345678"  # YubiKey 5
allow id 0483:5740 serial "FLIP-ABCD" # Flipper Zero
allow id 2341:0043                     # Arduino Uno (no serial)
allow id 0403:6001 serial "BUSPIR-XY"  # Bus Pirate
reject                                 # Block everything else
```

8. **Fail-closed runner behavior.** If a runner cannot reach the API for 5 minutes, it stops accepting new tasks and pauses the current task (if any). It does not continue operating independently. The operator is notified via ntfy.sh.

9. **Unprivileged execution.** The runner daemon and all agent processes run as the `runner` user (UID 1001), which has:
   - Read/write access to `/home/runner/projects` (git repos)
   - Read/write access to `/opt/code-orchestration` (daemon code, config)
   - Group membership in `plugdev` and `dialout` (for USB/serial devices)
   - No sudo access
   - No access to other users' home directories

### Authentication Flow

```
CLI                          API                         Runner
 |                            |                            |
 | POST /api/tasks            |                            |
 | Authorization: Bearer      |                            |
 |   co_op_xxx (operator key) |                            |
 |--------------------------->|                            |
 |                            | Validate operator token    |
 |                            | Check budget caps          |
 |                            | Enqueue to BullMQ          |
 |                            |                            |
 |                            |     BullMQ job pickup      |
 |                            |                            |
 |                            | POST /internal/tasks/:id/  |
 |                            |   started                  |
 |                            | Authorization: Bearer      |
 |                            |   co_run_yyy (runner key)  |
 |                            |<---------------------------|
 |                            | Validate runner token      |
 |                            | Check runner is registered |
 |                            |                            |
```

### Network Security Diagram

```
+------------------------------------------------------------------+
|                    Tailscale ACL Policy                           |
|                                                                  |
|  Runners (tag:runner):                                           |
|    - CAN reach: redis.ts.net:6379 (Redis)                       |
|    - CAN reach: api.ts.net:3000 (API, if self-hosted)            |
|    - CAN reach: github.com:22 (git SSH)                          |
|    - CANNOT reach: each other (no lateral movement)              |
|    - CANNOT reach: operator devices                              |
|                                                                  |
|  Operator (tag:operator):                                        |
|    - CAN reach: api.ts.net:3000 (API)                            |
|    - CAN reach: any runner via SSH (maintenance)                 |
|    - CAN reach: redis.ts.net:6379 (direct queue inspection)      |
|                                                                  |
|  Redis (tag:infra):                                              |
|    - Accepts from: tag:runner, tag:operator                      |
|    - No outbound connections                                     |
|                                                                  |
+------------------------------------------------------------------+
```

---

## 7. Cost Control

### Three-Layer Budget System

```
                    +-----------------------------------+
                    |        Monthly Cap: $500          |
                    |  Notification at $400 (80%)       |
                    |  Hard stop at $500                |
                    +-----------------------------------+
                                    |
                    +-----------------------------------+
                    |         Daily Cap: $50            |
                    |  Notification at $40 (80%)        |
                    |  Hard stop at $50                 |
                    +-----------------------------------+
                                    |
                    +-----------------------------------+
                    |       Per-Task Budget Cap         |
                    |  Passed to agent CLI              |
                    |  e.g., --max-budget-usd 2.00      |
                    +-----------------------------------+
```

### Layer 1: Per-Task Budget

The CLI accepts `--budget <usd>` which is passed through to the agent runtime:

- **Crush:** `--max-budget-usd 2.00`
- **Claude Code:** Budget enforcement via provider API config
- **Aider:** Model-specific token limits translated from USD budget

If no per-task budget is specified, the project default applies. If no project default, the system default ($5.00) applies. Every task has a budget -- there is no unbounded execution.

### Layer 2: Daily Cap

Before enqueueing a task, the API checks the `cost_daily` table:

```typescript
async function checkDailyBudget(taskBudget: number): Promise<boolean> {
  const today = new Date().toISOString().split("T")[0];
  const result = await db
    .select({ total: sql`SUM(total_usd)` })
    .from(costDaily)
    .where(eq(costDaily.date, today))
    .get();

  const currentSpend = result?.total ?? 0;
  const dailyCap = parseFloat(process.env.DAILY_BUDGET_CAP ?? "50");

  if (currentSpend >= dailyCap * 0.8) {
    await notify(`Daily spend at ${((currentSpend / dailyCap) * 100).toFixed(0)}%: $${currentSpend.toFixed(2)} / $${dailyCap.toFixed(2)}`);
  }

  if (currentSpend + taskBudget > dailyCap) {
    return false; // Reject task
  }

  return true;
}
```

### Layer 3: Monthly Cap

Same logic, aggregated across the month. Checked alongside the daily cap at task submission time.

### Cost Tracking Flow

```
Runner completes task
        |
        v
POST /internal/tasks/:id/result
  { cost_usd: 1.47 }
        |
        v
API updates tasks table
  SET cost_usd = 1.47, status = 'complete'
        |
        v
API upserts cost_daily table
  INSERT INTO cost_daily (date, project, runner_id, total_usd, task_count)
  VALUES ('2026-03-22', 'peer6', 'dell-01', 1.47, 1)
  ON CONFLICT (date, project, runner_id) DO UPDATE
    SET total_usd = total_usd + 1.47, task_count = task_count + 1
        |
        v
Check daily/monthly thresholds
  If 80%+ -> ntfy notification
  If 100%+ -> reject future tasks
```

### Cost Reporting

The API exposes `/api/cost` which aggregates the `cost_daily` table:

```json
{
  "period": "week",
  "from": "2026-03-16",
  "to": "2026-03-22",
  "projects": {
    "peer6": {"tasks": 23, "cost": 34.12, "avg": 1.48},
    "login2": {"tasks": 8, "cost": 11.45, "avg": 1.43},
    "rule1": {"tasks": 15, "cost": 18.90, "avg": 1.26}
  },
  "total": {"tasks": 46, "cost": 64.47, "avg": 1.40},
  "caps": {
    "daily": {"limit": 50.00, "current": 12.34, "pct": 25},
    "monthly": {"limit": 500.00, "current": 187.22, "pct": 37}
  }
}
```

---

## 8. Scaling Path

### v1: Minimal Viable Fleet (current target)

- **3 Dell 5070 thin clients**, each with 8GB RAM, 128GB SSD, Pentium J5005.
- **Single Redis instance** running on `dell-01` (or whichever Dell is most reliable). No replication. If Redis goes down, tasks queue in the API and runners wait.
- **API on Cloudflare Workers** (or on `dell-01` alongside Redis if we want everything on the mesh).
- **Bull Board** for monitoring, mounted on the API.
- **Concurrency: 1 task per runner.** The thin clients do not have enough RAM for parallel agent execution.
- **3 concurrent tasks max** across the fleet.
- **Estimated throughput:** 50-100 tasks/day depending on average task duration.

### v2: Expanded Fleet + High Availability

- **5-10 Dells.** Add machines as needed. Provisioning is a single Ansible playbook run.
- **Redis Sentinel** for high availability. Three Sentinel processes across three Dells. Automatic failover if the Redis primary goes down.
- **Runner tagging** becomes important. Tag runners by project expertise, device availability, location.
- **Queue priorities** and rate limiting tuned based on v1 usage patterns.
- **Estimated throughput:** 100-300 tasks/day.

### v3: Workflow Orchestration

- **Temporal replaces BullMQ** for complex multi-step workflows. BullMQ is excellent for single-step task queuing but cannot express workflows like:
  - "Implement feature, then run tests, then if tests pass create PR, else fix and retry."
  - "Run security scan on PR, wait for human review, then deploy to staging."
- **Temporal server** runs on one Dell (or multiple for HA). Workers connect the same way as BullMQ workers.
- **BullMQ retained** for simple fire-and-forget tasks. Temporal for multi-step workflows.
- **Inter-project coordination:** a single workflow can span multiple projects (e.g., "update the shared package in peer6, then update login2 and rule1 to use the new version").

### v4: Web Dashboard

- **SvelteKit dashboard** replaces Bull Board. Custom UI tailored to our workflow:
  - Real-time task status with live output streaming
  - Fleet map showing runner status and device inventory
  - Cost dashboards with charts and trend analysis
  - Approval queue for paused tasks (approve/deny from the browser)
  - Audit log viewer with search and filtering
  - Project configuration management
- **WebSocket-native.** The dashboard connects to the API's WebSocket endpoints for real-time updates.
- SvelteKit is the team's frontend standard (peer6 apps/web).

### Future Considerations

- **Scheduled tasks / cron:** recurring work like "run the full test suite nightly" or "check for dependency updates every Monday." Implementable as Temporal schedules in v3.
- **Inter-runner communication:** tasks on different runners coordinating (e.g., "runner A builds the library, runner B tests the consumer"). Temporal workflows handle this naturally.
- **Auto-scaling:** if the queue depth exceeds a threshold, notify the operator to plug in another Dell. Full auto-provisioning with PXE boot is possible but likely overkill.
- **Multi-tenancy:** if other teams want to use the fleet, add team-scoped API keys, project ACLs, and per-team budget caps.
- **Artifact storage:** R2 or MinIO for build artifacts, test reports, and agent session recordings. Currently just git branches.

---

## Appendix A: Dell 5070 Specifications

| Spec | Value |
|------|-------|
| CPU | Intel Pentium Silver J5005 (4 cores, 1.5-2.8 GHz) |
| RAM | 8 GB DDR4 (upgradeable to 32 GB, 2x SO-DIMM) |
| Storage | 128 GB M.2 SATA SSD (replaceable) |
| Network | 1x Gigabit Ethernet, optional Wi-Fi |
| USB | 5x USB 3.0 (2 front, 3 rear), 1x USB-C |
| Power | 35W TDP, fanless or single small fan |
| OS | Ubuntu 22.04 LTS (or 24.04 LTS) |
| Cost | ~$60-80 used on eBay |

These are former enterprise thin clients -- cheap, quiet, low power, and purpose-built for 24/7 operation. The USB port density is excellent for device-heavy workloads.

## Appendix B: Directory Structure

```
code-orchestration/
  packages/
    api/                   # Hono API (control plane)
      src/
        routes/
          tasks.ts
          runners.ts
          devices.ts
          audit.ts
          cost.ts
        middleware/
          auth.ts
          budget.ts
        queue/
          setup.ts         # BullMQ queue definitions
          routing.ts       # Queue selection logic
        db/
          schema.ts        # Drizzle schema
          migrate.ts
        bull-board.ts      # Bull Board setup
        index.ts           # Hono app entry
      package.json

    runner/                # Runner daemon
      src/
        daemon.ts          # Main entry, lifecycle management
        heartbeat.ts       # Heartbeat loop
        devices.ts         # Device health monitoring
        adapters/
          crush.ts         # Crush runtime adapter
          claude.ts        # Claude Code runtime adapter
          aider.ts         # Aider runtime adapter
          base.ts          # RuntimeAdapter interface
        worktree.ts        # Git worktree management
        stream.ts          # Redis pub/sub output streaming
      runner.yaml          # Runner manifest (per-machine)
      package.json

    cli/                   # CLI tool
      src/
        commands/
          run.ts
          status.ts
          logs.ts
          approve.ts
          deny.ts
          cancel.ts
          continue.ts
          runners.ts
          runner.ts
          devices.ts
          cost.ts
        api-client.ts      # HTTP client for API
        config.ts          # Config file loading
        output.ts          # Table formatting, streaming display
        index.ts           # CLI entry (commander or citty)
      package.json

    shared/                # Shared types and utilities
      src/
        types.ts           # TaskPayload, RunResult, RunnerStatus, etc.
        constants.ts       # Priority maps, status enums
      package.json

  ansible/                 # Fleet provisioning
    inventory.yaml
    playbooks/
      provision-runner.yaml
      deploy-runner.yaml
      update-udev-rules.yaml
    roles/
      base/                # Ubuntu base setup, packages
      tailscale/           # Tailscale install + join
      redis/               # Redis server (single node)
      runner/              # Runner daemon install + systemd
      udev/                # USB device udev rules
      usbguard/            # USBGuard whitelist

  docs/
    architecture.md        # This document

  package.json             # Root workspace config (pnpm workspaces)
  pnpm-workspace.yaml
  tsconfig.base.json
```
