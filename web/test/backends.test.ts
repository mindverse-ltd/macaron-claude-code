import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Backend } from '../src/lib/backends.ts';

// Minimal localStorage shim so the browser-facing modules run under node --test.
// `failWrites` = private mode (every setItem throws). `quotaFull` = a full quota
// where only writes that GROW a key throw — shrinking/clearing still persists,
// which is exactly what a per-backend token clear does.
function installLocalStorage(seed: Record<string, string> = {}): { failWrites: boolean; quotaFull: boolean; failReads: boolean } {
  const store = new Map<string, string>(Object.entries(seed));
  const ctl = { failWrites: false, quotaFull: false, failReads: false };
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => {
      if (ctl.failReads) throw new Error('SecurityError');
      return store.has(k) ? store.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if (ctl.failWrites) throw new Error('SecurityError');
      if (ctl.quotaFull && String(v).length > (store.get(k)?.length ?? 0)) throw new Error('QuotaExceeded');
      store.set(k, String(v));
    },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
  return ctl;
}

// auth.ts imports backends.ts internally, so both must resolve to the SAME
// module instance for the in-memory cache to be shared (as it is in the browser).
// Import without a query string and reset the cache per test instead of busting
// the ESM cache — that reset simulates a fresh page load.
async function freshModules() {
  const backends = await import('../src/lib/backends.ts');
  const auth = await import('../src/lib/auth.ts');
  backends.__resetForTests();
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
  // Simulate the backend list being wiped AND the page reloaded (cache dropped):
  localStorage.removeItem('macaron_backends');
  backends.__resetForTests();
  // Re-seeding must NOT resurrect the legacy token.
  assert.equal(backends.getActiveBackend().token, undefined);
  assert.equal(auth.getToken(), '');
});

test('failed migration is retried automatically once storage recovers', async () => {
  const ls = installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const { backends, auth } = await freshModules();
  ls.failWrites = true;
  // Migration surfaces the token in-memory this run, but must NOT delete the
  // legacy key while the seeded list can't be persisted.
  assert.equal(auth.getToken(), 'legacy-abc');
  assert.equal(localStorage.getItem('macaron_auth_token'), 'legacy-abc');
  // Storage recovers: the next operation flushes the deferred migration in this
  // same session — the seeded registry persists and the legacy key is removed,
  // WITHOUT waiting for a reload.
  ls.failWrites = false;
  backends.loadBackends();
  assert.equal(localStorage.getItem('macaron_auth_token'), null);
  const persisted = JSON.parse(localStorage.getItem('macaron_backends')!) as Array<{ token?: string }>;
  assert.equal(persisted[0].token, 'legacy-abc');
  // A fresh reload reads the migrated registry back; the old key does not re-migrate.
  backends.__resetForTests();
  assert.equal(backends.getActiveBackend().token, 'legacy-abc');
  assert.equal(localStorage.getItem('macaron_auth_token'), null);
});

test('explicit clear during a write failure invalidates the legacy source on recovery', async () => {
  // fail → clear → recover: a clear during a write-failure window takes effect
  // in-memory immediately, and the legacy key is dropped automatically once
  // storage recovers — WITHOUT the caller having to clear a second time.
  const ls = installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const { backends, auth } = await freshModules();
  ls.failWrites = true;           // registry can't persist...
  auth.clearToken();              // ...but the user explicitly clears
  // In-memory clear is authoritative even before the legacy key can be removed.
  assert.equal(auth.getToken(), '');
  assert.equal(backends.getActiveBackend().token, undefined);
  // Storage recovers: the very next operation flushes the deferred removal —
  // no second clearToken() needed.
  ls.failWrites = false;
  backends.loadBackends();
  assert.equal(localStorage.getItem('macaron_auth_token'), null);
  // And a fresh reload after that stays cleared, not re-migrated.
  localStorage.removeItem('macaron_backends');
  backends.__resetForTests();
  assert.equal(backends.getActiveBackend().token, undefined);
  assert.equal(auth.getToken(), '');
});

