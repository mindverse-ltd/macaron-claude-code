import { readPublicSettings, addProvider, updateProvider, deleteProvider, setActiveProvider, setYoloMode, } from '../lib/settings-store.js';
export async function registerSettingsRoutes(app) {
    app.get('/api/settings', async () => await readPublicSettings());
    app.post('/api/settings/providers', async (req, reply) => {
        const b = req.body || {};
        const name = String(b.name || '').trim();
        const endpoint = String(b.endpoint || '').trim();
        const model = String(b.model || '').trim();
        const apiKey = String(b.apiKey || '');
        if (!name)
            return reply.status(400).send({ error: 'name required' });
        if (!endpoint)
            return reply.status(400).send({ error: 'endpoint required' });
        if (!model)
            return reply.status(400).send({ error: 'model required' });
        try {
            const created = await addProvider({ name, endpoint, model, apiKey });
            return { id: created.id, settings: await readPublicSettings() };
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    app.put('/api/settings/providers/:id', async (req, reply) => {
        const b = req.body || {};
        const patch = {};
        if (typeof b.name === 'string')
            patch.name = b.name;
        if (typeof b.endpoint === 'string')
            patch.endpoint = b.endpoint;
        if (typeof b.model === 'string')
            patch.model = b.model;
        if (typeof b.apiKey === 'string')
            patch.apiKey = b.apiKey;
        try {
            const updated = await updateProvider(req.params.id, patch);
            if (!updated)
                return reply.status(404).send({ error: 'provider not found' });
            return await readPublicSettings();
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    app.delete('/api/settings/providers/:id', async (req, reply) => {
        try {
            const ok = await deleteProvider(req.params.id);
            if (!ok)
                return reply.status(404).send({ error: 'provider not found' });
            return await readPublicSettings();
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    app.put('/api/settings/active', async (req, reply) => {
        const id = String(req.body?.providerId || '');
        if (!id)
            return reply.status(400).send({ error: 'providerId required' });
        try {
            const ok = await setActiveProvider(id);
            if (!ok)
                return reply.status(404).send({ error: 'provider not found' });
            return await readPublicSettings();
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    // Toggle YOLO mode (global bypassPermissions). When enabled, every SDK
    // subprocess is launched with permissionMode='bypassPermissions' +
    // allowDangerouslySkipPermissions=true, regardless of what the WebUI sends.
    // Returns the full public settings so the client can update its UI.
    app.put('/api/settings/yolo', async (req, reply) => {
        if (typeof req.body?.enabled !== 'boolean') {
            return reply.status(400).send({ error: 'enabled (boolean) required' });
        }
        try {
            await setYoloMode(req.body.enabled);
            return await readPublicSettings();
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
}
//# sourceMappingURL=settings.js.map