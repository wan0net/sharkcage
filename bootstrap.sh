#!/usr/bin/env bash
set -euo pipefail

# Yeet bootstrap — sets up all packages from a fresh clone
#
# Usage:
#   git clone --recursive https://github.com/wan0net/yeet.git
#   cd yeet
#   ./bootstrap.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "╭─────────────────────────────────────╮"
echo "│         yeet bootstrap              │"
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

# --- Init submodules ---
echo "Initialising submodules..."
git submodule update --init --recursive
echo "  [ok] Submodules ready"
echo ""

# --- Install each package ---
PACKAGES=(
  "packages/sdk"
  "packages/supervisor"
  "packages/openclaw-plugin"
  "packages/cli"
)

for pkg in "${PACKAGES[@]}"; do
  if [ -f "$SCRIPT_DIR/$pkg/package.json" ]; then
    echo "Installing $pkg..."
    cd "$SCRIPT_DIR/$pkg"
    npm install --silent 2>/dev/null || npm install
    echo "  [ok] $pkg"
  else
    echo "  [skip] $pkg — no package.json"
  fi
done

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

# --- Create config directories ---
echo "Creating config directories..."
YEET_DIR="${HOME}/.config/yeet"
mkdir -p "$YEET_DIR"/{data,plugins,approvals}
echo "  [ok] $YEET_DIR"
echo ""

# --- Link CLI for development ---
echo "Linking yeet CLI..."
cd "$SCRIPT_DIR/packages/cli"
if command -v npx &>/dev/null; then
  # Create a wrapper script
  WRAPPER="$SCRIPT_DIR/bin/yeet"
  mkdir -p "$SCRIPT_DIR/bin"
  cat > "$WRAPPER" << WRAPPER_EOF
#!/usr/bin/env bash
exec npx tsx "$SCRIPT_DIR/packages/cli/src/main.ts" "\$@"
WRAPPER_EOF
  chmod +x "$WRAPPER"
  echo "  [ok] $WRAPPER"
  echo "  Add to PATH: export PATH=\"$SCRIPT_DIR/bin:\$PATH\""
fi

echo ""
echo "╭─────────────────────────────────────╮"
echo "│         bootstrap complete          │"
echo "╰─────────────────────────────────────╯"
echo ""
echo "Next steps:"
echo ""
echo "  1. Add yeet to your PATH:"
echo "     export PATH=\"$SCRIPT_DIR/bin:\$PATH\""
echo ""
echo "  2. Run the setup wizard:"
echo "     yeet init"
echo ""
echo "  3. Start yeet:"
echo "     yeet start"
echo ""
