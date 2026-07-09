---
description: Launch the Macaron WebUI (GenUI builder, model switcher, session manager)
allowed-tools: Bash(bash "${CLAUDE_PLUGIN_ROOT}/start.sh":*), Bash(open http\://*)
argument-hint: "[port]"
---

Start the Macaron WebUI server. The port defaults to 7878; the user may pass an alternate port as `$1`.

The plugin ships prebuilt (`web/dist/` and `server/dist/` are committed). `start.sh` handles port collisions, installs runtime deps only if missing (~10s one-off), and prints the URL. **Do NOT** rm node_modules, run npm install, run npm run build, or otherwise "prepare" the plugin before invoking `start.sh` — it does everything it needs internally. Just call it.

Run exactly this and nothing else. `MACARON_ENGINE=claude` is explicit so a stray shell export (e.g. from a prior Codex-side session) can't flip the WebUI to the wrong engine:

```bash
MACARON_ENGINE=claude MACARON_PORT="${1:-7878}" bash "${CLAUDE_PLUGIN_ROOT}/start.sh"
```

If `$1` is empty, run `MACARON_ENGINE=claude bash "${CLAUDE_PLUGIN_ROOT}/start.sh"`.

After the server prints `Macaron WebUI (engine=claude): http://localhost:<port>`, run `open "http://localhost:<port>"` to launch the browser, then quote the URL verbatim to the user (don't paraphrase it) and briefly summarize what's there:

- **Dashboard** — all workspaces from `~/.claude/projects`, sorted by last activity
- **Workspace** — one project's sessions with previews; start a new session from here
- **Session** — full transcript (thinking, tool calls, live GenUI previews) + follow-up chat
- **Settings** — manage Anthropic-compatible providers (Macaron, OpenRouter, LiteLLM, …) and pick the active one

If `start.sh` prints an error (e.g. it can't reclaim port 7878), report the error verbatim and ask the user for a free port to retry with as `$1`.
