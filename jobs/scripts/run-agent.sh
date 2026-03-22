#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# run-agent.sh — Core runtime adapter for code-orchestration (yeet)
#
# Nomad's raw_exec driver executes this script. It reads dispatch metadata
# from environment variables, sets up a git worktree, runs the selected
# coding agent, handles post-run git operations, records cost, and sends
# notifications.
#
# Supported runtimes: opencode, claude, aider
# ===========================================================================

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() { echo "[$(date -Iseconds)] $*" >&2; }

# ---------------------------------------------------------------------------
# 1. Read configuration from Nomad environment
# ---------------------------------------------------------------------------
PROJECT="${CO_PROJECT:?CO_PROJECT is required}"
RUNTIME="${CO_RUNTIME:-opencode}"
MODEL="${CO_MODEL:-}"
MODE="${CO_MODE:-implement}"
BUDGET="${CO_BUDGET:-}"
SESSION_ID="${CO_SESSION_ID:-}"
NEEDS_DEVICE="${CO_NEEDS_DEVICE:-}"
PROMPT_FILE="${CO_PROMPT_FILE:-${NOMAD_TASK_DIR:-.}/prompt.txt}"
ALLOC_ID="${NOMAD_ALLOC_ID:-local-$(date +%s)}"
JOB_ID="${NOMAD_JOB_ID:-local-run}"
NOMAD_ADDR="${NOMAD_ADDR:-}"
NOMAD_TOKEN="${NOMAD_TOKEN:-}"
NTFY_TOPIC="${NTFY_TOPIC:-yeet-notifications}"

# Derived paths
WORKSPACE="/opt/yeet/workspaces/$PROJECT"
OUTPUT_LOG="/tmp/yeet-output-${ALLOC_ID}.log"
POLICY_FILE="/tmp/yeet-policy-${ALLOC_ID}.yaml"
SHORT_ID=$(echo "$JOB_ID" | grep -o '[a-f0-9]\{8\}$' || echo "$JOB_ID" | tail -c 9)
BRANCH="yeet/${PROJECT}-${SHORT_ID}"
WORKTREE_DIR="/tmp/yeet-worktree-${ALLOC_ID}"
EXIT_CODE=0

log "Starting task: project=$PROJECT runtime=$RUNTIME model=$MODEL mode=$MODE"
log "Job=$JOB_ID Alloc=$ALLOC_ID Branch=$BRANCH"

