# Macaron · Claude Code plugin (demo)

A Claude Code plugin that opens a local **WebUI** giving you three things you can't get from the CLI alone:

1. **Visual `/resume`** — browse Claude Code workspaces & sessions with previews; one click copies the `--resume` command.
2. **Live chat** — continue any session (or start a new one) in the browser; streams thinking, tool calls and GenUI previews via the Claude Agent SDK.
3. **Provider switcher** — run sessions against your ambient Claude Code login or any Anthropic-compatible endpoint (Macaron, OpenRouter, LiteLLM, …).

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
claude plugin install /path/to/macaron-claude-code
```

Or register the parent directory as a personal marketplace and install by name:

```bash
claude plugin marketplace add /path/to/parent-dir
claude plugin install macaron@<marketplace>
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

The slash command starts the local server (`node server/dist/index.js`, port `7878` by default) and opens `http://localhost:7878` in your browser. Pass a custom port with `/macaron 8080`.

### Views

| View          | What it does |
| ------------- | ------------ |
| **Dashboard** | All workspaces from `~/.claude/projects/**/*.jsonl`, sorted by last activity. |
| **Workspace** | Sessions of one project with previews; start a new session from here. |
| **Session**   | Full transcript (thinking, tool calls, live GenUI TSX previews) + follow-up messages streamed over SSE. |
| **Settings**  | Manage Anthropic-compatible providers and pick the active one (stored in `~/.claude/macaron-config.json`). |

## Configure

Copy `.env.example` to `.env` (git-ignored) before launching:

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
start.sh                          one-time npm install + build, boots server in background
shared/                           domain types + SSE protocol (server ↔ web)
server/                           Fastify API, Claude Agent SDK runner, provider relay
web/                              Vite + React UI
```

## Notes

- Built and tested against **Node 22**.
- Claude Code stores project directories as `~/.claude/projects/-<encoded-path>`; hyphens in the original folder name are ambiguous (we display the best-guess decoded path).
