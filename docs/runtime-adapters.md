# Runtime Adapters

Runtime adaptation happens in `run-agent.sh`, the single entry point that Nomad executes via its `raw_exec` driver. There is no TypeScript adapter interface. Instead, a shell script reads environment variables set by Nomad's parameterized job dispatch, selects and configures the appropriate coding agent CLI, executes it, and handles all post-run operations.

The system currently supports three runtimes: Crush, Claude Code, and Aider. Adding a new runtime means adding a `case` branch to `run-agent.sh`.

---

## 1. Overview

When Nomad dispatches a parameterized job, it sets meta fields as environment variables and writes the dispatch payload to a file. `run-agent.sh` is the job's entry point. It performs the following steps:

1. Reads `CO_RUNTIME`, `CO_MODEL`, `CO_PROJECT`, `CO_MODE`, `CO_BUDGET`, `CO_SESSION_ID`, `CO_PROMPT_FILE` from the environment.
2. Changes to the project workspace directory.
3. Handles git operations (fetch, reset, worktree creation).
4. Builds the appropriate CLI command for the selected runtime.
5. Executes it, capturing output.
6. Handles post-run operations: commit, push, PR creation, cost recording, notification.

---

## 2. Environment Variables

Nomad sets these from the parameterized job's meta fields and built-in allocation data:

| Variable | Source | Description |
|----------|--------|-------------|
| `CO_PROJECT` | `NOMAD_META_project` | Project name (peer6, login2, rule1, etc.) |
| `CO_RUNTIME` | `NOMAD_META_runtime` | Runtime to use (crush, claude, aider) |
| `CO_MODEL` | `NOMAD_META_model` | Model identifier |
| `CO_MODE` | `NOMAD_META_mode` | Task mode (implement, test, review, analyze) |
| `CO_BUDGET` | `NOMAD_META_budget` | Cost cap in USD |
| `CO_SESSION_ID` | `NOMAD_META_session_id` | Session ID for resume (optional) |
| `CO_PROMPT_FILE` | `NOMAD_TASK_DIR/prompt.txt` | File containing the prompt text (from dispatch payload) |
| `NOMAD_ALLOC_ID` | (Nomad built-in) | Allocation ID |
| `NOMAD_JOB_ID` | (Nomad built-in) | Dispatched job ID |

API keys are sourced from the Nomad client's environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`.

---

## 3. Script Flow

The overall structure of `run-agent.sh`:

```bash
#!/bin/bash
set -euo pipefail

# 1. Read config from Nomad environment
PROJECT="$CO_PROJECT"
RUNTIME="$CO_RUNTIME"
MODEL="$CO_MODEL"
MODE="$CO_MODE"
BUDGET="${CO_BUDGET:-1.00}"
SESSION_ID="${CO_SESSION_ID:-}"
PROMPT=$(cat "$CO_PROMPT_FILE")

# 2. Workspace setup
WORKSPACE="/opt/code-orchestration/workspaces/$PROJECT"
cd "$WORKSPACE"
git fetch origin && git reset --hard origin/main
BRANCH="co/${PROJECT}-$(echo $NOMAD_JOB_ID | cut -c1-8)"
git worktree add "/tmp/$BRANCH" -b "$BRANCH"
cd "/tmp/$BRANCH"

# 3. Build runtime command
case "$RUNTIME" in
  crush)  CMD=(crush run --quiet --model "$MODEL" ...) ;;
  claude) CMD=(claude -p --output-format stream-json ...) ;;
  aider)  CMD=(aider --message --yes-always ...) ;;
  *)      echo "Unknown runtime: $RUNTIME" >&2; exit 1 ;;
esac

# 4. Execute
"${CMD[@]}" < "$CO_PROMPT_FILE" | tee /tmp/output.log

# 5. Post-run: commit and push
git add -A && git commit -m "co: $PROJECT task via $RUNTIME"
git push origin "$BRANCH"
gh pr create --draft \
  --title "co: $PROJECT task" \
  --body "Automated by code-orchestration. Job: $NOMAD_JOB_ID"

# 6. Record cost
COST=$(extract_cost /tmp/output.log)
curl -s -X PUT \
  -H "X-Nomad-Token: $NOMAD_TOKEN" \
  "$NOMAD_ADDR/v1/var/cost/$NOMAD_JOB_ID" \
  -d "{\"Items\": {
    \"cost_usd\": \"$COST\",
    \"project\": \"$PROJECT\",
    \"model\": \"$MODEL\",
    \"runtime\": \"$RUNTIME\",
    \"timestamp\": \"$(date -Iseconds)\"
  }}"

# 7. Notify
curl -d "Task complete: $PROJECT ($RUNTIME)" ntfy.sh/co-notifications

# 8. Cleanup
git worktree remove "/tmp/$BRANCH"
```

