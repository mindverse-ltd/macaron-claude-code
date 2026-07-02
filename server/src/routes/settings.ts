import type { FastifyInstance } from 'fastify';
import {
  readPublicSettings,
  writeSettings,
  type Provider,
} from '../lib/settings-store.js';

type PutBody = {
  provider?: Provider;
  providers?: {
    macaron?: {
      apiKey?: string;
    };
  };
};

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => await readPublicSettings());

  app.put<{ Body: PutBody }>('/api/settings', async (req, reply) => {
    try {
      const body = req.body || {};
      const next: Parameters<typeof writeSettings>[0] = {};
      if (body.provider === 'anthropic' || body.provider === 'macaron') {
        next.provider = body.provider;
      }
      if (body.providers?.macaron?.apiKey !== undefined) {
        next.providers = {
          macaron: { apiKey: String(body.providers.macaron.apiKey) },
        };
      }
      await writeSettings(next);
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: (e as Error).message });
    }
  });
}
