#!/usr/bin/env bash
set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Snapshot the caller-provided MACARON_* env BEFORE loading .env so a
# stale/malformed .env in the plugin cache can't clobber an explicit
# override from the /macaron command (e.g. `MACARON_ENGINE=claude bash
# start.sh` — otherwise the .env's ENGINE=codex would win and open the
# wrong SPA).
_CALLER_ENGINE="${MACARON_ENGINE-}"
_CALLER_PORT="${MACARON_PORT-}"
_CALLER_FOREGROUND="${MACARON_FOREGROUND-}"

# Load local .env if present (never committed — see .env.example for the
# required MACARON_API_BASE / MACARON_API_KEY variables).
if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/.env"
  set +a
fi

# Caller-provided values win over .env.
[ -n "$_CALLER_ENGINE" ] && MACARON_ENGINE="$_CALLER_ENGINE"
[ -n "$_CALLER_PORT" ] && MACARON_PORT="$_CALLER_PORT"
[ -n "$_CALLER_FOREGROUND" ] && MACARON_FOREGROUND="$_CALLER_FOREGROUND"

# Port default: Claude engine keeps historical 7878. Codex uses 7979 so
# both plugins can run at once without collision. Callers can override
# either default with MACARON_PORT.
ENGINE="${MACARON_ENGINE:-claude}"
if [ "$ENGINE" = "codex" ]; then
  PORT="${MACARON_PORT:-7979}"
else
  PORT="${MACARON_PORT:-7878}"
fi
# `1` = block in the foreground (`exec node …`). The Codex plugin sets
# this because its Bash tool kills backgrounded children when the outer
# script returns. Default = background with nohup so the Claude Code
# `/macaron` command can return the URL and continue.
FOREGROUND="${MACARON_FOREGROUND:-0}"

WEB_DIST="$DIR/web/dist"
SERVER_DIST="$DIR/server/dist/index.js"

# Prebuilt dist ships in the repo — see .gitignore for the `!web/dist/`
# and `!server/dist/` exceptions. So the marketplace flow (git clone
# → plugin cache → run) needs zero client-side BUILD in the common case.
# Runtime deps (fastify, agent-sdk, zod, …) still need to be present in
# node_modules; --omit=dev skips vite / rollup / typescript-toolchain,
# which sidesteps the npm/cli#4828 rollup platform-binary bug entirely.
if [ -f "$SERVER_DIST" ] && [ -f "$WEB_DIST/index.html" ]; then
  if [ ! -d "$DIR/node_modules/fastify" ]; then
    echo "[macaron] installing runtime deps (one-time, ~10s)…" >&2
    (cd "$DIR" && npm install --omit=dev --silent --no-audit --no-fund)
  fi
else
  echo "[macaron] no prebuilt dist found — falling back to source build (~60s)…" >&2

  # `npm install` on macOS arm64 sometimes skips Rollup's platform-specific
  # optional dep when the lock was generated elsewhere (npm/cli#4828) — the
  # build then blows up with "Cannot find module @rollup/rollup-darwin-arm64".
  # --include=optional forces the platform binaries in; --no-audit / --no-fund
  # just cut noise.
  run_install() {
    (cd "$DIR" && npm install --silent --include=optional --no-audit --no-fund)
  }

  # npm's optional-dep bug means even --include=optional won't insert the
  # platform-specific rollup binary when a foreign package-lock exists. We
  # can't safely delete package-lock.json (it's committed), so after install
  # we spot-check that the current platform's rollup native module is
  # present and force-install it if not.
  ensure_rollup_platform() {
    local os arch pkg workdir
    workdir="$DIR/web"
    os="$(node -p 'process.platform' 2>/dev/null || echo unknown)"
    arch="$(node -p 'process.arch' 2>/dev/null || echo unknown)"
    case "$os-$arch" in
      darwin-arm64|darwin-x64|linux-x64|linux-arm64|win32-x64) pkg="@rollup/rollup-${os}-${arch}" ;;
      *) return 0 ;;
    esac
    if [ ! -d "$workdir/node_modules/@rollup/rollup-${os}-${arch}" ]; then
      echo "[macaron] adding $pkg (workaround for npm/cli#4828)…" >&2
      (cd "$workdir" && npm install --no-save --silent --no-audit --no-fund "$pkg") || true
    fi
  }

  if [ ! -d "$DIR/node_modules" ] || [ ! -d "$DIR/server/node_modules" ] || [ ! -d "$DIR/web/node_modules" ]; then
    run_install
  fi
  ensure_rollup_platform
  if ! (cd "$DIR" && npm run build --silent); then
    echo "[macaron] build failed — re-adding rollup platform dep and retrying…" >&2
    ensure_rollup_platform
    (cd "$DIR" && npm run build --silent)
  fi
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

export MACARON_ENGINE="$ENGINE"
export MACARON_PORT="$PORT"

if [ "$FOREGROUND" = "1" ]; then
  # Foreground: schedule a health-check probe in the background that
  # prints the URL once the server accepts requests, THEN exec node so
  # this shell is REPLACED by the server (parent's death can't SIGHUP it
  # into oblivion the way `nohup … & disown` sometimes fails in
  # sandboxed shells).
  (
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.5
      if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
        echo "Macaron WebUI (engine=$ENGINE): http://localhost:$PORT"
        exit 0
      fi
    done
    echo "[macaron] server didn't answer /api/health within 5s" >&2
  ) &
  exec node "$SERVER_DIST"
else
  # Background: original behavior, keeps `/macaron` command in Claude
  # Code returning quickly so it can echo the URL.
  nohup node "$SERVER_DIST" > "$LOG" 2>&1 &
  SERVER_PID=$!
  disown "$SERVER_PID" 2>/dev/null || true

  for _ in 1 2 3 4 5 6; do
    sleep 0.5
    if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      break
    fi
  done

  echo "Macaron WebUI (engine=$ENGINE): http://localhost:$PORT"
  echo "PID: $SERVER_PID  (log: $LOG)"
fi
