import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const pathToFileURLString = (p: string) => pathToFileURL(p).href;

// Proves the per-engine dependency split: each launcher boots the shared
// `server/dist/index.js` while the OTHER engines' SDKs are absent, and only
// reaches for its own SDK lazily on first use. The pnpm workspace hoists every
// SDK into a shared node_modules, so we can't uninstall packages mid-suite —
// instead a loader `resolve` hook makes the forbidden SDK specifiers throw
// ERR_MODULE_NOT_FOUND, exactly what a tarball that never declared them would do.

const repoRoot = path.resolve(import.meta.dirname, '../..');
const bundle = path.join(repoRoot, 'server', 'dist', 'index.js');

const CLAUDE = '@anthropic-ai/claude-agent-sdk';
const CODEX = '@openai/codex-sdk';
const ACP = '@agentclientprotocol/sdk';

// engine → { own SDK it loads lazily, foreign SDKs its tarball must NOT ship }.
// mkx (kimi) drives the Kimi CLI over ACP; mcc (claude) and mcx (codex) load
// their named SDKs.
const ENGINES = {
  claude: { launcher: '.', own: CLAUDE, foreign: [CODEX, ACP] },
  codex: { launcher: 'mcx', own: CODEX, foreign: [CLAUDE, ACP] },
  kimi: { launcher: 'mkx', own: ACP, foreign: [CLAUDE, CODEX] },
} as const;

// A clean checkout has no committed server/dist (it's .gitignore'd), so build it
// once before the boot tests — the whole point is proving the SHIPPED bundle is
// engine-clean, and every launcher ships this same file.
before(() => {
  if (existsSync(bundle)) return;
  const r = spawnSync('bun', ['build', 'src/index.ts', '--target=node', '--format=esm', '--outfile=dist/index.js', '--packages=external'], {
    cwd: path.join(repoRoot, 'server'),
    stdio: 'inherit',
  });
  assert.equal(r.status, 0, 'failed to bundle server/dist/index.js for the isolation tests');
});

// Writes the loader bootstrap that makes `blocked` specifiers unresolvable. The
// blocking `resolve` hook must run on the loader thread via module.register — an
// `--import`ed module's exported `resolve` is NOT picked up as a hook (it just
// runs for side effects) — so we register a hooks module from a tiny bootstrap.
function writeBlockBootstrap(dir: string, blocked: string[]): string {
  const hooks = path.join(dir, 'block-hooks.mjs');
  writeFileSync(hooks, `
    const blocked = new Set(${JSON.stringify(blocked)});
    export async function resolve(specifier, context, next) {
      if (blocked.has(specifier)) {
        const err = new Error(\`Cannot find package '\${specifier}' (blocked for test)\`);
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      }
      return next(specifier, context);
    }
  `);
  const bootstrap = path.join(dir, 'register.mjs');
  writeFileSync(bootstrap, `
    import { register } from 'node:module';
    import { pathToFileURL } from 'node:url';
    register(${JSON.stringify(pathToFileURLString(hooks))}, pathToFileURL('./'));
  `);
  return bootstrap;
}

// Boots the bundle with `blocked` SDKs made unresolvable and `MACARON_ENGINE`
// set, then resolves once the server logs it is listening (success) or the
// child exits early (failure — e.g. a boot-path import of a blocked SDK).
function bootWithBlocked(engine: string | undefined, blocked: string[]): Promise<{ ok: boolean; output: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engine-iso-'));
  const bootstrap = writeBlockBootstrap(dir, blocked);

  const env = { ...process.env };
  delete env.MACARON_ENGINE;
  if (engine) env.MACARON_ENGINE = engine;
  // A random high port and a throwaway HOME keep parallel boots off each other
  // and off the real ~/.claude config.
  env.MACARON_PORT = String(20000 + Math.floor(Math.random() * 20000));
  env.HOME = dir;

  const child = spawn(process.execPath, ['--import', bootstrap, bundle], { cwd: repoRoot, env });

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ ok, output });
    };
    const onData = (b: Buffer) => {
      output += b.toString('utf8');
      if (output.includes('macaron server listening')) done(true);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => done(false)); // exited before "listening" → boot failed
    const timer = setTimeout(() => done(false), 15000);
  });
}

// Simulates the FIRST engine turn: a fresh process with the foreign SDKs blocked
// (a per-engine install) `await import()`s each SDK, exactly as the runner does
// lazily on first use. Returns which specifiers resolved.
function firstUseImport(blocked: string[], specifiers: string[]): { specifier: string; ok: boolean }[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engine-import-'));
  const bootstrap = writeBlockBootstrap(dir, blocked);
  // Bare specifiers resolve from the importing file's directory, so the probe
  // must live under server/ (which has every SDK installed for dev) — a tmp-dir
  // probe would fail to resolve even the own SDK. Write it beside the test tree.
  const probe = path.join(repoRoot, 'server', `.engine-import-probe-${path.basename(dir)}.mjs`);
  writeFileSync(probe, `
    const specs = ${JSON.stringify(specifiers)};
    const out = [];
    for (const s of specs) {
      try { await import(s); out.push({ specifier: s, ok: true }); }
      catch { out.push({ specifier: s, ok: false }); }
    }
    process.stdout.write(JSON.stringify(out));
  `);
  try {
    const r = spawnSync(process.execPath, ['--import', bootstrap, probe], { cwd: path.join(repoRoot, 'server'), encoding: 'utf8' });
    assert.equal(r.status, 0, `import probe crashed:\n${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(probe, { force: true });
  }
}

for (const [engine, { launcher, own, foreign }] of Object.entries(ENGINES)) {
  const name = launcher === '.' ? 'mcc' : launcher; // mcc is the root package
  const macaronEngine = engine === 'claude' ? undefined : engine;

  test(`${name} (${engine}) boots without the other engines' SDKs installed`, async () => {
    const { ok, output } = await bootWithBlocked(macaronEngine, [...foreign]);
    assert.ok(ok, `${engine} boot did not reach listening:\n${output}`);
  });

  test(`${name} (${engine}) lazily imports only its own SDK on first use`, () => {
    const results = firstUseImport([...foreign], [own, ...foreign]);
    const byName = Object.fromEntries(results.map((r) => [r.specifier, r.ok]));
    assert.equal(byName[own], true, `${engine}'s own SDK ${own} must resolve on first use`);
    for (const f of foreign) assert.equal(byName[f], false, `${engine} must not resolve foreign SDK ${f}`);
  });

  test(`${name} tarball declares only its own engine SDK`, () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, launcher, 'package.json'), 'utf8'));
    const deps = pkg.dependencies || {};
    assert.ok(deps[own], `${name} must declare its own SDK ${own}`);
    for (const f of foreign) assert.ok(!deps[f], `${name} must NOT declare foreign SDK ${f}`);
    assert.ok((pkg.files || []).includes('server/dist/index.js'), `${name} must ship the server bundle`);
  });
}
