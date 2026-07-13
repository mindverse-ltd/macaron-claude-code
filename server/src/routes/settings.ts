import type { FastifyInstance } from 'fastify';
import {
  readPublicSettings,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  setDefaultPermissionMode,
  setFollowupSuggestionsEnabled,
} from '../lib/settings-store.js';

type AddBody = { name?: string; endpoint?: string; model?: string; apiKey?: string };
type UpdateBody = { name?: string; endpoint?: string; model?: string; apiKey?: string };
type ActiveBody = { providerId?: string };
type YoloBody = { enabled?: boolean };
type FollowupsBody = { enabled?: boolean };

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => await readPublicSettings());

  app.post<{ Body: AddBody }>('/api/settings/providers', async (req, reply) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const endpoint = String(b.endpoint || '').trim();
    const model = String(b.model || '').trim();
    const apiKey = String(b.apiKey || '');
    if (!name) return reply.status(400).send({ error: 'name required' });
    if (!endpoint) return reply.status(400).send({ error: 'endpoint required' });
    if (!model) return reply.status(400).send({ error: 'model required' });
    try {
      const created = await addProvider({ name, endpoint, model, apiKey });
      return { id: created.id, settings: await readPublicSettings() };
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });

  app.put<{ Params: { id: string }; Body: UpdateBody }>(
    '/api/settings/providers/:id',
    async (req, reply) => {
      const b = req.body || {};
      const patch: UpdateBody = {};
      if (typeof b.name === 'string') patch.name = b.name;
      if (typeof b.endpoint === 'string') patch.endpoint = b.endpoint;
      if (typeof b.model === 'string') patch.model = b.model;
      if (typeof b.apiKey === 'string') patch.apiKey = b.apiKey;
      try {
        const updated = await updateProvider(req.params.id, patch);
        if (!updated) return reply.status(404).send({ error: 'provider not found' });
        return await readPublicSettings();
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/settings/providers/:id',
    async (req, reply) => {
      try {
        const ok = await deleteProvider(req.params.id);
        if (!ok) return reply.status(404).send({ error: 'provider not found' });
        return await readPublicSettings();
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  app.put<{ Body: ActiveBody }>('/api/settings/active', async (req, reply) => {
    const id = String(req.body?.providerId || '');
    if (!id) return reply.status(400).send({ error: 'providerId required' });
    try {
      const ok = await setActiveProvider(id);
      if (!ok) return reply.status(404).send({ error: 'provider not found' });
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });

  // Toggle YOLO mode (global bypassPermissions). When enabled, every SDK
  // subprocess is launched with permissionMode='bypassPermissions' +
  // allowDangerouslySkipPermissions=true, regardless of what the WebUI sends.
  // Returns the full public settings so the client can update its UI.
  app.put<{ Body: YoloBody }>('/api/settings/yolo', async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled (boolean) required' });
    }
    try {
      // Back-compat: legacy /api/settings/yolo maps onto
      // defaultPermissionMode ('bypassPermissions' when enabled, else 'default').
      await setDefaultPermissionMode(req.body.enabled ? 'bypassPermissions' : 'default');
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });

  app.put<{ Body: FollowupsBody }>('/api/settings/followups', async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled (boolean) required' });
    }
    try {
      await setFollowupSuggestionsEnabled(req.body.enabled);
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });
}
