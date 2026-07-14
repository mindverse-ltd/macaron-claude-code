// Backend registry for the WebUI. A "backend" is one headless macaron server the
// UI can talk to. The list lives entirely in localStorage — the servers are
// stateless and don't know about each other; picking which one to drive is a
// pure client concern (like VS Code's remote picker).
//
// This module is step 1 of the multi-backend split (MAC-8578): just the data
// model + per-backend token storage + a one-time migration off the old single
// global token. The switcher UI, health probing, and CORS are deliberately NOT
// here. Local default behavior must stay byte-for-byte the same: the built-in
// LOCAL backend has an empty baseUrl, so requests keep hitting same-origin
// relative /api paths exactly as before.

export type Backend = {
  id: string;
  label: string;
  // '' means same-origin (the local default). Otherwise an absolute origin like
  // https://box.example.com — no trailing slash, no path.
  baseUrl: string;
  token?: string;
};

export const LOCAL_BACKEND_ID = 'local';

const BACKENDS_KEY = 'macaron_backends';
const ACTIVE_KEY = 'macaron_active_backend';
// The pre-multi-backend single global token. Read once during migration, then
// deleted so a later clearToken() can't be undone by a re-migration (if the
// backend list is ever reset, the stale legacy token must not resurrect).
const LEGACY_TOKEN_KEY = 'macaron_auth_token';
// A persisted tombstone recording a legacy value we've decided is DEAD. The
// in-memory `retiredLegacyToken` is lost on a real page reload, so if the legacy
// key removal PERMANENTLY fails, the next process would re-absorb the still-present
// dead key. This key survives reload and lets hydrate() refuse that value by value.
// Removed the instant the legacy key is confirmed gone (its job is done).
const LEGACY_TOMBSTONE_KEY = 'macaron_auth_token_retired';

function localDefault(): Backend {
  return { id: LOCAL_BACKEND_ID, label: 'Local', baseUrl: '' };
}

// Read the raw registry string. `ok: false` means the read itself threw (private
// mode SecurityError) — distinct from a real absent key (`ok: true, raw: null`),
// which is what another tab deleting the registry looks like. Conflating the two
// would let a SecurityError reset a good in-memory cache to a tokenless LOCAL.
function readRegistryRaw(): { ok: boolean; raw: string | null } {
  try { return { ok: true, raw: localStorage.getItem(BACKENDS_KEY) }; }
  catch { return { ok: false, raw: null }; }
}

// Read the legacy key, distinguishing a real value / absence (`ok: true`) from a
// read that threw (`ok: false`). A thrown read is NOT a deletion — treating it as
// one would drop a LOCAL token whose only backing is the legacy key.
function readLegacyRaw(): { ok: boolean; value: string } {
  try { return { ok: true, value: localStorage.getItem(LEGACY_TOKEN_KEY) || '' }; }
  catch { return { ok: false, value: '' }; }
}

function readLegacy(): string { return readLegacyRaw().value; }

// The persisted retirement tombstone (a legacy value known dead), or '' if none.
// Read defensively — a thrown read just means "no durable tombstone available".
function readTombstone(): string {
  try { return localStorage.getItem(LEGACY_TOMBSTONE_KEY) || ''; } catch { return ''; }
}

// The persisted shape of the registry. The default LOCAL backend is synthetic —
// it's always re-seeded on load — so it needn't be stored. Omitting it keeps the
// stored registry in its ORIGINAL shape (a REMOTE-only list stays REMOTE-only),
// which is what lets a REMOTE token clear only ever SHRINK the stored value and
// therefore persist even under a full quota. A LOCAL that carries a token or
// non-default config is real state and is kept — UNLESS its token is `redundantLocalToken`
// (the still-present legacy key backs it), in which case it's droppable too: reload
// reconstructs LOCAL from the legacy key, so stripping it here loses nothing.
function toStored(list: Backend[], redundantLocalToken?: string): Backend[] {
  return list.filter((b) => {
    if (b.id !== LOCAL_BACKEND_ID) return true;
    if (!(b.label === 'Local' && b.baseUrl === '')) return true; // non-default LOCAL is real config
    if (!b.token) return false;                                  // tokenless default LOCAL: strip
    if (redundantLocalToken && b.token === redundantLocalToken) return false; // backed by legacy key: strip
    return true;
  });
}

function write(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; /* private mode / quota */ }
}

