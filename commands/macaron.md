---
description: Launch the Macaron WebUI (GenUI builder, model switcher, session manager)
allowed-tools: Bash(bash "${CLAUDE_PLUGIN_ROOT}/start.sh":*), Bash(open http\://*)
---

Start the Macaron WebUI server. The Claude Code flavor always launches on the fixed port 7878 (Codex uses 7979, Kimi 7980, so all three can run side by side) — there is no port argument.

The plugin arrives as source (no committed `dist/`) — `start.sh` uses `corepack pnpm` to install and build on first launch (~60s), then reuses the cached build on subsequent launches. When invoked from a plugin cache directory (which the host can prune under us), it transparently mirrors source into `~/.macaron/runtime/<version>/` and runs from there so `node_modules` / `dist` survive. Port collisions, install / build retries, and URL printing are all handled inside the script. **Do NOT** rm node_modules, run npm install, run npm run build, or otherwise "prepare" the plugin before invoking `start.sh` — call it once and let it print. If it errors out, follow the "fix:" line it prints on stderr and try again.

Run exactly this and nothing else. `MACARON_ENGINE=claude` and `MACARON_PORT=7878` are both explicit so stray shell exports (e.g. from a prior Codex/Kimi-side session) can't flip the WebUI to the wrong engine or port:

```bash
MACARON_ENGINE=claude MACARON_PORT=7878 bash "${CLAUDE_PLUGIN_ROOT}/start.sh"
```

After the server prints `Macaron WebUI (engine=claude): http://localhost:7878`, run `open "http://localhost:7878"` to launch the browser, then quote the URL verbatim to the user (don't paraphrase it) and briefly summarize what's there:

- **Dashboard** — all workspaces from `~/.claude/projects`, sorted by last activity
- **Workspace** — one project's sessions with previews; start a new session from here
- **Session** — full transcript (thinking, tool calls, live GenUI previews) + follow-up chat
- **Settings** — manage Anthropic-compatible providers (Macaron, OpenRouter, LiteLLM, …) and pick the active one

If `start.sh` prints an error:

- **Port busy**: `start.sh` kills whatever holds 7878 before binding, so this should not occur; if the server still fails to come up, quote the raw stderr and check `/tmp/macaron-plugin.log`.
- **Install / build failed**: `start.sh` prints one or more `[macaron] fix: <command>` lines on stderr. Run each printed fix command in order and retry `start.sh` after each; report the outcome to the user.
- **Anything else**: quote the raw stderr, then check `/tmp/macaron-plugin.log` for the server-side tail before proposing next steps.
