import type { FastifyInstance } from 'fastify';
import type { UsageResponse } from '@macaron/shared';
import { collectUsage } from '../lib/usage-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS: Record<string, number> = { '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS };

// GET /api/usage?window=7d|30d|90d|all  (default 30d)
// Explicit ?since / ?until (epoch ms) override the window preset.
export async function registerUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { window?: string; since?: string; until?: string } }>(
    '/api/usage',
    async ({ query }): Promise<UsageResponse> => {
      const window = query.window || '30d';
      const until = query.until ? Number(query.until) : Date.now();
      let since: number;
      if (query.since) since = Number(query.since);
      else if (window === 'all') since = 0;
      else since = until - (WINDOWS[window] ?? WINDOWS['30d']!);
      const res = await collectUsage(since, until);
      return { ...res, window };
    },
  );
}