// Set/clear a backend's token, mirroring the login flow: target the active id,
// falling back to LOCAL if it somehow isn't in the list. Pure — returns a new list.
function applyToken(list: Backend[], id: string, token: string | undefined): Backend[] {
  const next = list.map((b) => (b.id === id ? { ...b, token: token || undefined } : b));
  if (!next.some((b) => b.id === id)) {
    const i = next.findIndex((b) => b.id === LOCAL_BACKEND_ID);
    if (i >= 0) next[i] = { ...next[i], token: token || undefined };
  }
  return next;
}

// In-memory authoritative copy of the backend list. localStorage writes can fail
// (private mode / quota), so we can't re-read the list from storage every call —
// a failed clearToken() would keep reading back the stale persisted token. This
// cache is the source of truth for the session; storage is best-effort mirror.
let cache: Backend[] | null = null;
// `cacheReconciled` = the cache reflects a SUCCESSFUL storage read (or a seed we
// then read back), so it's safe to overwrite storage with it. A cache built purely
// from a mutation made while storage was unreadable is NOT reconciled: overwriting
// the (present but unread) registry with it would drop backends we never saw.
let cacheReconciled = false;
// `dirty` = the cache hasn't been persisted yet (a write failed). `pendingLegacyRemoval`
// = a migrated legacy key still needs deleting once the seeded list is persisted.
// Both are retried by flush() on the next operation, so once storage recovers the
// cleared / migrated state persists WITHOUT the caller having to act again.
let dirty = false;
let pendingLegacyRemoval = false;
// When a still-present legacy key was folded into LOCAL's token, this holds that
// value. It makes LOCAL's token redundant for persistence (reload re-absorbs it
// from the legacy key), so toStored() can strip LOCAL and a REMOTE clear shrinks
// the stored value even under a full quota. Cleared once the legacy key is gone.
let legacyBackedLocalToken: string | undefined;
// A legacy token value we've decided is DEAD (explicitly cleared, or already folded
// into a persisted registry). Even if we can't delete the key right now, this value
// must never be re-absorbed onto LOCAL — not by a hydrate(null) after another tab
// wipes the registry, nor by any later reset. Retirement outlives the legacy key.
let retiredLegacyToken: string | undefined;
// The raw registry string this module last read from / wrote to storage. Used to
// detect another tab clearing or reconfiguring a backend: if storage no longer
// matches what we last saw AND we have nothing unpersisted, adopt the newer value
// instead of clobbering it on the next save.
let lastSeenRaw: string | null = null;
// Token set/clear operations applied while storage was unreadable (no reconciled
// cache yet). They can't be persisted blind — doing so would clobber unseen state.
// On the next successful read they're REPLAYED onto the real registry, so the
// user's intent survives without overwriting backends we couldn't observe.
let pendingMutations: Array<{ id: string; token: string | undefined }> = [];

// Retire a legacy value: mark it dead so it's never re-absorbed, and schedule the
// key for removal. Also persist a durable tombstone so the retirement survives a
// real page reload even if the legacy-key removal keeps failing — otherwise the
// next process, with no in-memory marker, would re-absorb the still-present key.
function retireLegacy(value: string | undefined): void {
  if (value) { retiredLegacyToken = value; try { localStorage.setItem(LEGACY_TOMBSTONE_KEY, value); } catch { /* best-effort; in-memory marker still guards this session */ } }
  legacyBackedLocalToken = undefined;
  pendingLegacyRemoval = true;
}

// Compare-and-swap removal of the legacy key, by value. Only delete when the key
// STILL holds the value we retired — if another tab wrote a NEW token there, that
// value was never retired and must survive (deleting it would drop a fresh login).
// Returns true when the retirement is settled (key gone, or no longer our value),
// so the caller can stop retrying. The tombstone outlives the key by one step: once
// the retired value is gone from the key, the tombstone's job is done — clear it.
function removeLegacyKey(expected: string | undefined): boolean {
  const cur = readLegacyRaw();
  if (!cur.ok) return false;                          // couldn't read → retry later
  if (expected && cur.value && cur.value !== expected) {
    // Another tab replaced the retired token with a live one. Our retirement no longer
    // applies; leave the key and drop the stale tombstone so it can't block the new value.
    try { localStorage.removeItem(LEGACY_TOMBSTONE_KEY); } catch { /* best-effort */ }
    return true;
  }
  if (cur.value) { try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { return false; } }
  try { localStorage.removeItem(LEGACY_TOMBSTONE_KEY); } catch { /* harmless leftover: an absent legacy key can't be re-absorbed */ }
  return true;
}