# ---------------------------------------------------------------------------
# 11. Cleanup trap (defined early so it always runs)
# ---------------------------------------------------------------------------
cleanup() {
    log "Cleaning up..."
    git -C "$WORKSPACE" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
    rm -f "$POLICY_FILE" 2>/dev/null || true
    rm -f "$OUTPUT_LOG" 2>/dev/null || true
    # flock on fd 9 is released automatically when the process exits
    log "Cleanup complete. Exiting with code $EXIT_CODE"
    exit "$EXIT_CODE"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 2. Workspace setup
# ---------------------------------------------------------------------------
setup_workspace() {
    log "Setting up workspace at $WORKSPACE"

    if [[ ! -d "$WORKSPACE" ]]; then
        log "ERROR: Workspace directory $WORKSPACE does not exist"
        exit 1
    fi

    cd "$WORKSPACE"
    git fetch origin

    # Determine the default branch (main, master, etc.)
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||')
    log "Default branch: $DEFAULT_BRANCH"

    git reset --hard "origin/$DEFAULT_BRANCH"

    # Remove stale worktree if it exists from a previous failed run
    if [[ -d "$WORKTREE_DIR" ]]; then
        log "Removing stale worktree at $WORKTREE_DIR"
        git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
    fi

    # Delete the branch if it already exists (idempotent)
    git branch -D "$BRANCH" 2>/dev/null || true

    git worktree add "$WORKTREE_DIR" -b "$BRANCH"
    cd "$WORKTREE_DIR"

    log "Worktree created at $WORKTREE_DIR on branch $BRANCH"
}

# ---------------------------------------------------------------------------
# 3. Device locking
# ---------------------------------------------------------------------------
acquire_device_lock() {
    if [[ -z "$NEEDS_DEVICE" ]]; then
        return 0
    fi

    log "Acquiring lock for device: $NEEDS_DEVICE"

    local lock_dir="/var/lock/yeet"
    local lock_file="${lock_dir}/device-${NEEDS_DEVICE}.lock"

    mkdir -p "$lock_dir"

    # Open lock file on fd 9
    exec 9>"$lock_file"

    if ! flock -n 9; then
        log "ERROR: Device $NEEDS_DEVICE is busy (lock held by another task)"
        exit 1
    fi

    log "Lock acquired for device $NEEDS_DEVICE"

    # Verify the device actually exists
    if [[ ! -e "/dev/$NEEDS_DEVICE" ]]; then
        log "ERROR: Device /dev/$NEEDS_DEVICE does not exist"
        exit 1
    fi

    log "Device /dev/$NEEDS_DEVICE is present and locked"
}

# ---------------------------------------------------------------------------
# 4. Generate sandbox policy
# ---------------------------------------------------------------------------
generate_policy() {
    if ! command -v openshell-sandbox &>/dev/null; then
        log "openshell-sandbox not found, skipping policy generation (v1 mode)"
        return 1
    fi

    log "Generating sandbox policy at $POLICY_FILE"

    # Determine workspace access based on mode
    local ws_access="read_write"
    if [[ "$MODE" == "review" || "$MODE" == "analyze" ]]; then
        ws_access="read_only"
    fi

    # Build filesystem section
    local fs_read_only="    read_only:
      - /usr
      - /lib
      - /lib64
      - /bin
      - /sbin
      - /etc
      - /opt/yeet/devices/"

    local fs_read_write="    read_write:
      - /tmp"

    if [[ "$ws_access" == "read_write" ]]; then
        fs_read_write="    read_write:
      - $WORKTREE_DIR
      - /tmp"
    else
        fs_read_only="${fs_read_only}
      - $WORKTREE_DIR"
    fi

    # Add device paths if needed
    if [[ -n "$NEEDS_DEVICE" ]]; then
        fs_read_write="${fs_read_write}
      - /dev/$NEEDS_DEVICE
      - /var/lock/yeet/"
    fi

    # Build network section based on runtime
    local network_hosts=""
    case "$RUNTIME" in
        opencode)
            network_hosts="    allowed_hosts:
      - api.anthropic.com:443
      - api.openai.com:443
      - generativelanguage.googleapis.com:443
      - github.com:443
      - registry.npmjs.org:443"
            ;;
        claude)
            network_hosts="    allowed_hosts:
      - api.anthropic.com:443
      - github.com:443
      - registry.npmjs.org:443"
            ;;
        aider)
            network_hosts="    allowed_hosts:
      - api.anthropic.com:443
      - api.openai.com:443
      - github.com:443"
            ;;
        *)
            network_hosts="    allowed_hosts:
      - api.anthropic.com:443
      - github.com:443"
            ;;
    esac

    cat > "$POLICY_FILE" <<POLICY_EOF
# Auto-generated sandbox policy for yeet task
# Job: $JOB_ID | Project: $PROJECT | Mode: $MODE | Runtime: $RUNTIME
sandbox:
  filesystem:
${fs_read_only}
${fs_read_write}
    denied:
      - /etc/shadow
      - /root
  network:
${network_hosts}
    deny_all_other: true
  process:
    max_memory_mb: 4096
    max_cpu_seconds: 1800
    max_file_size_mb: 100
POLICY_EOF

    log "Sandbox policy written to $POLICY_FILE"
    return 0
}

# ---------------------------------------------------------------------------
# 5. Build runtime command
# ---------------------------------------------------------------------------
build_command() {
    log "Building command for runtime=$RUNTIME mode=$MODE"

    PROMPT=$(cat "$PROMPT_FILE")

    CMD=()

    case "$RUNTIME" in
        opencode)
            # For review/analyze modes, prepend instruction not to make changes
            local effective_prompt="$PROMPT"
            if [[ "$MODE" == "review" ]]; then
                effective_prompt="Review the following without making any changes. Do not edit any files. ${PROMPT}"
            elif [[ "$MODE" == "analyze" ]]; then
                effective_prompt="Analyze the following without making any changes. Do not edit any files. ${PROMPT}"
            fi

            CMD=(opencode run --quiet)

            if [[ -n "$MODEL" ]]; then
                CMD+=(--model "$MODEL")
            fi

            if [[ -n "$SESSION_ID" ]]; then
                CMD+=(--session "$SESSION_ID")
            fi

            CMD+=("$effective_prompt")
            ;;

        claude)
            CMD=(claude -p "$PROMPT" --output-format stream-json)

            if [[ -n "$MODEL" ]]; then
                CMD+=(--model "$MODEL")
            fi

            # Permission mode based on task mode
            case "$MODE" in
                implement|test)
                    CMD+=(--permission-mode acceptEdits)
                    ;;
                review|analyze)
                    CMD+=(--permission-mode plan)
                    ;;
            esac

            # Allowed tools for implement mode
            if [[ "$MODE" == "implement" ]]; then
                CMD+=(--allowedTools "Read,Edit,Write,Glob,Grep,Bash,Agent")
            fi

            if [[ -n "$BUDGET" ]]; then
                CMD+=(--max-budget-usd "$BUDGET")
            fi

            if [[ -n "$SESSION_ID" ]]; then
                CMD+=(--resume "$SESSION_ID")
            fi
            ;;

        aider)
            # For review/analyze modes, prepend instruction not to make changes
            local effective_prompt="$PROMPT"
            if [[ "$MODE" == "review" || "$MODE" == "analyze" ]]; then
                effective_prompt="Do not make any changes. ${PROMPT}"
            fi

            CMD=(aider --message "$effective_prompt" --yes-always --no-auto-commits --show-cost)

            if [[ -n "$MODEL" ]]; then
                CMD+=(--model "$MODEL")
            fi
            ;;

        *)
            log "ERROR: Unknown runtime: $RUNTIME"
            exit 1
            ;;
    esac

    log "Command: ${CMD[*]}"
}

