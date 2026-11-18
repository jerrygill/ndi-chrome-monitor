#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Error: Python 3.10+ not found. Please install Python 3.10 or newer."
  exit 1
fi

VENV_DIR="$ROOT_DIR/.venv"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "[setup] Creating virtual environment in .venv..."
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

STAMP_FILE="$VENV_DIR/.deps_installed"
if [ ! -f "$STAMP_FILE" ] || [ "$ROOT_DIR/requirements.txt" -nt "$STAMP_FILE" ]; then
  echo "[setup] Installing Python dependencies (fastapi, cyndilib, pillow, qrcode)..."
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/pip" install -r "$ROOT_DIR/requirements.txt"
  touch "$STAMP_FILE"
fi

PORT="${NDI_PORT:-8765}"
exec "$VENV_DIR/bin/python" -m server.app --host 0.0.0.0 --port "$PORT" "$@"
