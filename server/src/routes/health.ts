import type { FastifyInstance } from 'fastify';
import { MACARON_API_BASE, MACARON_MODEL, isMacaronConfigured } from '../config.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, model: MACARON_MODEL }));
  app.get('/api/config', async () => ({
    macaron: {
      base: MACARON_API_BASE,
      model: MACARON_MODEL,
      configured: isMacaronConfigured(),
    },
  }));
}
