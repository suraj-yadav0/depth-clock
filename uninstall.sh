#!/usr/bin/env bash
set -e

EXTENSION_ID="depth-clock@suraj-yadav0.github.io"
DATA_DIR="$HOME/.local/share/depth-clock"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_ID"
CACHE_DIR="$HOME/.cache/depth-clock"

echo "=== Uninstalling Depth Clock GNOME Extension ==="

if command -v gnome-extensions >/dev/null 2>&1; then
    echo "--> Disabling extension..."
    gnome-extensions disable "$EXTENSION_ID" 2>/dev/null || true
fi

if [ -d "$EXTENSION_DIR" ]; then
    echo "--> Removing extension files from $EXTENSION_DIR..."
    rm -rf "$EXTENSION_DIR"
fi

if [ -d "$DATA_DIR" ]; then
    echo "--> Removing backend data and models from $DATA_DIR..."
    rm -rf "$DATA_DIR"
fi

if [ -d "$CACHE_DIR" ]; then
    echo "--> Removing cached masks from $CACHE_DIR..."
    rm -rf "$CACHE_DIR"
fi

echo ""
echo "=== Uninstallation Complete ==="
echo "Please restart GNOME Shell to finish unloading the extension."
echo "  - On Wayland: Log out and log back in."
echo "  - On X11: Press Alt+F2, type 'r', and press Enter."
echo ""
