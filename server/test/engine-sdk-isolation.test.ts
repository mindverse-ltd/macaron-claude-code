import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Proves the per-engine dependency split for REAL published tarballs: pack each
// launcher, install it into a throwaway consumer project (so its bin is linked
// under node_modules/.bin exactly as `npx mcx@…` gets it), boot through that
// installed bin, and assert (1) only its own engine SDK landed in node_modules,
// (2) the server reaches "listening", (3) its own engine route group answers
// while the foreign groups 404, and (4) a real first turn POSTed through its own
// runner drives its lazy-imported SDK — mcc streams meta/delta/done off a local
// Anthropic stub, mcx/mkx reach their own SDK and surface the deterministic
// downstream failure of a `/bin/false` engine binary — with NO ERR_MODULE_NOT_FOUND
// anywhere in the stream. That last case is the point: routes 200/404 never touch
// the runner imports, so only a posted turn proves the own SDK actually loads.
// No synthetic import probes — the tarball IS the artifact.

const repoRoot = path.resolve(import.meta.dirname, '../..');

const CLAUDE = '@anthropic-ai/claude-agent-sdk';
const CODEX = '@openai/codex-sdk';
const ACP = '@agentclientprotocol/sdk';

// engine → launcher dir, bin name, own SDK, foreign SDKs, an own-engine route
// (200) and a foreign route (404) to prove route gating, plus how to POST a real
// first turn through its own runner: the endpoint to hit and the SSE event that
// proves the own SDK's lazy import resolved (`done` off the Anthropic stub for
// claude; the runner-level `error` a `/bin/false` engine binary yields for the
// spawn-based codex/kimi — either way the runner ran, so the import loaded).
const LAUNCHERS = {
  claude: { dir: '.', bin: 'mcc', engineEnv: undefined as string | undefined, own: CLAUDE, foreign: [CODEX, ACP], ownRoute: '/api/workspaces', foreignRoute: '/api/codex/sessions', turnRoute: '/api/workspaces/probe/sessions', expect: 'done' as 'done' | 'error' },
  codex: { dir: 'mcx', bin: 'mcx', engineEnv: 'codex', own: CODEX, foreign: [CLAUDE, ACP], ownRoute: '/api/codex/config', foreignRoute: '/api/workspaces', turnRoute: '/api/codex/threads', expect: 'error' as 'done' | 'error' },
  kimi: { dir: 'mkx', bin: 'mkx', engineEnv: 'kimi', own: ACP, foreign: [CLAUDE, CODEX], ownRoute: '/api/kimi/threads', foreignRoute: '/api/workspaces', turnRoute: '/api/kimi/threads', expect: 'error' as 'done' | 'error' },
} as const;

// These tests pack + install real tarballs, so they need `npm` and a populated
// package cache. Locally we skip deterministically (never fail) when the
// toolchain isn't there — e.g. a fully offline sandbox with a cold cache — so
// the clean-checkout suite stays green; MACARON_SKIP_PACK_TESTS=1 forces it.
// Under CI the coverage is MANDATORY: the skip env is ignored and a missing
// toolchain is a hard failure, so a green pipeline can never hide absent pack
// coverage (the whole point of this suite).
const CI = !!process.env.CI;
const npmOk = spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0;
if (CI) assert.ok(npmOk, 'CI requires npm for mandatory pack coverage, but `npm --version` failed');
const SKIP = !CI && (process.env.MACARON_SKIP_PACK_TESTS === '1' || !npmOk);

