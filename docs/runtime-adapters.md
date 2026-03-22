# Runtime Adapters

Runtime adapters are the abstraction layer that makes code-orchestration agent-agnostic. Each adapter normalizes a different AI coding agent CLI behind a common interface, allowing the runner daemon to spawn, monitor, and collect results from any supported runtime without coupling to its specifics.

The system currently supports three runtimes: Crush (the OpenCode successor), Claude Code, and Aider. Adding new runtimes requires implementing a single interface.

---

## 1. Adapter Interface

Every runtime adapter must implement the following interface:

```typescript
interface RuntimeAdapter {
  name: string;  // "crush" | "claude" | "aider"

  // Build the CLI command and arguments for a given task.
  buildCommand(task: Task): {
    command: string;
    args: string[];
    env: Record<string, string>;
  };

  // Parse a single line of stdout into a structured message.
  // The runner calls this on every line emitted by the child process.
  parseOutput(line: string): ParsedMessage;

  // After the process exits, attempt to extract a session ID from
  // the accumulated output. Returns null if the runtime does not
  // support session resume or no ID was found.
  extractSessionId(output: string): string | null;

  // Extract the total cost in USD from the accumulated output.
  // Returns null if cost information is unavailable.
  extractCost(output: string): number | null;

  // Build the command to resume an existing session, picking up
  // where the previous run left off.
  buildResumeCommand(
    task: Task,
    sessionId: string
  ): {
    command: string;
    args: string[];
    env: Record<string, string>;
  };

  // Verify that the runtime binary is installed and functional.
  healthCheck(): Promise<{
    ok: boolean;
    version: string;
    error?: string;
  }>;
}
```

### ParsedMessage

The `parseOutput` method normalizes runtime-specific output into a common message type:

```typescript
type ParsedMessage =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: string; is_error: boolean }
  | { type: "error"; message: string; code?: string }
  | { type: "cost"; usd: number; input_tokens?: number; output_tokens?: number }
  | { type: "unknown"; raw: string };
```

The runner daemon uses these normalized messages for logging, progress reporting, cost aggregation, and error detection. Adapters should map as much as they can; anything unrecognized should be emitted as `{ type: "unknown", raw: line }` rather than dropped.

---

## 2. Crush (OpenCode Successor) Adapter

Crush is the continuation of the OpenCode project, maintained by the Charm team. It provides multi-provider support (15+ providers), an optional TypeScript SDK, and a clean headless execution mode.

### Binary and Invocation

- **Binary**: `crush`
- **Headless mode**: `crush run "<prompt>"`
- **License**: FSL-1.1-MIT (Crush), MIT (original OpenCode)

### Key CLI Flags

| Flag | Purpose |
|------|---------|
| `--quiet` | Suppress interactive UI chrome, emit only content |
| `--model <provider/model>` | Set the primary model (e.g., `anthropic/claude-sonnet-4`) |
| `--small-model <provider/model>` | Set the secondary/cheap model for sub-tasks |
| `--session <id>` | Resume or attach to a named session |
| `--continue` | Continue the most recent session |
| `--yolo` | Auto-approve all tool invocations (no confirmation prompts) |

### Model Format

Crush uses a `provider/model-name` format:

```
anthropic/claude-sonnet-4
anthropic/claude-haiku-4-5
google/gemini-2.5-pro
openai/gpt-4.1
openrouter/anthropic/claude-sonnet-4
groq/llama-4-scout-17b
```

### Configuration

Crush reads configuration from `opencode.json` in the project root, or `~/.config/opencode/config.json` globally. Permissions can be configured per-tool:

```json
{
  "permissions": {
    "allowed_tools": ["read", "write", "bash", "glob", "grep"]
  }
}
```

### Output and Parsing

Crush writes to stdout as plain text. There is no native `--output-format stream-json` equivalent. For structured data, use the `@opencode-ai/sdk` TypeScript SDK, which exposes a REST API with typed session and message objects.

The adapter parses stdout line-by-line, looking for tool invocation markers and cost summaries. Because the output is less structured than Claude Code's stream-json, parsing is best-effort for tool_use/tool_result messages and reliable for text content.

### Session Resume

```
crush run "<prompt>" --session my-session-id
crush run "<prompt>" --continue
```

The `--session` flag attaches to a named session. The `--continue` flag resumes the most recent session. The adapter uses `--session <id>` for explicit resume.

### Cost Tracking

