// Client-side auth for the WebUI. The server gates /api and /relay behind a
// shared token when reachable from the network; here we store that token and
// attach it to every request. macaron streams over fetch()+getReader() (not
// the browser EventSource), so a single Authorization header covers plain
// requests and streaming reads alike — no cookie / query-token escape hatch.

const KEY = 'macaron_auth_token';

export function getToken(): string {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setToken(token: string): void {
  try { localStorage.setItem(KEY, token); } catch { /* private mode */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// fetch wrapper that injects the token and re-gates the UI on 401 (expired /
// wrong token). Every call site that hits our own server uses this.
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const t = getToken();
  if (t) headers.set('Authorization', `Bearer ${t}`);
  const resp = await fetch(input, { ...init, headers });
  if (resp.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('macaron:auth-required'));
  }
  return resp;
}

// Bootstrap from a shared link: ?token=... → store it, then strip it from the
// URL so it doesn't linger in history / referrers. Call once at startup.
export function consumeTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('token');
    if (!t) return;
    setToken(t);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch { /* non-browser / malformed URL */ }
}
