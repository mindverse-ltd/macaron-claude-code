#!/usr/bin/env node
// mcc — Macaron Claude Code WebUI launcher. Starts the prebuilt server and
// serves the bundled web UI. The server bundle (bun build --packages=external)
// leaves every npm dep external; @macaron/shared is types-only, so its
// `import type` usages erase at compile time and it never reaches the bundler.
// Keep it types-only: --packages=external would externalize any runtime code it
// gains into a bare import the published tarball can't resolve.
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`Usage: mcc [options]

  Start the Macaron Claude Code WebUI.

Options:
  --host <host>     Bind address (default: 127.0.0.1)
  --port <port>     Port (default: 7878)
  --version, -v     Print version and exit
  --help, -h        Show this help

Environment:
  MACARON_API_BASE   Macaron API endpoint
  MACARON_API_KEY    Macaron API key
  MACARON_MODEL      Model id (default: macaron-0.6)
  MACARON_LOG_LEVEL  Log level (default: info)`);
}

async function printVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
}

const readValue = (i, flag) => {
  const v = args[i + 1];
  // Reject only a missing or flag-like next token; an empty value passes here
  // (matching `--flag=`) and, for --port, is caught by the range check below.
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
      // Advance past the consumed value only for the space form (inline === null).
      // `--flag=` (inline='') already has its value, so it must NOT skip the next arg.
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
  console.error(`mcc: ${e.message}`);
  process.exit(1);
}
process.env.NODE_ENV ??= 'production';
process.env.MACARON_HOST ??= '127.0.0.1';
process.env.MACARON_PORT ??= '7878';

// Relative to this bin file → ../server/dist/index.js (ESM import() resolves
// against import.meta.url, so it works regardless of the caller's cwd).
await import('../server/dist/index.js');