Cost data is available via the SDK's session API rather than CLI stdout. The adapter can query the SDK after the process exits to retrieve session cost, or parse any summary line printed at the end of a run.

### Command Construction Examples

**Implement task:**
```bash
crush run "Implement the user profile API endpoint in /Users/icd/Workspace/mentor/apps/api/src/routes/profile.ts. Follow the existing route patterns in the routes directory. Export a Hono route group with GET and PATCH handlers." \
  --model anthropic/claude-sonnet-4 \
  --quiet \
  --yolo
```

**Test task:**
```bash
crush run "Write Vitest tests for the profile route in /Users/icd/Workspace/mentor/apps/api/src/routes/profile.test.ts. Use app.request() pattern, not SELF.fetch. Follow the existing test patterns in the test files." \
  --model anthropic/claude-sonnet-4 \
  --quiet \
  --yolo
```

**Review task (analysis, no edits expected):**
```bash
crush run "Review the code in /Users/icd/Workspace/mentor/apps/api/src/routes/profile.ts for security issues, error handling gaps, and adherence to project patterns. Do not modify any files. Report findings only." \
  --model anthropic/claude-sonnet-4 \
  --quiet
```

**Analyze task:**
```bash
crush run "Analyze the database schema in /Users/icd/Workspace/mentor/apps/api/src/db/schema.ts. Document all tables, their relationships, and any missing indexes or constraints. Do not modify any files." \
  --model anthropic/claude-haiku-4-5 \
  --quiet
```

### Limitations

- No lifecycle hooks (cannot intercept tool calls before/after execution)
- No native structured JSON output from CLI (use SDK for structured data)
- No built-in budget cap flag (relies on provider-level limits)
- No turn limit flag

---

## 3. Claude Code Adapter

Claude Code is Anthropic's official CLI. It provides the richest structured output, fine-grained permission controls, lifecycle hooks, and native cost tracking.

### Binary and Invocation

- **Binary**: `claude`
- **Headless mode**: `claude -p "<prompt>"`
- **SDK**: `@anthropic-ai/claude-agent-sdk`

### Key CLI Flags

| Flag | Purpose |
|------|---------|
| `-p "<prompt>"` | Run in headless/pipe mode with the given prompt |
| `--output-format stream-json` | Emit newline-delimited JSON with structured messages |
| `--permission-mode <mode>` | Set the permission level (see below) |
| `--allowedTools "<tools>"` | Whitelist specific tools (comma-separated) |
| `--disallowedTools "<tools>"` | Blacklist specific tools |
| `--max-budget-usd <n>` | Hard cost cap in USD |
| `--max-turns <n>` | Maximum number of agentic turns |
| `--resume <session-id>` | Resume a previous session by ID |
| `--session-id <uuid>` | Set an explicit session ID for a new session |
| `--model <model>` | Set the model (haiku, sonnet, opus) |
| `--worktree` | Run in an isolated git worktree |
| `--system-prompt "<prompt>"` | Prepend a system prompt |
| `--no-session-persistence` | Do not persist the session to disk |

### Permission Modes

Claude Code has five permission modes that control how much autonomy the agent has:

| Mode | Behavior |
|------|----------|
| `default` | Prompts for confirmation on file writes and shell commands |
| `acceptEdits` | Auto-approves file edits, prompts for shell commands |
| `plan` | Read-only. Cannot write files or run commands |
| `dontAsk` | Auto-approves most operations, still blocks dangerous ones |
| `bypassPermissions` | Auto-approves everything (equivalent to `--yolo`) |

### Permission Mode to Task Mode Mapping

| Task mode | Permission mode | Rationale |
|-----------|----------------|-----------|
| implement | `acceptEdits` + `--allowedTools` whitelist | Needs to write files, but shell commands are controlled |
| test | `acceptEdits` + restricted tool set | Writes test files, runs test commands only |
| review | `plan` | Read-only analysis, no modifications |
| analyze | `plan` | Read-only exploration and reporting |

### Lifecycle Hooks

