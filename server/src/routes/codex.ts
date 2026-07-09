// Codex-only API surface. Mounted under /api/codex/*. The claude API
// namespace stays pure claude — the two engines don't cross-index each other.
//
// Shape:
//   GET  /api/codex/threads                     — flat list of threads (sorted mtime desc)
//   GET  /api/codex/threads/:sid                — full transcript
//   DELETE /api/codex/threads/:sid              — delete rollout file
//   POST /api/codex/threads                     — start a new thread (SSE)
//   POST /api/codex/threads/:sid/message        — resume + send (SSE)
//   POST /api/codex/threads/:sid/stop           — abort in-flight run
//   GET/PUT /api/codex/config                   — provider config CRUD

import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  deleteCodexSession,
  listCodexSessions,
  readCodexSessionMessages,
} from '../lib/codex-store.js';
import { groupWorkspaces } from '../lib/session-store.js';
import { runCodex } from '../lib/codex-runner.js';
import { maybeGenerateCodexTitle } from '../lib/codex-title.js';
import {
  CODEX_SYSTEM_PROVIDER_ID,
  createCodexProvider,
  deleteCodexProvider,
  readPublicCodexSettings,
  setActiveCodexProvider,
  updateCodexProvider,
  updateCodexRuntime,
  type CodexCustomProvider,
  type CodexRuntimeOptions,
} from '../lib/codex-config.js';
import { startSSE, sseSend, sseDone } from '../lib/sse.js';
import { liveStart, livePush, liveEnd, liveGet } from '../lib/live-registry.js';
import { registerRun, abortRun, endRun } from '../lib/active-runs.js';
import type { AttachedImage } from '../lib/claude-runner.js';
import type { SessionStreamEvent } from '@macaron/shared';

type SidParams = { sid: string };
type NewThreadBody = { text?: string; cwd?: string; images?: AttachedImage[] };
type MessageBody = { text?: string; images?: AttachedImage[] };

