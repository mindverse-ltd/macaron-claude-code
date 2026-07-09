import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { CLAUDE_PROJECTS } from '../config.js';
import { decodeClaudeProjectName, readSessionSummary } from '../lib/session-store.js';
import { startSSE } from '../lib/sse.js';
import { getOrCreatePty, ptySubscribe, ptyInput, ptyResize, killPty } from '../lib/pty-registry.js';

type Params = { project: string; tid: string };

// Resolve a workspace cwd from its encoded project name the same way
// workspaces.ts does: prefer the cwd embedded in an existing session's jsonl,
// else the decoded project name (which mirrors claude-cli's encoding).
async function resolveCwd(project: string): Promise<string> {
  let cwd = decodeClaudeProjectName(project);
  try {
    const projDir = path.join(CLAUDE_PROJECTS, project);
    for (const f of await fs.readdir(projDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const meta = await readSessionSummary(path.join(projDir, f));
      if (meta?.cwd) { cwd = meta.cwd; break; }
    }
  } catch {
    /* no sessions yet — fall back to decoded name */
  }
  return cwd;
}

export async function registerTerminalRoutes(app: FastifyInstance): Promise<void> {
  // SSE: spawn (on first hit) and stream a PTY. cols/rows come from the
  // client's initial fit so the shell starts at the right size.
  app.get<{ Params: Params; Querystring: { cols?: string; rows?: string } }>(
    '/api/terminal/:project/:tid/stream',
    async (req, reply) => {
      const cols = Math.max(1, parseInt(req.query.cols || '80', 10) || 80);
      const rows = Math.max(1, parseInt(req.query.rows || '24', 10) || 24);
      const cwd = await resolveCwd(req.params.project);
      try {
        const st = await fs.stat(cwd);
        if (!st.isDirectory()) throw new Error('not a directory');
      } catch (e) {
        return reply.status(400).send({ error: `cwd unusable: ${cwd} (${(e as Error).message})` });
      }
      try {
        getOrCreatePty(req.params.tid, { cwd, cols, rows });
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
      startSSE(reply);
      ptySubscribe(req.params.tid, reply);
    },
  );

  app.post<{ Params: Params; Body: { data?: string } }>(
    '/api/terminal/:project/:tid/input',
    async (req, reply) => {
      const data = typeof req.body?.data === 'string' ? req.body.data : '';
      const ok = ptyInput(req.params.tid, data);
      return reply.send({ ok });
    },
  );

  app.post<{ Params: Params; Body: { cols?: number; rows?: number } }>(
    '/api/terminal/:project/:tid/resize',
    async (req, reply) => {
      const cols = Number(req.body?.cols);
      const rows = Number(req.body?.rows);
      const ok = ptyResize(req.params.tid, cols, rows);
      return reply.send({ ok });
    },
  );

  app.post<{ Params: Params }>('/api/terminal/:project/:tid/kill', async (req, reply) => {
    const ok = killPty(req.params.tid);
    return reply.send({ ok });
  });
}
