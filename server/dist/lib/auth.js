import { randomBytes, timingSafeEqual } from 'node:crypto';
// Loopback peers (the local CLI, start.sh's health curl, a browser on the same
// box) are never challenged — auth only guards access from the network.
export function isLoopback(ip) {
    if (!ip)
        return false;
    return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1' || ip.startsWith('::ffff:127.');
}
export function isLoopbackHost(host) {
    // Match the whole IPv4 loopback block 127.0.0.0/8, mirroring isLoopback — a
    // 127.x bind (e.g. 127.0.0.2) is still fully local and must not trip the
    // "exposed to the network" auto-generate path.
    return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}
// Constant-time string compare that also resists length leaks.
export function tokensMatch(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length)
        return false;
    return timingSafeEqual(ab, bb);
}
// The configured token wins. When the server is bound to a non-loopback host
// but no token was set, generate one so an exposed server is never wide open.
export function resolveToken(host, configured) {
    if (configured)
        return { token: configured, generated: false };
    if (!isLoopbackHost(host))
        return { token: randomBytes(24).toString('base64url'), generated: true };
    return { token: '', generated: false };
}
// Only the API and provider relay are sensitive; static assets + SPA HTML stay
// open so a remote browser can load the app shell and its login screen.
function isProtectedPath(url) {
    return url.startsWith('/api/') || url.startsWith('/relay/');
}
function isExemptPath(url) {
    return url === '/api/health' || url.startsWith('/api/auth/');
}
// The path to match the guard against: the resolved route pattern, which
// Fastify has already percent-decoded (e.g. /api/workspaces/:project). Matching
// the raw req.url instead lets an encoded request like /%61pi/... (== /api/...)
// slip past the prefix check while the router still dispatches it to the real
// handler. No matched route (static assets, SPA fallback) → req.url, which
// stays open by intent.
function routePath(req) {
    return req.routeOptions?.url ?? req.url;
}
export function extractToken(req) {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer '))
        return header.slice(7);
    const q = req.query?.token;
    return typeof q === 'string' ? q : '';
}
// The `token` query param doubles as a share-link credential, so it must never
// reach the logs. Fastify/pino's default req serializer logs `req.url` verbatim
// (query and all) on every request — strip any token value before it lands in
// structured output.
export function redactTokenInUrl(url) {
    return url.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}
// Fastify onRequest hook. No-op when auth is off; otherwise 401s any protected
// request that isn't from loopback and doesn't carry a valid token.
export function makeAuthHook(token) {
    return function authHook(req, reply, done) {
        const path = routePath(req);
        if (!token || isLoopback(req.ip) || !isProtectedPath(path) || isExemptPath(path))
            return done();
        if (tokensMatch(extractToken(req), token))
            return done();
        reply.code(401).send({ error: 'authentication required', authRequired: true });
    };
}
//# sourceMappingURL=auth.js.map