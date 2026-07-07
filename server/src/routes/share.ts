import type { FastifyInstance } from 'fastify';
import { createShare, resolveShare, deleteShareBySession } from '../lib/share-store.js';
import { readSessionMessages } from '../lib/session-store.js';

type ShareBody = { project?: string; sid?: string };
type TokenParams = { token: string };

export async function registerShareRoutes(app: FastifyInstance): Promise<void> {
  // Publish a session — mints (or reuses) an unguessable token.
  app.post<{ Body: ShareBody }>('/api/share', async (req, reply) => {
    const project = String(req.body?.project || '').trim();
    const sid = String(req.body?.sid || '').trim();
    if (!project || !sid) return reply.status(400).send({ error: 'project + sid required' });
    const token = await createShare(project, sid);
    return { token };
  });

  // Unshare — revoke by session (the owning UI holds project+sid, not the
  // token). Data on disk is untouched; ok:false if it wasn't shared.
  app.post<{ Body: ShareBody }>('/api/share/revoke', async (req, reply) => {
    const project = String(req.body?.project || '').trim();
    const sid = String(req.body?.sid || '').trim();
    if (!project || !sid) return reply.status(400).send({ error: 'project + sid required' });
    const ok = await deleteShareBySession(project, sid);
    return { ok };
  });

  // Public read: resolve token → session snapshot. No gating — the token IS
  // the capability, and the server is 127.0.0.1-bound.
  app.get<{ Params: TokenParams }>('/api/share/:token', async ({ params }, reply) => {
    const entry = await resolveShare(params.token);
    if (!entry) return reply.status(404).send({ error: 'share not found' });
    try {
      const detail = await readSessionMessages(entry.project, entry.sid);
      return { sessionId: entry.sid, createdAt: entry.createdAt, detail };
    } catch (e) {
      // Token still maps, but the underlying session was deleted/moved.
      return reply.status(404).send({ error: (e as Error).message });
    }
  });
}
