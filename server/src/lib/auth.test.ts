import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isCrossOriginRequest, isLocalRequest, makeAuthHook, setArmedToken } from './auth.js';

// Minimal FastifyRequest double: only the fields the auth predicates read.
function req(opts: { ip?: string; host?: string; origin?: string; auth?: string; url?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.host) headers.host = opts.host;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.auth) headers.authorization = opts.auth;
  return { ip: opts.ip ?? '127.0.0.1', headers, url: opts.url ?? '/api/settings', routeOptions: { url: opts.url ?? '/api/settings' } } as never;
}
function reply() {
  let code = 0; let sent = false;
  return { code_: () => code, sent_: () => sent, code(c: number) { code = c; return this; }, send() { sent = true; return this; } };
}

afterEach(() => setArmedToken(''));

test('isCrossOriginRequest: cross-origin Origin true, same-origin/no-origin false', () => {
  assert.equal(isCrossOriginRequest(req({ origin: 'https://hosted.example', host: '127.0.0.1:7878' })), true);
  assert.equal(isCrossOriginRequest(req({ origin: 'http://127.0.0.1:7878', host: '127.0.0.1:7878' })), false);
  assert.equal(isCrossOriginRequest(req({ host: '127.0.0.1:7878' })), false); // no Origin (CLI)
});

test('isLocalRequest: loopback CLI (no Origin) is local; loopback + cross-origin Origin is NOT', () => {
  assert.equal(isLocalRequest(req({ ip: '127.0.0.1' })), true);
  // P0-1: a hosted page hitting the loopback server must not inherit the bypass.
  assert.equal(isLocalRequest(req({ ip: '127.0.0.1', origin: 'https://hosted.example', host: '127.0.0.1:7878' })), false);
});

test('auth hook: cross-origin loopback request with wrong token is 401 (P0-1 regression)', () => {
  setArmedToken('correct-token');
  const hook = makeAuthHook();
  const r = reply();
  let done = false;
  hook(req({ ip: '127.0.0.1', origin: 'https://hosted.example', host: '127.0.0.1:7878', auth: 'Bearer wrong' }), r as never, () => { done = true; });
  assert.equal(done, false);
  assert.equal(r.code_(), 401);
});

test('auth hook: cross-origin loopback request with correct token proceeds', () => {
  setArmedToken('correct-token');
  const hook = makeAuthHook();
  const r = reply();
  let done = false;
  hook(req({ ip: '127.0.0.1', origin: 'https://hosted.example', host: '127.0.0.1:7878', auth: 'Bearer correct-token' }), r as never, () => { done = true; });
  assert.equal(done, true);
  assert.equal(r.code_(), 0);
});

test('auth hook: same-box CLI (no Origin) stays frictionless even with a token armed', () => {
  setArmedToken('correct-token');
  const hook = makeAuthHook();
  const r = reply();
  let done = false;
  hook(req({ ip: '127.0.0.1' }), r as never, () => { done = true; });
  assert.equal(done, true);
});
