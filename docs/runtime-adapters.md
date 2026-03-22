---
layout: doc
title: Runtime Adapters
description: How OpenCode, Claude Code, and Aider are integrated via run-agent.sh.
---

# Runtime Adapters

Runtime adaptation happens in `run-agent.sh`, the single entry point that Nomad executes via its `raw_exec` driver. There is no TypeScript adapter interface. Instead, a shell script reads environment variables set by Nomad's parameterized job dispatch, selects and configures the appropriate coding agent CLI, executes it, and handles all post-run operations.

The system currently supports three runtimes: OpenCode, Claude Code, and Aider. Adding a new runtime means adding a `case` branch to `run-agent.sh`.

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
| `CO_RUNTIME` | `NOMAD_META_runtime` | Runtime to use (opencode, claude, aider) |
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
WORKSPACE="/opt/yeet/workspaces/$PROJECT"
cd "$WORKSPACE"
git fetch origin && git reset --hard origin/main
BRANCH="yeet/${PROJECT}-$(echo $NOMAD_JOB_ID | cut -c1-8)"
git worktree add "/tmp/$BRANCH" -b "$BRANCH"
cd "/tmp/$BRANCH"

# 3. Build runtime command
case "$RUNTIME" in
  opencode) CMD=(opencode run --quiet --model "$MODEL" ...) ;;
  claude) CMD=(claude -p --output-format stream-json ...) ;;
  aider)  CMD=(aider --message --yes-always ...) ;;
  *)      echo "Unknown runtime: $RUNTIME" >&2; exit 1 ;;
esac

# 3.5 Generate sandbox policy (v2)
POLICY="/tmp/policy-${NOMAD_ALLOC_ID}.yaml"
generate_policy "$PROJECT" "$MODE" "$CO_NEEDS_DEVICE" > "$POLICY"

# 4. Execute (sandboxed)
openshell-sandbox \
  --policy-rules /opt/yeet/policies/agent.rego \
  --policy-data "$POLICY" \
  -- "${CMD[@]}" < "$CO_PROMPT_FILE" | tee /tmp/output.log

# 5. Post-run: commit and push
git add -A && git commit -m "yeet: $PROJECT task via $RUNTIME"
git push origin "$BRANCH"
gh pr create --draft \
  --title "yeet: $PROJECT task" \
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
curl -d "Task complete: $PROJECT ($RUNTIME)" ntfy.sh/yeet-notifications

# 8. Cleanup
git worktree remove "/tmp/$BRANCH"
```

---

## 4. OpenCode Runtime Details

OpenCode provides multi-provider support (15+ providers) and a clean headless execution mode via `opencode run`.

### Command Construction by Mode

**implement mode:**
```bash
opencode run --quiet --model "$CO_MODEL" "$PROMPT"
```

**review mode (read-only):**
```bash
opencode run --quiet --model "$CO_MODEL" \
  "Review the following without making any changes. Do not edit any files. $PROMPT"
```

OpenCode does not have a native read-only mode like Claude Code's `--permission-mode plan`. The prompt must instruct it not to make changes.

**test mode:**
```bash
opencode run --quiet --model "$CO_MODEL" "$PROMPT"
```

**analyze mode:**
```bash
opencode run --quiet --model "$CO_MODEL" \
  "Analyze the following without making any changes. Do not edit any files. $PROMPT"
```

**With session resume:**
```bash
opencode run --quiet --model "$CO_MODEL" --session "$CO_SESSION_ID" "$PROMPT"
```

### Model Format

OpenCode uses `provider/model-name`:

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

**OpenCode:** Parse session output for cost summary line. Alternatively, query the SDK's session API after the process exits.

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
5. Test with a simple dispatch: `yeet run <project> "hello world" --runtime newruntime`

There is no adapter class to implement, no registry to update, and no TypeScript to write. The entire integration is a shell `case` branch plus a cost-parsing function.

---

## 9. Capability Matrix

What `run-agent.sh` can do with each runtime:

| Capability | OpenCode | Claude Code | Aider |
|---|---|---|---|
| Headless execution | `opencode run` | `claude -p` | `--message` |
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
| Sandbox isolation | OpenShell (process-level) | OpenShell (process-level) | OpenShell (process-level) |

---

## 10. Configuration

Runtime availability is per-node, configured via Ansible (which binaries are installed, which API keys are present). Project-level defaults and runtime preferences are in a config file read by the `yeet` CLI before dispatch:

```yaml
# ~/.config/yeet/config.yaml
defaults:
  runtime: opencode
  model: anthropic/claude-sonnet-4

projects:
  peer6:
    runtime: opencode
    model: anthropic/claude-sonnet-4
  login2:
    runtime: claude
    model: opus
  rule1:
    runtime: opencode
    model: google/gemini-2.5-pro
