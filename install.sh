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
#   --ref GIT_REF       Git ref to install (default: main, use latest-tag for newest release tag)
#   --configure         Run `sc init` after install using command-line flags
#   --mode MODE         Pass sandbox mode to `sc init` (full | skills-only)
#   --service-user USER Pass dedicated runtime user to `sc init`
#   --no-service-user   Skip dedicated runtime user setup in `sc init`
#   --install-service   Install systemd service during `sc init`
#   --enable-service    Enable systemd service during `sc init`
#   --start-service     Start systemd service during `sc init`
#   SHARKCAGE_DIR env   Same as --dir
#   SHARKCAGE_REF env   Same as --ref

REPO="https://github.com/wan0net/sharkcage.git"
INSTALL_DIR="${SHARKCAGE_DIR:-/opt/sharkcage}"
INSTALL_REF="${SHARKCAGE_REF:-main}"
RUN_CONFIGURE=0
INIT_MODE=""
INIT_SERVICE_USER=""
INIT_DISABLE_SERVICE_USER=0
INIT_INSTALL_SERVICE=0
INIT_ENABLE_SERVICE=0
INIT_START_SERVICE=0

# --- Parse flags ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --ref)
      INSTALL_REF="$2"
      shift 2
      ;;
    --configure)
      RUN_CONFIGURE=1
      shift
      ;;
    --mode)
      INIT_MODE="$2"
      shift 2
      ;;
    --service-user)
      INIT_SERVICE_USER="$2"
      shift 2
      ;;
    --no-service-user)
      INIT_DISABLE_SERVICE_USER=1
      shift
      ;;
    --install-service)
      INIT_INSTALL_SERVICE=1
      shift
      ;;
    --enable-service)
      INIT_INSTALL_SERVICE=1
      INIT_ENABLE_SERVICE=1
      shift
      ;;
    --start-service)
      INIT_INSTALL_SERVICE=1
      INIT_START_SERVICE=1
      shift
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

NODE_BIN="$(command -v node)"
RUNTIME_NODE_BIN="$INSTALL_DIR/bin/node"

resolve_target_ref() {
  if [ "$INSTALL_REF" = "latest-tag" ]; then
    local latest_tag
    latest_tag=$(git tag -l 'v*' --sort=-version:refname | head -1)
    if [ -z "$latest_tag" ]; then
      echo "No tagged releases found for latest-tag install."
      exit 1
    fi
    printf '%s' "$latest_tag"
    return 0
  fi

  printf '%s' "$INSTALL_REF"
}

restore_deps() {
  npm ci --silent 2>/dev/null || npm ci || npm install --silent 2>/dev/null || npm install
}

install_runtime_dep() {
  local dep="$1"
  npm install --no-save "$dep" --silent 2>/dev/null || npm install --no-save "$dep"
}

check_linux_sandbox_host() {
  [ "$(uname -s)" = "Linux" ] || return 0
  command -v bwrap >/dev/null 2>&1 || return 0

  local restrict_userns=""
  if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
    restrict_userns="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)"
  fi

  if bwrap --unshare-user --uid 0 --gid 0 --ro-bind / / true >/dev/null 2>&1; then
    echo "  [ok] bubblewrap host smoke test"
    return 0
  fi

  echo "  [!!] bubblewrap host smoke test failed"
  if [ "$restrict_userns" = "1" ]; then
    echo "  Ubuntu/AppArmor is restricting unprivileged user namespaces."
    echo "  Sharkcage secure mode will fail closed until you allow them."
    echo "  Temporary fix:"
    echo "    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
    echo "  Persistent fix:"
    echo "    printf 'kernel.apparmor_restrict_unprivileged_userns=0\\n' | sudo tee /etc/sysctl.d/99-sharkcage-userns.conf"
    echo "    sudo sysctl --system"
  else
    echo "  bubblewrap is installed, but the host still denied unprivileged sandbox startup."
    echo "  Test manually:"
    echo "    bwrap --unshare-user --uid 0 --gid 0 --ro-bind / / true"
  fi
  echo "  Installer will continue, but secure startup may refuse to run on this host."
}

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

# --- Clone or update target ref ---
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating $INSTALL_DIR..."
  cd "$INSTALL_DIR"
  git fetch --quiet --tags origin

  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "  Resetting tracked file changes in $INSTALL_DIR..."
    git reset --hard --quiet
  fi
else
  echo "  Installing to $INSTALL_DIR..."
  git clone --quiet "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  git fetch --quiet --tags origin
fi