test('per-backend clear persists under a full quota (shrinking write succeeds)', async () => {
  // A token clear only ever shrinks the registry, so it persists even when the
  // quota is full — no need to delete the whole registry. Reload reads it back.
  const persisted = JSON.stringify([{ id: 'local', label: 'Local', baseUrl: '', token: 'persisted-tok' }]);
  const ls = installLocalStorage({ macaron_backends: persisted });
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'persisted-tok');

  ls.quotaFull = true;       // quota is full: growing writes fail, shrinking ones don't
  auth.clearToken();         // clearing shrinks the registry → persists
  assert.equal(auth.getToken(), '');
  const persistedNow = JSON.parse(localStorage.getItem('macaron_backends')!) as Array<{ token?: string }>;
  assert.equal(persistedNow.some((b) => b.token), false);
  // A reload (even under the still-full quota) reads the cleared registry back.
  backends.__resetForTests();
  assert.equal(auth.getToken(), '');
  assert.equal(backends.getActiveBackend().token, undefined);
});

test('private-mode clear is authoritative in-session and persists once storage recovers', async () => {
  // Full private mode (every setItem throws): the clear can't persist, but the
  // in-memory cache is authoritative for the session, and flush() persists it as
  // soon as storage recovers — WITHOUT deleting other backends' config.
  const persisted = JSON.stringify([
    { id: 'local', label: 'Local', baseUrl: '', token: 'persisted-tok' },
    { id: 'remote', label: 'Box', baseUrl: 'https://box.example.com' }, // tokenless REMOTE config
  ]);
  const ls = installLocalStorage({ macaron_backends: persisted });
  const { backends, auth } = await freshModules();
  ls.failWrites = true;
  auth.clearToken();
  assert.equal(auth.getToken(), '');
  assert.equal(backends.getActiveBackend().token, undefined);

  ls.failWrites = false;     // storage recovers
  backends.loadBackends();   // deferred flush persists the cleared registry
  const persistedNow = JSON.parse(localStorage.getItem('macaron_backends')!) as Backend[];
  assert.equal(persistedNow.find((b) => b.id === 'local')?.token, undefined);
  // The tokenless REMOTE config must survive — never dropped as throwaway state.
  assert.equal(persistedNow.find((b) => b.id === 'remote')?.baseUrl, 'https://box.example.com');
});

test('registry persisted but legacy removal failed: reload reconciles, reset does not re-migrate', async () => {
  // The registry write succeeds while the legacy-key removal fails, leaving a
  // stale legacy key behind. Loading the persisted registry must reconcile it
  // (delete the leftover), so a later registry reset can't re-migrate the token.
  const migrated = JSON.stringify([{ id: 'local', label: 'Local', baseUrl: '', token: 'migrated-tok' }]);
  installLocalStorage({ macaron_backends: migrated, macaron_auth_token: 'legacy-abc' });
  const { backends } = await freshModules();
  // First load reads the persisted registry and reconciles the stale legacy key.
  assert.equal(backends.getActiveBackend().token, 'migrated-tok');
  assert.equal(localStorage.getItem('macaron_auth_token'), null);
  // Even if the registry is later wiped, there's nothing left to re-migrate.
  localStorage.removeItem('macaron_backends');
  backends.__resetForTests();
  assert.equal(backends.getActiveBackend().token, undefined);
});

test('clearing one backend token leaves the other backends and their tokens intact', async () => {
  const persisted = JSON.stringify([
    { id: 'local', label: 'Local', baseUrl: '', token: 'local-tok' },
    { id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'remote-tok' },
  ]);
  installLocalStorage({ macaron_backends: persisted, macaron_active_backend: 'remote' });
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'remote-tok');   // active = remote
  auth.clearToken();                             // clears ONLY remote
  const list = backends.loadBackends();
  assert.equal(list.find((b) => b.id === 'remote')?.token, undefined);
  assert.equal(list.find((b) => b.id === 'local')?.token, 'local-tok'); // untouched
});

test('a tokenless REMOTE backend is preserved through a LOCAL clear', async () => {
  const persisted = JSON.stringify([
    { id: 'local', label: 'Local', baseUrl: '', token: 'local-tok' },
    { id: 'remote', label: 'Box', baseUrl: 'https://box.example.com' }, // no token, real config
  ]);
  installLocalStorage({ macaron_backends: persisted });
  const { backends, auth } = await freshModules();
  auth.clearToken();                             // active defaults to local
  const list = backends.loadBackends();
  assert.equal(list.length, 2);
  const remote = list.find((b) => b.id === 'remote');
  assert.equal(remote?.baseUrl, 'https://box.example.com');
  assert.equal(remote?.token, undefined);
});

