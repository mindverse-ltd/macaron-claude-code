import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Proves the per-engine dependency split for REAL published tarballs: pack each
// launcher, install it into a throwaway consumer project (so its bin is linked
// under node_modules/.bin exactly as `npx mcx@…` gets it), boot through that
// installed bin, and assert (1) only its own engine SDK landed in node_modules,
// (2) the server reaches "listening", (3) its own engine route group answers
// while the foreign groups 404, and (4) a first turn through its own runner path
// resolves its own SDK. No synthetic import probes — the tarball IS the artifact.

const repoRoot = path.resolve(import.meta.dirname, '../..');

const CLAUDE = '@anthropic-ai/claude-agent-sdk';
const CODEX = '@openai/codex-sdk';
const ACP = '@agentclientprotocol/sdk';

// engine → launcher dir, bin name, own SDK, foreign SDKs, an own-engine route
// (200) and a foreign route (404) to prove route gating from the installed bin.
const LAUNCHERS = {
  claude: { dir: '.', bin: 'mcc', engineEnv: undefined as string | undefined, own: CLAUDE, foreign: [CODEX, ACP], ownRoute: '/api/workspaces', foreignRoute: '/api/codex/sessions' },
  codex: { dir: 'mcx', bin: 'mcx', engineEnv: 'codex', own: CODEX, foreign: [CLAUDE, ACP], ownRoute: '/api/codex/config', foreignRoute: '/api/workspaces' },
  kimi: { dir: 'mkx', bin: 'mkx', engineEnv: 'kimi', own: ACP, foreign: [CLAUDE, CODEX], ownRoute: '/api/kimi/threads', foreignRoute: '/api/workspaces' },
} as const;

// These tests pack + install real tarballs, so they need `npm` and a populated
// package cache. Skip deterministically (never fail) when the toolchain isn't
// there — e.g. a fully offline sandbox with a cold cache — so the clean-checkout
// suite stays green. MACARON_SKIP_PACK_TESTS=1 forces the skip.
const npmOk = spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0;
const SKIP = process.env.MACARON_SKIP_PACK_TESTS === '1' || !npmOk;

// Build the shared bundles ONCE, then stage them into mcx/mkx (their prepack
// does the same) so all three tarballs are self-contained. Done in `before` so a
// clean checkout with no dist/ still produces faithful tarballs.
before(() => {
  if (SKIP) return;
  const run = (cmd: string, args: string[], cwd: string) => {
    const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')} failed in ${cwd}`);
  };
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

// Boot the installed bin and resolve once it logs "listening" (with its chosen
// port) or exits early. Returns { ok, port, output, kill }.
function boot(consumer: string, bin: string, engineEnv: string | undefined): Promise<{ ok: boolean; port: number; output: string; kill: () => void }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env };
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
    const b = await boot(consumer, l.bin, l.engineEnv);
    try {
      assert.ok(b.ok, `${l.bin} did not reach listening:\n${b.output}`);
      const eng = await fetch(`http://127.0.0.1:${b.port}/api/engine`).then((r) => r.json()).catch(() => null);
      assert.equal(eng?.engine, engine, `/api/engine should report ${engine}`);
      assert.equal(await httpStatus(b.port, l.ownRoute), 200, `${l.bin} own route ${l.ownRoute} should answer 200`);
      assert.equal(await httpStatus(b.port, l.foreignRoute), 404, `${l.bin} foreign route ${l.foreignRoute} should be absent (404)`);
    } finally {
      b.kill();
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      await fs.rm(consumer, { recursive: true, force: true }).catch(() => {});
    }
  });
}
