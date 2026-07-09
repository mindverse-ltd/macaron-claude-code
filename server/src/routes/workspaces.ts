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
import { runClaude, runFollowup, type AttachedImage } from '../lib/claude-runner.js';
import { registerRun, endRun } from '../lib/active-runs.js';
import { getActiveProviderEnv, getFollowupSuggestionsEnabled } from '../lib/settings-store.js';
import { pushPermissionRequest, pushSessionDone } from '../lib/push-notify.js';
import { createWorktree, bindWorktree, cleanupPendingWorktree, type PendingWorktree } from '../lib/worktree-store.js';

type Params = { project: string };
type NewSessionBody = {
  text?: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  images?: AttachedImage[];
  // When true, run this session in a dedicated git worktree + branch off the
  // repo's current HEAD, so it doesn't share the working tree with siblings.
  // Silently no-ops if the derived cwd isn't a git work tree.
  isolate?: boolean;
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

      // Optional worktree isolation: create a dedicated branch+worktree off the
      // repo's HEAD and run the agent there. Created BEFORE the run so cwd
      // exists; the record is bound to the sessionId once the SDK emits it.
      let pendingWt: PendingWorktree | null = null;
      if (req.body?.isolate) {
        try {
          pendingWt = await createWorktree(cwd);
          if (pendingWt) cwd = pendingWt.worktreePath;
        } catch (e) {
          return reply.status(400).send({ error: `worktree create failed: ${(e as Error).message}` });
        }
      }

      startSSE(reply);
      sseSend(reply, { type: 'starting', cwd });

      // Pass an abortController so a later `/stop` (from the Session view
      // once it has a sid) can interrupt this stream. Navigating away does
      // NOT abort — only an explicit /stop does.
      const abortController = new AbortController();
      const stream = runClaude({ prompt: text, cwd, model, permissionMode, images, envOverrides: providerEnv, abortController });

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
            registerRun(capturedSid, abortController);
            if (pendingWt) bindWorktree(capturedSid, pendingWt).catch(() => {});
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
          } else if (ev.kind === 'permission_request') {
            const payload = { type: 'permission_request' as const, id: ev.id, toolName: ev.toolName, input: ev.input, suggestion: ev.suggestion };
            safeSend(payload);
            if (capturedSid) {
              livePush(capturedSid, payload);
              pushPermissionRequest(project, capturedSid, ev.toolName);
            }
          } else if (ev.kind === 'permission_resolved') {
            const payload = { type: 'permission_resolved' as const, id: ev.id, decision: ev.decision };
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
            if (capturedSid) {
              liveEnd(capturedSid, { type: 'done', exitCode: ev.exitCode });
              endRun(capturedSid);
              pushSessionDone(project, capturedSid);
            }
            // Same post-turn follow-up as the resume path: stream a throwaway,
            // persistSession:false query resuming this fresh session (shared
            // prefix → cache hit). Best-effort; never blocks the turn close.
            // Gated on exitCode 0 so an abort/error stays identical to before.
            if (!clientGone && capturedSid && ev.exitCode === 0 && getFollowupSuggestionsEnabled()) {
              try {
                for await (const delta of runFollowup({ resume: capturedSid, cwd, model, envOverrides: providerEnv })) {
                  if (clientGone) break;
                  safeSend({ type: 'followup_delta', text: delta });
                }
              } catch {
                /* swallow: follow-up is enrichment, never fatal */
              }
            }
            if (!clientGone) sseDone(reply);
          }
        }
        // Stream ended without ever emitting a session (startup failure: bad
        // provider/auth/model). Tear down the pre-created worktree so it doesn't
        // leak untracked — bindWorktree only runs when capturedSid is set.
        if (pendingWt && !capturedSid) await cleanupPendingWorktree(pendingWt);
      })().catch((e: unknown) => {
        const msg = (e as Error).message;
        safeSend({ type: 'error', error: msg });
        if (pendingWt && !capturedSid) cleanupPendingWorktree(pendingWt).catch(() => {});
        if (capturedSid) {
          liveEnd(capturedSid, { type: 'done', exitCode: -1, error: msg });
          endRun(capturedSid);
        }
        if (!clientGone) sseDone(reply);
      });
    },
  );
}