// Retry any deferred persistence. Clearing a token only ever shrinks the registry,
// so its write succeeds under quota pressure; a write that still fails means storage
// is frozen (private mode), and the in-memory cache stays authoritative for the
// session. We never delete the whole registry as a fallback — that would drop
// tokenless REMOTE backends (their label/baseUrl are real config, not throwaway
// state). Order matters: persist the registry first, and only drop the legacy key
// once it's safely written, so a crash between the two can't lose the token.
function flush(): void {
  // Only a cache reconciled with storage may overwrite it. An unreconciled cache
  // (a blind mutation during a read failure) stays pending until the next read
  // merges it — see loadBackends. We still process pendingLegacyRemoval below.
  if (dirty && cache && cacheReconciled) {
    // Prefer persisting the FULL registry: a legacy-backed LOCAL token becomes real
    // registry state, after which the legacy key is redundant — retire it so a later
    // reset can't roll back to the old token.
    const full = toStored(cache);
    if (write(BACKENDS_KEY, full)) {
      dirty = false;
      lastSeenRaw = JSON.stringify(full);
      if (legacyBackedLocalToken) retireLegacy(legacyBackedLocalToken);
    } else if (legacyBackedLocalToken && cache.some((b) => b.id === LOCAL_BACKEND_ID && b.token === legacyBackedLocalToken)) {
      // Quota-full fallback — ONLY while LOCAL genuinely still carries the legacy-backed
      // token. Persist a SHRUNK shape dropping that LOCAL: reload re-absorbs it from the
      // legacy key, so nothing is lost, and a later REMOTE clear only shrinks the stored
      // value. LOCAL's token now lives ONLY in the legacy key — KEEP it (cancel pending
      // removal). If LOCAL's token was since cleared/changed, this branch is skipped so
      // an explicit clear's legacy removal is NOT cancelled (the token must stay dead).
      const shrunk = toStored(cache, legacyBackedLocalToken);
      if (write(BACKENDS_KEY, shrunk)) { dirty = false; lastSeenRaw = JSON.stringify(shrunk); pendingLegacyRemoval = false; return; }
    }
  }
  if (pendingLegacyRemoval) {
    // Dropping the legacy key while the registry is still unpersisted is safe when the
    // in-memory LOCAL no longer needs it: either its token was cleared (reload seeds a
    // fresh tokenless LOCAL, which IS the cleared state) or the value is retired (dead).
    // Mid-migration (LOCAL still holds an un-persisted token backed ONLY by the legacy
    // key) we must persist the registry first, else a session ending between the two
    // loses the sole credential.
    const localHasToken = !!cache?.find((b) => b.id === LOCAL_BACKEND_ID)?.token;
    const localBackedByLegacy = !!legacyBackedLocalToken && localHasToken;
    if (!localBackedByLegacy && (!dirty || !localHasToken || !!retiredLegacyToken)) {
      if (removeLegacyKey(retiredLegacyToken)) { pendingLegacyRemoval = false; legacyBackedLocalToken = undefined; } /* else retry next time */
    }
  }
}

// Reconcile the legacy key across tabs. When LOCAL's token is backed ONLY by the
// legacy key (a quota fallback stripped it from the persisted registry), the
// registry raw alone can't reflect another tab clearing or changing LOCAL by
// touching that key — so watch it directly. A read that THREW is not a deletion:
// leave the token in place. An empty value clears LOCAL; a changed value updates it.
function revalidateLegacy(): void {
  if (!legacyBackedLocalToken || !cache) return;
  const { ok, value } = readLegacyRaw();
  if (!ok) return;                              // SecurityError — not a delete
  if (value === legacyBackedLocalToken) return; // unchanged
  const nextToken = value || undefined;         // '' → cleared, other → updated
  cache = cache.map((b) => (b.id === LOCAL_BACKEND_ID && b.token === legacyBackedLocalToken ? { ...b, token: nextToken } : b));
  legacyBackedLocalToken = nextToken;
  dirty = true;
}

