#!/usr/bin/env bash
set -euo pipefail

# For developers. For production installs, use install.sh instead.
#
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

# Check Node.js — install via nvm if missing or too old
NODE_MIN=22
NEED_NODE=0

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt "$NODE_MIN" ]; then
    echo "  [!!] node v$(node -v | sed 's/v//') — need v${NODE_MIN}+"
    NEED_NODE=1
  else
    echo "  [ok] node $(node -v)"
  fi
else
  echo "  [  ] node — not found"
  NEED_NODE=1
fi

if [ "$NEED_NODE" -eq 1 ]; then
  echo ""
  echo "  Installing Node.js $NODE_MIN via nvm (no sudo required)..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MIN"
  nvm use "$NODE_MIN"
  echo "  [ok] node $(node -v) (via nvm)"
fi

check_cmd npm "Comes with Node.js" || { echo ""; echo "npm not found — something went wrong with Node install."; exit 1; }
check_cmd git "Install: brew install git or apt install git" || { echo ""; echo "Install git and re-run."; exit 1; }

echo ""

# --- Install root dependencies ---
echo "Installing root dependencies..."
npm install --silent 2>/dev/null || npm install
echo "  [ok] Dependencies installed"
echo ""

# --- Install srt locally ---
if [ -x "$SCRIPT_DIR/node_modules/.bin/srt" ]; then
  echo "  [ok] srt (Anthropic Sandbox Runtime)"
else
  echo "  [  ] srt not found"
  echo "  Installing srt..."
  npm install --save @anthropic-ai/sandbox-runtime --silent 2>/dev/null || npm install --save @anthropic-ai/sandbox-runtime
  echo "  [ok] srt installed (local)"
fi

# --- Install OpenClaw locally ---
if [ -x "$SCRIPT_DIR/node_modules/.bin/openclaw" ]; then
  echo "  [ok] OpenClaw"
else
  echo "  [  ] OpenClaw not found"
  echo "  Installing OpenClaw..."
  npm install --save openclaw --silent 2>/dev/null || npm install --save openclaw
  echo "  [ok] OpenClaw installed (local)"
fi

echo ""

# --- Build plugin for OpenClaw ---
echo "Building plugin..."
npx tsc -p tsconfig.plugin.json --outDir dist/sharkcage-build 2>/dev/null
mkdir -p dist/sharkcage dist/supervisor dist/shared
cp dist/sharkcage-build/plugin/* dist/sharkcage/ 2>/dev/null || true
cp dist/sharkcage-build/supervisor/types.js dist/supervisor/ 2>/dev/null || true
cp dist/sharkcage-build/supervisor/types.d.ts dist/supervisor/ 2>/dev/null || true
cp dist/sharkcage-build/shared/* dist/shared/ 2>/dev/null || true
cp src/plugin/openclaw.plugin.json dist/sharkcage/
cp src/plugin/security-patterns.json dist/sharkcage/
echo "  [ok] Plugin built to dist/sharkcage/"
echo ""

# --- Create config directories ---
echo "Creating config directories..."
mkdir -p "$SCRIPT_DIR/etc"
mkdir -p "$SCRIPT_DIR/var"/{plugins,approvals,denied,backups}
echo "  [ok] $SCRIPT_DIR/etc"
echo "  [ok] $SCRIPT_DIR/var/{plugins,approvals,denied,backups}"
echo ""

# --- Link CLI for development ---
echo "Linking sharkcage CLI..."
if command -v npx &>/dev/null; then
  # Create a wrapper script
  WRAPPER="$SCRIPT_DIR/bin/sc"
  mkdir -p "$SCRIPT_DIR/bin"
  cat > "$WRAPPER" << WRAPPER_EOF
#!/usr/bin/env bash
# Source nvm if available (for nvm-managed Node)
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
# Add local binaries to PATH
export PATH="$SCRIPT_DIR/node_modules/.bin:\$PATH"
exec "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/src/cli/main.ts" "\$@"
WRAPPER_EOF
  chmod +x "$WRAPPER"
  echo "  [ok] $WRAPPER"
  echo "  Add to PATH: export PATH=\"$SCRIPT_DIR/bin:\$PATH\""
fi

# --- Write etc/install.json ---
echo "Writing install metadata..."
node -e "
  const fs = require('fs');
  fs.writeFileSync('$SCRIPT_DIR/etc/install.json', JSON.stringify({
    installDir: '$SCRIPT_DIR',
    openclawBin: '$SCRIPT_DIR/node_modules/.bin/openclaw',
    srtBin: '$SCRIPT_DIR/node_modules/.bin/srt',
    scBin: '$SCRIPT_DIR/bin/sc',
    installedBy: process.env.USER || 'unknown',
    version: require('$SCRIPT_DIR/package.json').version,
    installedAt: new Date().toISOString()
  }, null, 2) + '\n');
"
echo "  [ok] $SCRIPT_DIR/etc/install.json"

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
