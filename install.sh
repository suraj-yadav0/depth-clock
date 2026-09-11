#!/usr/bin/env bash
set -e

EXTENSION_ID="depth-clock@suraj-yadav0.github.io"
REPO_URL="https://github.com/suraj-yadav0/depth-clock.git"
ARCHIVE_URL="https://github.com/suraj-yadav0/depth-clock/archive/refs/heads/main.tar.gz"
MODEL_URL="https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"
MODEL_MIRROR_URL="https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"
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

# Determine source directory safely across shells
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$BASH_SOURCE")" 2>/dev/null && pwd || true)"
elif [ -n "$0" ] && [ -f "$0" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/extension" ] && [ -d "$SCRIPT_DIR/backend" ]; then
    SOURCE_DIR="$SCRIPT_DIR"
else
    echo "--> Remote execution detected. Fetching repository files..."
    TEMP_DIR=$(mktemp -d)
    SOURCE_DIR=""

    if command -v git >/dev/null 2>&1; then
        echo "    Cloning repository via git..."
        if git clone --depth 1 "$REPO_URL" "$TEMP_DIR/depth-clock" 2>/dev/null; then
            SOURCE_DIR="$TEMP_DIR/depth-clock"
        else
            echo "    [WARN] Git clone failed. Falling back to archive download..."
        fi
    fi

    if [ -z "$SOURCE_DIR" ]; then
        echo "    Downloading repository archive..."
        mkdir -p "$TEMP_DIR/depth-clock-archive"
        if curl -sSL --retry 3 --retry-delay 2 "$ARCHIVE_URL" | tar -xz -C "$TEMP_DIR/depth-clock-archive"; then
            SOURCE_DIR="$TEMP_DIR/depth-clock-archive/depth-clock-main"
        fi
    fi

    if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR/extension" ]; then
        echo "[ERROR] Failed to fetch repository files via git and archive download."
        exit 1
    fi
fi

# Check system dependencies
echo "--> Checking system dependencies..."
missing_bins=""
for cmd in python3 curl tar; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        missing_bins="$missing_bins $cmd"
    fi
done

if [ -n "$missing_bins" ]; then
    echo "[ERROR] Required base commands missing:$missing_bins"
    exit 1
fi

missing_packages=""
if ! python3 -m venv --help >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
        missing_packages="$missing_packages python3-venv"
    elif command -v dnf >/dev/null 2>&1; then
        missing_packages="$missing_packages python3"
    elif command -v pacman >/dev/null 2>&1; then
        missing_packages="$missing_packages python"
    fi
fi

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
        missing_packages="$missing_packages libglib2.0-bin"
    elif command -v dnf >/dev/null 2>&1; then
        missing_packages="$missing_packages glib2"
    elif command -v pacman >/dev/null 2>&1; then
        missing_packages="$missing_packages glib2"
    fi
fi

if [ -n "$missing_packages" ]; then
    installed=false
    if [ -e /dev/tty ] && [ -r /dev/tty ] && command -v sudo >/dev/null 2>&1; then
        echo "--> Missing required system packages:$missing_packages"
        printf "    Install missing packages with sudo? [Y/n] " >/dev/tty
        read -r reply </dev/tty || reply="n"
        if [ -z "$reply" ] || [ "$reply" = "y" ] || [ "$reply" = "Y" ]; then
            if command -v apt-get >/dev/null 2>&1; then
                sudo apt-get update -qq && sudo apt-get install -y $missing_packages </dev/tty && installed=true
            elif command -v dnf >/dev/null 2>&1; then
                sudo dnf install -y $missing_packages </dev/tty && installed=true
            elif command -v pacman >/dev/null 2>&1; then
                sudo pacman -S --noconfirm $missing_packages </dev/tty && installed=true
            fi
        fi
    fi

    if [ "$installed" = false ]; then
        echo "[ERROR] Missing required dependencies:$missing_packages"
        echo "Please install them manually using your package manager:"
        echo "    Ubuntu/Debian: sudo apt install python3-venv libglib2.0-bin"
        echo "    Fedora:        sudo dnf install python3 glib2"
        echo "    Arch Linux:    sudo pacman -S python glib2"
        exit 1
    fi
fi

# Set up Python virtual environment and download AI model via setup-backend.sh
echo "--> Setting up AI segmentation backend and model..."
bash "$SOURCE_DIR/extension/setup-backend.sh" --install

mkdir -p "$DATA_DIR/backend"
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
cp "$SOURCE_DIR/extension/"*.js "$EXTENSION_DIR/"
cp "$SOURCE_DIR/extension/metadata.json" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/extension/stylesheet.css" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/extension/schemas/"*.gschema.xml "$EXTENSION_DIR/schemas/"
if [ -f "$SOURCE_DIR/extension/setup-backend.sh" ]; then
    cp "$SOURCE_DIR/extension/setup-backend.sh" "$EXTENSION_DIR/"
    chmod +x "$EXTENSION_DIR/setup-backend.sh"
fi
if [ -d "$SOURCE_DIR/extension/backend" ]; then
    mkdir -p "$EXTENSION_DIR/backend"
    cp -r "$SOURCE_DIR/extension/backend/"* "$EXTENSION_DIR/backend/"
fi
if [ -d "$SOURCE_DIR/extension/fonts" ]; then
    mkdir -p "$EXTENSION_DIR/fonts"
    cp -r "$SOURCE_DIR/extension/fonts/"* "$EXTENSION_DIR/fonts/"
fi

# Compile schemas
glib-compile-schemas "$EXTENSION_DIR/schemas"
echo "    [OK] GSettings schemas compiled."

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