---

## 4. Crush Runtime Details

Crush is the continuation of the OpenCode project, maintained by the Charm team. It provides multi-provider support (15+ providers) and a clean headless execution mode via `crush run`.

### Command Construction by Mode

**implement mode:**
```bash
crush run --quiet --model "$CO_MODEL" "$PROMPT"
```

**review mode (read-only):**
```bash
crush run --quiet --model "$CO_MODEL" \
  "Review the following without making any changes. Do not edit any files. $PROMPT"
```

Crush does not have a native read-only mode like Claude Code's `--permission-mode plan`. The prompt must instruct it not to make changes.

**test mode:**
```bash
crush run --quiet --model "$CO_MODEL" "$PROMPT"
```

**analyze mode:**
```bash
crush run --quiet --model "$CO_MODEL" \
  "Analyze the following without making any changes. Do not edit any files. $PROMPT"
```

**With session resume:**
```bash
crush run --quiet --model "$CO_MODEL" --session "$CO_SESSION_ID" "$PROMPT"
```

### Model Format

Crush uses `provider/model-name`:

```
anthropic/claude-sonnet-4
anthropic/claude-haiku-4-5
google/gemini-2.5-pro
openai/gpt-4.1
openrouter/anthropic/claude-sonnet-4
groq/llama-4-scout-17b
```

### Limitations

- No lifecycle hooks (cannot intercept tool calls before/after execution)
- No native structured JSON output from CLI (use SDK for structured data)
- No built-in budget cap flag (relies on provider-level limits)
- No turn limit flag
- No native read-only mode (prompt-based enforcement only)

---

## 5. Claude Code Runtime Details

Claude Code is Anthropic's official CLI. It provides the richest structured output, fine-grained permission controls, and native cost tracking via `--max-budget-usd`.

### Command Construction by Mode

**implement mode:**
```bash
claude -p "$PROMPT" \
  --output-format stream-json \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Write,Bash(npm *),Bash(pnpm *),Glob,Grep" \
  --disallowedTools "Bash(git push *),Bash(rm -rf *)" \
  --model "$CO_MODEL" \
  --max-budget-usd "$CO_BUDGET"
```

**review mode:**
```bash
claude -p "$PROMPT" \
  --output-format stream-json \
  --permission-mode plan \
  --model "$CO_MODEL" \
  --max-budget-usd "$CO_BUDGET"
```

**test mode:**
```bash
claude -p "$PROMPT" \
  --output-format stream-json \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Bash(npm test *),Bash(pnpm test *),Bash(vitest *),Glob,Grep" \
  --model "$CO_MODEL" \
  --max-budget-usd "$CO_BUDGET"
```

**analyze mode:**
```bash
claude -p "$PROMPT" \
  --output-format stream-json \
  --permission-mode plan \
  --model "$CO_MODEL" \
  --max-budget-usd "$CO_BUDGET"
```

**With session resume:**
```bash
claude -p "$PROMPT" --resume "$CO_SESSION_ID" --output-format stream-json \
  --model "$CO_MODEL" --max-budget-usd "$CO_BUDGET"
```

### Permission Mode Mapping

| Task mode | Claude permission mode | Rationale |
|-----------|----------------------|-----------|
| implement | `acceptEdits` | Auto-approve file changes, shell commands controlled via allowedTools |
| test | `acceptEdits` | Can write test files and run test commands |
| review | `plan` | Read-only, no changes |
| analyze | `plan` | Read-only, no changes |

### Limitations

- Anthropic models only (no OpenAI, Google, etc.)
- No multi-provider support
- Requires Anthropic API key or Claude subscription

---

## 6. Aider Runtime Details

Aider is a mature, Python-based coding assistant. It is best suited for targeted edits where the files to change are already known.

### Command Construction

```bash
aider --message "$PROMPT" \
  --yes-always \
  --no-auto-commits \
  --model "$CO_MODEL" \
  --show-cost
```

