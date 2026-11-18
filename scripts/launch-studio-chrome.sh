#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
PROFILE_DIR="$ROOT_DIR/.ndi-chrome-studio-profile"
EXT_ID="anjokcpcmbhbimpjgbffkjfbnciaaeff"
mkdir -p "$PROFILE_DIR"

CHROME_BIN=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "$(command -v google-chrome || true)" \
  "$(command -v google-chrome-stable || true)" \
  "$(command -v chromium || true)" \
  "$(command -v chromium-browser || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    CHROME_BIN="$candidate"
    break
  fi
done

if [ -z "$CHROME_BIN" ]; then
  echo "Could not find Google Chrome executable."
  exit 1
fi

START_URL="${1:-http://127.0.0.1:8765}"
echo "Launching Studio Chrome with zero-click Meet tab capture..."
echo "Extension ID: $EXT_ID"
echo "Profile Dir : $PROFILE_DIR"

exec "$CHROME_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --load-extension="$EXT_DIR" \
  --allowlisted-extension-id="$EXT_ID" \
  --auto-select-tab-capture-source-by-title=__NDI_SHARE__ \
  --disable-blink-features=GetDisplayMediaRequiresUserActivation \
  --silent-debugger-extension-api \
  --autoplay-policy=no-user-gesture-required \
  "$START_URL"
