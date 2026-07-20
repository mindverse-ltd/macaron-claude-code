import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

// Isolate HOME before importing settings-store: CONFIG_PATH (and HOME) are
// captured at module load from ~/.claude/macaron-config.json, so a temp HOME
// keeps these tests from touching the real config.
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'macaron-env-'));
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_MODEL;

const store = await import('../src/lib/settings-store.js');

before(async () => {
  await store.warmSettingsCache();
});

beforeEach(() => {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_MODEL;
});

test('system provider passes through ambient ANTHROPIC_MODEL', async () => {
  await store.setActiveProvider(store.SYSTEM_PROVIDER_ID);
  process.env.ANTHROPIC_MODEL = 'Macaron-V1-Venti';
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, 'Macaron-V1-Venti');
  assert.equal(env, null); // pass-through: no env override
});

test('system provider with no ambient model yields undefined', async () => {
  await store.setActiveProvider(store.SYSTEM_PROVIDER_ID);
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, undefined);
  assert.equal(env, null);
});

test('active custom provider builds a relay env override', async () => {
  const p = await store.addProvider({ name: 'Test', endpoint: 'https://api.example.com/v1', model: 'custom-model', apiKey: 'sk-test' });
  await store.setActiveProvider(p.id);
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, 'custom-model');
  assert.ok(env);
  assert.match(env!.ANTHROPIC_BASE_URL, /\/relay\/anthropic\//);
});

test('pasted ANTHROPIC_BASE_URL overrides a stale persisted custom provider', async () => {
  const p = await store.addProvider({ name: 'Stale', endpoint: 'https://api.example.com/v1', model: 'custom-model', apiKey: 'sk-test' });
  await store.setActiveProvider(p.id);
  // Simulate the pasted `mcc` launch env block + `--model Macaron-V1-Venti`.
  process.env.ANTHROPIC_BASE_URL = 'https://mint.macaron.im';
  process.env.ANTHROPIC_MODEL = 'Macaron-V1-Venti';
  const { model, env } = store.getActiveProviderEnv();
  assert.equal(model, 'Macaron-V1-Venti'); // launch model wins
  assert.equal(env, null); // pass-through, NOT the relay
});
