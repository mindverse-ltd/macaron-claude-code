#!/usr/bin/env bash
set -euo pipefail

# Macaron plugin entry point. Builds and launches the WebUI server.
#
# We do NOT ship prebuilt dist/ in the repo — every commit rebuilding
# server/dist + web/dist caused unresolvable rebase conflicts across
# concurrent PRs. Instead the plugin arrives as source, and this script
# does one build on first launch (~60s) then runs `node …` on every
# subsequent launch.
#
# Design invariants for the AI agent that spawns this via `/macaron`:
#  * Any failure inside install/build prints an actionable "Try …" line
#    to stderr. The agent can read stderr, run the printed command, and
#    retry — no human intervention needed.
#  * The script is idempotent: running it twice from a clean cache
#    installs once; running after `git pull` rebuilds only if source
#    changed (mtime check).
#  * Uses pnpm via corepack (Node 22+ ships with it), so plain `node` +
#    `bash` on the user's machine is enough — no manual npm/pnpm setup.

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Snapshot caller-provided MACARON_* env before sourcing .env so a stale
# .env in the plugin cache can't clobber an explicit override (e.g.
# `MACARON_ENGINE=claude bash start.sh` from the /macaron command).
_CALLER_ENGINE="${MACARON_ENGINE-}"
_CALLER_PORT="${MACARON_PORT-}"
_CALLER_FOREGROUND="${MACARON_FOREGROUND-}"

if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/.env"
  set +a
fi

[ -n "$_CALLER_ENGINE" ] && MACARON_ENGINE="$_CALLER_ENGINE"
[ -n "$_CALLER_PORT" ] && MACARON_PORT="$_CALLER_PORT"
[ -n "$_CALLER_FOREGROUND" ] && MACARON_FOREGROUND="$_CALLER_FOREGROUND"

ENGINE="${MACARON_ENGINE:-claude}"
if [ "$ENGINE" = "codex" ]; then
  PORT="${MACARON_PORT:-7979}"
else
  PORT="${MACARON_PORT:-7878}"
fi
FOREGROUND="${MACARON_FOREGROUND:-0}"

WEB_DIST="$DIR/web/dist"
SERVER_DIST="$DIR/server/dist/index.js"

# --- pnpm via corepack --------------------------------------------------

# Node 22 ships corepack, which auto-materialises the pnpm binary from the
# `packageManager` field in package.json. Prefer it over any globally
# installed pnpm so the version is consistent across machines.
_PNPM=""
if command -v corepack >/dev/null 2>&1; then
  # corepack enable is idempotent; --install-directory ensures we don't
  # need root privileges.
  corepack enable --install-directory "$DIR/node_modules/.corepack-bin" pnpm >/dev/null 2>&1 || true
  # Prepend the corepack shim dir so `pnpm` resolves to the pinned version.
  export PATH="$DIR/node_modules/.corepack-bin:$PATH"
  _PNPM="pnpm"
elif command -v pnpm >/dev/null 2>&1; then
  _PNPM="pnpm"
fi

if [ -z "$_PNPM" ]; then
  cat >&2 <<EOF
[macaron] neither \`corepack\` (Node 22+) nor a global \`pnpm\` is available.
[macaron] fix: install Node 22+ (corepack ships with it) or run
[macaron]      \`npm install -g pnpm@10.28.2\` and retry.
EOF
  exit 1
fi

# --- install ------------------------------------------------------------

# Marker file records the mtime of pnpm-lock.yaml at last successful
# install. If the lockfile is newer than the marker, node_modules is
# stale and we reinstall.
_INSTALL_MARKER="$DIR/node_modules/.macaron-install-marker"
needs_install=0
if [ ! -d "$DIR/node_modules" ] || [ ! -f "$_INSTALL_MARKER" ]; then
  needs_install=1
elif [ "$DIR/pnpm-lock.yaml" -nt "$_INSTALL_MARKER" ]; then
  needs_install=1
fi

if [ "$needs_install" = 1 ]; then
  echo "[macaron] installing workspace deps via pnpm (one-time, ~60s)…" >&2
  # First try frozen-lockfile — fast, reproducible, matches the committed
  # lockfile. Fall back to a full resolve if frozen fails (usually because
  # the lockfile drifted after a manual dep bump the user hasn't run
  # `pnpm install` for yet).
  if ! (cd "$DIR" && "$_PNPM" install --frozen-lockfile 2>&1); then
    echo "[macaron] frozen install failed — retrying without --frozen-lockfile" >&2
    if ! (cd "$DIR" && "$_PNPM" install 2>&1); then
      cat >&2 <<EOF
[macaron] pnpm install failed.
[macaron] fix: cd "$DIR" && rm -rf node_modules && $_PNPM install
[macaron] if that still fails, the pnpm-lock.yaml may be corrupt; open
[macaron] an issue at https://github.com/mindverse-ltd/macaron-claude-code/issues
EOF
      exit 1
    fi
  fi
  mkdir -p "$DIR/node_modules"
  touch "$_INSTALL_MARKER"
fi

# --- build --------------------------------------------------------------

# Rebuild only when dist is missing or a source file is newer than the
# current bundle. The mtime check is fast even on cold NFS mounts because
# `find … -print -quit` stops at the first match.
needs_build=0
if [ ! -f "$SERVER_DIST" ] || [ ! -f "$WEB_DIST/index.html" ]; then
  needs_build=1
elif [ -n "$(find "$DIR/web/src" "$DIR/server/src" "$DIR/shared/src" \
       -newer "$WEB_DIST/index.html" -type f -print -quit 2>/dev/null)" ]; then
  needs_build=1
fi

if [ "$needs_build" = 1 ]; then
  echo "[macaron] building (~30s)…" >&2
  if ! (cd "$DIR" && "$_PNPM" run build 2>&1); then
    cat >&2 <<EOF
[macaron] build failed. Common causes and fixes:
[macaron]  1. Node version — this project needs Node 22+; check with \`node --version\`.
[macaron]  2. Stale install — try:
[macaron]        cd "$DIR" && rm -rf node_modules && $_PNPM install && $_PNPM run build
[macaron]  3. Read the build output above for the specific error and share it in an issue.
EOF
    exit 1
  fi
fi

# --- launch -------------------------------------------------------------

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
  # Foreground path: async health-check probe prints the URL once the
  # server responds, THEN exec node so this shell becomes the server.
  # Used by the Codex plugin because its Bash tool kills backgrounded
  # children when the outer script returns.
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
  # Background path: keeps Claude's /macaron command returning quickly
  # so it can echo the URL and continue the assistant turn.
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