// Build the shared bundles ONCE, then stage them into mcx/mkx (their prepack
// does the same) so all three tarballs are self-contained. Done in `before` so a
// clean checkout with no dist/ still produces faithful tarballs.
before(() => {
  if (SKIP) return;
  const run = (cmd: string, args: string[], cwd: string) => {
    const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')} failed in ${cwd}`);
  };
  // @macaron/shared must be built first — both the server bundle and the web
  // build resolve it from its dist (a clean CI checkout has none). Mirrors the
  // order the root `prepack` runs in.
  if (!existsSync(path.join(repoRoot, 'shared', 'dist', 'index.js'))) {
    run('pnpm', ['--filter', '@macaron/shared', 'build'], repoRoot);
  }
  if (!existsSync(path.join(repoRoot, 'server', 'dist', 'index.js'))) {
    run('bun', ['build', 'src/index.ts', '--target=node', '--format=esm', '--outfile=dist/index.js', '--packages=external'], path.join(repoRoot, 'server'));
  }
  if (!existsSync(path.join(repoRoot, 'web', 'dist', 'index.html'))) {
    run('pnpm', ['--filter', '@macaron/web', 'build'], repoRoot);
  }
  // Stage the shared outputs into mcx/mkx (mirrors their scripts/stage.mjs).
  for (const dir of ['mcx', 'mkx']) {
    run('node', ['scripts/stage.mjs'], path.join(repoRoot, dir));
  }
}, { timeout: 180_000 });

// pack the launcher (scripts skipped — bundles are already staged) into `dest`,
// returning the tarball path.
function pack(dir: string, dest: string): string {
  const r = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dest], { cwd: path.join(repoRoot, dir), encoding: 'utf8' });
  assert.equal(r.status, 0, `npm pack failed for ${dir}:\n${r.stderr}`);
  const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, `no tarball produced for ${dir}`);
  return path.join(dest, tgz);
}

// Install `tarball` as the sole dependency of a fresh consumer project, so its
// bin lands in node_modules/.bin. Scripts run (node-pty needs its native build);
// --prefer-offline keeps it fast when the cache is warm.
function install(tarball: string): string {
  const consumer = mkdtempSync(path.join(os.tmpdir(), 'macaron-consumer-'));
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  const r = spawnSync('npm', ['install', tarball, '--no-audit', '--no-fund', '--prefer-offline'], { cwd: consumer, encoding: 'utf8' });
  assert.equal(r.status, 0, `npm install failed:\n${r.stderr}`);
  return consumer;
}

// Ask the OS for a free ephemeral port (bind :0, read it back, release). Far
// safer than a blind random pick in a fixed range — the kernel won't hand out a
// port it's already using. A tiny TOCTOU window remains between release and the
// child's bind, which boot()'s EADDRINUSE retry covers.
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Boot the installed bin and resolve once it logs "listening" (with its chosen
// port) or exits early. Returns { ok, port, output, kill }. Retries on a lost
// port race (EADDRINUSE) with a freshly reserved port so this required
// pre-publish gate stays deterministic.
async function boot(consumer: string, bin: string, engineEnv: string | undefined, extraEnv: Record<string, string> = {}): Promise<{ ok: boolean; port: number; output: string; kill: () => void }> {
  for (let attempt = 0; ; attempt++) {
    const port = await reservePort();
    const res = await bootOnce(consumer, bin, engineEnv, extraEnv, port);
    if (res.ok || !/EADDRINUSE/.test(res.output) || attempt >= 4) return res;
    res.kill(); // lost the port between reserve and bind — try a fresh one
  }
}

function bootOnce(consumer: string, bin: string, engineEnv: string | undefined, extraEnv: Record<string, string>, port: number): Promise<{ ok: boolean; port: number; output: string; kill: () => void }> {
  const env = { ...process.env, ...extraEnv };
  delete env.MACARON_ENGINE;
  if (engineEnv) env.MACARON_ENGINE = engineEnv;
  env.MACARON_PORT = String(port);
  env.HOME = path.join(consumer, 'home');
  const child = spawn(path.join(consumer, 'node_modules', '.bin', bin), [], { cwd: consumer, env });
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const done = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok, port, output, kill }); };
    const onData = (b: Buffer) => { output += b.toString('utf8'); if (output.includes('listening')) done(true); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => done(false));
    const timer = setTimeout(() => done(false), 20_000);
  });
}