// Normalize a (possibly null / LOCAL-less / malformed) stored registry into the
// in-memory cache, always LOCAL-bearing. This is the single cold-load path: a fresh
// page load, an external delete, and another tab's reconfiguration all funnel through
// here from ONE raw read of storage, so raw and cache never disagree.
function hydrate(raw: string | null): Backend[] {
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  // Keep only well-formed entries — a hand-corrupted `[null]` / `[{}]` must not crash.
  const stored = Array.isArray(parsed) ? (parsed.filter((b): b is Backend => !!b && typeof (b as Backend).id === 'string')) : null;
  cacheReconciled = true;
  // Load any durable tombstone into the in-memory marker FIRST. On a real reload the
  // in-memory `retiredLegacyToken` is gone, so this is the only thing standing between
  // a permanently-undeletable dead legacy key and its resurrection below.
  const tomb = readTombstone();
  if (tomb) retiredLegacyToken = tomb;
  if (stored && stored.length > 0 && stored.some((b) => b.id === LOCAL_BACKEND_ID)) {
    cache = stored;
    lastSeenRaw = raw;
    // A LOCAL-bearing registry is self-sufficient: LOCAL's token (if any) lives in the
    // registry, not the legacy key, so clear the marker — else a later quota fallback
    // could wrongly strip LOCAL as "legacy-backed" and lose the sole token. Any leftover
    // legacy key is stale — retire + remove it (retried every load via pendingLegacyRemoval
    // on failure) so a reset can't re-migrate the old token.
    legacyBackedLocalToken = undefined;
    const stale = readLegacyRaw();
    if (stale.ok && stale.value) retireLegacy(stale.value); // records tombstone + schedules removal
    if (pendingLegacyRemoval && removeLegacyKey(retiredLegacyToken)) { pendingLegacyRemoval = false; }
    return cache;
  }
  // No usable stored list, or one missing LOCAL: (re)build LOCAL. If a legacy token is
  // still present AND not retired, it was never migrated (no LOCAL ever held it), so
  // absorb it now — else a tokenless LOCAL would drop the sole credential. A RETIRED
  // legacy value is dead: never re-absorb it (that would resurrect a cleared token after
  // another tab wiped the registry); just keep trying to remove the key. Non-LOCAL kept.
  const local = localDefault();
  const legacy = readLegacy();
  if (legacy && legacy !== retiredLegacyToken) { local.token = legacy; legacyBackedLocalToken = legacy; pendingLegacyRemoval = true; }
  else if (legacy) { pendingLegacyRemoval = true; } // retired leftover — schedule removal, don't absorb
  cache = stored ? [local, ...stored] : [local];
  dirty = true; // persist the seeded / reconstructed list (in its original stored shape)
  flush();
  return cache;
}

// Load the backend list, seeding + migrating on first run. Always returns at
// least the built-in LOCAL backend, and guarantees LOCAL is present even if a
// stored list somehow dropped it.
export function loadBackends(): Backend[] {
  const { ok, raw } = readRegistryRaw();
  // A read that THREW (private-mode SecurityError) is not a delete. With a warm cache,
  // keep it authoritative. With NO cache yet (cold load) we can't know what storage
  // holds — return an ephemeral LOCAL default WITHOUT caching or marking it dirty, so a
  // later successful load re-reads the real registry instead of a dirty-flush writing
  // over the (present but unreadable) stored token + REMOTE config once reads recover.
  if (!ok) {
    if (cache) { revalidateLegacy(); flush(); return cache; }
    return [localDefault()];
  }
  // Blind mutations made while storage was unreadable: now that we can read, MERGE them
  // onto the real registry instead of overwriting it with our partial cache. Replaying
  // through hydrate + applyToken preserves backends we never saw and the user's intent.
  if (cache && dirty && !cacheReconciled) {
    let merged = hydrate(raw);
    for (const m of pendingMutations) {
      merged = applyToken(merged, m.id, m.token);
      // A blind clear we couldn't classify at the time is now resolvable against the real
      // registry: if it targeted LOCAL (or an id absent from the registry), retire the
      // legacy value BY VALUE so the just-cleared token can't re-migrate on a later reload.
      if (!m.token && (m.id === LOCAL_BACKEND_ID || !merged.some((b) => b.id === m.id))) {
        retireLegacy(legacyBackedLocalToken || readLegacy());
        merged = merged.map((b) => (b.id === LOCAL_BACKEND_ID ? { ...b, token: undefined } : b));
      }
    }
    cache = merged;
    pendingMutations = [];
    dirty = true;
    flush();
    return cache;
  }
  // Reconciled but unpersisted local changes are authoritative — never let storage
  // clobber them. Still revalidate the legacy key: another tab may have cleared a
  // legacy-backed LOCAL token even while our registry cache is mid-write.
  if (cache && dirty) { revalidateLegacy(); flush(); return cache; }
  // Single raw read drives both the no-op and revalidation paths, so the parsed value
  // and the raw we compare against can't drift out of sync.
  if (cache && raw === lastSeenRaw) { revalidateLegacy(); flush(); return cache; }
  // Cold load, or another tab changed storage (including a real delete → raw null):
  // adopt it through the same normalization a fresh page load uses.
  return hydrate(raw);
}

