#!/usr/bin/env bash
set -e

DATA_DIR="$HOME/.local/share/depth-clock"
VENV_DIR="$DATA_DIR/venv"
PYTHON_BIN="$VENV_DIR/bin/python3"
MODELS_DIR="$DATA_DIR/models"
MODEL_PATH="$MODELS_DIR/rmbg-1.4.onnx"
MODEL_URL="https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"
MODEL_MIRROR_URL="https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$BASH_SOURCE")" 2>/dev/null && pwd || true)"
elif [ -n "$0" ] && [ -f "$0" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
fi

REQUIREMENTS_FILE="$SCRIPT_DIR/backend/requirements.txt"

check_status() {
    if [ ! -f "$PYTHON_BIN" ]; then
        echo "MISSING_VENV"
        return 1
    fi
    if [ ! -f "$MODEL_PATH" ]; then
        echo "MISSING_MODEL"
        return 2
    fi
    local model_size
    model_size=$(stat -c%s "$MODEL_PATH" 2>/dev/null || stat -f%z "$MODEL_PATH" 2>/dev/null || echo 0)
    if [ "$model_size" -lt 150000000 ]; then
        echo "INCOMPLETE_MODEL"
        return 2
    fi
    echo "READY"
    return 0
}

install_backend() {
    echo "[STEP] Checking system environment..."
    if ! command -v python3 >/dev/null 2>&1; then
        echo "[ERROR] python3 is not installed on this system."
        exit 3
    fi

    if ! python3 -m venv --help >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
            echo "[ERROR] python3-venv is missing. Run: sudo apt install python3-venv"
        else
            echo "[ERROR] Python venv module is missing on this system."
        fi
        exit 3
    fi

    if ! command -v curl >/dev/null 2>&1; then
        echo "[ERROR] curl is not installed on this system."
        exit 3
    fi

    mkdir -p "$DATA_DIR" "$MODELS_DIR"

    echo "[STEP] Setting up Python virtual environment..."
    if [ ! -f "$PYTHON_BIN" ]; then
        python3 -m venv "$VENV_DIR"
    fi

    echo "[STEP] Installing Python AI dependencies..."
    "$PYTHON_BIN" -m pip install --quiet --upgrade pip
    if [ -f "$REQUIREMENTS_FILE" ]; then
        "$PYTHON_BIN" -m pip install --quiet -r "$REQUIREMENTS_FILE"
    else
        "$PYTHON_BIN" -m pip install --quiet "numpy>=1.26.0" "pillow>=10.0.0" "onnxruntime>=1.18.0"
    fi

    echo "[STEP] Checking AI segmentation model..."
    local need_download=true
    if [ -f "$MODEL_PATH" ]; then
        local current_size
        current_size=$(stat -c%s "$MODEL_PATH" 2>/dev/null || stat -f%z "$MODEL_PATH" 2>/dev/null || echo 0)
        if [ "$current_size" -ge 150000000 ]; then
            need_download=false
        fi
    fi

    if [ "$need_download" = true ]; then
        echo "[STEP] Downloading RMBG-1.4 segmentation model (~176 MB)..."
        local tmp_model="$MODEL_PATH.tmp"
        local download_ok=false

        if curl -L --fail --retry 3 --retry-delay 2 --connect-timeout 15 -C - -o "$tmp_model" "$MODEL_URL"; then
            download_ok=true
        else
            echo "[WARN] Primary download failed. Retrying with mirror..."
            if curl -L --fail --retry 3 --retry-delay 2 --connect-timeout 15 -C - -o "$tmp_model" "$MODEL_MIRROR_URL"; then
                download_ok=true
            fi
        fi

        if [ "$download_ok" = false ]; then
            rm -f "$tmp_model"
            echo "[ERROR] Failed to download model from primary and mirror sources."
            exit 4
        fi

        local downloaded_size
        downloaded_size=$(stat -c%s "$tmp_model" 2>/dev/null || stat -f%z "$tmp_model" 2>/dev/null || echo 0)
        if [ "$downloaded_size" -lt 150000000 ]; then
            rm -f "$tmp_model"
            echo "[ERROR] Downloaded model is incomplete or corrupted."
            exit 4
        fi

        mv "$tmp_model" "$MODEL_PATH"
    fi

    echo "[SUCCESS] AI segmentation backend is ready."
    exit 0
}

case "${1:-}" in
    --status)
        check_status
        ;;
    --install)
        install_backend
        ;;
    *)
        echo "Usage: $0 [--status | --install]"
        exit 1
        ;;
esac