test('stored registry missing LOCAL absorbs the un-migrated legacy token, not drops it', async () => {
  // A stored list without LOCAL + a still-present legacy key means migration never
  // ran. Rebuilding LOCAL must fold the legacy token in, or the sole credential is lost.
  const stored = JSON.stringify([{ id: 'remote', label: 'Box', baseUrl: 'https://box.example.com' }]);
  installLocalStorage({ macaron_backends: stored, macaron_auth_token: 'legacy-abc' });
  const { backends } = await freshModules();
  const list = backends.loadBackends();
  const local = list.find((b) => b.id === backends.LOCAL_BACKEND_ID);
  assert.equal(local?.token, 'legacy-abc');      // absorbed, not dropped
  assert.equal(list.find((b) => b.id === 'remote')?.baseUrl, 'https://box.example.com');
  // Reconstructed list persisted and legacy consumed; a reset can't re-migrate.
  assert.equal(localStorage.getItem('macaron_auth_token'), null);
  localStorage.removeItem('macaron_backends');
  backends.__resetForTests();
  assert.equal(backends.getActiveBackend().token, undefined);
});

test('legacy-only migration clear persists under a full quota (no stored value to shrink)', async () => {
  // Blocker 1: on first run the seeded registry is written fresh — a clear can't
  // "shrink" a value that was never stored. Under a full quota the seeded write
  // fails, but an explicit clear drops the legacy key so the reload seeds a fresh
  // tokenless LOCAL: the cleared state survives without re-migrating the old token.
  const ls = installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const { backends, auth } = await freshModules();
  ls.quotaFull = true;             // seeded registry can't be written fresh
  assert.equal(auth.getToken(), 'legacy-abc'); // surfaced in-memory
  auth.clearToken();               // explicit clear
  assert.equal(auth.getToken(), '');
  // The legacy key is gone even though the registry never persisted.
  assert.equal(localStorage.getItem('macaron_auth_token'), null);
  // A fresh reload (still quota-full) seeds a clean tokenless LOCAL — not the old token.
  backends.__resetForTests();
  assert.equal(auth.getToken(), '');
  assert.equal(backends.getActiveBackend().token, undefined);
});

test('stored-LOCAL legacy removal failure is retried on the next load', async () => {
  // Blocker 2: the stored-with-LOCAL fast path removes the stale legacy key, but if
  // that removal fails it must defer via pendingLegacyRemoval — else the populated
  // cache makes later loads skip the reconcile and the key re-migrates on reset.
  const migrated = JSON.stringify([{ id: 'local', label: 'Local', baseUrl: '', token: 'migrated-tok' }]);
  installLocalStorage({ macaron_backends: migrated, macaron_auth_token: 'legacy-abc' });
  const { backends } = await freshModules();
  // Force the removal to fail by making removeItem throw for this one load.
  const realRemove = localStorage.removeItem.bind(localStorage);
  (localStorage as unknown as { removeItem: (k: string) => void }).removeItem = () => { throw new Error('fail'); };
  backends.loadBackends();         // reconcile attempt fails → deferred
  assert.equal(localStorage.getItem('macaron_auth_token'), 'legacy-abc');
  (localStorage as unknown as { removeItem: (k: string) => void }).removeItem = realRemove;
  backends.loadBackends();         // cache-hit path retries the deferred removal
  assert.equal(localStorage.getItem('macaron_auth_token'), null);
  // Reset can't re-migrate: the legacy key is gone.
  localStorage.removeItem('macaron_backends');
  backends.__resetForTests();
  assert.equal(backends.getActiveBackend().token, undefined);
});

