#!/usr/bin/env node
// mcx — Macaron Codex WebUI launcher. Same server as mcc, but boots the
// codex SPA (codex.html) at `/` instead of the claude SPA. All API namespaces
// (claude + codex) stay available; the UI chooses which side to render.
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`Usage: mcx [options]

  Start the Macaron Codex WebUI (ChatGPT-style chat over the Codex SDK).

Options:
  --host <host>     Bind address (default: 127.0.0.1)
  --port <port>     Port (default: 7979 — offset from mcc's 7878 so both can run)
  --version, -v     Print version and exit
  --help, -h        Show this help

Environment:
  MACARON_CODEX_PATH   Path to codex CLI binary (default: auto-detected)
  MACARON_LOG_LEVEL    Log level (default: info)

Configure the provider (base URL, API key, model, reasoning effort, sandbox
mode) via the Settings page in the WebUI. Settings persist to
~/.claude/macaron-codex-config.json.`);
}

async function printVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
}

const readValue = (i, flag) => {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) throw new Error(`${flag} requires a value`);
  return v;
};

try {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    if (flag === '--help' || flag === '-h') { printHelp(); process.exit(0); }
    if (flag === '--version' || flag === '-v') { await printVersion(); process.exit(0); }
    if (flag === '--host' || flag === '--port') {
      process.env[flag === '--host' ? 'MACARON_HOST' : 'MACARON_PORT'] = inline ?? readValue(i, flag);
      if (inline === null) i++;
      continue;
    }
    throw new Error(`Unknown option: ${a}`);
  }

  const port = process.env.MACARON_PORT;
  if (port !== undefined && (!/^\d+$/.test(port) || +port < 1 || +port > 65535)) {
    throw new Error(`Invalid port: ${port}`);
  }
} catch (e) {
  console.error(`mcx: ${e.message}`);
  process.exit(1);
}

// The one env flag that flips the SPA served at `/` from index.html to codex.html.
process.env.MACARON_ENGINE = 'codex';
// Codex-side default port is 7979 (mcc uses 7878) so both can run at once.
process.env.MACARON_PORT ??= '7979';
process.env.NODE_ENV ??= 'production';

await import('../server/dist/index.js');
