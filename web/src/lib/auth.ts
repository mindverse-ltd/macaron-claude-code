// Client-side auth for the WebUI. The server gates /api and /relay behind a
// shared token when reachable from the network; here we store that token and
// attach it to every request. macaron streams over fetch()+getReader() (not
// the browser EventSource), so a single Authorization header covers plain
// requests and streaming reads alike — no cookie / query-token escape hatch.
//
// Outside the docs-hosted handoff, the token and API base come from the active
// backend (see backends.ts). The built-in LOCAL backend has an empty baseUrl, so
// same-origin local usage behaves exactly as before.

import { getActiveBackend, getActiveBackendId, setActiveBackendToken, clearBackendTokenIfMatches } from './backends';
import type { Backend } from './backends';
import { clearApiBase, getApiBase, isLoopbackBase, setApiBase } from './apiBase';

const KEY = 'macaron_auth_token';

// sessionStorage key the docs connect page WRITES and we READ once on load.
// Must stay identical to HANDOFF_KEY in site/app/lib/hosted-target.ts.
const HANDOFF_KEY = 'macaron_connect_handoff';

type RequestAuth = {
  backend: Backend | null;
  baseUrl: string;
  hosted: boolean;
  token: string;
};

// Derive the request URL / auth header from a SINGLE backend snapshot. authedFetch
// takes one snapshot and uses these, so a mid-flight backend switch can never pair
// one backend's baseUrl with another's token (a TOCTOU the two-call form allowed).
function urlFor(baseUrl: string, path: string, apiOnly = false): string {
  if (!baseUrl || /^https?:\/\//i.test(path)) return path;
  if (apiOnly && !path.startsWith('/api') && !path.startsWith('/relay')) return path;
  return baseUrl + path;
}

function headerFor(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function tokenKey(baseUrl: string): string {
  return baseUrl ? `${KEY}::${baseUrl}` : KEY;
}

function getSessionToken(baseUrl: string): string {
  try { return sessionStorage.getItem(tokenKey(baseUrl)) || ''; } catch { return ''; }
}

function setSessionToken(baseUrl: string, token: string): void {
  try { sessionStorage.setItem(tokenKey(baseUrl), token); } catch { /* private mode */ }
}

function clearSessionToken(baseUrl: string): void {
  try { sessionStorage.removeItem(tokenKey(baseUrl)); } catch { /* private mode */ }
}

function clearSessionTokenIfMatches(baseUrl: string, expectedToken: string): boolean {
  try {
    const key = tokenKey(baseUrl);
    if ((sessionStorage.getItem(key) || '') !== expectedToken) return false;
    sessionStorage.removeItem(key);
    return true;
  } catch {
    // Hosted mode historically re-gated on every 401 even when storage was
    // unavailable; keep that behavior because the rejected credential cannot
    // be trusted merely because its cleanup failed.
    return true;
  }
}

function requestAuth(): RequestAuth {
  const hostedBase = getApiBase();
  if (hostedBase) {
    return { backend: null, baseUrl: hostedBase, hosted: true, token: getSessionToken(hostedBase) };
  }
  const backend = getActiveBackend();
  return { backend, baseUrl: backend.baseUrl, hosted: false, token: backend.token || '' };
}

function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/\.$/, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host.startsWith('127.') || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

export function getToken(): string {
  const hostedBase = getApiBase();
  return hostedBase ? getSessionToken(hostedBase) : getActiveBackend().token || '';
}

export function setToken(token: string): void {
  const hostedBase = getApiBase();
  if (hostedBase) setSessionToken(hostedBase, token);
  else setActiveBackendToken(token);
}

export function clearToken(): void {
  const hostedBase = getApiBase();
  if (hostedBase) clearSessionToken(hostedBase);
  else setActiveBackendToken('');
}

export function authHeaders(): Record<string, string> {
  return headerFor(getToken());
}

// Prefix a relative /api path with the active backend's base. Absolute URLs and
// the local default (empty base) pass through unchanged, so same-origin
// requests stay byte-for-byte identical to before.
export function apiUrl(path: string): string {
  const request = requestAuth();
  return urlFor(request.baseUrl, path, request.hosted);
}

// fetch wrapper that injects the token and re-gates the UI on 401 (expired /
// wrong token). Every call site that hits our own server uses this.
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  // ONE snapshot for both URL and token — see urlFor/headerFor. Reading them via
  // separate getActiveBackend() calls would let a backend switch between the two
  // send backend A's token to backend B's origin.
  const request = requestAuth();
  const headers = new Headers(init.headers);
  const auth = headerFor(request.token);
  if (auth.Authorization) headers.set('Authorization', auth.Authorization);
  const extra: RequestInit = {};
  // Cross-origin mode needs credentials mode explicit, and loopback targets
  // want the LNA hint so Chrome skips the mixed-content check.
  if (request.baseUrl) {
    extra.mode = 'cors';
    if (request.backend ? isLoopbackUrl(request.baseUrl) : isLoopbackBase()) {
      (extra as { targetAddressSpace?: string }).targetAddressSpace = 'loopback';
    }
  }
  const resp = await fetch(urlFor(request.baseUrl, input, request.hosted), { ...init, ...extra, headers });
  if (resp.status === 401) {
    // Clear the token THIS request actually used — bound by id AND value from the snapshot.
    // Binding the value means a token refreshed on this backend mid-flight survives a stale
    // 401, and a backend deleted mid-flight clears nothing (no id fallback onto LOCAL). Only
    // re-gate the UI when we ACTUALLY cleared the current credential AND that backend is STILL
    // the active one: a no-op clear (already refreshed / backend gone) must not lock a valid
    // backend behind the login gate, and a stale 401 for backend A after the user switched to a
    // valid B must clear A silently — never gate B (whose token is fine) behind A's failure.
    const cleared = request.backend
      ? clearBackendTokenIfMatches(request.backend.id, request.token)
      : clearSessionTokenIfMatches(request.baseUrl, request.token);
    const stillActive = request.backend
      ? getActiveBackendId() === request.backend.id
      : getApiBase() === request.baseUrl;
    if (cleared && stillActive) {
      window.dispatchEvent(new Event('macaron:auth-required'));
    }
  }
  return resp;
}

// Hosted-mode bootstrap. The docs connect page validated the server target and
// stashed {server, token} in sessionStorage (same tab, same origin) — never on
// the URL, so the credential can't leak into the document GET / logs / referrers.
// Read it ONCE, bind the api base FIRST so the token is keyed to that origin,
// then store the token atomically with it, and delete the handoff.
//
// Only this same-tab handoff is trusted: a hand-crafted `/app?server=<attacker>`
// carries no handoff and is ignored, so the connect page's scheme / self-origin
// / public-HTTP validation cannot be bypassed by a direct link. Call once at
// startup, before anything fetches. No handoff leaves the active backend intact.
export function consumeHandoff(): void {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(HANDOFF_KEY); sessionStorage.removeItem(HANDOFF_KEY); } catch { return; }
  if (!raw) return;
  try {
    const { server, token } = JSON.parse(raw) as { server?: string; token?: string };
    if (!server) return;
    setApiBase(server);                       // bind origin FIRST → token keys to it
    if (token) setToken(token); else clearToken();
  } catch { clearApiBase(); }                 // malformed handoff → no half-bound base
}
