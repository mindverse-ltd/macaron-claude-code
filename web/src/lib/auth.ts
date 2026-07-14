// Client-side auth for the WebUI. The server gates /api and /relay behind a
// shared token when reachable from the network; here we store that token and
// attach it to every request. macaron streams over fetch()+getReader() (not
// the browser EventSource), so a single Authorization header covers plain
// requests and streaming reads alike — no cookie / query-token escape hatch.
//
// The token and API base now come from the *active backend* (see backends.ts):
// the built-in LOCAL backend has an empty baseUrl + carries the migrated legacy
// token, so same-origin local usage behaves exactly as it did with the old
// single global token.

import { getActiveBackend, setActiveBackendToken } from './backends';
import type { Backend } from './backends';

// Derive the request URL / auth header from a SINGLE backend snapshot. authedFetch
// takes one snapshot and uses these, so a mid-flight backend switch can never pair
// one backend's baseUrl with another's token (a TOCTOU the two-call form allowed).
function urlFor(backend: Backend, path: string): string {
  if (!backend.baseUrl || /^https?:\/\//i.test(path)) return path;
  return backend.baseUrl + path;
}

function headerFor(backend: Backend): Record<string, string> {
  return backend.token ? { Authorization: `Bearer ${backend.token}` } : {};
}

export function getToken(): string {
  return getActiveBackend().token || '';
}

export function setToken(token: string): void {
  setActiveBackendToken(token);
}

export function clearToken(): void {
  setActiveBackendToken('');
}

export function authHeaders(): Record<string, string> {
  return headerFor(getActiveBackend());
}

// Prefix a relative /api path with the active backend's base. Absolute URLs and
// the local default (empty base) pass through unchanged, so same-origin
// requests stay byte-for-byte identical to before.
export function apiUrl(path: string): string {
  return urlFor(getActiveBackend(), path);
}

// fetch wrapper that injects the token and re-gates the UI on 401 (expired /
// wrong token). Every call site that hits our own server uses this.
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  // ONE snapshot for both URL and token — see urlFor/headerFor. Reading them via
  // separate getActiveBackend() calls would let a backend switch between the two
  // send backend A's token to backend B's origin.
  const backend = getActiveBackend();
  const headers = new Headers(init.headers);
  const auth = headerFor(backend);
  if (auth.Authorization) headers.set('Authorization', auth.Authorization);
  const resp = await fetch(urlFor(backend, input), { ...init, headers });
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
