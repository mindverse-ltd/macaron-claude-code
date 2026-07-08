import { extractToken, isLoopback, tokensMatch } from '../lib/auth.js';
// `token` is the armed shared secret ('' when auth is off). Registered inside
// the same encapsulated scope as the other routes, but these two paths are
// exempt from the auth hook so the login screen can always reach them.
export async function registerAuthRoutes(app, token) {
    // Whether THIS caller must authenticate: a token is armed, they're remote,
    // and they aren't already carrying a valid token (matching the auth hook so
    // a stored token survives a page reload instead of re-prompting).
    app.get('/api/auth/status', async (req) => {
        if (!token || isLoopback(req.ip))
            return { required: false };
        return { required: !tokensMatch(extractToken(req), token) };
    });
    app.post('/api/auth/login', async (req, reply) => {
        const provided = typeof req.body?.token === 'string' ? req.body.token : '';
        if (!token || tokensMatch(provided, token))
            return { ok: true };
        return reply.code(401).send({ error: 'invalid token' });
    });
}
//# sourceMappingURL=auth.js.map