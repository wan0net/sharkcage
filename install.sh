#!/usr/bin/env bash
set -euo pipefail

# sharkcage — OpenClaw, but you trust it.
#
# Production installer. Clones the repo, installs deps, builds plugin, sets up PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash
#   wget -qO- https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash
#
# Options:
#   --dir PATH          Install directory (default: /opt/sharkcage)
#   SHARKCAGE_DIR env   Same as --dir

REPO="https://github.com/wan0net/sharkcage.git"
INSTALL_DIR="${SHARKCAGE_DIR:-/opt/sharkcage}"

# --- Parse flags ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo ""
echo "  sharkcage — OpenClaw, but you trust it."
echo ""

# --- Check prerequisites ---
echo "Checking prerequisites..."

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

if command -v npm &>/dev/null; then
  echo "  [ok] npm"
else
  echo "  [  ] npm — required (comes with Node.js)"
  echo "  npm not found — something went wrong with Node install."
  exit 1
fi

if command -v git &>/dev/null; then
  echo "  [ok] git"
else
  echo "  [  ] git — required"
  echo "  Install git and re-run."
  exit 1
fi

echo ""

# --- Create install directory (may need sudo for /opt) ---
if [ ! -d "$INSTALL_DIR" ]; then
  echo "  Creating $INSTALL_DIR..."
  if mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    : # worked without sudo
  else
    echo "  (requires sudo for $INSTALL_DIR)"
    sudo mkdir -p "$INSTALL_DIR"
    sudo chown "$(id -u):$(id -g)" "$INSTALL_DIR"
  fi
fi

# --- Clone or update (latest tagged release) ---
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating $INSTALL_DIR..."
  cd "$INSTALL_DIR"
  git fetch --quiet --tags
  LATEST_TAG=$(git tag -l 'v*' --sort=-version:refname | head -1)
  if [ -n "$LATEST_TAG" ]; then
    echo "  Checking out $LATEST_TAG..."
    git checkout --quiet "$LATEST_TAG"
  else
    echo "  No tagged releases found, using main branch"
    git pull --quiet
  fi
else
  echo "  Installing to $INSTALL_DIR..."
  git clone --quiet "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  LATEST_TAG=$(git tag -l 'v*' --sort=-version:refname | head -1)
  if [ -n "$LATEST_TAG" ]; then
    echo "  Checking out $LATEST_TAG..."
    git checkout --quiet "$LATEST_TAG"
  else
    echo "  No tagged releases found, using main branch"
  fi
fi

echo ""

# --- Install dependencies ---
echo "Installing dependencies..."
npm install --silent 2>/dev/null || npm install
echo "  [ok] Dependencies installed"
echo ""

# --- Install srt locally ---
if [ -x "$INSTALL_DIR/node_modules/.bin/srt" ]; then
  echo "  [ok] srt (Anthropic Sandbox Runtime)"
else
  echo "  [  ] srt not found"
  echo "  Installing srt..."
  npm install --save @anthropic-ai/sandbox-runtime --silent 2>/dev/null || npm install --save @anthropic-ai/sandbox-runtime
  echo "  [ok] srt installed (local)"
fi

# --- Install OpenClaw locally ---
if [ -x "$INSTALL_DIR/node_modules/.bin/openclaw" ]; then
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
mkdir -p dist/sharkcage dist/supervisor
cp dist/sharkcage-build/plugin/* dist/sharkcage/ 2>/dev/null || true
cp dist/sharkcage-build/supervisor/types.js dist/supervisor/ 2>/dev/null || true
cp dist/sharkcage-build/supervisor/types.d.ts dist/supervisor/ 2>/dev/null || true
cp src/plugin/openclaw.plugin.json dist/sharkcage/
cp src/plugin/security-patterns.json dist/sharkcage/
echo "  [ok] Plugin built to dist/sharkcage/"
echo ""

# --- Create directories ---
echo "Creating directories..."
mkdir -p "$INSTALL_DIR/etc"
mkdir -p "$INSTALL_DIR/var"/{plugins,approvals,denied,backups}
echo "  [ok] $INSTALL_DIR/etc"
echo "  [ok] $INSTALL_DIR/var/{plugins,approvals,denied,backups}"
echo ""

# --- Generate bin/sc wrapper ---
echo "Linking sharkcage CLI..."
mkdir -p "$INSTALL_DIR/bin"
cat > "$INSTALL_DIR/bin/sc" << WRAPPER_EOF
#!/usr/bin/env bash
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
export PATH="$INSTALL_DIR/node_modules/.bin:\$PATH"
exec npx tsx "$INSTALL_DIR/src/cli/main.ts" "\$@"
WRAPPER_EOF
chmod +x "$INSTALL_DIR/bin/sc"
echo "  [ok] $INSTALL_DIR/bin/sc"
echo ""

# --- Write etc/install.json ---
echo "Writing install metadata..."
node -e "
  const fs = require('fs');
  fs.writeFileSync('$INSTALL_DIR/etc/install.json', JSON.stringify({
    installDir: '$INSTALL_DIR',
    openclawBin: '$INSTALL_DIR/node_modules/.bin/openclaw',
    srtBin: '$INSTALL_DIR/node_modules/.bin/srt',
    scBin: '$INSTALL_DIR/bin/sc',
    installedBy: process.env.USER || 'unknown',
    version: require('$INSTALL_DIR/package.json').version,
    installedAt: new Date().toISOString()
  }, null, 2) + '\n');
"
echo "  [ok] $INSTALL_DIR/etc/install.json"
echo ""

# --- Add to PATH ---
PATH_LINE="export PATH=\"$INSTALL_DIR/bin:\$PATH\""
SHELL_RC=""

for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  if [ -f "$rc" ]; then
    SHELL_RC="$rc"
    break
  fi
done

if [ -n "$SHELL_RC" ]; then
  if ! grep -q "sharkcage" "$SHELL_RC" 2>/dev/null; then
    printf '\n# sharkcage\n%s\n' "$PATH_LINE" >> "$SHELL_RC"
    echo "  Added to $SHELL_RC"
  else
    echo "  PATH already in $SHELL_RC"
  fi
fi

echo ""
echo "  Binary locations:"
echo "    sc:        $INSTALL_DIR/bin/sc"
echo "    openclaw:  $INSTALL_DIR/node_modules/.bin/openclaw"
echo "    srt:       $INSTALL_DIR/node_modules/.bin/srt"
echo ""
echo "  Done. Next steps:"
echo ""
if [ -n "$SHELL_RC" ]; then
  echo "    source $SHELL_RC    # reload PATH"
fi
echo "    sc init             # setup wizard"
echo "    sc start            # start sharkcage"
echo ""