test('cross-tab clear is adopted, not clobbered, on the next load', async () => {
  // Blocker 3: another tab clears a token and rewrites the registry. Our module
  // cache must revalidate against storage and adopt the newer value instead of
  // overwriting it with a stale in-memory copy on the next save.
  const persisted = JSON.stringify([{ id: 'local', label: 'Local', baseUrl: '', token: 'tok-1' }]);
  installLocalStorage({ macaron_backends: persisted });
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'tok-1');           // cache populated
  // Simulate another tab clearing the token directly in storage.
  localStorage.setItem('macaron_backends', JSON.stringify([{ id: 'local', label: 'Local', baseUrl: '' }]));
  // Next load revalidates and adopts the cleared registry.
  const list = backends.loadBackends();
  assert.equal(list.find((b) => b.id === 'local')?.token, undefined);
  assert.equal(auth.getToken(), '');
  // A subsequent save (e.g. adding a backend) must not resurrect the old token.
  backends.saveBackends([...list, { id: 'remote', label: 'Box', baseUrl: 'https://box.example.com' }]);
  const persistedNow = JSON.parse(localStorage.getItem('macaron_backends')!) as Backend[];
  assert.equal(persistedNow.find((b) => b.id === 'local')?.token, undefined);
  assert.equal(persistedNow.find((b) => b.id === 'remote')?.baseUrl, 'https://box.example.com');
});

test('REMOTE-only stored registry: clearing the active REMOTE token persists under a full quota', async () => {
  // Blocker A: a stored [remote] list has no LOCAL. Loading rebuilds [local, remote]
  // in-memory, but the SYNTHETIC default LOCAL isn't persisted -- the stored shape
  // stays [remote]. So clearing REMOTE only ever shrinks the stored value and
  // persists even when the quota is full; a reload does NOT resurrect the token.
  const stored = JSON.stringify([{ id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'remote-tok' }]);
  const ls = installLocalStorage({ macaron_backends: stored, macaron_active_backend: 'remote' });
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'remote-tok');   // active = remote
  ls.quotaFull = true;                            // growing writes fail, shrinking ones don't
  auth.clearToken();                              // clears the REMOTE token
  assert.equal(auth.getToken(), '');
  const persistedNow = JSON.parse(localStorage.getItem('macaron_backends')!) as Backend[];
  assert.equal(persistedNow.find((b) => b.id === 'remote')?.token, undefined);
  assert.equal(persistedNow.find((b) => b.id === 'remote')?.baseUrl, 'https://box.example.com');
  // A reload (still quota-full) reads the cleared REMOTE back -- no resurrection.
  backends.__resetForTests();
  backends.setActiveBackendId('remote');
  assert.equal(auth.getToken(), '');
});

test('another tab deleting the registry is adopted, not overwritten from stale cache', async () => {
  // Blocker B: revalidation must treat an external delete (raw === null) the same as
  // any other storage change and re-hydrate through the cold-load path, instead of
  // ignoring it and later re-persisting the stale cached token.
  const persisted = JSON.stringify([{ id: 'local', label: 'Local', baseUrl: '', token: 'tok-1' }]);
  installLocalStorage({ macaron_backends: persisted });
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'tok-1');
  localStorage.removeItem('macaron_backends');   // another tab wipes the registry
  const list = backends.loadBackends();          // must re-seed a fresh tokenless LOCAL
  assert.equal(list.find((b) => b.id === 'local')?.token, undefined);
  assert.equal(auth.getToken(), '');
});

test('another tab clearing a REMOTE-only token is adopted on the next load', async () => {
  // Blocker B: a REMOTE-only stored registry (no LOCAL) changed by another tab must
  // still be revalidated -- the earlier LOCAL-only guard ignored REMOTE-only updates.
  const stored = JSON.stringify([{ id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'remote-tok' }]);
  installLocalStorage({ macaron_backends: stored, macaron_active_backend: 'remote' });
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'remote-tok');
  // Another tab clears the REMOTE token directly in storage.
  localStorage.setItem('macaron_backends', JSON.stringify([{ id: 'remote', label: 'Box', baseUrl: 'https://box.example.com' }]));
  const list = backends.loadBackends();
  assert.equal(list.find((b) => b.id === 'remote')?.token, undefined);
  assert.equal(auth.getToken(), '');
});