// Update the in-memory source of truth first, then best-effort mirror to
// storage. The cache update is what makes an explicit / 401 clear stick even
// when the write fails; `dirty` gets retried by flush() once storage recovers.
export function saveBackends(list: Backend[]): void {
  cache = list;
  dirty = true;
  // A full-list save with readable storage is authoritative and safe to persist.
  // Only a save made while storage is unreadable (a blind mutation) stays
  // unreconciled, to be replayed onto the real registry once reads recover.
  if (readRegistryRaw().ok) cacheReconciled = true;
  flush();
}

// Test-only: drop the in-memory cache + deferred-write state so the next
// loadBackends() re-reads storage, simulating a fresh page load. Never in prod.
export function __resetForTests(): void {
  cache = null;
  cacheReconciled = false;
  dirty = false;
  pendingLegacyRemoval = false;
  legacyBackedLocalToken = undefined;
  retiredLegacyToken = undefined;
  lastSeenRaw = null;
  pendingMutations = [];
}

export function getActiveBackendId(): string {
  return readActiveId().value;
}

// Read the active id, distinguishing a real value / default (`ok: true`) from a
// read that threw (`ok: false`). Callers that would take a DESTRUCTIVE action based
// on the id being LOCAL (e.g. retiring the legacy token) must not act on a guessed
// default — an unreadable active key is unknown, not "definitely LOCAL".
function readActiveId(): { ok: boolean; value: string } {
  try { return { ok: true, value: localStorage.getItem(ACTIVE_KEY) || LOCAL_BACKEND_ID }; }
  catch { return { ok: false, value: LOCAL_BACKEND_ID }; }
}

export function setActiveBackendId(id: string): void {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* private mode */ }
}

export function getActiveBackend(): Backend {
  const list = loadBackends();
  const id = getActiveBackendId();
  return list.find((b) => b.id === id) || list.find((b) => b.id === LOCAL_BACKEND_ID) || localDefault();
}

// Persist a single-token intent by re-hydrating the FRESHEST registry raw first, then
// applying just that one (id → token) change onto it. This is the unified recovery write:
// a whole-list save would revert a concurrent cross-tab change to a DIFFERENT backend, but
// re-reading raw here means we only ever touch the one backend the intent names. Returns the
// resulting list (already cached + flushed).
function persistTokenIntent(id: string, token: string | undefined): Backend[] {
  const { ok, raw } = readRegistryRaw();
  // Unreadable storage → keep the in-memory cache authoritative for this session; a whole-list
  // save is the only option, and loadBackends already recorded the intent for later replay.
  const base = ok ? hydrate(raw) : (cache ?? [localDefault()]);
  const next = applyToken(base, id, token);
  saveBackends(next);
  return next;
}

// Persist a token against the active backend (used by the login flow). Writing
// an empty string clears it. This replaces the old single-key token storage.
export function setActiveBackendToken(token: string): void {
  const list = loadBackends();
  const reconciled = cacheReconciled; // did the load above see real storage?
  const active = readActiveId();
  const id = active.value;
  // A CLEAR whose target we only GUESSED is destructive on the wrong backend: applying it to a
  // guessed LOCAL both drops LOCAL's token and lets flush() retire the legacy value. Skip it
  // ONLY when the registry WAS readable (reconciled) but the active-id read threw — there we're
  // about to act immediately on a wrong LIVE target and can't confirm it. When nothing was
  // readable (unreconciled), we instead defer via pendingMutations below, which re-resolves the
  // real target on replay, so a legitimate blind clear still survives.
  if (!token && reconciled && !active.ok) return;
  // Explicitly clearing the LOCAL token must also invalidate the legacy source,
  // even if the registry write below fails (private mode / quota): otherwise the
  // next loadBackends() would re-migrate the stale legacy token and resurrect a
  // token the user just cleared. Retire the value so it stays dead across a failed
  // removal / registry wipe, and defer the key removal to flush().
  if (!token && active.ok && (id === LOCAL_BACKEND_ID || !list.some((b) => b.id === id))) {
    retireLegacy(legacyBackedLocalToken || readLegacy());
  }
  // If storage was unreadable, this mutation was applied blind: record it so the next
  // successful read replays it onto the real registry rather than overwriting.
  if (!reconciled) { pendingMutations.push({ id, token: token || undefined }); saveBackends(applyToken(list, id, token)); return; }
  // Reconciled: persist by re-hydrating the freshest raw so a concurrent cross-tab change to a
  // different backend survives — we only mutate the one backend this intent names.
  persistTokenIntent(id, token);
}