async function httpStatus(port: number, route: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`).catch(() => null);
  return res ? res.status : 0;
}

// A deterministic local Anthropic endpoint. The claude-agent-sdk's spawned CLI
// probes /v1/models etc. at startup (any 2xx satisfies them) then streams
// POST /v1/messages; we answer with a minimal valid message-stream SSE carrying
// STUB_TEXT so mcc's first turn resolves to a real delta+done without a network.
const STUB_TEXT = 'macaron-isolation-ok';
function startAnthropicStub(): Promise<{ url: string; close: () => void }> {
  const sse = (obj: unknown) => `event: ${(obj as { type: string }).type}\ndata: ${JSON.stringify(obj)}\n\n`;
  const messageObj = () => ({ id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub', content: [{ type: 'text', text: STUB_TEXT }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && /\/messages$/.test((req.url || '').split('?')[0])) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let streaming = true;
        try { streaming = !!JSON.parse(raw || '{}').stream; } catch { /* default to streaming */ }
        if (!streaming) {
          // Non-streaming path: a single JSON message object.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(messageObj()));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse({ type: 'message_start', message: { ...messageObj(), content: [], stop_reason: null } }));
        res.write(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        res.write(sse({ type: 'ping' }));
        res.write(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: STUB_TEXT } }));
        res.write(sse({ type: 'content_block_stop', index: 0 }));
        res.write(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }));
        res.write(sse({ type: 'message_stop' }));
        res.end();
      });
      return;
    }
    // Every startup probe just needs any 2xx.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${p}`, close: () => server.close() });
    });
  });
}

// POST a real first turn and drain the SSE reply until `done` (or timeout),
// returning the raw stream text. This is the ONLY probe that drives a runner's
// lazy SDK import — routes 200/404 never reach it.
async function postTurn(port: number, route: string, cwd: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi', cwd }),
  }).catch(() => null);
  if (!res?.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  const deadline = new Promise<void>((r) => setTimeout(r, 30_000));
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      if (out.includes('"type":"done"') || out.includes('[DONE]')) break;
    }
  })();
  await Promise.race([read, deadline]);
  try { await reader.cancel(); } catch { /* already closed */ }
  return out;
}

// True when a first-turn SSE stream proves the runner's own lazy SDK import
// resolved: no module-resolution error, plus the engine-specific success signal
// (claude streams the stub delta+done; codex/kimi reach their runner and report
// the deterministic `/bin/false` downstream failure). The negative control below
// removes the own SDK and asserts this flips to false — the module error appears.
const MODULE_ERR = /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/;
function firstTurnProvesOwnSdk(turn: string, expect: 'done' | 'error'): boolean {
  if (MODULE_ERR.test(turn)) return false;
  if (expect === 'done') return /"type":"delta"/.test(turn) && new RegExp(STUB_TEXT).test(turn) && /"type":"done"/.test(turn);
  return /"type":"error"|"type":"done"/.test(turn);
}

// True if `node_modules/<pkg>` exists in the consumer install.
function installed(consumer: string, pkg: string): boolean {
  return existsSync(path.join(consumer, 'node_modules', ...pkg.split('/')));
}