test('REMOTE-only + legacy LOCAL token, quota full BEFORE first hydrate: clearing REMOTE persists', async () => {
  // Blocker 1: stored [remote] + a still-present legacy key, quota already full at the
  // very first load. hydrate rebuilds [local(legacy), remote]; the full write grows past
  // quota, so flush falls back to a SHRUNK shape that drops the legacy-backed LOCAL and
  // keeps the legacy key as its backing. Clearing REMOTE then only shrinks the stored
  // value -> persists; a reload does NOT resurrect the REMOTE token.
  const stored = JSON.stringify([{ id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'remote-tok' }]);
  const ls = installLocalStorage({ macaron_backends: stored, macaron_active_backend: 'remote', macaron_auth_token: 'legacy-abc' });
  ls.quotaFull = true;                            // full BEFORE the first hydrate
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'remote-tok');    // active = remote
  auth.clearToken();                              // clear the REMOTE token
  assert.equal(auth.getToken(), '');
  const persistedNow = JSON.parse(localStorage.getItem('macaron_backends')!) as Backend[];
  assert.equal(persistedNow.find((b) => b.id === 'remote')?.token, undefined);
  assert.equal(persistedNow.find((b) => b.id === 'remote')?.baseUrl, 'https://box.example.com');
  // Reload (still quota-full): REMOTE stays cleared; LOCAL re-absorbs the legacy token.
  backends.__resetForTests();
  backends.setActiveBackendId('remote');
  assert.equal(auth.getToken(), '');
});

test('storage SecurityError on read is not a delete: cache survives, no [] written', async () => {
  // Blocker 2: getItem throwing (private-mode SecurityError) must NOT be treated as an
  // external delete. The good in-memory cache stays authoritative; once reads recover the
  // module must not have reset LOCAL to tokenless and written an empty registry.
  const persisted = JSON.stringify([{ id: 'local', label: 'Local', baseUrl: '', token: 'tok-1' }]);
  const ls = installLocalStorage({ macaron_backends: persisted });
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'tok-1');
  ls.failReads = true;                            // getItem now throws SecurityError
  assert.equal(auth.getToken(), 'tok-1');         // cache is still authoritative, not reset
  const list = backends.loadBackends();
  assert.equal(list.find((b) => b.id === 'local')?.token, 'tok-1');
  ls.failReads = false;                           // reads recover
  // The registry was never overwritten with [] — the token is intact on reload.
  assert.equal(JSON.parse(localStorage.getItem('macaron_backends')!)[0].token, 'tok-1');
});

test('a corrupt [null] stored registry hydrates to a clean LOCAL instead of crashing', async () => {
  installLocalStorage({ macaron_backends: '[null]' });
  const { backends, auth } = await freshModules();
  const list = backends.loadBackends();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, backends.LOCAL_BACKEND_ID);
  assert.equal(auth.getToken(), '');
});

test('cold-load storage SecurityError does not clobber a present-but-unreadable registry', async () => {
  // Blocker 1: read throws with NO cache yet (fresh page load in private mode). We must
  // NOT seed a dirty tokenless LOCAL that later flushes `[]` over the real (unreadable)
  // registry. Instead return an ephemeral default and re-read once storage recovers.
  const persisted = JSON.stringify([
    { id: 'local', label: 'Local', baseUrl: '', token: 'tok-1' },
    { id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'remote-tok' },
  ]);
  const ls = installLocalStorage({ macaron_backends: persisted });
  ls.failReads = true;                            // getItem throws from the very first load
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), '');              // ephemeral LOCAL default, nothing cached
  // Storage must not have been overwritten with `[]` — the read failure is transparent.
  ls.failReads = false;
  const list = backends.loadBackends();           // now re-reads the real registry
  assert.equal(list.find((b) => b.id === 'local')?.token, 'tok-1');
  assert.equal(list.find((b) => b.id === 'remote')?.token, 'remote-tok');
  assert.equal(JSON.parse(localStorage.getItem('macaron_backends')!).length, 2);
});

test('legacy-backed LOCAL: another tab deleting the legacy key clears LOCAL on revalidation', async () => {
  // Blocker 2: after a quota fallback, LOCAL's token lives ONLY in the legacy key.
  // Another tab clearing LOCAL deletes that key; revalidation must watch it (not just the
  // registry raw) and drop the now-unbacked token so recovery can't re-persist it.
  const stored = JSON.stringify([{ id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'remote-tok' }]);
  const ls = installLocalStorage({ macaron_backends: stored, macaron_auth_token: 'legacy-abc' });
  ls.quotaFull = true;                            // force the shrunk fallback at hydrate
  const { backends } = await freshModules();
  assert.equal(backends.loadBackends().find((b) => b.id === 'local')?.token, 'legacy-abc'); // absorbed onto LOCAL
  // Another tab clears LOCAL by removing the legacy key.
  localStorage.removeItem('macaron_auth_token');
  const list = backends.loadBackends();           // revalidation notices the missing backing
  assert.equal(list.find((b) => b.id === 'local')?.token, undefined);
});

