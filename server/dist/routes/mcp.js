import { readPublicMcpServers, addServer, updateServer, deleteServer, } from '../lib/mcp-store.js';
// A string map must be a plain object whose every value is a string; anything
// else is rejected rather than coerced, so a raw API call can't smuggle arrays
// or objects into the user's real ~/.claude.json (e.g. {"env":{"TOKEN":["x"]}}).
// `undefined` (field absent) is allowed and means "leave unchanged".
function parseStringMap(v, field) {
    if (v === undefined)
        return { value: {} };
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return { error: `${field} must be an object` };
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        if (typeof val !== 'string')
            return { error: `${field}.${k} must be a string` };
        out[k] = val;
    }
    return { value: out };
}
function parseBody(b) {
    const transport = String(b.transport || '');
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
        return { error: 'transport must be stdio, http, or sse' };
    }
    const env = parseStringMap(b.env, 'env');
    if ('error' in env)
        return env;
    const headers = parseStringMap(b.headers, 'headers');
    if ('error' in headers)
        return headers;
    return {
        name: String(b.name || ''),
        transport,
        command: typeof b.command === 'string' ? b.command : undefined,
        args: Array.isArray(b.args) ? b.args.map(String) : undefined,
        url: typeof b.url === 'string' ? b.url : undefined,
        env: Object.keys(env.value).length ? env.value : undefined,
        headers: Object.keys(headers.value).length ? headers.value : undefined,
    };
}
export async function registerMcpRoutes(app) {
    app.get('/api/mcp/servers', async () => ({ servers: await readPublicMcpServers() }));
    app.post('/api/mcp/servers', async (req, reply) => {
        const parsed = parseBody(req.body || {});
        if ('error' in parsed)
            return reply.status(400).send({ error: parsed.error });
        try {
            const r = await addServer(parsed);
            if ('status' in r)
                return reply.status(r.status).send({ error: r.message });
            return { servers: await readPublicMcpServers() };
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    app.put('/api/mcp/servers/:name', async (req, reply) => {
        const parsed = parseBody(req.body || {});
        if ('error' in parsed)
            return reply.status(400).send({ error: parsed.error });
        try {
            const r = await updateServer(req.params.name, parsed);
            if ('status' in r)
                return reply.status(r.status).send({ error: r.message });
            return { servers: await readPublicMcpServers() };
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    app.delete('/api/mcp/servers/:name', async (req, reply) => {
        try {
            const r = await deleteServer(req.params.name);
            if ('status' in r)
                return reply.status(r.status).send({ error: r.message });
            return { servers: await readPublicMcpServers() };
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
}
//# sourceMappingURL=mcp.js.map