Claude Code supports PreToolUse, PostToolUse, and PermissionRequest hooks. These are configured in `.claude/hooks.json` and can auto-approve, block, or modify tool calls:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "tool": "Write",
        "command": "echo 'APPROVE'"
      }
    ]
  }
}
```

The orchestrator can use hooks to enforce constraints beyond what permission modes provide -- for example, blocking writes outside a specific directory, or logging every tool invocation to an audit trail.

### Output and Parsing

With `--output-format stream-json`, Claude Code emits one JSON object per line:

```json
{"type":"assistant","message":{"type":"text","text":"I'll read the file first."}}
{"type":"tool_use","tool":"Read","input":{"file_path":"/Users/icd/Workspace/mentor/apps/api/src/index.ts"}}
{"type":"tool_result","tool":"Read","output":"...file contents...","is_error":false}
{"type":"result","total_cost_usd":0.0342,"session_id":"abc-123-def"}
```

The adapter maps these directly to `ParsedMessage` types with minimal transformation. This is the most reliable output parsing of all three adapters.

### Session Resume

```bash
claude -p "<prompt>" --resume abc-123-def --output-format stream-json
```

The session ID is extracted from the final `result` message in stream-json output. The adapter stores this and uses it for `buildResumeCommand`.

### Cost Tracking

The `total_cost_usd` field in the final `result` message provides exact cost. The adapter extracts this directly -- no parsing heuristics needed.

### Command Construction Examples

**Implement task:**
```bash
claude -p "Implement the user profile API endpoint in /Users/icd/Workspace/mentor/apps/api/src/routes/profile.ts. Follow the existing route patterns in the routes directory. Export a Hono route group with GET and PATCH handlers." \
  --output-format stream-json \
  --permission-mode acceptEdits \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash" \
  --max-budget-usd 0.50 \
  --max-turns 30 \
  --model sonnet \
  --session-id "task-implement-profile-001"
```

**Test task:**
```bash
claude -p "Write Vitest tests for the profile route in /Users/icd/Workspace/mentor/apps/api/src/routes/profile.test.ts. Use app.request() pattern. Follow existing test patterns. Run the tests and fix any failures." \
  --output-format stream-json \
  --permission-mode acceptEdits \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash" \
  --max-budget-usd 0.50 \
  --max-turns 40 \
  --model sonnet \
  --session-id "task-test-profile-001"
```

**Review task:**
```bash
claude -p "Review the code in /Users/icd/Workspace/mentor/apps/api/src/routes/profile.ts for security issues, error handling gaps, and adherence to project patterns. Report findings only." \
  --output-format stream-json \
  --permission-mode plan \
  --max-budget-usd 0.20 \
  --max-turns 15 \
  --model sonnet \
  --session-id "task-review-profile-001"
```

**Analyze task:**
```bash
claude -p "Analyze the database schema in /Users/icd/Workspace/mentor/apps/api/src/db/schema.ts. Document all tables, relationships, and any missing indexes or constraints." \
  --output-format stream-json \
  --permission-mode plan \
  --max-budget-usd 0.10 \
  --max-turns 10 \
  --model haiku \
  --session-id "task-analyze-schema-001"
```

### Limitations

- Anthropic models only (no OpenAI, Google, etc.)
- No multi-provider support
- Requires Anthropic API key or Claude subscription

---

## 4. Aider Adapter

Aider is a mature, Python-based coding assistant. It excels at targeted edits where you already know which files need to change. It is less suitable for open-ended exploration or multi-file discovery tasks.

### Binary and Invocation

- **Binary**: `aider`
- **Headless mode**: `aider --message "<prompt>" --yes-always --no-auto-commits`
- **SDK**: Python only (`aider` package)

### Key CLI Flags

| Flag | Purpose |
|------|---------|
| `--message "<prompt>"` | Run non-interactively with the given prompt |
| `--yes-always` | Auto-approve all edits (no confirmation prompts) |
| `--no-auto-commits` | Disable automatic git commits (the orchestrator handles commits) |
| `--model <model>` | Set the primary model |
| `--edit-format <format>` | Set edit format (`diff`, `whole`, `udiff`, `architect`) |
| `--show-cost` | Print cost summary at end of run |
| `--file <path>` | Add a file to the chat context (repeatable) |
| `--read <path>` | Add a read-only file to context (repeatable) |
| `--no-auto-lint` | Disable automatic linting |
| `--no-auto-test` | Disable automatic test execution |

### Model Format

Aider uses provider-prefixed model names similar to Crush:

```
anthropic/claude-sonnet-4
openai/gpt-4.1
google/gemini-2.5-pro
deepseek/deepseek-r1
```

### Output and Parsing

Aider writes to stdout as unstructured plain text. There is no JSON output mode. The adapter performs best-effort parsing:

- Lines starting with `>` are typically echoed prompts
- Lines containing file paths with diff markers indicate edits
- Cost summaries appear at the end if `--show-cost` is used
- Error messages are heuristically detected by keywords

This makes Aider the least reliable adapter for structured output parsing. The adapter captures the full stdout and extracts what it can, but tool_use and tool_result messages are not reliably distinguishable.

### Session Resume

Aider has limited session resume capability. It does not assign session IDs. The adapter can approximate resume by replaying the chat history file (`.aider.chat.history.md`), but this is fragile and not equivalent to the session resume offered by Crush or Claude Code.

`extractSessionId` always returns `null` for the Aider adapter. `buildResumeCommand` throws an error.

### Cost Tracking

With `--show-cost`, Aider prints a cost summary at the end of the run:

```
Tokens: 12.5k sent, 3.2k received. Cost: $0.04
```

The adapter parses this line with a regex. If the line is not found (or the format changes between Aider versions), `extractCost` returns `null`.

### Command Construction Examples

**Implement task:**
```bash
aider \
  --message "Implement the user profile API endpoint with GET and PATCH handlers. Follow the existing route patterns." \
  --file /Users/icd/Workspace/mentor/apps/api/src/routes/profile.ts \
  --read /Users/icd/Workspace/mentor/apps/api/src/routes/goals.ts \
  --read /Users/icd/Workspace/mentor/apps/api/src/db/schema.ts \
  --model anthropic/claude-sonnet-4 \
  --yes-always \
  --no-auto-commits \
  --show-cost
