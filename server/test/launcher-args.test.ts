import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const launchers = [
  path.join(repoRoot, 'bin', 'mcc.mjs'),
  path.join(repoRoot, 'mcx', 'bin', 'mcx.mjs'),
];

function runLauncher(launcher: string, args: string[]) {
  const env = { ...process.env };
  delete env.MACARON_ALLOWED_ORIGINS;
  delete env.MACARON_ALLOW_HOSTED;
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

for (const launcher of launchers) {
  const name = path.basename(launcher);

  test(`${name} rejects an empty --allow-origin value`, () => {
    const result = runLauncher(launcher, ['--allow-origin=']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--allow-origin requires a non-empty value/);
  });

  test(`${name} rejects an empty space-form --allow-origin value`, () => {
    const result = runLauncher(launcher, ['--allow-origin', '   ']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--allow-origin requires a non-empty value/);
  });

  test(`${name} rejects an inline value on --allow-hosted`, () => {
    const result = runLauncher(launcher, ['--allow-hosted=false']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--allow-hosted does not take a value/);
  });
}

// --model is mcc-only (Claude launch model → ANTHROPIC_MODEL, mirrors `claude --model X`).
const mcc = path.join(repoRoot, 'bin', 'mcc.mjs');

test('mcc lists --model in --help', () => {
  const result = runLauncher(mcc, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--model <model>/);
});

test('mcc rejects --model with no value', () => {
  const result = runLauncher(mcc, ['--model']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model requires a value/);
});

test('mcc rejects an empty inline --model value', () => {
  const result = runLauncher(mcc, ['--model=']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model requires a non-empty value/);
});

test('mcc rejects a whitespace-only --model value', () => {
  const result = runLauncher(mcc, ['--model', '   ']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model requires a non-empty value/);
});

test('mcc rejects --model swallowing the next flag as its value', () => {
  const result = runLauncher(mcc, ['--model', '--port']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model requires a value/);
});
