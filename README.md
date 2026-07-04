# Macaron · Claude Code plugin (demo)

A Claude Code plugin that opens a local **WebUI** giving you three things you can't get from the CLI alone:

1. **GenUI Builder** — stream Macaron-generated TSX with live code pane (thinking-tokens shown separately).
2. **Model switcher** — send the same prompt to Claude, Codex, or **Macaron-0.6** without leaving the page.
3. **Visual `/resume`** — browse Claude Code & Codex session history with previews; one click copies the `--resume` command.

The plugin bundles the official **`genui-builder` skill** so any Claude Code instance that has it loaded can also produce GenUI TSX from the command line.

---

## Run via npx

No clone, no build — just Node 22+. Pre-release builds publish to [pkg.pr.new](https://pkg.pr.new) on every push, so run the latest PR build straight from its URL:

```bash
npx https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcc@8            # → http://localhost:7878
npx https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcc@8 --port 8080
MACARON_API_KEY=sk-… npx https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcc@8
```

The tarball ships the prebuilt web UI + a bundled server; only the npm-installable runtime deps (`fastify`, `@fastify/static`, `zod`, `@anthropic-ai/claude-agent-sdk`) are fetched on first run.

`bunx` can't run a tarball URL directly — install first, then invoke: `bun add https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcc@8 && bunx mcc`.

---

## Install

Drop the folder into Claude Code's local marketplace, or load it directly:

```bash
# from anywhere
claude plugin install /Users/linfan/mindverse/macaron-plugin
```

Or register the directory as a personal marketplace and install by name:

```bash
claude plugin marketplace add /Users/linfan/mindverse
claude plugin install macaron@mindverse
```

Verify:

```bash
claude plugin list
# → macaron@local  0.1.0  (commands: /macaron, skills: genui-builder)
```

## Use

Inside any Claude Code session:

```
/macaron
```

The slash command starts the local server (`node server/server.mjs`, port `7878` by default) and opens `http://localhost:7878` in your browser. Pass a custom port with `/macaron 8080`.

### Tabs

| Tab          | What it does |
| ------------ | ------------ |
| **GenUI**    | POST `/api/genui` → streams `chat/completions` from Macaron with the live GenUI system prompt. TSX grows in the code pane as tokens arrive; reasoning tokens are surfaced in the status line. |
| **Chat**     | POST `/api/chat` with a model id. `macaron-*` hits the API directly; `claude` and `codex` spawn the local CLI and pipe stdout back as SSE. |
| **Sessions** | Reads `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/rollout-*.jsonl`, previews the first user message, copies the right `--resume` command for either CLI. |

## Configure

The demo ships with a Macaron API key embedded. Override via env vars before launching:

```bash
export MACARON_API_BASE="https://your-endpoint/v1"
export MACARON_API_KEY="sk-…"
export MACARON_MODEL="macaron-0.6"
export MACARON_PORT=7878
/macaron
```

## Layout

```
.claude-plugin/plugin.json        plugin manifest
commands/macaron.md               /macaron slash command
skills/genui-builder/             bundled skill (used by Claude Code directly)
start.sh                          boots the server in background, opens browser
server/server.mjs                 zero-dep Node HTTP + SSE server
server/public/{index.html,app.js,styles.css}   WebUI
```

## Notes

- Built and tested against **Node 22**. No npm deps.
- Claude Code stores project directories as `~/.claude/projects/-<encoded-path>`; hyphens in the original folder name are ambiguous (we display the best-guess decoded path).
- The "Build & open" button in the GenUI tab is wired but not implemented — drop in `bunx @genui/cli build` when you want to render the preview in-page.
- Codex SSE streaming uses `codex exec` subprocess; for richer streaming swap in the Codex MCP server.
