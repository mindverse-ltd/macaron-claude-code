# Macaron · Claude Code plugin

A Claude Code plugin that opens a local **WebUI** giving you three things you can't get from the CLI alone:

1. **Visual `/resume`** — browse Claude Code workspaces & sessions with previews; one click copies the `--resume` command.
2. **Live chat** — continue any session (or start a new one) in the browser; streams thinking, tool calls and GenUI previews via the Claude Agent SDK.
3. **Provider switcher** — run sessions against your ambient Claude Code login or any Anthropic-compatible endpoint (Macaron, OpenRouter, LiteLLM, …).

The plugin bundles the official **`genui-builder` skill** so any Claude Code instance that has it loaded can also produce GenUI TSX from the command line.

---

## Install

The repo doubles as its own plugin marketplace (`.claude-plugin/marketplace.json`). Use the full https URL — the `owner/repo` shorthand may clone over SSH, which fails without a GitHub SSH key. In a Claude Code session, run each command separately (pasting both lines at once merges them into one command):

```
/plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts
```

```
/plugin install macaron@macaron
```

or from the shell:

```bash
claude plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts
claude plugin install macaron@macaron
```

For local development, install your checkout directly: `claude plugin install /path/to/macaron`.

Verify:

```bash
claude plugin list
# → macaron@macaron  (commands: /macaron, skills: genui-builder)
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

Zero config by default — sessions run against your ambient Claude Code login. Add Macaron or any Anthropic-compatible provider from the **Settings** page (persisted to `~/.claude/macaron-config.json`), or override via env — copy `.env.example` to `.env` (git-ignored) before launching:

```bash
MACARON_API_BASE=https://your-endpoint/v1
MACARON_API_KEY=sk-…
MACARON_MODEL=macaron-0.6     # optional
MACARON_PORT=7878             # optional
```

### Exposing on your LAN

By default the server binds to `127.0.0.1`, so only the local machine can reach it — no auth needed. To use the WebUI from your phone or another machine, bind to a routable address and set a shared token:

```bash
MACARON_HOST=0.0.0.0 MACARON_AUTH_TOKEN=your-long-random-token /macaron
```

Remote requests must then present the token; localhost stays frictionless (loopback is never challenged). The web app shows a one-field unlock screen, and you can share a ready-to-use link as `http://<host>:7878/?token=your-long-random-token` (the token is stored and stripped from the URL on first load). If you bind to a non-loopback host **without** setting a token, the server generates one at boot and prints it to the log so it's never left wide open.

## Layout

```
.claude-plugin/                   plugin manifest + marketplace (install from GitHub)
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
