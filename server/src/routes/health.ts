import type { FastifyInstance } from 'fastify';
import { readPublicSettings } from '../lib/settings-store.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const s = await readPublicSettings();
    return {
      ok: true,
      provider: s.provider,
      model: s.provider === 'macaron' ? s.providers.macaron.model : 'claude-opus-4-7',
    };
  });
  // Legacy /api/config kept for the older WebUI bundle — the Settings page
  // uses /api/settings. Both surface the same underlying state.
  app.get('/api/config', async () => {
    const s = await readPublicSettings();
    return {
      macaron: {
        base: s.providers.macaron.base,
        model: s.providers.macaron.model,
        configured: s.providers.macaron.configured,
      },
    };
  });
}
