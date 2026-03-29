#!/usr/bin/env bash
# entrypoint.sh – Godot MCP container startup script
# Starts Xvfb, optionally opens the Godot editor, optionally starts MCP Pro,
# then keeps the container alive. Handles SIGTERM/SIGINT gracefully.

set -euo pipefail

# ── Signal handling ───────────────────────────────────────────────────────────
# Track child PIDs so we can clean them up on exit
declare -a CHILD_PIDS=()

cleanup() {
    echo "[entrypoint] Received shutdown signal — stopping child processes..."
    for pid in "${CHILD_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    # Give processes a moment to exit cleanly
    sleep 2
    for pid in "${CHILD_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
    echo "[entrypoint] Shutdown complete."
    exit 0
}

trap cleanup SIGTERM SIGINT

# ── 1. Start Xvfb ────────────────────────────────────────────────────────────
echo "[entrypoint] Starting Xvfb on display :99 (1920x1080x24)..."
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
CHILD_PIDS+=("$XVFB_PID")

# Wait for Xvfb to be ready (poll the lock file rather than a blind sleep)
XVFB_READY=false
for i in $(seq 1 20); do
    if [ -e /tmp/.X99-lock ]; then
        XVFB_READY=true
        break
    fi
    sleep 0.2
done

if [ "$XVFB_READY" = "false" ]; then
    echo "[entrypoint] WARNING: Xvfb lock file not found after 4 s — continuing anyway."
fi
echo "[entrypoint] Xvfb ready (PID ${XVFB_PID})."

# ── 2. Start Godot editor (if project is mounted) ────────────────────────────
GODOT_RUNNING=false
if [ -f /project/project.godot ]; then
    echo "[entrypoint] Found /project/project.godot — starting Godot editor..."
    godot --editor --path /project &
    GODOT_PID=$!
    CHILD_PIDS+=("$GODOT_PID")
    GODOT_RUNNING=true
    echo "[entrypoint] Godot editor started (PID ${GODOT_PID})."
else
    echo "[entrypoint] No project.godot found at /project — skipping Godot editor."
    echo "[entrypoint] Mount a Godot project at /project to enable the editor."
fi

# ── 3. Start MCP Pro server (if mounted) ─────────────────────────────────────
MCP_RUNNING=false
if [ -f /opt/godot-mcp/package.json ]; then
    echo "[entrypoint] Found /opt/godot-mcp/package.json — starting MCP Pro server..."
    (
        cd /opt/godot-mcp
        echo "[entrypoint] Installing MCP Pro dependencies..."
        npm install --prefer-offline 2>&1 | sed 's/^/[npm] /'
        echo "[entrypoint] Launching MCP Pro server on port 6505..."
        exec node index.js
    ) &
    MCP_PID=$!
    CHILD_PIDS+=("$MCP_PID")
    MCP_RUNNING=true
    echo "[entrypoint] MCP Pro server started (PID ${MCP_PID})."
else
    echo "[entrypoint] No package.json found at /opt/godot-mcp — skipping MCP Pro server."
    echo "[entrypoint] Mount an MCP Pro server package at /opt/godot-mcp to enable it."
fi

# ── 4. Status summary ────────────────────────────────────────────────────────
echo ""
echo "┌──────────────────────────────────────────────────┐"
echo "│           Godot MCP Container Running             │"
echo "├──────────────────────────────────────────────────┤"
printf "│  Xvfb (display :99)   %-26s │\n" "running (PID ${XVFB_PID})"
printf "│  Godot editor         %-26s │\n" "$([ "$GODOT_RUNNING" = "true" ] && echo "running (PID ${GODOT_PID})" || echo "not started (no project)")"
printf "│  MCP Pro server       %-26s │\n" "$([ "$MCP_RUNNING" = "true" ] && echo "running (PID ${MCP_PID})" || echo "not started (not mounted)")"
echo "├──────────────────────────────────────────────────┤"
echo "│  MCP WebSocket port: 6505                        │"
echo "│  Project mount:      /project                    │"
echo "│  MCP mount:          /opt/godot-mcp              │"
echo "└──────────────────────────────────────────────────┘"
echo ""

# ── 5. Keep container alive ───────────────────────────────────────────────────
# Wait on all background children. If any critical process exits, we stay up
# so the agent/operator can investigate. Use tail -f /dev/null as a fallback
# keepalive that always responds to signals via the trap above.
wait "${CHILD_PIDS[@]}" 2>/dev/null || true
echo "[entrypoint] All child processes have exited — keeping container alive."
tail -f /dev/null &
TAIL_PID=$!
CHILD_PIDS+=("$TAIL_PID")
wait "$TAIL_PID"