for (const [engine, l] of Object.entries(LAUNCHERS)) {
  test(`${l.bin} (${engine}): packs, installs with only its own SDK, and boots through its installed bin`, { timeout: 180_000, skip: SKIP && 'npm/package cache unavailable' }, async () => {
    const dest = mkdtempSync(path.join(os.tmpdir(), `macaron-pack-${l.bin}-`));
    const tarball = pack(l.dir, dest);
    const consumer = install(tarball);

    // (1) Only its own engine SDK is present; the foreign ones never installed.
    assert.ok(installed(consumer, l.own), `${l.bin} must install its own SDK ${l.own}`);
    for (const f of l.foreign) assert.ok(!installed(consumer, f), `${l.bin} must NOT install foreign SDK ${f}`);

    // (2)-(3) Boots through the installed bin; own route answers, foreign 404s.
    // For claude, route the SDK at a local Anthropic stub so its first turn
    // completes deterministically offline; codex/kimi spawn a `/bin/false`
    // engine binary so their first turn reaches the own SDK then fails downstream.
    const stub = engine === 'claude' ? await startAnthropicStub() : null;
    const falseBin = spawnSync('sh', ['-c', 'command -v false'], { encoding: 'utf8' }).stdout.trim() || '/bin/false';
    const extraEnv: Record<string, string> =
      engine === 'claude' ? { ANTHROPIC_BASE_URL: stub!.url, ANTHROPIC_AUTH_TOKEN: 'stub', ANTHROPIC_API_KEY: 'stub' } :
      // Force the SDK transport (not the default app-server bridge) so the POST
      // actually reaches `import('@openai/codex-sdk')` in codex-runner — that
      // lazy import is the thing this test exists to prove.
      engine === 'codex' ? { MACARON_CODEX_PATH: falseBin, MACARON_CODEX_TRANSPORT: 'sdk' } :
      { MACARON_KIMI_PATH: falseBin };
    const b = await boot(consumer, l.bin, l.engineEnv, extraEnv);
    try {
      assert.ok(b.ok, `${l.bin} did not reach listening:\n${b.output}`);
      const eng = await fetch(`http://127.0.0.1:${b.port}/api/engine`).then((r) => r.json()).catch(() => null);
      assert.equal(eng?.engine, engine, `/api/engine should report ${engine}`);
      assert.equal(await httpStatus(b.port, l.ownRoute), 200, `${l.bin} own route ${l.ownRoute} should answer 200`);
      assert.equal(await httpStatus(b.port, l.foreignRoute), 404, `${l.bin} foreign route ${l.foreignRoute} should be absent (404)`);

      // (4) POST a real first turn: this is what actually drives the runner's
      // lazy `import('<own-sdk>')`. A missing/broken own SDK would surface as
      // ERR_MODULE_NOT_FOUND in the stream instead of the engine's own output.
      const turn = await postTurn(b.port, l.turnRoute, consumer);
      assert.ok(firstTurnProvesOwnSdk(turn, l.expect), `${l.bin} first turn must import its own SDK and reach the ${l.expect} signal:\n${turn}`);
    } finally {
      b.kill();
      stub?.close();
    }

    // (5) Negative control: remove ONLY the own SDK and repeat the first turn.
    // The same probe must now FAIL — proving the assertion above is load-bearing
    // and not silently passing on a path that never touches the SDK.
    await fs.rm(path.join(consumer, 'node_modules', ...l.own.split('/')), { recursive: true, force: true });
    const nstub = engine === 'claude' ? await startAnthropicStub() : null;
    const nEnv = { ...extraEnv, ...(nstub ? { ANTHROPIC_BASE_URL: nstub.url } : {}) };
    const nb = await boot(consumer, l.bin, l.engineEnv, nEnv);
    try {
      // Lazy imports mean the server still boots; the failure surfaces on the
      // turn. mcc/mcx catch the import and emit a stream `error` carrying
      // ERR_MODULE_NOT_FOUND; mkx's ACP import sits before its try so the turn
      // simply never reaches its runner completion. Either way the success
      // predicate must flip to false — that's the load-bearing signal.
      assert.ok(nb.ok, `${l.bin} negative control should still boot (imports are lazy):\n${nb.output}`);
      const nturn = await postTurn(nb.port, l.turnRoute, consumer);
      assert.ok(!firstTurnProvesOwnSdk(nturn, l.expect), `${l.bin} negative control must FAIL its first turn once ${l.own} is removed, but it passed:\n${nturn}`);
    } finally {
      nb.kill();
      nstub?.close();
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      await fs.rm(consumer, { recursive: true, force: true }).catch(() => {});
    }
  });
}