TARGET_REF="$(resolve_target_ref)"
echo "  Checking out $TARGET_REF..."
git checkout --quiet "$TARGET_REF"
if git show-ref --verify --quiet "refs/remotes/origin/$TARGET_REF"; then
  git reset --hard --quiet "origin/$TARGET_REF"
fi

echo ""

# --- Install dependencies ---
echo "Installing dependencies..."
restore_deps
echo "  [ok] Dependencies installed"
echo ""

# --- Install srt locally ---
if [ -x "$INSTALL_DIR/node_modules/.bin/srt" ]; then
  echo "  [ok] srt (Anthropic Sandbox Runtime)"
else
  echo "  [  ] srt not found"
  echo "  Reinstalling dependencies to restore srt..."
  restore_deps
  if [ -x "$INSTALL_DIR/node_modules/.bin/srt" ]; then
    echo "  [ok] srt restored (local)"
  else
    echo "  Installing srt without modifying tracked package files..."
    install_runtime_dep "@anthropic-ai/sandbox-runtime"
    if [ -x "$INSTALL_DIR/node_modules/.bin/srt" ]; then
      echo "  [ok] srt installed (local, no-save)"
    else
      echo "  Failed to install srt"
      exit 1
    fi
  fi
fi

# --- Install OpenClaw locally ---
if [ -x "$INSTALL_DIR/node_modules/.bin/openclaw" ]; then
  echo "  [ok] OpenClaw"
else
  echo "  [  ] OpenClaw not found"
  echo "  Reinstalling dependencies to restore OpenClaw..."
  restore_deps
  if [ -x "$INSTALL_DIR/node_modules/.bin/openclaw" ]; then
    echo "  [ok] OpenClaw restored (local)"
  else
    echo "  Installing OpenClaw without modifying tracked package files..."
    install_runtime_dep "openclaw"
    if [ -x "$INSTALL_DIR/node_modules/.bin/openclaw" ]; then
      echo "  [ok] OpenClaw installed (local, no-save)"
    else
      echo "  Failed to install OpenClaw"
      exit 1
    fi
  fi
fi

echo ""

echo "Checking Linux sandbox host compatibility..."
check_linux_sandbox_host
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
cp "$NODE_BIN" "$RUNTIME_NODE_BIN"
chmod +x "$RUNTIME_NODE_BIN"
cat > "$INSTALL_DIR/bin/sc" << WRAPPER_EOF
#!/usr/bin/env bash
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
export PATH="$INSTALL_DIR/node_modules/.bin:\$PATH"
exec "$RUNTIME_NODE_BIN" "$INSTALL_DIR/node_modules/.bin/tsx" "$INSTALL_DIR/src/cli/main.ts" "\$@"
WRAPPER_EOF
chmod +x "$INSTALL_DIR/bin/sc"
echo "  [ok] $INSTALL_DIR/bin/sc"
echo "  [ok] $RUNTIME_NODE_BIN"
echo ""

# --- Write etc/install.json ---
echo "Writing install metadata..."
node -e "
  const fs = require('fs');
  fs.writeFileSync('$INSTALL_DIR/etc/install.json', JSON.stringify({
    installDir: '$INSTALL_DIR',
    gitRef: '$TARGET_REF',
    gitCommit: require('child_process').execSync('git rev-parse HEAD', { cwd: '$INSTALL_DIR', encoding: 'utf8' }).trim(),
    nodeBin: '$RUNTIME_NODE_BIN',
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

if [ "$RUN_CONFIGURE" -eq 1 ]; then
  echo "Running sharkcage setup..."
  INIT_ARGS=(init --non-interactive)
  if [ -n "$INIT_MODE" ]; then
    INIT_ARGS+=(--mode "$INIT_MODE")
  fi
  if [ -n "$INIT_SERVICE_USER" ]; then
    INIT_ARGS+=(--service-user "$INIT_SERVICE_USER")
  elif [ "$INIT_DISABLE_SERVICE_USER" -eq 1 ]; then
    INIT_ARGS+=(--no-service-user)
  fi
  if [ "$INIT_INSTALL_SERVICE" -eq 1 ]; then
    INIT_ARGS+=(--install-service)
  fi
  if [ "$INIT_ENABLE_SERVICE" -eq 1 ]; then
    INIT_ARGS+=(--enable-service)
  fi
  if [ "$INIT_START_SERVICE" -eq 1 ]; then
    INIT_ARGS+=(--start-service)
  fi

  "$INSTALL_DIR/bin/sc" "${INIT_ARGS[@]}"
  echo "  [ok] sharkcage configured"
  echo ""
fi

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