export async function registerCodexRoutes(app: FastifyInstance): Promise<void> {
  // --- Threads -----------------------------------------------------------

  app.get('/api/codex/threads', async () => {
    const threads = await listCodexSessions();
    return { threads };
  });

  // Workspaces = codex threads grouped by cwd (same shape as the claude
  // /api/workspaces endpoint so the sidebar layout can mirror claude's).
  app.get('/api/codex/workspaces', async () => {
    const sessions = await listCodexSessions();
    return { workspaces: groupWorkspaces(sessions) };
  });

  app.get<{ Params: { project: string } }>(
    '/api/codex/workspaces/:project',
    async ({ params }) => {
      const sessions = await listCodexSessions();
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
    },
  );

  app.get<{ Params: SidParams }>('/api/codex/threads/:sid', async ({ params }, reply) => {
    try {
      return await readCodexSessionMessages(params.sid);
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: SidParams }>('/api/codex/threads/:sid', async ({ params }, reply) => {
    try {
      await deleteCodexSession(params.sid);
      return { ok: true };
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
  });

  // --- Send / resume -----------------------------------------------------

  const pipeCodexToSSE = (
    reply: Parameters<typeof startSSE>[0],
    stream: ReturnType<typeof runCodex>,
    sid: string | null,
    live: { cwd: string; text: string; hasImages: boolean },
  ) => {
    let clientGone = false;
    reply.raw.on('close', () => { clientGone = true; });
    const safeSend = (payload: Parameters<typeof sseSend>[1]) => {
      if (clientGone) return;
      try { sseSend(reply, payload); } catch { clientGone = true; }
    };
    let capturedSid = sid;
    // Mirror the Claude route: the primary client is written directly, while a
    // parallel copy of every event lands in the live registry so a browser
    // refresh mid-turn can reattach via the snapshot-then-live /live endpoint.
    let liveStarted = false;
    const ensureLive = () => {
      if (liveStarted || !capturedSid) return;
      liveStarted = true;
      liveStart(capturedSid, { cwd: live.cwd });
      // Seed the user bubble for the reattach snapshot whenever the turn had
      // any input — an image-only turn still needs its bubble.
      if (live.text || live.hasImages) livePush(capturedSid, { type: 'user-text', text: live.text });
    };
    ensureLive(); // resume already knows the sid; a new thread waits for `session`
    const relay = (payload: SessionStreamEvent) => {
      safeSend(payload);
      if (capturedSid) livePush(capturedSid, payload);
    };
    (async () => {
      for await (const ev of stream) {
        if (ev.kind === 'session' && !capturedSid) {
          capturedSid = ev.sessionId;
          ensureLive();
          safeSend({ type: 'meta', cwd: live.cwd, sessionId: capturedSid });
        } else if (ev.kind === 'delta') relay({ type: 'delta', text: ev.text });
        else if (ev.kind === 'tool_use') relay({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        else if (ev.kind === 'tool_result') relay({ type: 'tool_result', tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
        else if (ev.kind === 'usage') relay({ type: 'usage', outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
        else if (ev.kind === 'message') relay({ type: 'event', event: 'system', subtype: ev.subtype });
        else if (ev.kind === 'error') relay({ type: 'error', error: ev.error });
        else if (ev.kind === 'done') {
          safeSend({ type: 'done', exitCode: ev.exitCode });
          if (capturedSid) { liveEnd(capturedSid, { type: 'done', exitCode: ev.exitCode }); endRun(capturedSid); }
          // Name the thread from its opening exchange once the turn's rollout
          // has landed. Fire-and-forget: no-op if already titled, never blocks
          // the response, failures swallowed.
          if (capturedSid && ev.exitCode === 0) void maybeGenerateCodexTitle(capturedSid).catch(() => {});
          if (!clientGone) sseDone(reply);
        }
      }
    })().catch((e: unknown) => {
      const msg = (e as Error).message;
      if (capturedSid) { liveEnd(capturedSid, { type: 'done', exitCode: -1, error: msg }); endRun(capturedSid); }
      safeSend({ type: 'error', error: msg });
      if (!clientGone) sseDone(reply);
    });
  };

  app.post<{ Body: NewThreadBody }>('/api/codex/threads', async (req, reply) => {
    const text = String(req.body?.text || '').trim();
    const images = Array.isArray(req.body?.images) ? req.body!.images! : [];
    const cwd = String(req.body?.cwd || process.env.HOME || '/tmp');
    if (!text && images.length === 0) {
      return reply.status(400).send({ error: 'text or images required' });
    }
    try {
      const st = await fs.stat(cwd);
      if (!st.isDirectory()) throw new Error('cwd not a directory');
    } catch (e) {
      return reply.status(400).send({ error: `cwd unusable: ${cwd} (${(e as Error).message})` });
    }
    startSSE(reply);
    sseSend(reply, { type: 'starting', cwd });
    const abortController = new AbortController();
    const stream = runCodex({ prompt: text, cwd, images, abortController });
    // pipeCodexToSSE owns the iteration, so wrap the runner to install the abort
    // under the sid once the first `session` event reveals it.
    const wrapped = (async function* () {
      for await (const ev of stream) {
        if (ev.kind === 'session') registerRun(ev.sessionId, abortController);
        yield ev;
      }
    })();
    pipeCodexToSSE(reply, wrapped as ReturnType<typeof runCodex>, null, { cwd, text, hasImages: images.length > 0 });
  });

  app.post<{ Params: SidParams; Body: MessageBody }>(
    '/api/codex/threads/:sid/message',
    async (req, reply) => {
      const sid = req.params.sid;
      const text = String(req.body?.text || '').trim();
      const images = Array.isArray(req.body?.images) ? req.body!.images! : [];
      if (!text && images.length === 0) {
        return reply.status(400).send({ error: 'text or images required' });
      }
      let cwd = process.env.HOME || '/tmp';
      try {
        const detail = await readCodexSessionMessages(sid);
        if (detail.cwd) cwd = detail.cwd;
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
      startSSE(reply);
      sseSend(reply, { type: 'meta', sessionId: sid, cwd });
      const abortController = new AbortController();
      registerRun(sid, abortController);
      pipeCodexToSSE(reply, runCodex({ prompt: text, cwd, resume: sid, images, abortController }), sid, { cwd, text, hasImages: images.length > 0 });
    },
  );

  app.post<{ Params: SidParams }>('/api/codex/threads/:sid/stop', async ({ params }, reply) => {
    const ok = abortRun(params.sid);
    return reply.send({ ok, running: ok });
  });

  // SSE: reattach to a Codex turn. Replays the current snapshot (liveGet), then
  // forwards live events until the turn ends — so a browser refresh mid-turn
  // picks the stream back up instead of waiting for the rollout to land on disk.
  // Mirrors the Claude route's /live handler.
  app.get<{ Params: SidParams }>('/api/codex/threads/:sid/live', async ({ params }, reply) => {
    startSSE(reply);
    const ls = liveGet(params.sid);
    if (!ls) {
      sseSend(reply, { type: 'live-end', reason: 'not-live' });
      sseDone(reply);
      return;
    }
    // Replay the fully-buffered transcript even when the turn already ended:
    // the codex rollout is written asynchronously after `done`, so the disk
    // history can 404 or be partial right after a turn while the complete
    // buffer sits here for KEEP_AROUND_MS. The client reconciles any overlap.
    for (const ev of ls.events) {
      try { sseSend(reply, ev); } catch { return; }
    }
    if (ls.ended) {
      sseDone(reply);
      return;
    }
    ls.subs.add(reply);
    reply.raw.on('close', () => ls.subs.delete(reply));
  });

  // --- Config ------------------------------------------------------------

  app.get('/api/codex/config', async () => readPublicCodexSettings());

  // Switch the active provider (system or a customProviders[].id).
  app.put<{ Body: { providerId?: string } }>('/api/codex/config/active', async (req, reply) => {
    const id = String(req.body?.providerId || '').trim();
    if (!id) return reply.status(400).send({ error: 'providerId required' });
    try {
      await setActiveCodexProvider(id);
    } catch (e) {
      return reply.status(404).send({ error: (e as Error).message });
    }
    return reply.send(await readPublicCodexSettings());
  });

  // Runtime knobs (sandbox / approval) — apply to system + custom alike.
  app.put<{ Body: Partial<CodexRuntimeOptions> }>('/api/codex/config/runtime', async (req, reply) => {
    const patch: Partial<CodexRuntimeOptions> = {};
    const b = req.body || {};
    if (typeof b.sandboxMode === 'string') patch.sandboxMode = b.sandboxMode;
    if (typeof b.approvalPolicy === 'string') patch.approvalPolicy = b.approvalPolicy;
    await updateCodexRuntime(patch);
    return reply.send(await readPublicCodexSettings());
  });

  // Create a new custom provider.
  app.post<{ Body: Partial<CodexCustomProvider> }>('/api/codex/config/providers', async (req, reply) => {
    const created = await createCodexProvider(pickCustomProviderPatch(req.body || {}));
    return reply.send({ id: created.id, settings: await readPublicCodexSettings() });
  });

  // Update an existing custom provider (partial patch — omitted fields keep
  // their current value; apiKey is only overwritten if non-empty).
  app.put<{ Params: { id: string }; Body: Partial<CodexCustomProvider> }>(
    '/api/codex/config/providers/:id',
    async (req, reply) => {
      const id = req.params.id;
      if (id === CODEX_SYSTEM_PROVIDER_ID) {
        return reply.status(400).send({ error: 'system provider is not editable' });
      }
      try {
        await updateCodexProvider(id, pickCustomProviderPatch(req.body || {}));
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
      return reply.send(await readPublicCodexSettings());
    },
  );

  app.delete<{ Params: { id: string } }>('/api/codex/config/providers/:id', async (req, reply) => {
    if (req.params.id === CODEX_SYSTEM_PROVIDER_ID) {
      return reply.status(400).send({ error: 'system provider cannot be deleted' });
    }
    await deleteCodexProvider(req.params.id);
    return reply.send(await readPublicCodexSettings());
  });

  // --- Engine banner -----------------------------------------------------

  function pickCustomProviderPatch(b: Partial<CodexCustomProvider>): Partial<CodexCustomProvider> {
    const patch: Partial<CodexCustomProvider> = {};
    if (typeof b.name === 'string') patch.name = b.name;
    if (typeof b.baseUrl === 'string') patch.baseUrl = b.baseUrl;
    if (typeof b.model === 'string') patch.model = b.model;
    if (typeof b.modelProvider === 'string') patch.modelProvider = b.modelProvider;
    if (b.wireApi === 'responses' || b.wireApi === 'chat') patch.wireApi = b.wireApi;
    if (typeof b.reasoningEffort === 'string') patch.reasoningEffort = b.reasoningEffort;
    if (typeof b.apiKey === 'string' && b.apiKey.length > 0) patch.apiKey = b.apiKey;
    if (typeof b.webSearchEnabled === 'boolean') patch.webSearchEnabled = b.webSearchEnabled;
    if (typeof b.disableResponseStorage === 'boolean') patch.disableResponseStorage = b.disableResponseStorage;
    if (typeof b.contextWindow === 'number') patch.contextWindow = b.contextWindow;
    if (typeof b.autoCompactTokenLimit === 'number') patch.autoCompactTokenLimit = b.autoCompactTokenLimit;
    return patch;
  }


  app.get('/api/engine', async () => ({
    engine: process.env.MACARON_ENGINE === 'codex' ? 'codex' : 'claude',
  }));
}
