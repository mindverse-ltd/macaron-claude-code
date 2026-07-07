import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { CreatePrRequest } from '@macaron/shared';
import { CLAUDE_PROJECTS } from '../config.js';
import { decodeClaudeProjectName, readSessionSummary } from '../lib/session-store.js';
import { getPrContext, createPr } from '../lib/git.js';

type Params = { project: string; sid: string };

// Resolve the session's working directory the same way sessions.ts does:
// prefer the cwd embedded in the jsonl head, fall back to the decoded project
// name (which mirrors claude-cli's cwd encoding).
async function resolveCwd(project: string, sid: string): Promise<string> {
  let cwd = decodeClaudeProjectName(project) || process.env.HOME || '/tmp';
  try {
    const head = await readSessionSummary(path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`));
    if (head?.cwd) cwd = head.cwd;
  } catch {
    /* fall back to decoded project name */
  }
  return cwd;
}

export async function registerGitRoutes(app: FastifyInstance): Promise<void> {
  // Branch/ahead/dirty/existing-PR snapshot used to prefill and gate the
  // Create-PR dialog.
  app.get<{ Params: Params }>(
    '/api/sessions/claude/:project/:sid/pr-context',
    async ({ params }, reply) => {
      const cwd = await resolveCwd(params.project, params.sid);
      try {
        return await getPrContext(cwd);
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
    },
  );

  // Push the branch and open (or resolve an existing) PR.
  app.post<{ Params: Params; Body: CreatePrRequest }>(
    '/api/sessions/claude/:project/:sid/pr',
    async (req, reply) => {
      const title = String(req.body?.title || '').trim();
      if (!title) return reply.status(400).send({ error: 'title required' });
      const body = String(req.body?.body || '');
      const draft = Boolean(req.body?.draft);
      const cwd = await resolveCwd(req.params.project, req.params.sid);
      try {
        return await createPr(cwd, { title, body, draft });
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
    },
  );
}
