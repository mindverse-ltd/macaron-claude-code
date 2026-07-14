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
// left alone (we don't delete it, so downgrading to an older build still works).
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

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

// Load the backend list, seeding + migrating on first run. Always returns at
// least the built-in LOCAL backend, and guarantees LOCAL is present even if a
// stored list somehow dropped it.
export function loadBackends(): Backend[] {
  const stored = read<Backend[]>(BACKENDS_KEY);
  if (stored && Array.isArray(stored) && stored.length > 0) {
    return stored.some((b) => b.id === LOCAL_BACKEND_ID) ? stored : [localDefault(), ...stored];
  }
  // First run on a multi-backend build: fold any legacy single token into the
  // local backend so a remembered share-link/tunnel token keeps working.
  const local = localDefault();
  let legacy = '';
  try { legacy = localStorage.getItem(LEGACY_TOKEN_KEY) || ''; } catch { /* ignore */ }
  if (legacy) local.token = legacy;
  const seeded = [local];
  write(BACKENDS_KEY, seeded);
  return seeded;
}

export function saveBackends(list: Backend[]): void {
  write(BACKENDS_KEY, list);
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
  saveBackends(next);
}
