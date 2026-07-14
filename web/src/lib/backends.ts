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

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
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
    if (write(BACKENDS_KEY, cache)) { dirty = false; lastSeenRaw = JSON.stringify(cache); }
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
      try { localStorage.removeItem(LEGACY_TOKEN_KEY); pendingLegacyRemoval = false; } catch { /* retry next time */ }
    }
  }
}

// Load the backend list, seeding + migrating on first run. Always returns at
// least the built-in LOCAL backend, and guarantees LOCAL is present even if a
// stored list somehow dropped it.
export function loadBackends(): Backend[] {
  if (cache) {
    // Revalidate against storage: another tab may have cleared a token or added a
    // backend. If we have nothing unpersisted and storage now holds a different
    // registry, adopt it — otherwise the next saveBackends() would clobber the
    // other tab's change with our stale cache.
    if (!dirty) {
      let raw: string | null = null;
      try { raw = localStorage.getItem(BACKENDS_KEY); } catch { /* ignore */ }
      if (raw && raw !== lastSeenRaw) {
        const fresh = read<Backend[]>(BACKENDS_KEY);
        if (fresh && Array.isArray(fresh) && fresh.some((b) => b.id === LOCAL_BACKEND_ID)) {
          cache = fresh;
          lastSeenRaw = raw;
        }
      }
    }
    flush();
    return cache;
  }
  const stored = read<Backend[]>(BACKENDS_KEY);
  if (stored && Array.isArray(stored) && stored.length > 0) {
    if (stored.some((b) => b.id === LOCAL_BACKEND_ID)) {
      cache = stored;
      lastSeenRaw = localStorage.getItem(BACKENDS_KEY);
      // A LOCAL-bearing registry means migration already happened; any leftover
      // legacy key is stale (a previous removal must have failed). Reconcile it
      // here — retried every load — so a later reset can't re-migrate the old token.
      // If the removal fails, defer it via pendingLegacyRemoval so flush() retries
      // it on the next operation (the cache-hit path only retries pending removals).
      try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { pendingLegacyRemoval = true; }
      return cache;
    }
    // Stored backends exist but LOCAL is missing: rebuild it. If a legacy token is
    // still present it was never migrated (no LOCAL ever held it), so absorb it
    // now — otherwise rebuilding a tokenless LOCAL would drop the sole credential.
    const local = localDefault();
    let legacy = '';
    try { legacy = localStorage.getItem(LEGACY_TOKEN_KEY) || ''; } catch { /* ignore */ }
    if (legacy) { local.token = legacy; pendingLegacyRemoval = true; }
    cache = [local, ...stored];
    dirty = true; // persist the reconstructed (LOCAL-containing) list
    flush();
    return cache;
  }
  // First run on a multi-backend build: fold any legacy single token into the
  // local backend so a remembered share-link/tunnel token keeps working. The
  // legacy key is only removed once the seeded list is confirmed persisted (via
  // flush) — else a failed write (private mode / quota) would drop the token with
  // nothing to re-migrate from. A failed persist leaves dirty + pendingLegacyRemoval
  // set, so the next operation after storage recovers completes the migration.
  const local = localDefault();
  let legacy = '';
  try { legacy = localStorage.getItem(LEGACY_TOKEN_KEY) || ''; } catch { /* ignore */ }
  if (legacy) { local.token = legacy; pendingLegacyRemoval = true; }
  cache = [local];
  dirty = true;
  flush();
  return cache;
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
