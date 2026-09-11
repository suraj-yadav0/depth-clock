#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building Depth Clock Extension Package ==="

# Compile GSettings schemas
glib-compile-schemas extension/schemas/

# Package using gnome-extensions pack
gnome-extensions pack extension \
    --force \
    --out-dir=. \
    --extra-source=colorUtils.js \
    --extra-source=clockWidget.js \
    --extra-source=wallpaperManager.js \
    --extra-source=setup-backend.sh \
    --extra-source=backend/segment.py \
    --extra-source=backend/requirements.txt \
    --extra-source=fonts/Antonio-Bold.ttf

echo "[OK] Package created: depth-clock@suraj-yadav0.github.io.shell-extension.zip"
