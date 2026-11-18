#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

pick_python() {
  if [ -n "${PYTHON_BIN:-}" ]; then
    if command -v "$PYTHON_BIN" >/dev/null 2>&1 && "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
      echo "$PYTHON_BIN"
      return 0
    fi
  fi

  local candidates=(
    "/opt/homebrew/bin/python3.13"
    "/opt/homebrew/bin/python3.12"
    "/opt/homebrew/bin/python3.11"
    "/opt/homebrew/bin/python3.10"
    "/opt/homebrew/bin/python3"
    "/usr/local/bin/python3.13"
    "/usr/local/bin/python3.12"
    "/usr/local/bin/python3.11"
    "/usr/local/bin/python3.10"
    "/usr/local/bin/python3"
    "python3.13"
    "python3.12"
    "python3.11"
    "python3.10"
    "python3"
    "python"
  )

  local c
  for c in "${candidates[@]}"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then
      if "$c" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
        command -v "$c" 2>/dev/null || echo "$c"
        return 0
      fi
    fi
  done
  return 1
}

PYTHON_EXE="$(pick_python || true)"
if [ -z "$PYTHON_EXE" ]; then
  echo "Error: Python 3.10 or newer is required (Apple's built-in /usr/bin/python3 is often 3.9)."
  echo "On macOS, install Python 3.12 via Homebrew:"
  echo "  brew install python@3.12"
  echo "Or download from https://www.python.org/downloads/macos/"
  exit 1
fi

VENV_DIR="$ROOT_DIR/.venv"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "[setup] Creating virtual environment in .venv using $PYTHON_EXE..."
  "$PYTHON_EXE" -m venv "$VENV_DIR"
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
