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

function readLegacy(): string {
  try { return localStorage.getItem(LEGACY_TOKEN_KEY) || ''; } catch { return ''; }
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

// In-memory authoritative copy of the backend list. localStorage writes can fail
// (private mode / quota), so we can't re-read the list from storage every call —
// a failed clearToken() would keep reading back the stale persisted token. This
// cache is the source of truth for the session; storage is best-effort mirror.
let cache: Backend[] | null = null;
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
// The raw registry string this module last read from / wrote to storage. Used to
// detect another tab clearing or reconfiguring a backend: if storage no longer
// matches what we last saw AND we have nothing unpersisted, adopt the newer value
// instead of clobbering it on the next save.
let lastSeenRaw: string | null = null;

// Retry any deferred persistence. Clearing a token only ever shrinks the registry,
// so its write succeeds under quota pressure; a write that still fails means storage
// is frozen (private mode), and the in-memory cache stays authoritative for the
// session. We never delete the whole registry as a fallback — that would drop
// tokenless REMOTE backends (their label/baseUrl are real config, not throwaway
// state). Order matters: persist the registry first, and only drop the legacy key
// once it's safely written, so a crash between the two can't lose the token.
function flush(): void {
  if (dirty && cache) {
    // Prefer persisting the FULL registry: a legacy-backed LOCAL token becomes real
    // registry state, after which the legacy key is redundant — schedule its removal
    // (and drop the marker) so a later reset can't roll back to the old token.
    const full = toStored(cache);
    if (write(BACKENDS_KEY, full)) {
      dirty = false;
      lastSeenRaw = JSON.stringify(full);
      if (legacyBackedLocalToken) { legacyBackedLocalToken = undefined; pendingLegacyRemoval = true; }
    } else if (legacyBackedLocalToken) {
      // Quota-full fallback: the full write grew past the quota. Persist a SHRUNK shape
      // that drops the still-legacy-backed LOCAL — reload re-absorbs it from the legacy
      // key, so nothing is lost, and now a later REMOTE clear only shrinks the stored
      // value. LOCAL's token now lives ONLY in the legacy key, so the legacy key is its
      // backing — KEEP it (cancel any pending removal) and leave the marker set.
      const shrunk = toStored(cache, legacyBackedLocalToken);
      if (write(BACKENDS_KEY, shrunk)) { dirty = false; lastSeenRaw = JSON.stringify(shrunk); pendingLegacyRemoval = false; return; }
    }
  }
  if (pendingLegacyRemoval) {
    // Dropping the legacy key while the registry is still unpersisted is safe ONLY
    // when the in-memory LOCAL no longer needs it (its token was cleared) — then the
    // reload path seeds a fresh tokenless LOCAL, which IS the cleared state. This is
    // what lets an explicit clear stick under a full quota even when the seeded /
    // reconstructed registry can't be written fresh. Mid-migration (LOCAL still holds
    // the token) we must persist the registry first, else a session ending between the
    // two loses the sole credential.
    const localHasToken = !!cache?.find((b) => b.id === LOCAL_BACKEND_ID)?.token;
    if (!dirty || !localHasToken) {
      try { localStorage.removeItem(LEGACY_TOKEN_KEY); pendingLegacyRemoval = false; legacyBackedLocalToken = undefined; } catch { /* retry next time */ }
    }
  }
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
  if (stored && stored.length > 0 && stored.some((b) => b.id === LOCAL_BACKEND_ID)) {
    cache = stored;
    lastSeenRaw = raw;
    // A LOCAL-bearing registry is self-sufficient: LOCAL's token (if any) lives in the
    // registry, not the legacy key, so clear the marker — else a later quota fallback
    // could wrongly strip LOCAL as "legacy-backed" and lose the sole token. Any leftover
    // legacy key is stale; reconcile it — retried every load — so a reset can't
    // re-migrate the old token. On failure defer via pendingLegacyRemoval so flush()
    // retries it (the cache-hit path only retries that).
    legacyBackedLocalToken = undefined;
    try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { pendingLegacyRemoval = true; }
    return cache;
  }
  // No usable stored list, or one missing LOCAL: (re)build LOCAL. If a legacy token is
  // still present it was never migrated (no LOCAL ever held it), so absorb it now — else
  // a tokenless LOCAL would drop the sole credential. Any non-LOCAL entries are kept.
  const local = localDefault();
  const legacy = readLegacy();
  if (legacy) { local.token = legacy; legacyBackedLocalToken = legacy; pendingLegacyRemoval = true; }
  cache = stored ? [local, ...stored] : [local];
  dirty = true; // persist the seeded / reconstructed list (in its original stored shape)
  flush();
  return cache;
}

// Load the backend list, seeding + migrating on first run. Always returns at
// least the built-in LOCAL backend, and guarantees LOCAL is present even if a
// stored list somehow dropped it.
export function loadBackends(): Backend[] {
  // Unpersisted local changes are authoritative — never let storage clobber them.
  if (cache && dirty) { flush(); return cache; }
  const { ok, raw } = readRegistryRaw();
  // A read that THREW (private-mode SecurityError) is not a delete. With a warm cache,
  // keep it authoritative. With NO cache yet (cold load), we can't know what storage
  // holds — return an ephemeral LOCAL default WITHOUT caching or marking it dirty, so a
  // later successful load re-reads the real registry instead of a dirty-flush writing
  // `[]` over the (present but unreadable) stored token + REMOTE config once reads recover.
  if (!ok) {
    if (cache) { flush(); return cache; }
    return [localDefault()];
  }
  // Single raw read drives both the no-op and revalidation paths, so the parsed value
  // and the raw we compare against can't drift out of sync.
  if (cache && raw === lastSeenRaw) {
    // If LOCAL's token is backed ONLY by the legacy key (quota fallback stripped it from
    // the persisted registry), revalidation must watch that key too — the registry raw
    // alone won't reflect another tab clearing LOCAL by deleting the legacy key. If it's
    // gone, drop LOCAL's now-unbacked token so we don't re-persist it once quota recovers.
    if (legacyBackedLocalToken && !readLegacy()) {
      cache = cache.map((b) => (b.id === LOCAL_BACKEND_ID && b.token === legacyBackedLocalToken ? { ...b, token: undefined } : b));
      legacyBackedLocalToken = undefined;
      dirty = true;
    }
    flush();
    return cache;
  }
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
  flush();
}

// Test-only: drop the in-memory cache + deferred-write state so the next
// loadBackends() re-reads storage, simulating a fresh page load. Never in prod.
export function __resetForTests(): void {
  cache = null;
  dirty = false;
  pendingLegacyRemoval = false;
  legacyBackedLocalToken = undefined;
  lastSeenRaw = null;
}

export function getActiveBackendId(): string {
  try { return localStorage.getItem(ACTIVE_KEY) || LOCAL_BACKEND_ID; } catch { return LOCAL_BACKEND_ID; }
}

export function setActiveBackendId(id: string): void {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* private mode */ }
}

