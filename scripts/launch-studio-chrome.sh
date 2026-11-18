#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
EXT_ID="anjokcpcmbhbimpjgbffkjfbnciaaeff"

PROFILE_QUERY="${CHROME_PROFILE:-}"
START_URL="http://127.0.0.1:8765"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile|-p)
      if [ "$#" -lt 2 ]; then
        echo "Error: --profile requires a profile name (e.g. \"alpha colors church\")."
        exit 1
      fi
      PROFILE_QUERY="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--profile \"Profile Name\"] [start_url]"
      echo ""
      echo "Without --profile: launches an isolated .ndi-chrome-studio-profile window."
      echo "With --profile   : resolves your real Chrome profile (e.g. \"alpha colors church\")"
      echo "                   from Chrome's Local State and launches it with Studio flags."
      exit 0
      ;;
    *)
      START_URL="$1"
      shift
      ;;
  esac
done

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

EXTRA_ARGS=()

if [ -n "$PROFILE_QUERY" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome"
  elif [ -d "$HOME/.config/google-chrome" ]; then
    USER_DATA_DIR="$HOME/.config/google-chrome"
  else
    USER_DATA_DIR="$HOME/.config/chromium"
  fi

  LOCAL_STATE="$USER_DATA_DIR/Local State"
  if [ ! -f "$LOCAL_STATE" ]; then
    echo "Could not find Chrome Local State at: $LOCAL_STATE"
    echo "Open Chrome once first, or run without --profile to use an isolated Studio profile."
    exit 1
  fi

  PY_HELPER="$(command -v python3 || command -v python || true)"
  if [ -z "$PY_HELPER" ]; then
    echo "python3 is required to resolve Chrome profile names."
    exit 1
  fi

  PROFILE_DIR_NAME="$("$PY_HELPER" - "$LOCAL_STATE" "$PROFILE_QUERY" <<'PYEOF'
import json
import sys

state_path, query = sys.argv[1], sys.argv[2].strip()
with open(state_path, "r", encoding="utf-8") as f:
    data = json.load(f)

cache = (data.get("profile") or {}).get("info_cache") or {}
q_low = query.lower()

exact_dir = next((k for k in cache if k.lower() == q_low), None)
if exact_dir:
    print(exact_dir)
    sys.exit(0)

exact_name = next(
    (k for k, v in cache.items() if (v.get("name") or "").strip().lower() == q_low),
    None,
)
if exact_name:
    print(exact_name)
    sys.exit(0)

partial = [
    (k, v.get("name") or "")
    for k, v in cache.items()
    if q_low in (v.get("name") or "").lower()
    or q_low in (v.get("user_name") or "").lower()
]
if len(partial) == 1:
    print(partial[0][0])
    sys.exit(0)

sys.stderr.write(f"Could not uniquely match Chrome profile '{query}'. Available profiles:\n")
for k, v in sorted(cache.items()):
    sys.stderr.write(f"  - {v.get('name', '?')}  (dir: {k}, email: {v.get('user_name', '')})\n")
sys.exit(2)
PYEOF
)"

  if [ "$(uname -s)" = "Darwin" ] && pgrep -x "Google Chrome" >/dev/null 2>&1; then
    echo "Google Chrome is currently running."
    echo "Quit Google Chrome completely first (press Cmd+Q), then re-run this script"
    echo "so Studio Zero-Click flags are applied to your \"$PROFILE_QUERY\" profile."
    exit 1
  fi

  EXTRA_ARGS+=("--profile-directory=$PROFILE_DIR_NAME")
  echo "Matched Chrome profile \"$PROFILE_QUERY\" -> directory \"$PROFILE_DIR_NAME\""
  echo "Note: In recent Google Chrome releases, also load extension/ once via chrome://extensions -> Load unpacked."
else
  USER_DATA_DIR="$ROOT_DIR/.ndi-chrome-studio-profile"
  mkdir -p "$USER_DATA_DIR"
fi

echo "Launching Studio Chrome with zero-click Meet tab capture..."
echo "Extension ID: $EXT_ID"
echo "User Data   : $USER_DATA_DIR"

exec "$CHROME_BIN" \
  --user-data-dir="$USER_DATA_DIR" \
  "${EXTRA_ARGS[@]}" \
  --no-first-run \
  --no-default-browser-check \
  --load-extension="$EXT_DIR" \
  --allowlisted-extension-id="$EXT_ID" \
  --auto-select-tab-capture-source-by-title=__NDI_SHARE__ \
  --disable-blink-features=GetDisplayMediaRequiresUserActivation \
  --silent-debugger-extension-api \
  --autoplay-policy=no-user-gesture-required \
  "$START_URL"
