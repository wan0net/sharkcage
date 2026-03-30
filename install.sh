#!/usr/bin/env bash
set -euo pipefail

# curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash
# wget -qO- https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash

REPO="https://github.com/wan0net/sharkcage.git"
INSTALL_DIR="${SHARKCAGE_DIR:-$HOME/.sharkcage}"

echo ""
echo "  sharkcage — OpenClaw, but you trust it."
echo ""

# --- Prerequisites ---
FAIL=0
for cmd in node npm git; do
  if command -v "$cmd" &>/dev/null; then
    echo "  [ok] $cmd"
  else
    echo "  [  ] $cmd — required"
    FAIL=1
  fi
done
echo ""

if [ "$FAIL" -eq 1 ]; then
  echo "  Install missing prerequisites and re-run."
  echo "  Node.js: https://nodejs.org/"
  exit 1
fi

# --- Clone or update ---
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating $INSTALL_DIR..."
  cd "$INSTALL_DIR"
  git pull --quiet
else
  echo "  Installing to $INSTALL_DIR..."
  git clone --quiet --depth 1 "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# --- Bootstrap (deps + plugin build) ---
bash "$INSTALL_DIR/bootstrap.sh"

# --- Add to PATH ---
SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.profile" ]; then
  SHELL_RC="$HOME/.profile"
fi

PATH_LINE="export PATH=\"$INSTALL_DIR/bin:\$PATH\""

if [ -n "$SHELL_RC" ]; then
  if ! grep -q "sharkcage" "$SHELL_RC" 2>/dev/null; then
    printf '\n# sharkcage\n%s\n' "$PATH_LINE" >> "$SHELL_RC"
    echo "  Added to $SHELL_RC"
  fi
fi

echo ""
echo "  Done. Run:"
echo ""
echo "    source $SHELL_RC    # reload PATH"
echo "    sc init             # setup wizard"
echo "    sc start            # start sharkcage"
echo ""