```

**Test task:**
```bash
aider \
  --message "Write Vitest tests for the profile route. Use app.request() pattern. Follow existing test patterns." \
  --file /Users/icd/Workspace/mentor/apps/api/src/routes/profile.test.ts \
  --read /Users/icd/Workspace/mentor/apps/api/src/routes/profile.ts \
  --read /Users/icd/Workspace/mentor/apps/api/src/routes/goals.test.ts \
  --model anthropic/claude-sonnet-4 \
  --yes-always \
  --no-auto-commits \
  --show-cost
```

**Review task:**
```bash
aider \
  --message "Review this file for security issues, error handling gaps, and adherence to project patterns. Do not make any changes. Report findings only." \
  --read /Users/icd/Workspace/mentor/apps/api/src/routes/profile.ts \
  --model anthropic/claude-sonnet-4 \
  --no-auto-commits \
  --show-cost
```

**Analyze task:**
```bash
aider \
  --message "Analyze the database schema. Document all tables, relationships, and any missing indexes or constraints. Do not make any changes." \
  --read /Users/icd/Workspace/mentor/apps/api/src/db/schema.ts \
  --model anthropic/claude-haiku-4-5 \
  --no-auto-commits \
  --show-cost
```

Note that for review and analyze tasks, all files are added with `--read` (read-only) rather than `--file` (editable). This prevents Aider from attempting modifications.

### Limitations

- No structured JSON output
- No session resume (no session ID system)
- No lifecycle hooks or permission system beyond `--yes-always`
- No built-in budget cap
- No turn limit
- No sub-agent capability
- Requires explicit file lists (cannot discover files on its own)
- No git worktree support
- No MCP support
- Python-only SDK (no TypeScript/JS SDK)

---

## 5. Adding a New Runtime

To add support for a new coding agent CLI, follow these steps:

### Step 1: Create the Adapter

Create a new file in the adapters directory implementing the `RuntimeAdapter` interface:

```typescript
// adapters/my-runtime.ts
import { RuntimeAdapter, Task, ParsedMessage } from "../types";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";

export class MyRuntimeAdapter implements RuntimeAdapter {
  name = "my-runtime" as const;

  buildCommand(task: Task) {
    return {
      command: "/usr/local/bin/my-runtime",
      args: ["run", task.prompt, "--headless"],
      env: { MY_RUNTIME_API_KEY: process.env.MY_RUNTIME_API_KEY ?? "" },
    };
  }

  parseOutput(line: string): ParsedMessage {
    // Map runtime-specific output to ParsedMessage.
    // Return { type: "unknown", raw: line } for anything unrecognized.
    return { type: "text", content: line };
  }

  extractSessionId(output: string): string | null {
    // Parse session ID from output, or return null if not supported.
    return null;
  }

  extractCost(output: string): number | null {
    // Parse cost from output, or return null if not available.
    return null;
  }

  buildResumeCommand(task: Task, sessionId: string) {
    throw new Error("my-runtime does not support session resume");
  }