For review and analyze modes, `run-agent.sh` prepends "Do not make any changes." to the prompt. Aider has no native read-only mode.

### Limitations

- No native session resume (no session ID system)
- No structured JSON output (parse stdout for cost)
- No permission system (`--yes-always` accepts everything)
- Must specify files explicitly for best results (or let aider auto-detect)
- No built-in budget cap
- No turn limit
- No sub-agent capability
- No git worktree support
- No MCP support

---

## 7. Cost Extraction

`run-agent.sh` extracts cost from each runtime's output differently:

**Crush:** Parse session output for cost summary line. Alternatively, query the SDK's session API after the process exits.

**Claude Code:** Parse `stream-json` output for the final `result` message containing `total_cost_usd`:
```bash
COST=$(grep '"type":"result"' /tmp/output.log | jq -r '.total_cost_usd')
```

**Aider:** Parse stdout for the `Cost:` line:
```bash
COST=$(grep 'Cost:' /tmp/output.log | grep -oP '\$[\d.]+' | tr -d '$')
```

### Storing Cost in Nomad Variables

```bash
curl -s -X PUT \
  -H "X-Nomad-Token: $NOMAD_TOKEN" \
  "$NOMAD_ADDR/v1/var/cost/$NOMAD_JOB_ID" \
  -d "{\"Items\": {
    \"cost_usd\": \"$COST\",
    \"project\": \"$CO_PROJECT\",
    \"model\": \"$CO_MODEL\",
    \"runtime\": \"$CO_RUNTIME\",
    \"timestamp\": \"$(date -Iseconds)\"
  }}"
```

---

## 8. Adding a New Runtime

1. Add a new `case` branch in `run-agent.sh` that builds the CLI command for the new runtime.
2. Handle command construction for each task mode (implement, test, review, analyze).
3. Handle session resume if the runtime supports it.
4. Add cost extraction logic for the new runtime's output format.
5. Test with a simple dispatch: `co run <project> "hello world" --runtime newruntime`

There is no adapter class to implement, no registry to update, and no TypeScript to write. The entire integration is a shell `case` branch plus a cost-parsing function.

---

## 9. Capability Matrix

What `run-agent.sh` can do with each runtime:

| Capability | Crush | Claude Code | Aider |
|---|---|---|---|
| Headless execution | `crush run` | `claude -p` | `--message` |
| Structured JSON output | Via SDK | `--output-format stream-json` | No |
| Session resume | `--session` / `--continue` | `--resume` | No |
| Multi-provider | 15+ providers | Anthropic only | Multi-provider |
| Budget cap | No (provider-level only) | `--max-budget-usd` | No |
| Turn limit | No | `--max-turns` | No |
| Read-only mode | Prompt-based | `--permission-mode plan` | Prompt-based |
| Permission control | `--yolo` / config | 5 modes + tool whitelists | `--yes-always` only |
| Sub-agents | Yes | Yes | No |
| Git worktree | Supported | `--worktree` flag | No |
| File discovery | Built-in | Built-in | Requires explicit `--file` / `--read` |
| MCP support | Yes | Yes | No |
| Cost in output | Best-effort parse | Exact (`total_cost_usd`) | Parse `Cost:` line |

---

## 10. Configuration

Runtime availability is per-Dell, configured via Ansible (which binaries are installed, which API keys are present). Project-level defaults and runtime preferences are in a config file read by the `co` CLI before dispatch:

```yaml
# ~/.config/co/config.yaml
defaults:
  runtime: crush
  model: anthropic/claude-sonnet-4

projects:
  peer6:
    runtime: crush
    model: anthropic/claude-sonnet-4
  login2:
    runtime: claude
    model: opus
  rule1:
    runtime: crush
    model: google/gemini-2.5-pro
```

The `co` CLI reads these defaults and passes them as meta fields in the Nomad job dispatch. Task-level overrides (via `--runtime` and `--model` flags on the `co` command) take precedence over project defaults.

### Resolution Order

When resolving which runtime and model to use for a task:

1. **CLI flags** -- explicit `--runtime` and `--model` on the `co run` command.
2. **Project configuration** -- project entry in `~/.config/co/config.yaml`.
3. **Global defaults** -- top-level `defaults` in `~/.config/co/config.yaml`.
4. **Hard-coded fallback** -- Crush with `anthropic/claude-sonnet-4`.