test('marker lifecycle: a successful full write retires the legacy key and resists reset', async () => {
  // Blocker 3: once the full registry persists (LOCAL's token is now real registry state),
  // the legacy key must be removed and the marker cleared — else a reset rolls back to the
  // old token, or a later quota fallback wrongly strips LOCAL as still legacy-backed.
  installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const { backends } = await freshModules();
  assert.equal(backends.getActiveBackend().token, 'legacy-abc'); // migrated onto LOCAL
  backends.loadBackends();                        // flush the deferred legacy removal
  assert.equal(localStorage.getItem('macaron_auth_token'), null); // legacy key retired
  const persisted = JSON.parse(localStorage.getItem('macaron_backends')!) as Backend[];
  assert.equal(persisted.find((b) => b.id === 'local')?.token, 'legacy-abc'); // now real state
  // A reset (fresh reload) reads the persisted token back — no rollback to a stale legacy.
  backends.__resetForTests();
  assert.equal(backends.getActiveBackend().token, 'legacy-abc');
});

test('cold-cache read failure + mutation: recovery merges, does not clobber unseen backends', async () => {
  // Blocker 1: reads throw on the first load (no cache). A setToken/clearToken during that
  // window is applied blind — it must NOT be dirty-flushed as a partial `[local]` that wipes
  // the present-but-unread REMOTE config. On recovery it's REPLAYED onto the real registry.
  const persisted = JSON.stringify([
    { id: 'local', label: 'Local', baseUrl: '', token: 'local-tok' },
    { id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'remote-tok' },
  ]);
  const ls = installLocalStorage({ macaron_backends: persisted });
  ls.failReads = true;                            // reads throw from the very first load
  const { backends, auth } = await freshModules();
  auth.clearToken();                              // blind clear (active defaults to local)
  assert.equal(auth.getToken(), '');              // authoritative in-session
  ls.failReads = false;                           // reads recover
  const list = backends.loadBackends();           // replays the clear onto the real registry
  assert.equal(list.find((b) => b.id === 'local')?.token, undefined);       // clear survived
  assert.equal(list.find((b) => b.id === 'remote')?.baseUrl, 'https://box.example.com'); // NOT clobbered
  assert.equal(list.find((b) => b.id === 'remote')?.token, 'remote-tok');   // REMOTE token intact
  const stored = JSON.parse(localStorage.getItem('macaron_backends')!) as Backend[];
  assert.equal(stored.find((b) => b.id === 'remote')?.token, 'remote-tok');
});

test('legacy-backed dirty cache: another tab deleting the legacy key still clears LOCAL on recovery', async () => {
  // Blocker 2: after a quota fallback LOCAL's token lives only in the legacy key AND the cache
  // is dirty. A dirty cache must still revalidate the legacy key — else another tab clearing
  // LOCAL (removing the key) is ignored and the old token re-persists once quota recovers.
  const stored = JSON.stringify([{ id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'remote-tok' }]);
  const ls = installLocalStorage({ macaron_backends: stored, macaron_auth_token: 'legacy-abc' });
  ls.quotaFull = true;                            // force the shrunk fallback; cache stays dirty
  const { backends } = await freshModules();
  assert.equal(backends.loadBackends().find((b) => b.id === 'local')?.token, 'legacy-abc'); // absorbed
  localStorage.removeItem('macaron_auth_token'); // another tab clears LOCAL via the legacy key
  const list = backends.loadBackends();           // dirty-path revalidation notices it
  assert.equal(list.find((b) => b.id === 'local')?.token, undefined);
  ls.quotaFull = false;                           // storage recovers
  backends.loadBackends();
  // The cleared LOCAL token must NOT have been re-persisted.
  const persistedNow = JSON.parse(localStorage.getItem('macaron_backends')!) as Backend[];
  assert.equal(persistedNow.find((b) => b.id === 'local')?.token, undefined);
});