  async healthCheck() {
    const result = await execFileNoThrow("my-runtime", ["--version"]);
    if (result.status === 0) {
      return { ok: true, version: result.stdout.trim() };
    }
    return { ok: false, version: "", error: result.stderr };
  }
}
```

### Step 2: Register in the Adapter Registry

Add the adapter to the registry so the runner can look it up by name:

```typescript
// adapters/registry.ts
import { CrushAdapter } from "./crush";
import { ClaudeAdapter } from "./claude";
import { AiderAdapter } from "./aider";
import { MyRuntimeAdapter } from "./my-runtime";

export const adapters = {
  crush: new CrushAdapter(),
  claude: new ClaudeAdapter(),
  aider: new AiderAdapter(),
  "my-runtime": new MyRuntimeAdapter(),
};

export function getAdapter(name: string): RuntimeAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(
      `Unknown runtime "${name}". Available: ${Object.keys(adapters).join(", ")}`
    );
  }
  return adapter;
}
```

### Step 3: Document CLI Flags and Capabilities

Add an entry to the capability matrix (Section 6) and document:

- The binary name and headless invocation pattern
- All relevant CLI flags
- Output format and what can be reliably parsed
- Session resume support (or lack thereof)
- Permission/safety controls
- Provider and model support
- Cost tracking mechanism
- Any SDK or API options

### Step 4: Test with a Simple Task

Run the adapter through a basic smoke test:

```typescript
const adapter = getAdapter("my-runtime");

// Verify the binary is installed
const health = await adapter.healthCheck();
assert(health.ok, `Health check failed: ${health.error}`);

// Build and execute a simple task
const task: Task = {
  id: "test-001",
  prompt: "Read the file /tmp/test.txt and report its contents.",
  mode: "analyze",
  workdir: "/tmp",
};

const { command, args, env } = adapter.buildCommand(task);
// Spawn the process, collect output, verify parseOutput works
```

### Step 5: Document Limitations

Be explicit about what the new runtime cannot do compared to others. Common gaps:

- No structured output (makes parsing unreliable)
- No session resume (prevents continuation of failed tasks)
- No permission controls (all-or-nothing execution)
- No cost tracking (cannot enforce budgets)
- No sub-agent support (limits complex multi-step tasks)

---

## 6. Capability Matrix

| Capability | Crush | Claude Code | Aider |
|---|---|---|---|
| Headless execution | Yes (`crush run`) | Yes (`claude -p`) | Yes (`--message`) |
| Structured JSON output | Via SDK | `--output-format stream-json` | No |
| Session resume | Yes (`--session`, `--continue`) | Yes (`--resume`) | No |
| Multi-provider | 15+ providers | Anthropic only | Multi-provider |
| Budget cap | Provider-level config | `--max-budget-usd` | No |
| Turn limit | No | `--max-turns` | No |
| Permission control | `--yolo` / config file | 5 modes + lifecycle hooks | `--yes-always` only |
| Lifecycle hooks | No | PreToolUse, PostToolUse, PermissionRequest | No |
| Sub-agents | Yes (agent tool) | Yes (Agent tool) | No |
| Git worktree | Supported | `--worktree` flag | No |
| SDK | `@opencode-ai/sdk` (TypeScript) | `@anthropic-ai/claude-agent-sdk` (TypeScript) | Python only |
| File discovery | Built-in (glob, grep, etc.) | Built-in (Glob, Grep, etc.) | Requires explicit `--file` / `--read` |
| MCP support | Yes | Yes | No |
| System prompt injection | Via config | `--system-prompt` flag | Via config file |
| Edit format control | N/A | N/A | `--edit-format` (diff, whole, udiff, architect) |

---

## 7. Runtime Selection Strategy

### When to Use Crush

Crush is the default choice for most tasks. Use it when:

- You need multi-provider flexibility (e.g., using Google models for some tasks, Anthropic for others).
- You want a consistent interface across providers.
- The task does not require fine-grained permission hooks.
- You want to use the `@opencode-ai/sdk` for programmatic integration beyond CLI spawning.
- Cost optimization via provider selection matters (e.g., routing cheap tasks to Groq or Google).

### When to Use Claude Code

Use Claude Code when:

- You need fine-grained permission control (e.g., `plan` mode for read-only analysis, `acceptEdits` with tool whitelists for implementation).
- You need lifecycle hooks to intercept or audit tool calls.
- You want the most reliable structured JSON output for parsing.
- You need hard budget caps (`--max-budget-usd`) or turn limits (`--max-turns`).
- The task specifically benefits from Anthropic models and you do not need provider flexibility.
- You want git worktree isolation (`--worktree` flag).

### When to Use Aider

Use Aider when:

- The task is a targeted edit to known files (you already know exactly which files to change).
- You want the `architect` edit format for high-level planning followed by implementation.
- The task is simple enough that structured output parsing is not needed.
- You are working in a Python-centric environment and want to use Aider's Python SDK.

Aider is **not recommended** for:

- Open-ended exploration (it cannot discover files on its own).
- Tasks requiring session resume (no session ID system).
- Tasks requiring budget enforcement (no built-in cap).
- Complex multi-step workflows (no sub-agent support).

### Decision Flowchart

```
Is the task read-only (review/analyze)?
  Yes -> Does it need strict read-only enforcement?
    Yes -> Claude Code (plan mode)
    No  -> Crush or Claude Code
  No (implementation/test) ->
    Do you need multi-provider model selection?
      Yes -> Crush
      No  ->
        Do you need permission hooks or budget caps?
          Yes -> Claude Code
          No  ->
            Do you already know the exact files?
              Yes -> Any runtime (Aider is fine here)
              No  -> Crush or Claude Code (file discovery needed)
