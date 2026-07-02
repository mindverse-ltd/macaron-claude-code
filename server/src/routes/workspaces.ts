import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { CLAUDE_PROJECTS } from '../config.js';
import {
  decodeClaudeProjectName,
  groupWorkspaces,
  listAllSessions,
  readSessionSummary,
} from '../lib/session-store.js';
import { startSSE, sseSend, sseDone } from '../lib/sse.js';
import { liveStart, livePush, liveEnd } from '../lib/live-registry.js';
import { runClaude, type AttachedImage } from '../lib/claude-runner.js';
import { getActiveProviderEnv } from '../lib/settings-store.js';

type Params = { project: string };
type NewSessionBody = {
  text?: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  images?: AttachedImage[];
};

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/workspaces', async () => {
    const sessions = await listAllSessions();
    return { workspaces: groupWorkspaces(sessions) };
  });

  app.get<{ Params: Params }>('/api/workspaces/:project', async ({ params }) => {
    const sessions = await listAllSessions();
    const mine = sessions.filter((s) => s.project === params.project);
    const meta =
      groupWorkspaces(mine)[0] || {
        project: params.project,
        cwd: '',
        name: params.project,
        sessionCount: 0,
        lastActivity: 0,
        lastSessionId: '',
        lastPreview: '',
      };
    return { workspace: meta, sessions: mine };
  });

  app.post<{ Params: Params; Body: NewSessionBody }>(
    '/api/workspaces/:project/sessions',
    async (req, reply) => {
      const project = req.params.project;
      const text = String(req.body?.text || '').trim();
      const images = Array.isArray(req.body?.images) ? req.body!.images! : [];
      const permissionMode = req.body?.permissionMode || 'default';
      if (!text && images.length === 0) {
        return reply.status(400).send({ error: 'text or images required' });
      }
      // Active provider (from Settings) picks the SDK's backing endpoint.
      // The `model` body field is currently ignored — provider is global.
      const { model, env: providerEnv } = getActiveProviderEnv();

      // Derive cwd from any existing session in this project, else decode the
      // project name (which mirrors claude-cli's encoding).
      let cwd = decodeClaudeProjectName(project);
      try {
        const projDir = path.join(CLAUDE_PROJECTS, project);
        const files = await fs.readdir(projDir);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const meta = await readSessionSummary(path.join(projDir, f));
          if (meta?.cwd) {
            cwd = meta.cwd;
            break;
          }
        }
      } catch {
        /* no sessions yet — fall back to decoded name */
      }

      try {
        const st = await fs.stat(cwd);
        if (!st.isDirectory()) throw new Error('cwd not a directory');
      } catch (e) {
        return reply.status(400).send({ error: `cwd unusable: ${cwd} (${(e as Error).message})` });
      }

      startSSE(reply);
      sseSend(reply, { type: 'starting', cwd });

      // Don't pass abortController — we want the SDK to keep running even if
      // the client navigates away. The live registry handles the post-nav
      // subscription.
      const stream = runClaude({ prompt: text, cwd, model, permissionMode, images, envOverrides: providerEnv });

      let clientGone = false;
      reply.raw.on('close', () => {
        clientGone = true;
      });
      const safeSend = (payload: Parameters<typeof sseSend>[1]) => {
        if (clientGone) return;
        try {
          sseSend(reply, payload);
        } catch {
          clientGone = true;
        }
      };

      let capturedSid = '';
      // Run the iterator in the background so this handler returns immediately
      // (Fastify supports hijacked replies as long as we don't await forever).
      (async () => {
        for await (const ev of stream) {
          if (ev.kind === 'session' && !capturedSid) {
            capturedSid = ev.sessionId;
            liveStart(capturedSid, { cwd });
            livePush(capturedSid, { type: 'user-text', text });
            safeSend({ type: 'meta', cwd, sessionId: capturedSid });
          } else if (ev.kind === 'delta') {
            safeSend({ type: 'delta', text: ev.text });
            if (capturedSid) livePush(capturedSid, { type: 'delta', text: ev.text });
          } else if (ev.kind === 'tool_use') {
            const payload = { type: 'tool_use' as const, id: ev.id, name: ev.name, input: ev.input };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'tool_input_delta') {
            const payload = { type: 'tool_input_delta' as const, id: ev.id, name: ev.name, partial_json: ev.partial_json, accumulated: ev.accumulated };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'tool_input_done') {
            const payload = { type: 'tool_input_done' as const, id: ev.id, name: ev.name, final_json: ev.final_json };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'tool_result') {
            const payload = { type: 'tool_result' as const, tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'usage') {
            const payload = { type: 'usage' as const, outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens };
            safeSend(payload);
            if (capturedSid) livePush(capturedSid, payload);
          } else if (ev.kind === 'message') {
            safeSend({ type: 'event', event: 'system', subtype: ev.subtype });
            if (capturedSid) livePush(capturedSid, { type: 'event', event: 'system', subtype: ev.subtype });
          } else if (ev.kind === 'error') {
            safeSend({ type: 'error', error: ev.error });
            if (capturedSid) livePush(capturedSid, { type: 'error', error: ev.error });
          } else if (ev.kind === 'done') {
            safeSend({ type: 'done', exitCode: ev.exitCode });
            if (capturedSid) liveEnd(capturedSid, { type: 'done', exitCode: ev.exitCode });
            if (!clientGone) sseDone(reply);
          }
        }
      })().catch((e: unknown) => {
        const msg = (e as Error).message;
        safeSend({ type: 'error', error: msg });
        if (capturedSid) liveEnd(capturedSid, { type: 'done', exitCode: -1, error: msg });
        if (!clientGone) sseDone(reply);
      });
    },
  );
}
