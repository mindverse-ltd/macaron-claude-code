#!/usr/bin/env bash
set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Load local .env if present (never committed — see .env.example for the
# required MACARON_API_BASE / MACARON_API_KEY variables).
if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/.env"
  set +a
fi

PORT="${MACARON_PORT:-7878}"
WEB_DIST="$DIR/web/dist"
SERVER_DIST="$DIR/server/dist/index.js"

# One-time install + build if anything's missing.
if [ ! -d "$DIR/node_modules" ] || [ ! -d "$DIR/server/node_modules" ] || [ ! -d "$DIR/web/node_modules" ]; then
  echo "[macaron] installing workspaces (one-time, ~30s)…" >&2
  (cd "$DIR" && npm install --silent)
fi

# Rebuild when dist is missing OR when any tracked source file is newer
# than the current bundle — so `claude plugin update` (git pull) picks up
# code changes without users having to blow the cache away by hand.
needs_build=0
if [ ! -f "$SERVER_DIST" ] || [ ! -f "$WEB_DIST/index.html" ]; then
  needs_build=1
elif [ -n "$(find "$DIR/web/src" "$DIR/server/src" "$DIR/shared/src" \
       -newer "$WEB_DIST/index.html" -type f -print -quit 2>/dev/null)" ]; then
  needs_build=1
fi
if [ "$needs_build" -eq 1 ]; then
  echo "[macaron] building (~30s)…" >&2
  (cd "$DIR" && npm run build --silent)
fi

# Kill any prior instance bound to this port.
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti :"$PORT" 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    echo "[macaron] killing existing process on port $PORT: $PIDS" >&2
    kill -9 $PIDS 2>/dev/null || true
    sleep 0.3
  fi
fi

LOG="/tmp/macaron-plugin.log"
cd "$DIR"
MACARON_PORT="$PORT" nohup node "$SERVER_DIST" > "$LOG" 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true

# Wait for /api/health (max ~3s).
for i in 1 2 3 4 5 6; do
  sleep 0.5
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
done

echo "Macaron WebUI: http://localhost:$PORT"
echo "PID: $SERVER_PID  (log: $LOG)"