test('explicit clear during a transient write failure does not resurrect the legacy token', async () => {
  // Blocker 3: clear writes a tokenless LOCAL, but the legacy removal / registry write fails.
  // The retired value must stay dead: even if the registry is later wiped by another tab, a
  // reload must not re-absorb the still-present legacy key. And the quota fallback must not
  // cancel the pending removal once LOCAL no longer matches the marker.
  const ls = installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'legacy-abc');    // migrated onto LOCAL, legacy-backed
  ls.failWrites = true;                           // writes freeze
  auth.clearToken();                              // explicit clear during the failure
  assert.equal(auth.getToken(), '');
  // Another tab wipes the registry while writes are still frozen.
  localStorage.removeItem('macaron_backends');
  const list = backends.loadBackends();           // hydrate(null) must NOT re-absorb the retired key
  assert.equal(list.find((b) => b.id === 'local')?.token, undefined);
  assert.equal(auth.getToken(), '');
  ls.failWrites = false;                           // storage recovers
  backends.loadBackends();
  assert.equal(localStorage.getItem('macaron_auth_token'), null); // legacy key finally retired
  backends.__resetForTests();
  assert.equal(backends.getActiveBackend().token, undefined);      // stays cleared across reload
});

test('known-stale legacy removal failure: another tab wiping the registry does not re-migrate it', async () => {
  // Blocker 4: the persisted registry already migrated the token (LOCAL carries it in the
  // registry) but the legacy-key removal failed, leaving a known-stale key. If another tab
  // then deletes the registry, hydrate(null) must NOT re-migrate that retired key.
  const migrated = JSON.stringify([{ id: 'local', label: 'Local', baseUrl: '', token: 'migrated-tok' }]);
  installLocalStorage({ macaron_backends: migrated, macaron_auth_token: 'legacy-abc' });
  const { backends } = await freshModules();
  // First load reconciles: LOCAL keeps its registry token; the stale legacy key is retired.
  const realRemove = localStorage.removeItem.bind(localStorage);
  (localStorage as unknown as { removeItem: (k: string) => void }).removeItem = (k: string) => {
    if (k === 'macaron_auth_token') throw new Error('fail'); // legacy removal fails this load
    realRemove(k);
  };
  assert.equal(backends.loadBackends().find((b) => b.id === 'local')?.token, 'migrated-tok');
  assert.equal(localStorage.getItem('macaron_auth_token'), 'legacy-abc'); // removal failed → still there
  // Another tab wipes the registry while the stale key lingers.
  (localStorage as unknown as { removeItem: (k: string) => void }).removeItem = realRemove;
  localStorage.removeItem('macaron_backends');
  const list = backends.loadBackends();           // hydrate(null): must not re-absorb the retired key
  assert.equal(list.find((b) => b.id === 'local')?.token, undefined);
});

test('permanent legacy-removal failure survives a REAL reload via durable tombstone', async () => {
  // Meeseeks #1: the earlier blocker-3 test let writes recover in-session. The real danger is
  // a legacy key whose removal PERMANENTLY fails: after a genuine reload the in-memory
  // retiredLegacyToken is gone, so only a persisted tombstone can stop hydrate() re-absorbing
  // the still-present dead key. Here removeItem('macaron_auth_token') ALWAYS throws.
  const ls = installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const realRemove = localStorage.removeItem.bind(localStorage);
  (localStorage as unknown as { removeItem: (k: string) => void }).removeItem = (k: string) => {
    if (k === 'macaron_auth_token') throw new Error('permanent'); // never deletable
    realRemove(k);
  };
  const { backends, auth } = await freshModules();
  assert.equal(auth.getToken(), 'legacy-abc');      // migrated onto LOCAL
  auth.clearToken();                                 // explicit clear; legacy key can't be deleted
  assert.equal(auth.getToken(), '');
  const tomb = localStorage.getItem('macaron_auth_token_retired');
  assert.equal(tomb, 'legacy-abc');                  // durable tombstone written
  assert.equal(localStorage.getItem('macaron_auth_token'), 'legacy-abc'); // key still there (undeletable)
  // Simulate a REAL page reload: fresh module state (no in-memory retiredLegacyToken), plus
  // another tab having wiped the registry. The tombstone is the ONLY guard now.
  backends.__resetForTests();
  ls.failWrites = false;
  const list = backends.loadBackends();              // hydrate reads the tombstone, refuses re-absorb
  assert.equal(list.find((b) => b.id === 'local')?.token, undefined);
  assert.equal(auth.getToken(), '');
  (localStorage as unknown as { removeItem: (k: string) => void }).removeItem = realRemove;
});

