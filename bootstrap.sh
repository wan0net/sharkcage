#!/usr/bin/env bash
set -euo pipefail

# Sharkcage bootstrap — sets up the monorepo from a fresh clone
#
# Usage:
#   git clone https://github.com/wan0net/sharkcage.git
#   cd sharkcage
#   ./bootstrap.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "╭─────────────────────────────────────╮"
echo "│      sharkcage bootstrap            │"
echo "╰─────────────────────────────────────╯"
echo ""

# --- Check prerequisites ---
echo "Checking prerequisites..."

check_cmd() {
  if command -v "$1" &>/dev/null; then
    echo "  [ok] $1"
    return 0
  else
    echo "  [  ] $1 — $2"
    return 1
  fi
}

MISSING=0
check_cmd node "Install: https://nodejs.org/ or brew install node" || MISSING=1
check_cmd npm "Comes with Node.js" || MISSING=1
check_cmd git "Install: brew install git" || MISSING=1

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo "Install missing prerequisites and re-run."
  exit 1
fi

echo ""

# --- Install root dependencies ---
echo "Installing root dependencies..."
npm install --silent 2>/dev/null || npm install
echo "  [ok] Dependencies installed"
echo ""

# --- Optional: install srt (ASRT) ---
echo "Checking optional dependencies..."

if command -v srt &>/dev/null; then
  echo "  [ok] srt (Anthropic Sandbox Runtime)"
else
  echo "  [  ] srt not found"
  read -p "  Install srt? (recommended for sandboxing) [Y/n] " -r REPLY
  REPLY=${REPLY:-Y}
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    echo "  Installing srt..."
    npm install -g @anthropic-ai/sandbox-runtime
    echo "  [ok] srt installed"
  else
    echo "  [skip] Running without kernel sandbox"
  fi
fi

# --- Optional: install OpenClaw ---
if command -v openclaw &>/dev/null; then
  echo "  [ok] OpenClaw"
else
  echo "  [  ] OpenClaw not found"
  read -p "  Install OpenClaw? [Y/n] " -r REPLY
  REPLY=${REPLY:-Y}
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    echo "  Installing OpenClaw..."
    npm install -g openclaw
    echo "  [ok] OpenClaw installed"
  else
    echo "  [skip] Install later with: npm install -g openclaw"
  fi
fi

echo ""

# --- Build plugin for OpenClaw ---
echo "Building plugin..."
npx tsc -p tsconfig.plugin.json --outDir dist/sharkcage-build 2>/dev/null
mkdir -p dist/sharkcage
cp dist/sharkcage-build/plugin/* dist/sharkcage/ 2>/dev/null || true
cp src/plugin/openclaw.plugin.json dist/sharkcage/
cp src/plugin/security-patterns.json dist/sharkcage/
echo "  [ok] Plugin built to dist/sharkcage/"
echo ""

# --- Create config directories ---
echo "Creating config directories..."
SHARKCAGE_DIR="${HOME}/.config/sharkcage"
mkdir -p "$SHARKCAGE_DIR"/{data,plugins,approvals,denied}
echo "  [ok] $SHARKCAGE_DIR"
echo ""

# --- Link CLI for development ---
echo "Linking sharkcage CLI..."
if command -v npx &>/dev/null; then
  # Create a wrapper script
  WRAPPER="$SCRIPT_DIR/bin/sc"
  mkdir -p "$SCRIPT_DIR/bin"
  cat > "$WRAPPER" << WRAPPER_EOF
#!/usr/bin/env bash
exec npx tsx "$SCRIPT_DIR/src/cli/main.ts" "\$@"
WRAPPER_EOF
  chmod +x "$WRAPPER"
  echo "  [ok] $WRAPPER"
  echo "  Add to PATH: export PATH=\"$SCRIPT_DIR/bin:\$PATH\""
fi

echo ""
echo "╭─────────────────────────────────────╮"
echo "│      bootstrap complete             │"
echo "╰─────────────────────────────────────╯"
echo ""
echo "Next steps:"
echo ""
echo "  1. Add sharkcage to your PATH:"
echo "     export PATH=\"$SCRIPT_DIR/bin:\$PATH\""
echo ""
echo "  2. Run the setup wizard:"
echo "     sc init"
echo ""
echo "  3. Start sharkcage:"
echo "     sc start"
echo ""
