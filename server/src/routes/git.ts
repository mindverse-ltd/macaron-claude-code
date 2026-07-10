// Git panel API. Mounted under /api/git/*. Everything runs against a
// workspace cwd resolved from the claude project name (the same cwd the
// agent edits in), so the panel shows exactly what the agent just changed.
//
// Shape:
//   GET  /api/git/:project/status                — porcelain status + branch + ahead/behind
//   GET  /api/git/:project/diff?file&staged&untracked — unified diff for one file
//   POST /api/git/:project/stage                 — { files[] } → git add
//   POST /api/git/:project/unstage               — { files[] } → git restore --staged
//   POST /api/git/:project/commit                — { message, all? } → git commit
//   GET  /api/git/:project/branches              — local branches + current
//   POST /api/git/:project/checkout              — { branch, create? } → git checkout

import type { FastifyInstance } from 'fastify';
import * as g from '../lib/git.js';

type Params = { project: string };

export async function registerGitRoutes(app: FastifyInstance): Promise<void> {
  const cwdOf = (project: string) => g.resolveProjectCwd(project);

  const fail = (reply: import('fastify').FastifyReply, e: unknown) => {
    const code = e instanceof g.GitError ? 400 : 500;
    return reply.status(code).send({ error: (e as Error).message });
  };

  app.get<{ Params: Params }>('/api/git/:project/status', async ({ params }, reply) => {
    try {
      return await g.status(await cwdOf(params.project));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: Params; Querystring: { file?: string; staged?: string; untracked?: string } }>(
    '/api/git/:project/diff',
    async ({ params, query }, reply) => {
      const file = String(query.file || '');
      if (!file) return reply.status(400).send({ error: 'file required' });
      try {
        const diff = await g.diff(await cwdOf(params.project), file, {
          staged: query.staged === '1' || query.staged === 'true',
          untracked: query.untracked === '1' || query.untracked === 'true',
        });
        return { diff };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.post<{ Params: Params; Body: { files?: string[] } }>(
    '/api/git/:project/stage',
    async ({ params, body }, reply) => {
      const files = Array.isArray(body?.files) ? body!.files!.filter((f) => typeof f === 'string') : [];
      if (files.length === 0) return reply.status(400).send({ error: 'files required' });
      try {
        await g.stage(await cwdOf(params.project), files);
        return { ok: true };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.post<{ Params: Params; Body: { files?: string[] } }>(
    '/api/git/:project/unstage',
    async ({ params, body }, reply) => {
      const files = Array.isArray(body?.files) ? body!.files!.filter((f) => typeof f === 'string') : [];
      if (files.length === 0) return reply.status(400).send({ error: 'files required' });
      try {
        await g.unstage(await cwdOf(params.project), files);
        return { ok: true };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.post<{ Params: Params; Body: { message?: string; all?: boolean } }>(
    '/api/git/:project/commit',
    async ({ params, body }, reply) => {
      const message = String(body?.message || '').trim();
      if (!message) return reply.status(400).send({ error: 'message required' });
      try {
        const output = await g.commit(await cwdOf(params.project), message, Boolean(body?.all));
        return { ok: true, output };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get<{ Params: Params }>('/api/git/:project/branches', async ({ params }, reply) => {
    try {
      return await g.branches(await cwdOf(params.project));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: Params; Body: { branch?: string; create?: boolean } }>(
    '/api/git/:project/checkout',
    async ({ params, body }, reply) => {
      const branch = String(body?.branch || '').trim();
      if (!branch) return reply.status(400).send({ error: 'branch required' });
      try {
        const output = await g.checkout(await cwdOf(params.project), branch, Boolean(body?.create));
        return { ok: true, output };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