```

---

## 8. Configuration

### Runner Configuration

The runner daemon is configured with the runtimes available on the host machine. This is a machine-level concern -- which binaries are installed and where.

```yaml
# ~/.config/code-orchestration/runner.yaml

runtimes:
  crush:
    binary: /usr/local/bin/crush
    version: "0.1.x"
    default_model: "anthropic/claude-sonnet-4"
    small_model: "anthropic/claude-haiku-4-5"
    env:
      # Provider API keys are read from the environment by default.
      # Override here if needed.
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
      OPENAI_API_KEY: "${OPENAI_API_KEY}"

  claude:
    binary: /usr/local/bin/claude
    version: "2.x"
    default_model: "sonnet"
    default_permission_mode: "acceptEdits"
    max_budget_usd: 1.00
    max_turns: 50
    env:
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"

  aider:
    binary: /usr/local/bin/aider
    version: "0.75.x"
    default_model: "anthropic/claude-sonnet-4"
    default_edit_format: "diff"
    env:
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
```

### Project Configuration

Each project can specify its preferred runtime and model. The orchestrator uses this when dispatching tasks for that project.

```yaml
# ~/.config/code-orchestration/projects.yaml

projects:
  peer6:
    repo: git@github.com:wan0net/mentor.git
    workdir: /Users/icd/Workspace/mentor
    preferred_runtime: crush
    preferred_model: "anthropic/claude-sonnet-4"
    small_model: "anthropic/claude-haiku-4-5"
    budget_per_task_usd: 0.50
    settings:
      # Crush-specific: auto-approve everything for CI-like execution
      yolo: true

  login2:
    repo: git@github.com:wan0net/auth.git
    workdir: /Users/icd/Workspace/auth
    preferred_runtime: claude
    preferred_model: "opus"
    budget_per_task_usd: 2.00
    settings:
      # Claude Code-specific
      permission_mode: "acceptEdits"
      max_turns: 40
      worktree: true

  rule1:
    repo: git@github.com:wan0net/ism-explorer.git
    workdir: /Users/icd/Workspace/ism-explorer
    preferred_runtime: crush
    preferred_model: "google/gemini-2.5-pro"
    small_model: "google/gemini-2.5-flash"
    budget_per_task_usd: 0.30
```

### Task-Level Override

Individual tasks can override the project default at dispatch time:

```typescript
const task: Task = {
  id: "task-042",
  project: "peer6",
  prompt: "Refactor the auth middleware to use the new session validation endpoint.",
  mode: "implement",
  // Override: use Claude Code for this specific task because we want
  // strict permission hooks and budget enforcement.
  runtime: "claude",
  model: "sonnet",
  budget_usd: 0.75,
  max_turns: 30,
};
```

### Resolution Order

When the runner resolves which runtime and model to use for a task, it follows this precedence (highest to lowest):

1. **Task-level override** -- explicit `runtime` and `model` on the task object.
2. **Project configuration** -- `preferred_runtime` and `preferred_model` in projects.yaml.
3. **Runner defaults** -- `default_model` in the runtime's runner.yaml entry.
4. **Hard-coded fallback** -- Crush with `anthropic/claude-sonnet-4`.

If the resolved runtime is not installed (healthCheck fails), the runner logs an error and falls back to the next available runtime in the order: Crush, Claude Code, Aider.
