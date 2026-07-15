// Where the WebUI sends its /api and /relay calls. Normally empty: the UI is
// served by the same server it talks to, so every path stays same-origin (the
// historical behavior). When the UI is hosted on a *different* origin (e.g. the
// docs site connecting to a user's local `mcc`/`mcx`), the connect flow records
// that server's origin here and we retarget every API call to it.
//
// Only `/api` and `/relay` paths are rewritten — asset/SPA URLs stay local. The
// base is an origin only (scheme://host[:port]); we reject anything with a path
// so a stored value can't silently reroute non-API URLs.

const KEY = 'macaron_api_base';

let cached: string | null = null;

function normalize(raw: string): string {
  const u = new URL(raw); // throws on garbage → caller falls back to same-origin
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('api base must be an origin, no path');
  return u.origin;
}

export function getApiBase(): string {
  if (cached !== null) return cached;
  try { cached = localStorage.getItem(KEY) || ''; } catch { cached = ''; }
  return cached;
}

export function setApiBase(origin: string): void {
  const clean = normalize(origin);
  cached = clean;
  try { localStorage.setItem(KEY, clean); } catch { /* private mode */ }
}

export function clearApiBase(): void {
  cached = '';
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

// Loopback / private-range hosts are reached over Chrome's Local Network Access
// path; annotating the fetch with targetAddressSpace lets the browser skip the
// mixed-content pre-check (see server CORS + LNA headers). Best-effort: only
// loopback literals/names get flagged, everything else is left to normal rules.
export function isLoopbackBase(): boolean {
  const b = getApiBase();
  if (!b) return false;
  try {
    const h = new URL(b).hostname.replace(/\.$/, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h.startsWith('127.') || h === '[::1]' || h === '::1';
  } catch { return false; }
}

// Retarget an /api or /relay path at the configured server. Absolute URLs and
// non-API paths pass through untouched.
export function resolveApiUrl(input: string): string {
  const base = getApiBase();
  if (!base) return input;
  if (!input.startsWith('/api') && !input.startsWith('/relay')) return input;
  return base + input;
}

// Connect entry for hosted mode: a `?server=<origin>` query (paired with the
// existing `?token=`) points the UI at a remote server, then we strip it from
// the URL so it doesn't linger in history. Same-origin loads have no `?server=`
// and keep the empty base. Call once at startup BEFORE consumeTokenFromUrl.
//
// Credentials are bound to the origin: whenever `?server=` is present we drop
// any previously stored token unless the SAME URL carries a fresh `?token=`.
// Otherwise a token minted for server A would be sent as the bearer — and into
// `/api/events?token=` — of an attacker-supplied server B. `clearToken` is
// passed in (not imported) to avoid an apiBase↔auth import cycle. The URL is
// scrubbed even when the server value is malformed, so a bad `?server=` can't
// linger in history either.
export function consumeServerFromUrl(clearToken?: () => void): void {
  try {
    const url = new URL(window.location.href);
    const server = url.searchParams.get('server');
    if (server === null) return;
    // A `?server=` switch invalidates any stored credential unless this same
    // load also brings a matching token. Clear first; consumeTokenFromUrl runs
    // next and re-sets the token when `?token=` is present.
    if (!url.searchParams.get('token')) clearToken?.();
    try {
      if (server === '') clearApiBase();
      else setApiBase(server); // throws on garbage/with-path
    } finally {
      // Always scrub, even if setApiBase threw on a malformed origin.
      url.searchParams.delete('server');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch { /* non-browser / malformed URL */ }
}