```

The `yeet` CLI reads these defaults and passes them as meta fields in the Nomad job dispatch. Task-level overrides (via `--runtime` and `--model` flags on the `yeet` command) take precedence over project defaults.

### Resolution Order

When resolving which runtime and model to use for a task:

1. **CLI flags** -- explicit `--runtime` and `--model` on the `yeet run` command.
2. **Project configuration** -- project entry in `~/.config/yeet/config.yaml`.
3. **Global defaults** -- top-level `defaults` in `~/.config/yeet/config.yaml`.
4. **Hard-coded fallback** -- OpenCode with `anthropic/claude-sonnet-4`.

---

## 11. Sandbox Integration

From v2, `run-agent.sh` wraps agent execution in NVIDIA OpenShell's standalone binary (`openshell-sandbox`). This provides Landlock + seccomp + network namespace isolation with per-task YAML policies. The sandbox is runtime-agnostic — it wraps the entire agent process regardless of whether the inner runtime is OpenCode, Claude Code, or Aider.

### Policy Generation

Before execution, `run-agent.sh` calls `generate_policy` to produce a per-task YAML policy file. The function takes three inputs — project, mode, and device flag — and outputs a policy tailored to the task's requirements.

```bash
generate_policy "$PROJECT" "$MODE" "$CO_NEEDS_DEVICE" > "/tmp/policy-${NOMAD_ALLOC_ID}.yaml"
```

#### `generate_policy` Logic

The function assembles four policy dimensions:

1. **Mode determines filesystem access:**
   - `implement` and `test` modes grant `read_write` access to the workspace directory.
   - `review` and `analyze` modes grant `read_only` access to the workspace directory.

2. **Runtime determines allowed network hosts:**
   - Claude Code tasks allow `api.anthropic.com`.
   - OpenCode tasks allow `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai` (since it supports multiple providers).
   - Aider tasks allow `api.anthropic.com`, `api.openai.com` (provider-dependent).
   - All runtimes allow `ntfy.sh` (for notifications) and the Nomad API address (for cost recording).

3. **Device flag adds hardware paths:**
   - When `CO_NEEDS_DEVICE` is set, `/dev/` paths are added to the `read_write` filesystem list. This supports GPU-accelerated workloads or tasks that need device access.

4. **Project determines workspace and registries:**
   - The project name resolves to a workspace path (`/opt/yeet/workspaces/$PROJECT`).
   - Project-specific package registries are added to the allowed network hosts (e.g., `registry.npmjs.org` for Node.js projects, `pypi.org` for Python projects).

### Policy Template

A generated policy YAML looks like this:

```yaml
# /tmp/policy-<alloc-id>.yaml
sandbox:
  filesystem:
    read_only:
      - /opt/yeet/bin
      - /opt/yeet/policies
      - /usr/lib
      - /usr/bin
      - /etc/resolv.conf
    read_write:
      - /opt/yeet/workspaces/peer6
      - /tmp
    denied:
      - /etc/shadow
      - /root
  network:
    allowed_hosts:
      - api.anthropic.com:443
      - ntfy.sh:443
      - registry.npmjs.org:443
    deny_all_other: true
  process:
    max_memory_mb: 4096
    max_cpu_seconds: 1800
    max_file_size_mb: 100
```

For a `review` mode task, the workspace entry would appear under `read_only` instead of `read_write`. When `CO_NEEDS_DEVICE` is set, `/dev/nvidia*` or similar paths are added to `read_write`.

### Relationship to Runtime Permission Systems

Claude Code has its own permission system (`--permission-mode`, `--allowedTools`, `--disallowedTools`) that controls what the agent can do at the application level. OpenShell operates at the OS level — it is the outer fence. The two systems complement each other:

- **Claude Code permissions** control which tools the agent model is allowed to invoke (e.g., can it call `Bash(rm -rf *)`?). These are advisory controls enforced by the Claude Code process itself.
- **OpenShell sandbox** controls what the process can actually do at the kernel level via Landlock LSM and seccomp filters. Even if the agent attempts an operation its runtime permissions allow, the sandbox blocks it if the policy does not permit it.

OpenCode and Aider have weaker or no internal permission systems (`--yolo`, `--yes-always`), which makes the OpenShell sandbox especially important for those runtimes. It provides the hard security boundary that the runtimes themselves do not enforce.

### v1 Compatibility

In v1 deployments (where `openshell-sandbox` is not installed), the policy generation step is skipped and the runtime command executes directly without sandboxing. The script detects this by checking for the binary:

```bash
if command -v openshell-sandbox &>/dev/null; then
  # v2: generate policy and wrap
  POLICY="/tmp/policy-${NOMAD_ALLOC_ID}.yaml"
  generate_policy "$PROJECT" "$MODE" "$CO_NEEDS_DEVICE" > "$POLICY"
  openshell-sandbox --policy-rules /opt/yeet/policies/agent.rego --policy-data "$POLICY" \
    -- "${CMD[@]}" < "$CO_PROMPT_FILE" | tee /tmp/output.log
else
  # v1: direct execution
  "${CMD[@]}" < "$CO_PROMPT_FILE" | tee /tmp/output.log
fi
```
