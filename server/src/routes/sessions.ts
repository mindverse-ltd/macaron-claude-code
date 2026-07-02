import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { CLAUDE_PROJECTS } from '../config.js';
import { deleteSession, readSessionMessages, readSessionSummary } from '../lib/session-store.js';
import { startSSE, sseSend, sseDone } from '../lib/sse.js';
import { liveGet } from '../lib/live-registry.js';
import { runClaude, type AttachedImage } from '../lib/claude-runner.js';
import { getProviderEnv } from '../lib/settings-store.js';

type Params = { project: string; sid: string };
type MessageBody = {
  text?: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  images?: AttachedImage[];
};

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: Params }>('/api/sessions/claude/:project/:sid', async ({ params }, reply) => {
    try {
      return await readSessionMessages(params.project, params.sid);
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: Params }>('/api/sessions/claude/:project/:sid', async ({ params }, reply) => {
    try {
      await deleteSession(params.project, params.sid);
      return { ok: true };
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
  });

  // SSE: subscribe to a live spawn registered by /api/workspaces/.../sessions.
  // Replays buffered events, then forwards new ones until the spawn closes.
  app.get<{ Params: Params }>('/api/sessions/claude/:project/:sid/live', async (req, reply) => {
    startSSE(reply);
    const ls = liveGet(req.params.sid);
    if (!ls) {
      sseSend(reply, { type: 'live-end', reason: 'not-live' });
      sseDone(reply);
      return;
    }
    for (const ev of ls.events) {
      try {
        sseSend(reply, ev);
      } catch {
        return;
      }
    }
    if (ls.ended) {
      sseDone(reply);
      return;
    }
    ls.subs.add(reply);
    reply.raw.on('close', () => ls.subs.delete(reply));
  });

  // Send a message into an existing session (`claude -p --resume <sid>`).
  app.post<{ Params: Params; Body: MessageBody }>(
    '/api/sessions/claude/:project/:sid/message',
    async (req, reply) => {
      const { project, sid } = req.params;
      const text = String(req.body?.text || '').trim();
      const images = Array.isArray(req.body?.images) ? req.body!.images! : [];
      const model = req.body?.model || 'claude-opus-4-7';
      const permissionMode = req.body?.permissionMode || 'default';
      if (!text && images.length === 0) {
        return reply.status(400).send({ error: 'text or images required' });
      }

      let cwd = process.env.HOME || '/tmp';
      try {
        const head = await readSessionSummary(path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`));
        if (head?.cwd) cwd = head.cwd;
      } catch {
        /* fall back to HOME */
      }

      startSSE(reply);
      sseSend(reply, { type: 'meta', cwd, sessionId: sid });

      let clientGone = false;
      reply.raw.on('close', () => { clientGone = true; });
      const safeSend = (payload: Parameters<typeof sseSend>[1]) => {
        if (clientGone) return;
        try { sseSend(reply, payload); } catch { clientGone = true; }
      };

      // Provider switch: Settings.provider decides whether Claude Code SDK
      // talks to the default Anthropic endpoint or Macaron's /v1/messages.
      // Same tools, same jsonl, same everything — just a different backing LLM.
      const { model: providerModel, env: providerEnv } = getProviderEnv();
      void model; // eslint: kept in body for future per-message override

      (async () => {
        for await (const ev of runClaude({ prompt: text, cwd, resume: sid, model: providerModel, permissionMode, images, envOverrides: providerEnv })) {
          if (ev.kind === 'delta') safeSend({ type: 'delta', text: ev.text });
          else if (ev.kind === 'tool_use') {
            safeSend({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
          }
          else if (ev.kind === 'tool_input_delta') {
            safeSend({ type: 'tool_input_delta', id: ev.id, name: ev.name, partial_json: ev.partial_json, accumulated: ev.accumulated });
          }
          else if (ev.kind === 'tool_input_done') {
            safeSend({ type: 'tool_input_done', id: ev.id, name: ev.name, final_json: ev.final_json });
          }
          else if (ev.kind === 'tool_result') safeSend({ type: 'tool_result', tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
          else if (ev.kind === 'usage') safeSend({ type: 'usage', outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
          else if (ev.kind === 'message') safeSend({ type: 'event', event: 'system', subtype: ev.subtype });
          else if (ev.kind === 'error') safeSend({ type: 'error', error: ev.error });
          else if (ev.kind === 'done') {
            safeSend({ type: 'done', exitCode: ev.exitCode });
            if (!clientGone) sseDone(reply);
          }
        }
      })().catch((e: unknown) => {
        const msg = (e as Error).message;
        safeSend({ type: 'error', error: msg });
        if (!clientGone) sseDone(reply);
      });
    },
  );
}
