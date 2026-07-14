import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

// Minimal localStorage shim so the browser-facing modules run under node --test.
// Returns a handle whose `failWrites` flag makes setItem throw (private mode /
// quota), so migration-persistence failures are testable.
function installLocalStorage(seed: Record<string, string> = {}): { failWrites: boolean } {
  const store = new Map<string, string>(Object.entries(seed));
  const ctl = { failWrites: false };
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { if (ctl.failWrites) throw new Error('QuotaExceeded'); store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
  return ctl;
}

// Fresh module state per test: node caches ESM, so bust the query string.
async function freshModules() {
  const suffix = `?t=${test.name}-${Math.random()}`;
  const backends = await import('../src/lib/backends.ts' + suffix);
  const auth = await import('../src/lib/auth.ts' + suffix);
  return { backends, auth };
}

const origLS = (globalThis as { localStorage?: Storage }).localStorage;
afterEach(() => { (globalThis as { localStorage?: Storage }).localStorage = origLS; });

test('fresh install seeds a single LOCAL backend with empty baseUrl', async () => {
  installLocalStorage();
  const { backends } = await freshModules();
  const list = backends.loadBackends();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, backends.LOCAL_BACKEND_ID);
  assert.equal(list[0].baseUrl, '');
  assert.equal(backends.getActiveBackendId(), backends.LOCAL_BACKEND_ID);
});

test('legacy single token migrates onto the LOCAL backend', async () => {
  installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const { backends, auth } = await freshModules();
  assert.equal(backends.getActiveBackend().token, 'legacy-abc');
  // The auth facade reads through to the active backend.
  assert.equal(auth.getToken(), 'legacy-abc');
  // The legacy key is consumed (deleted) so it can't re-migrate later.
  assert.equal(localStorage.getItem('macaron_auth_token'), null);
});

test('cleared token stays cleared even if the backend list is reset', async () => {
  // Regression: migration must delete the legacy key, else clearToken() gets
  // undone by a re-migration when the backend list is later dropped.
  installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const { backends, auth } = await freshModules();
  auth.clearToken();
  assert.equal(auth.getToken(), '');
  // Simulate the backend list being wiped (e.g. a storage reset / new build):
  localStorage.removeItem('macaron_backends');
  // Re-seeding must NOT resurrect the legacy token.
  assert.equal(backends.getActiveBackend().token, undefined);
  assert.equal(auth.getToken(), '');
});

test('failed persistence keeps the legacy key so the next load retries migration', async () => {
  const ls = installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const { backends, auth } = await freshModules();
  ls.failWrites = true;
  // Migration still surfaces the token in-memory this run, but must NOT delete
  // the legacy key when the seeded list couldn't be persisted.
  assert.equal(auth.getToken(), 'legacy-abc');
  assert.equal(localStorage.getItem('macaron_auth_token'), 'legacy-abc');
  // Storage recovers → the next load completes the migration and removes the key.
  ls.failWrites = false;
  assert.equal(backends.getActiveBackend().token, 'legacy-abc');
  assert.equal(localStorage.getItem('macaron_auth_token'), null);
});

test('no legacy token → LOCAL backend has no token', async () => {
  installLocalStorage();
  const { auth } = await freshModules();
  assert.equal(auth.getToken(), '');
});

test('setToken / clearToken write to the active backend', async () => {
  installLocalStorage();
  const { backends, auth } = await freshModules();
  auth.setToken('tok-1');
  assert.equal(backends.getActiveBackend().token, 'tok-1');
  assert.equal(auth.getToken(), 'tok-1');
  auth.clearToken();
  assert.equal(backends.getActiveBackend().token, undefined);
  assert.equal(auth.getToken(), '');
});

test('apiUrl leaves relative paths untouched for the local default', async () => {
  installLocalStorage();
  const { auth } = await freshModules();
  assert.equal(auth.apiUrl('/api/health'), '/api/health');
});

test('apiUrl prefixes the active backend baseUrl; absolute URLs pass through', async () => {
  installLocalStorage();
  const { backends, auth } = await freshModules();
  backends.saveBackends([
    { id: backends.LOCAL_BACKEND_ID, label: 'Local', baseUrl: '' },
    { id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'rt' },
  ]);
  backends.setActiveBackendId('remote');
  assert.equal(auth.apiUrl('/api/health'), 'https://box.example.com/api/health');
  assert.equal(auth.apiUrl('https://other.test/x'), 'https://other.test/x');
  assert.equal(auth.getToken(), 'rt');
});

test('authHeaders reflects the active backend token', async () => {
  installLocalStorage();
  const { auth } = await freshModules();
  assert.deepEqual(auth.authHeaders(), {});
  auth.setToken('h1');
  assert.deepEqual(auth.authHeaders(), { Authorization: 'Bearer h1' });
});
