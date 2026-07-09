import { listAgents, readAgent, writeAgent, deleteAgent, isValidAgentName, } from '../lib/agents-store.js';
function normalizeTools(tools) {
    if (Array.isArray(tools))
        return tools.map((t) => String(t).trim()).filter(Boolean);
    if (typeof tools === 'string')
        return tools.split(',').map((t) => t.trim()).filter(Boolean);
    return [];
}
function validNameOr400(name, reply) {
    if (isValidAgentName(name))
        return true;
    reply.status(400).send({ error: 'invalid agent name' });
    return false;
}
export async function registerAgentRoutes(app) {
    app.get('/api/agents', async () => ({ agents: await listAgents() }));
    app.get('/api/agents/:name', async (req, reply) => {
        if (!validNameOr400(req.params.name, reply))
            return;
        const a = await readAgent(req.params.name);
        if (!a)
            return reply.status(404).send({ error: 'agent not found' });
        return a;
    });
    app.post('/api/agents', async (req, reply) => {
        const b = req.body || {};
        const name = String(b.name || '').trim();
        const description = String(b.description || '').trim();
        if (!name)
            return reply.status(400).send({ error: 'name required' });
        if (!isValidAgentName(name)) {
            return reply.status(400).send({ error: 'name must be lowercase letters, digits, and hyphens' });
        }
        if (!description)
            return reply.status(400).send({ error: 'description required' });
        if (await readAgent(name))
            return reply.status(409).send({ error: 'agent already exists' });
        const agent = {
            name,
            description,
            tools: normalizeTools(b.tools),
            model: String(b.model || '').trim(),
            prompt: String(b.prompt || ''),
        };
        try {
            await writeAgent(agent);
            return { agents: await listAgents() };
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    app.put('/api/agents/:name', async (req, reply) => {
        if (!validNameOr400(req.params.name, reply))
            return;
        const cur = await readAgent(req.params.name);
        if (!cur)
            return reply.status(404).send({ error: 'agent not found' });
        const b = req.body || {};
        const description = typeof b.description === 'string' ? b.description.trim() : cur.description;
        if (!description)
            return reply.status(400).send({ error: 'description required' });
        const next = {
            // Name is the filename — renaming would orphan the old file, so keep it.
            name: cur.name,
            description,
            tools: b.tools === undefined ? cur.tools : normalizeTools(b.tools),
            model: typeof b.model === 'string' ? b.model.trim() : cur.model,
            prompt: typeof b.prompt === 'string' ? b.prompt : cur.prompt,
            extra: cur.extra,
        };
        try {
            await writeAgent(next);
            return { agents: await listAgents() };
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    app.delete('/api/agents/:name', async (req, reply) => {
        if (!validNameOr400(req.params.name, reply))
            return;
        const ok = await deleteAgent(req.params.name);
        if (!ok)
            return reply.status(404).send({ error: 'agent not found' });
        return { agents: await listAgents() };
    });
}
//# sourceMappingURL=agents.js.map