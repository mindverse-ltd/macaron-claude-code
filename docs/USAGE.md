# Macaron Artifacts

A local WebUI that ships as a plugin for **both** Claude Code and Codex — you can install one or both, and they run side-by-side:

- Claude → <http://localhost:7878>
- Codex → <http://localhost:7979>

## Install

### Claude Code

```
/plugin marketplace add https://github.com/mindverse-ltd/macaron-artifacts
/plugin install macaron@macaron
```

Open it in a session with `/macaron`.

### Codex

```bash
codex plugin marketplace add https://github.com/mindverse-ltd/macaron-artifacts
codex plugin add macaron@macaron
```

Open it in a session with `open macaron web ui`.

### No plugin — one-liner via bunx / npx

Two independent packages, each shipping its own prebuilt server + web assets:
`mcc` (Claude WebUI on port `7878`) and `mcx` (Codex WebUI on port `7979`).
Install neither; run whichever you want directly:

```bash
bunx mcc@https://pkg.pr.new/mindverse-ltd/macaron-artifacts/mcc@<sha>   # Claude → http://localhost:7878
bunx mcx@https://pkg.pr.new/mindverse-ltd/macaron-artifacts/mcx@<sha>   # Codex  → http://localhost:7979
```

`npx` works the same — both packages have `bin` name == package name:

```bash
npx mcc@https://pkg.pr.new/mindverse-ltd/macaron-artifacts/mcc@<sha>    # Claude → http://localhost:7878
npx mcx@https://pkg.pr.new/mindverse-ltd/macaron-artifacts/mcx@<sha>    # Codex  → http://localhost:7979
```

Replace `<sha>` with any commit on `main`. Both bins accept `--host` / `--port`; run with `--help` for the full flag list.

## Using the WebUI

Once open:

- Click a workspace in the sidebar to enter its canvas; pin a session with the `+` button.
- On the canvas: drag the grip to reorder tiles, drag the SE corner to resize, click a tile to focus.
- Composer: **Enter** sends · **Shift+Enter** newline · **↑ / ↓** cycles prompt history · paste an image to attach it directly.

First time on the Codex side, open **Settings** and fill in your Base URL / API key / Model.

## Update

### Claude Code

```
/plugin update macaron
```

### Codex

```bash
codex plugin marketplace upgrade macaron   # pull the latest version
codex plugin remove macaron@macaron
codex plugin add macaron@macaron           # reinstall
```

## Feedback

Open an issue: <https://github.com/mindverse-ltd/macaron-artifacts/issues>
