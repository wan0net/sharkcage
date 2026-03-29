#!/usr/bin/env bash
set -euo pipefail

# curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash
#
# Or if you prefer wget:
# wget -qO- https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash

REPO="https://github.com/wan0net/sharkcage.git"
INSTALL_DIR="${SHARKCAGE_DIR:-$HOME/.sharkcage}"

echo ""
echo "  ╭─────────────────────────────────────╮"
echo "  │     sharkcage installer              │"
echo "  │                                      │"
echo "  │     Attack surface in your pocket.   │"
echo "  ╰─────────────────────────────────────╯"
echo ""

# --- Check prerequisites ---
check() {
  if command -v "$1" &>/dev/null; then
    echo "  [ok] $1"
    return 0
  else
    echo "  [  ] $1 — $2"
    return 1
  fi
}

echo "  Checking prerequisites..."
echo ""
FAIL=0
check node "https://nodejs.org/" || FAIL=1
check npm "comes with Node.js" || FAIL=1
check git "brew install git / apt install git" || FAIL=1
echo ""

if [ "$FAIL" -eq 1 ]; then
  echo "  Install missing prerequisites and re-run."
  exit 1
fi

# --- Clone ---
if [ -d "$INSTALL_DIR" ]; then
  echo "  Updating $INSTALL_DIR..."
  cd "$INSTALL_DIR"
  git pull --quiet
else
  echo "  Cloning to $INSTALL_DIR..."
  git clone --quiet "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# --- Run bootstrap ---
echo "  Running bootstrap..."
if [ -f "$INSTALL_DIR/bootstrap.sh" ]; then
  bash "$INSTALL_DIR/bootstrap.sh"
fi

# --- Create sc wrapper ---
mkdir -p "$INSTALL_DIR/bin"
cat > "$INSTALL_DIR/bin/sc" << WRAPPER
#!/usr/bin/env bash
exec npx tsx "$INSTALL_DIR/packages/cli/src/main.ts" "\$@"
WRAPPER
chmod +x "$INSTALL_DIR/bin/sc"

# --- Shell config ---
SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

PATH_LINE="export PATH=\"$INSTALL_DIR/bin:\$PATH\""

if [ -n "$SHELL_RC" ]; then
  if ! grep -q "$INSTALL_DIR/bin" "$SHELL_RC" 2>/dev/null; then
    echo "" >> "$SHELL_RC"
    echo "# sharkcage" >> "$SHELL_RC"
    echo "$PATH_LINE" >> "$SHELL_RC"
    echo ""
    echo "  Added to $SHELL_RC:"
    echo "    $PATH_LINE"
  fi
fi

# --- Done ---
echo ""
echo "  ╭─────────────────────────────────────╮"
echo "  │          installed!                  │"
echo "  ╰─────────────────────────────────────╯"
echo ""
echo "  Next steps:"
echo ""
echo "    1. Reload your shell (or run):"
echo "       $PATH_LINE"
echo ""
echo "    2. Set your API key:"
echo "       export OPENROUTER_API_KEY=your-key"
echo ""
echo "    3. Run the setup wizard:"
echo "       sc init"
echo ""
echo "    4. Start:"
echo "       sc start"
echo ""
