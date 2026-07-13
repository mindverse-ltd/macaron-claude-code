# mcx

Standalone launcher for the **Macaron Codex WebUI** (ChatGPT-style chat over the Codex SDK).

This package ships no runtime of its own — it depends on [`mcc`](https://github.com/mindverse-ltd/macaron-claude-code) and boots its prebuilt server with the Codex SPA at `/`. It exists so `npx mcx@…` resolves (bin name = package name); `bunx mcx@…` from the `mcc` package works too.

```bash
npx mcx@https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcx@<sha>   # Codex → http://localhost:7979
```

Accepts `--host` / `--port`; run with `--help` for the full list.
