#!/usr/bin/env bash
set -e

EXTENSION_ID="depth-clock@suraj.local"
REPO_URL="https://github.com/suraj-yadav0/depth-clock.git"
MODEL_URL="https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"
EXPECTED_MODEL_SHA256="8cafcf770b06757c4eaced21b1a88e57fd2b66de01b8045f35f01535ba742e0f"

DATA_DIR="$HOME/.local/share/depth-clock"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_ID"
FONTS_DIR="$HOME/.local/share/fonts"

TEMP_DIR=""
cleanup() {
    if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
}
trap cleanup EXIT

echo "=== Installing Depth Clock GNOME Extension ==="

# Determine source directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

if [ -d "$SCRIPT_DIR/extension" ] && [ -d "$SCRIPT_DIR/backend" ]; then
    SOURCE_DIR="$SCRIPT_DIR"
else
    echo "--> Remote execution detected. Fetching repository files..."
    TEMP_DIR=$(mktemp -d)
    if command -v git >/dev/null 2>&1; then
        git clone --depth 1 "$REPO_URL" "$TEMP_DIR/depth-clock" >/dev/null 2>&1 || {
            echo "[ERROR] Failed to clone repository."
            exit 1
        }
        SOURCE_DIR="$TEMP_DIR/depth-clock"
    else
        curl -sSL "https://github.com/suraj-yadav0/depth-clock/archive/refs/heads/main.tar.gz" | tar -xz -C "$TEMP_DIR" || {
            echo "[ERROR] Failed to download repository archive."
            exit 1
        }
        SOURCE_DIR="$TEMP_DIR/depth-clock-main"
    fi
fi

# Check system dependencies
echo "--> Checking system dependencies..."
for cmd in python3 curl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "[ERROR] Required dependency '$cmd' is not installed."
        exit 1
    fi
done

if ! python3 -m venv --help >/dev/null 2>&1; then
    echo "[ERROR] python3-venv is required. Install it using your distribution package manager."
    echo "    Ubuntu/Debian: sudo apt install python3-venv"
    echo "    Fedora: sudo dnf install python3"
    echo "    Arch Linux: sudo pacman -S python"
    exit 1
fi

# Set up Python virtual environment
echo "--> Setting up Python virtual environment in $DATA_DIR/venv..."
mkdir -p "$DATA_DIR/backend" "$DATA_DIR/models"
if [ ! -f "$DATA_DIR/venv/bin/python3" ]; then
    python3 -m venv "$DATA_DIR/venv"
fi

"$DATA_DIR/venv/bin/pip" install --quiet --upgrade pip
"$DATA_DIR/venv/bin/pip" install --quiet -r "$SOURCE_DIR/backend/requirements.txt"
echo "    [OK] Python dependencies installed."

# Download AI Segmentation Model if missing or incomplete
MODEL_PATH="$DATA_DIR/models/rmbg-1.4.onnx"
download_model=false

if [ ! -f "$MODEL_PATH" ]; then
    download_model=true
else
    MODEL_SIZE=$(stat -c%s "$MODEL_PATH" 2>/dev/null || stat -f%z "$MODEL_PATH" 2>/dev/null || echo 0)
    if [ "$MODEL_SIZE" -lt 150000000 ]; then
        echo "--> Existing model appears incomplete. Re-downloading..."
        download_model=true
    fi
fi

if [ "$download_model" = true ]; then
    echo "--> Downloading RMBG-1.4 segmentation model (~176 MB)..."
    TMP_MODEL="$MODEL_PATH.tmp"
    curl -L --fail --progress-bar -o "$TMP_MODEL" "$MODEL_URL" || {
        echo "[ERROR] Failed to download model from $MODEL_URL"
        rm -f "$TMP_MODEL"
        exit 1
    }
    mv "$TMP_MODEL" "$MODEL_PATH"
    echo "    [OK] Model downloaded successfully."
else
    echo "    [OK] Segmentation model already present."
fi

# Install backend segmentation script
echo "--> Installing segmentation backend..."
cp "$SOURCE_DIR/backend/segment.py" "$DATA_DIR/backend/segment.py"
chmod +x "$DATA_DIR/backend/segment.py"
echo "    [OK] Backend installed to $DATA_DIR/backend/"

# Install fonts
echo "--> Installing Antonio Bold font..."
mkdir -p "$FONTS_DIR"
if [ -f "$SOURCE_DIR/fonts/Antonio-Bold.ttf" ]; then
    cp "$SOURCE_DIR/fonts/Antonio-Bold.ttf" "$FONTS_DIR/"
    if command -v fc-cache >/dev/null 2>&1; then
        fc-cache -f "$FONTS_DIR" >/dev/null 2>&1 || true
    fi
    echo "    [OK] Font installed to $FONTS_DIR"
fi

# Install GNOME Shell Extension
echo "--> Installing GNOME extension files..."
mkdir -p "$EXTENSION_DIR/schemas"
cp "$SOURCE_DIR/extension/extension.js" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/extension/prefs.js" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/extension/metadata.json" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/extension/stylesheet.css" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/extension/schemas/"*.gschema.xml "$EXTENSION_DIR/schemas/"

# Compile schemas
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$EXTENSION_DIR/schemas"
    echo "    [OK] GSettings schemas compiled."
else
    echo "[WARN] glib-compile-schemas not found. Please install libglib2.0-bin / glib2."
fi

# Attempt to enable the extension
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "$EXTENSION_ID" 2>/dev/null || true
fi

echo ""
echo "=== Installation Completed Successfully ==="
echo "Extension installed at: $EXTENSION_DIR"
echo "Backend installed at:   $DATA_DIR"
echo ""
echo "Next steps to activate the extension:"
echo "1. Restart GNOME Shell:"
echo "   - On Wayland: Log out and log back in."
echo "   - On X11: Press Alt+F2, type 'r', and press Enter."
echo "2. If needed, enable manually:"
echo "   gnome-extensions enable $EXTENSION_ID"
echo "3. Open Preferences:"
echo "   gnome-extensions prefs $EXTENSION_ID"
echo ""
