---
name: macaron-webui
description: "Launch the Macaron WebUI — a browser-based session manager and GenUI preview for Codex, backed by ~/.codex/sessions/. Use when the user says 'open macaron', 'launch macaron', '@macaron', 'macaron webui', 'open the session manager', or asks to browse / continue / preview Codex sessions in a visual UI."
---

# Macaron WebUI

Use this skill when the user wants to open the Macaron WebUI — a local browser app that lists Codex workspaces + sessions from `~/.codex/sessions/`, lets them continue any turn, and streams GenUI TSX previews.

## Resolving the plugin root

Resolve the plugin root from this `SKILL.md` file by going two directories up from `skills/macaron-webui/`. The launcher script is at `<plugin root>/start.sh`.

## Bootstrap

Run this once per turn (substitute `<plugin root>` for the absolute path resolved above; the user may optionally pass a port as an argument):

```bash
MACARON_PORT="${MACARON_PORT:-7878}" bash "<plugin root>/start.sh"
```

The script:
- Runs `npm install` + `npm run build` on first launch (~30s, cached afterwards).
- Frees the port if a stale `mcx` / `mcc` is bound (`lsof` → `kill`).
- Prints `Macaron WebUI: http://localhost:<port>` once ready.
- Stays in the foreground until Ctrl-C — run it in the background (`&`) or in a shell the user can leave open.

Once the URL prints, open the browser:

```bash
open "http://localhost:${MACARON_PORT:-7878}"
```

Quote the URL verbatim — do not paraphrase it, so the user can click it directly.

## What the user sees

- **Dashboard** — every workspace under `~/.codex/sessions/` sorted by last activity.
- **Workspace** — one project's sessions as tiles on a canvas; pin, reorder, resize, and continue any turn.
- **Session** — full transcript with reasoning, tool calls, live GenUI TSX previews.
- **Settings** — pick the active model/provider (system Codex, Macaron, OpenRouter, any OpenAI-compatible endpoint).

## Notes for the model

- Do NOT run `mcx` / `mcc` directly with `npx` — always go through `start.sh` so port-collision handling and env plumbing work.
- If the port is busy AND the script fails to reclaim it: report the failure verbatim and ask the user for a free port.
- The WebUI binds to `127.0.0.1:${port}` — nothing leaves the user's machine.
- After the user closes the browser tab the server keeps running. To stop: Ctrl-C in the shell that spawned it, or `lsof -ti tcp:${port} | xargs kill`.