test('tombstone is cleared once the legacy key is finally removed', async () => {
  // The tombstone outlives the key by exactly one step: when key removal at last succeeds,
  // the tombstone's job is done and it must be dropped too (no orphaned retirement marker).
  const ls = installLocalStorage({ macaron_auth_token: 'legacy-abc' });
  const realRemove = localStorage.removeItem.bind(localStorage);
  let blockRemoval = true;
  (localStorage as unknown as { removeItem: (k: string) => void }).removeItem = (k: string) => {
    if (k === 'macaron_auth_token' && blockRemoval) throw new Error('fail'); // key removal fails at first
    realRemove(k);
  };
  const { backends, auth } = await freshModules();
  auth.clearToken();
  assert.equal(localStorage.getItem('macaron_auth_token_retired'), 'legacy-abc');
  blockRemoval = false;                              // removal now succeeds
  backends.loadBackends();
  assert.equal(localStorage.getItem('macaron_auth_token'), null);          // key gone
  assert.equal(localStorage.getItem('macaron_auth_token_retired'), null);  // tombstone gone too
  (localStorage as unknown as { removeItem: (k: string) => void }).removeItem = realRemove;
});

test('recovery hydrates real registry BEFORE replaying a blind clear, retiring by value', async () => {
  // Meeseeks #2/#3: a clear issued while reads throw is blind — active id unknown, so it must
  // NOT retire on a guess. On recovery we hydrate the REAL registry first, then replay the
  // clear against it, and only THEN (target resolved to LOCAL) retire the legacy value by value.
  const persisted = JSON.stringify([{ id: 'local', label: 'Local', baseUrl: '', token: 'reg-tok' }]);
  const ls = installLocalStorage({ macaron_backends: persisted, macaron_auth_token: 'legacy-abc' });
  ls.failReads = true;                               // cold reads throw
  const { backends, auth } = await freshModules();
  auth.clearToken();                                 // blind clear — target guessed LOCAL, but NOT retired yet
  assert.equal(auth.getToken(), '');
  ls.failReads = false;                              // reads recover
  const list = backends.loadBackends();              // hydrate(real) THEN replay clear
  assert.equal(list.find((b) => b.id === 'local')?.token, undefined);       // clear won over reg-tok
  // hydrate's LOCAL-bearing branch deletes the legacy key outright, so no dead key lingers to
  // resurrect — the clear is durable whether via key-removal or (if removal failed) tombstone.
  assert.equal(localStorage.getItem('macaron_auth_token'), null);           // legacy key gone
  // And it stays cleared across a real reload.
  backends.__resetForTests();
  assert.equal(backends.getActiveBackend().token, undefined);
});

test('active-id read exception does not guess LOCAL and does not wrongly retire the legacy token', async () => {
  // Meeseeks #4: clearing while the ACTIVE-id read throws must not be mis-attributed to LOCAL —
  // retiring the legacy value on that guess would kill a still-valid LOCAL credential. quota-full
  // keeps LOCAL legacy-backed (not migrated into the registry, so the legacy key stays live).
  const persisted = JSON.stringify([{ id: 'remote', label: 'Box', baseUrl: 'https://box.example.com', token: 'remote-tok' }]);
  const ls = installLocalStorage({ macaron_backends: persisted, macaron_auth_token: 'legacy-abc', macaron_active_backend: 'remote' });
  ls.quotaFull = true;                               // LOCAL can't be migrated in → stays legacy-backed
  const { backends, auth } = await freshModules();
  assert.equal(backends.loadBackends().find((b) => b.id === 'local')?.token, 'legacy-abc'); // legacy-backed LOCAL
  assert.equal(localStorage.getItem('macaron_auth_token_retired'), null);  // not retired: LOCAL still needs it
  const realGet = localStorage.getItem.bind(localStorage);
  (localStorage as unknown as { getItem: (k: string) => string | null }).getItem = (k: string) => {
    if (k === 'macaron_active_backend') throw new Error('SecurityError'); // active id unreadable
    return realGet(k);
  };
  auth.clearToken();                                 // target id unknown → must NOT retire legacy
  (localStorage as unknown as { getItem: (k: string) => string | null }).getItem = realGet;
  assert.equal(localStorage.getItem('macaron_auth_token_retired'), null);  // no wrongful retirement
  assert.equal(localStorage.getItem('macaron_auth_token'), 'legacy-abc');  // legacy key untouched
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
