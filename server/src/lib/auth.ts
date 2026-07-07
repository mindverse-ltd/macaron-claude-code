import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

// Loopback peers (the local CLI, start.sh's health curl, a browser on the same
// box) are never challenged — auth only guards access from the network.
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1' || ip.startsWith('::ffff:127.');
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// Constant-time string compare that also resists length leaks.
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// The configured token wins. When the server is bound to a non-loopback host
// but no token was set, generate one so an exposed server is never wide open.
export function resolveToken(host: string, configured: string): { token: string; generated: boolean } {
  if (configured) return { token: configured, generated: false };
  if (!isLoopbackHost(host)) return { token: randomBytes(24).toString('base64url'), generated: true };
  return { token: '', generated: false };
}

// Only the API and provider relay are sensitive; static assets + SPA HTML stay
// open so a remote browser can load the app shell and its login screen.
function isProtectedPath(url: string): boolean {
  return url.startsWith('/api/') || url.startsWith('/relay/');
}

function isExemptPath(url: string): boolean {
  return url === '/api/health' || url.startsWith('/api/auth/');
}

export function extractToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof q === 'string' ? q : '';
}

// Fastify onRequest hook. No-op when auth is off; otherwise 401s any protected
// request that isn't from loopback and doesn't carry a valid token.
export function makeAuthHook(token: string) {
  return function authHook(req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
    if (!token || isLoopback(req.ip) || !isProtectedPath(req.url) || isExemptPath(req.url)) return done();
    if (tokensMatch(extractToken(req), token)) return done();
    reply.code(401).send({ error: 'authentication required', authRequired: true });
  };
}