export function getActiveBackend(): Backend {
  const list = loadBackends();
  const id = getActiveBackendId();
  return list.find((b) => b.id === id) || list.find((b) => b.id === LOCAL_BACKEND_ID) || localDefault();
}

// Persist a token against the active backend (used by the login flow). Writing
// an empty string clears it. This replaces the old single-key token storage.
export function setActiveBackendToken(token: string): void {
  const list = loadBackends();
  const id = getActiveBackendId();
  const next = list.map((b) => (b.id === id ? { ...b, token: token || undefined } : b));
  // If the active id isn't in the list (shouldn't happen), fall back to LOCAL.
  if (!next.some((b) => b.id === id)) {
    const i = next.findIndex((b) => b.id === LOCAL_BACKEND_ID);
    if (i >= 0) next[i] = { ...next[i], token: token || undefined };
  }
  // Explicitly clearing the LOCAL token must also invalidate the legacy source,
  // even if the registry write below fails (private mode / quota): otherwise the
  // next loadBackends() would re-migrate the stale legacy token and resurrect a
  // token the user just cleared. Defer via pendingLegacyRemoval so flush() retries
  // it (after the cleared registry persists) once storage recovers.
  if (!token && (id === LOCAL_BACKEND_ID || !list.some((b) => b.id === id))) {
    pendingLegacyRemoval = true;
  }
  saveBackends(next);
}
