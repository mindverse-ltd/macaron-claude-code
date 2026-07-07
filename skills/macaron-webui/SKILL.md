---
name: macaron-webui
description: "Launch the Macaron WebUI — a browser-based session manager and GenUI preview for Codex, backed by ~/.codex/sessions/. Use when the user says 'open macaron', 'launch macaron', '@macaron', 'macaron webui', 'open the session manager', or asks to browse / continue / preview Codex sessions in a visual UI."
---

# Macaron WebUI

Use this skill when the user wants to open the Macaron WebUI — a local browser app that lists Codex workspaces + sessions from `~/.codex/sessions/`, lets them continue any turn, and streams GenUI TSX previews.

## Resolving the plugin root

Resolve the plugin root from this `SKILL.md` file by going two directories up from `skills/macaron-webui/`. The launcher script is at `<plugin root>/start.sh`.

## Bootstrap

Run this exactly once. Two env vars matter:

- `MACARON_ENGINE=codex` — flips the SPA served at `/` from the Claude-focused UI to the Codex-focused one. **Never omit this.** Without it the user sees the Claude Code UI, not Codex.
- `MACARON_FOREGROUND=1` — makes `start.sh` `exec node` into the foreground instead of nohup-backgrounding. Backgrounded children get killed when the outer script returns inside your Bash tool, so the server would disappear seconds after launch. Foreground keeps the process anchored to the tool session and the URL is printed asynchronously before `exec` blocks.

```bash
MACARON_ENGINE=codex MACARON_FOREGROUND=1 MACARON_PORT=7979 bash "<plugin root>/start.sh"
```

Port `7979` is the Codex-side default so it doesn't collide with the Claude Code plugin (which uses `7878`). Both can run at once. If 7979 is busy, tell the user to override with `MACARON_PORT=<n>`.

The script:
- Runs `npm install --include=optional` + `npm run build` on first launch (~60s). If the build fails (usually a missing `@rollup/rollup-darwin-arm64` from a partial install), it wipes `node_modules` and retries once — no user action needed.
- Frees the port if a stale `mcx` / `mcc` is bound (`lsof` → `kill`).
- Prints `Macaron WebUI (engine=codex): http://localhost:7979` once `/api/health` answers, THEN blocks on `exec node`.
- Stays in the foreground indefinitely. This is expected — do NOT kill it after launch. The Bash tool can move on while this shell keeps the server alive.

Once the URL line prints, open the browser:

```bash
open "http://localhost:7979"
```

Quote the URL verbatim so the user can click it directly. If `open` fails in a sandbox (`kLSExecutableIncorrectFormat`), tell the user to paste the URL into their browser.

## What the user sees

- **Dashboard** — every workspace under `~/.codex/sessions/` sorted by last activity.
- **Workspace** — one project's sessions as tiles on a canvas; pin, reorder, resize, and continue any turn.
- **Session** — full transcript with reasoning, tool calls, live GenUI TSX previews.
- **Settings** — pick the active model/provider (system Codex, Macaron, OpenRouter, any OpenAI-compatible endpoint).

## Notes for the model

- Do NOT run `mcx` / `mcc` directly with `npx` — always go through `start.sh` so the port-collision handler and env plumbing (especially `MACARON_ENGINE=codex`) both apply.
- If the port is busy AND the script fails to reclaim it: report the failure verbatim and ask the user for a free port (`MACARON_PORT=<n>`).
- The WebUI binds to `127.0.0.1:${port}` — nothing leaves the user's machine.
- Stop the server with Ctrl-C in the shell that spawned it, or `lsof -ti tcp:${port} | xargs kill`.
