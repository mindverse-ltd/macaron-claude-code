import type { FastifyInstance } from 'fastify';
import type { UsageResponse } from '@macaron/shared';
import { collectUsage } from '../lib/usage-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS: Record<string, number> = { '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS };

function firstParam(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function numberParam(v: unknown, fallback: number): number {
  const raw = firstParam(v);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// GET /api/usage?window=7d|30d|90d|all  (default 30d)
// Explicit ?since / ?until (epoch ms) override the window preset.
export async function registerUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { window?: string; since?: string; until?: string } }>(
    '/api/usage',
    async ({ query }): Promise<UsageResponse> => {
      const requestedWindow = firstParam(query.window) || '30d';
      // hasOwn, not truthiness: `WINDOWS[requestedWindow]` would accept inherited
      // keys ('constructor', 'toString', '__proto__'…), which make `defaultSince`
      // NaN and defeat the mtime prune + row filter into a full-history scan.
      const window = requestedWindow === 'all' || Object.hasOwn(WINDOWS, requestedWindow) ? requestedWindow : '30d';
      const until = numberParam(query.until, Date.now());
      const defaultSince = window === 'all' ? 0 : until - WINDOWS[window]!;
      const since = numberParam(query.since, defaultSince);
      const res = await collectUsage(since, until);
      return { ...res, window };
    },
  );
}
