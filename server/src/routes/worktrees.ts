import type { FastifyInstance } from 'fastify';
import {
  listWorktrees,
  getWorktree,
  mergeWorktree,
  discardWorktree,
  WorktreeError,
} from '../lib/worktree-store.js';

type Params = { sid: string };
type DiscardQuery = { force?: string };

export async function registerWorktreeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/worktrees', async () => {
    return { worktrees: await listWorktrees() };
  });

  app.get<{ Params: Params }>('/api/worktrees/:sid', async ({ params }, reply) => {
    const wt = await getWorktree(params.sid);
    if (!wt) return reply.status(404).send({ error: 'no worktree for this session' });
    return wt;
  });

  app.post<{ Params: Params }>('/api/worktrees/:sid/merge', async ({ params }, reply) => {
    try {
      await mergeWorktree(params.sid);
      return { ok: true, merged: true };
    } catch (e) {
      const status = e instanceof WorktreeError && e.conflict ? 409 : 400;
      return reply.status(status).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: Params; Querystring: DiscardQuery }>(
    '/api/worktrees/:sid/discard',
    async ({ params, query }, reply) => {
      try {
        await discardWorktree(params.sid, query.force === '1' || query.force === 'true');
        return { ok: true };
      } catch (e) {
        const status = e instanceof WorktreeError && e.conflict ? 409 : 400;
        return reply.status(status).send({ error: (e as Error).message });
      }
    },
  );
}
