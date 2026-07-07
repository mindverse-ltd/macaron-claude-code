import type { FastifyInstance } from 'fastify';
import { getActiveProviderEnv } from '../lib/settings-store.js';
import { isSearchEnabled, indexStats } from '../lib/search-index.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const { model } = getActiveProviderEnv();
    return {
      ok: true,
      model: model || 'claude-opus-4-7',
      search: isSearchEnabled() ? indexStats() : null,
    };
  });
}