# ---------------------------------------------------------------------------
# 6. Execute the agent
# ---------------------------------------------------------------------------
execute_agent() {
    log "Executing agent..."

    local use_sandbox=false
    if command -v openshell-sandbox &>/dev/null && [[ -f "$POLICY_FILE" ]]; then
        use_sandbox=true
    fi

    if [[ "$use_sandbox" == "true" ]]; then
        log "Running inside openshell-sandbox"
        openshell-sandbox \
            --policy-data "$POLICY_FILE" \
            -- "${CMD[@]}" 2>&1 | tee "$OUTPUT_LOG"
        EXIT_CODE=${PIPESTATUS[0]}
    else
        log "Running directly (no sandbox)"
        "${CMD[@]}" 2>&1 | tee "$OUTPUT_LOG"
        EXIT_CODE=${PIPESTATUS[0]}
    fi

    log "Agent exited with code $EXIT_CODE"
}

# ---------------------------------------------------------------------------
# 7. Post-run: git commit and PR
# ---------------------------------------------------------------------------
post_run_git() {
    # Only commit for implement and test modes on success
    if [[ "$EXIT_CODE" -ne 0 ]]; then
        log "Skipping git operations (agent exited with $EXIT_CODE)"
        return 0
    fi

    if [[ "$MODE" != "implement" && "$MODE" != "test" ]]; then
        log "Skipping git operations (mode=$MODE does not produce changes)"
        return 0
    fi

    cd "$WORKTREE_DIR"

    # Check if there are any changes
    if git diff --quiet && git diff --cached --quiet && [[ -z "$(git ls-files --others --exclude-standard)" ]]; then
        log "No changes detected, skipping commit"
        return 0
    fi

    log "Committing and pushing changes"

    git add -A
    git commit -m "yeet: ${PROJECT} task (${RUNTIME}/${MODEL:-default})"
    git push origin "$BRANCH"

    log "Pushed branch $BRANCH"

    # Create a draft PR
    local pr_prompt
    pr_prompt=$(head -c 500 "$PROMPT_FILE")

    local pr_body
    pr_body=$(cat <<PR_EOF
## Automated by yeet (code-orchestration)

**Runtime:** $RUNTIME
**Model:** ${MODEL:-default}
**Mode:** $MODE
**Job:** $JOB_ID

### Task prompt
\`\`\`
${pr_prompt}
\`\`\`
PR_EOF
    )

    if command -v gh &>/dev/null; then
        gh pr create \
            --draft \
            --title "yeet: ${PROJECT} - ${SHORT_ID}" \
            --body "$pr_body" 2>&1 || log "WARNING: Failed to create PR (non-fatal)"
    else
        log "WARNING: gh CLI not found, skipping PR creation"
    fi
}

# ---------------------------------------------------------------------------
# 8. Record cost in Nomad Variables
# ---------------------------------------------------------------------------
record_cost() {
    if [[ -z "$NOMAD_ADDR" || -z "$NOMAD_TOKEN" ]]; then
        log "Nomad API not configured, skipping cost recording"
        return 0
    fi

    log "Extracting cost from output..."

    local cost="unknown"

    case "$RUNTIME" in
        claude)
            cost=$(grep '"type":"result"' "$OUTPUT_LOG" 2>/dev/null | tail -1 | jq -r '.total_cost_usd // empty' 2>/dev/null) || true
            ;;
        aider)
            cost=$(grep 'Cost:' "$OUTPUT_LOG" 2>/dev/null | grep -oE '\$[0-9]+\.[0-9]+' | tr -d '$' | tail -1) || true
            ;;
        opencode)
            # OpenCode does not have a standardised cost output — best-effort parse
            cost=$(grep -i 'cost' "$OUTPUT_LOG" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | tail -1) || true
            ;;
    esac

    if [[ -z "$cost" ]]; then
        cost="unknown"
    fi

    log "Cost: $cost USD"

    local timestamp
    timestamp=$(date -Iseconds)

    # Store cost in Nomad Variables (best-effort — do not fail the task)
    curl -sf -X PUT \
        -H "X-Nomad-Token: $NOMAD_TOKEN" \
        -H "Content-Type: application/json" \
        "${NOMAD_ADDR}/v1/var/yeet/cost/${JOB_ID}" \
        -d "{\"Items\": {\"cost_usd\": \"$cost\", \"project\": \"$PROJECT\", \"model\": \"${MODEL:-default}\", \"runtime\": \"$RUNTIME\", \"timestamp\": \"$timestamp\"}}" \
        2>&1 || log "WARNING: Failed to store cost in Nomad Variables (non-fatal)"
}

# ---------------------------------------------------------------------------
# 9. Store session ID for resume capability
# ---------------------------------------------------------------------------
store_session_id() {
    if [[ -z "$NOMAD_ADDR" || -z "$NOMAD_TOKEN" ]]; then
        log "Nomad API not configured, skipping session storage"
        return 0
    fi

    log "Extracting session ID from output..."

    local session_id=""

    case "$RUNTIME" in
        claude)
            session_id=$(grep '"session_id"' "$OUTPUT_LOG" 2>/dev/null | tail -1 | jq -r '.session_id // empty' 2>/dev/null) || true
            ;;
        opencode)
            # OpenCode may output session info — best-effort parse
            session_id=$(grep -i 'session' "$OUTPUT_LOG" 2>/dev/null | grep -oE '[a-f0-9-]{36}' | tail -1) || true
            ;;
        aider)
            # Aider does not support session resume
            return 0
            ;;
    esac

    if [[ -z "$session_id" ]]; then
        log "No session ID found in output"
        return 0
    fi

    log "Storing session ID: $session_id"

    local timestamp
    timestamp=$(date -Iseconds)

    curl -sf -X PUT \
        -H "X-Nomad-Token: $NOMAD_TOKEN" \
        -H "Content-Type: application/json" \
        "${NOMAD_ADDR}/v1/var/yeet/sessions/${JOB_ID}" \
        -d "{\"Items\": {\"session_id\": \"$session_id\", \"project\": \"$PROJECT\", \"runtime\": \"$RUNTIME\", \"branch\": \"$BRANCH\", \"timestamp\": \"$timestamp\"}}" \
        2>&1 || log "WARNING: Failed to store session ID in Nomad Variables (non-fatal)"
}

# ---------------------------------------------------------------------------
# 10. Notify
# ---------------------------------------------------------------------------
notify() {
    if [[ -z "$NTFY_TOPIC" ]]; then
        return 0
    fi

    log "Sending notification to ntfy.sh/$NTFY_TOPIC"

    if [[ "$EXIT_CODE" -eq 0 ]]; then
        curl -sf \
            -H "Title: yeet task complete" \
            -H "Tags: white_check_mark" \
            -d "Task complete: $PROJECT ($RUNTIME/${MODEL:-default})" \
            "https://ntfy.sh/$NTFY_TOPIC" \
            2>&1 || log "WARNING: Failed to send notification (non-fatal)"
    else
        curl -sf \
            -H "Title: yeet task FAILED" \
            -H "Tags: x,warning" \
            -H "Priority: high" \
            -d "Task FAILED: $PROJECT ($RUNTIME/${MODEL:-default}) exit=$EXIT_CODE" \
            "https://ntfy.sh/$NTFY_TOPIC" \
            2>&1 || log "WARNING: Failed to send notification (non-fatal)"
    fi
}

# ===========================================================================
# Main execution flow
# ===========================================================================
main() {
    setup_workspace
    acquire_device_lock
    generate_policy || true  # returns 1 if openshell-sandbox not found
    build_command
    execute_agent
    post_run_git
    record_cost
    store_session_id
    notify
    # cleanup runs via EXIT trap
}

main
