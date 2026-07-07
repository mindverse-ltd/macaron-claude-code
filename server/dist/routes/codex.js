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
import { deleteCodexSession, listCodexSessions, readCodexSessionMessages, } from '../lib/codex-store.js';
import { groupWorkspaces } from '../lib/session-store.js';
import { runCodex } from '../lib/codex-runner.js';
import { CODEX_SYSTEM_PROVIDER_ID, createCodexProvider, deleteCodexProvider, readPublicCodexSettings, setActiveCodexProvider, updateCodexProvider, updateCodexRuntime, } from '../lib/codex-config.js';
import { startSSE, sseSend, sseDone } from '../lib/sse.js';
import { registerRun, abortRun, endRun } from '../lib/active-runs.js';
export async function registerCodexRoutes(app) {
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
    app.get('/api/codex/workspaces/:project', async ({ params }) => {
        const sessions = await listCodexSessions();
        const mine = sessions.filter((s) => s.project === params.project);
        const meta = groupWorkspaces(mine)[0] || {
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
    app.get('/api/codex/threads/:sid', async ({ params }, reply) => {
        try {
            return await readCodexSessionMessages(params.sid);
        }
        catch (e) {
            return reply.status(404).send({ error: e.message });
        }
    });
    app.delete('/api/codex/threads/:sid', async ({ params }, reply) => {
        try {
            await deleteCodexSession(params.sid);
            return { ok: true };
        }
        catch (e) {
            return reply.status(404).send({ error: e.message });
        }
    });
    // --- Send / resume -----------------------------------------------------
    const pipeCodexToSSE = (reply, stream, sid) => {
        let clientGone = false;
        reply.raw.on('close', () => { clientGone = true; });
        const safeSend = (payload) => {
            if (clientGone)
                return;
            try {
                sseSend(reply, payload);
            }
            catch {
                clientGone = true;
            }
        };
        let capturedSid = sid;
        (async () => {
            for await (const ev of stream) {
                if (ev.kind === 'session' && !capturedSid) {
                    capturedSid = ev.sessionId;
                    safeSend({ type: 'meta', sessionId: capturedSid });
                }
                else if (ev.kind === 'delta')
                    safeSend({ type: 'delta', text: ev.text });
                else if (ev.kind === 'tool_use')
                    safeSend({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
                else if (ev.kind === 'tool_result')
                    safeSend({ type: 'tool_result', tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
                else if (ev.kind === 'usage')
                    safeSend({ type: 'usage', outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
                else if (ev.kind === 'message')
                    safeSend({ type: 'event', subtype: ev.subtype });
                else if (ev.kind === 'error')
                    safeSend({ type: 'error', error: ev.error });
                else if (ev.kind === 'done') {
                    safeSend({ type: 'done', exitCode: ev.exitCode });
                    if (capturedSid)
                        endRun(capturedSid);
                    if (!clientGone)
                        sseDone(reply);
                }
            }
        })().catch((e) => {
            if (capturedSid)
                endRun(capturedSid);
            safeSend({ type: 'error', error: e.message });
            if (!clientGone)
                sseDone(reply);
        });
    };
    app.post('/api/codex/threads', async (req, reply) => {
        const text = String(req.body?.text || '').trim();
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const cwd = String(req.body?.cwd || process.env.HOME || '/tmp');
        if (!text && images.length === 0) {
            return reply.status(400).send({ error: 'text or images required' });
        }
        try {
            const st = await fs.stat(cwd);
            if (!st.isDirectory())
                throw new Error('cwd not a directory');
        }
        catch (e) {
            return reply.status(400).send({ error: `cwd unusable: ${cwd} (${e.message})` });
        }
        startSSE(reply);
        sseSend(reply, { type: 'starting', cwd });
        const abortController = new AbortController();
        const stream = runCodex({ prompt: text, cwd, images, abortController });
        // Register the abort under the sid once we learn it.
        (async () => {
            // Peek at first session event so we can wire the abort — but pipeCodexToSSE
            // owns the iteration. We register on the ev.kind==='session' path inside.
        })();
        // We can't peek; instead, register on capturedSid after the pipe learns it.
        // Simpler: wrap the runner to install the abort after first event.
        const wrapped = (async function* () {
            for await (const ev of stream) {
                if (ev.kind === 'session')
                    registerRun(ev.sessionId, abortController);
                yield ev;
            }
        })();
        pipeCodexToSSE(reply, wrapped, null);
    });
    app.post('/api/codex/threads/:sid/message', async (req, reply) => {
        const sid = req.params.sid;
        const text = String(req.body?.text || '').trim();
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        if (!text && images.length === 0) {
            return reply.status(400).send({ error: 'text or images required' });
        }
        let cwd = process.env.HOME || '/tmp';
        try {
            const detail = await readCodexSessionMessages(sid);
            if (detail.cwd)
                cwd = detail.cwd;
        }
        catch (e) {
            return reply.status(404).send({ error: e.message });
        }
        startSSE(reply);
        sseSend(reply, { type: 'meta', sessionId: sid, cwd });
        const abortController = new AbortController();
        registerRun(sid, abortController);
        pipeCodexToSSE(reply, runCodex({ prompt: text, cwd, resume: sid, images, abortController }), sid);
    });
    app.post('/api/codex/threads/:sid/stop', async ({ params }, reply) => {
        const ok = abortRun(params.sid);
        return reply.send({ ok, running: ok });
    });
    // --- Config ------------------------------------------------------------
    app.get('/api/codex/config', async () => readPublicCodexSettings());
    // Switch the active provider (system or a customProviders[].id).
    app.put('/api/codex/config/active', async (req, reply) => {
        const id = String(req.body?.providerId || '').trim();
        if (!id)
            return reply.status(400).send({ error: 'providerId required' });
        try {
            await setActiveCodexProvider(id);
        }
        catch (e) {
            return reply.status(404).send({ error: e.message });
        }
        return reply.send(await readPublicCodexSettings());
    });
    // Runtime knobs (sandbox / approval) — apply to system + custom alike.
    app.put('/api/codex/config/runtime', async (req, reply) => {
        const patch = {};
        const b = req.body || {};
        if (typeof b.sandboxMode === 'string')
            patch.sandboxMode = b.sandboxMode;
        if (typeof b.approvalPolicy === 'string')
            patch.approvalPolicy = b.approvalPolicy;
        await updateCodexRuntime(patch);
        return reply.send(await readPublicCodexSettings());
    });
    // Create a new custom provider.
    app.post('/api/codex/config/providers', async (req, reply) => {
        const created = await createCodexProvider(pickCustomProviderPatch(req.body || {}));
        return reply.send({ id: created.id, settings: await readPublicCodexSettings() });
    });
    // Update an existing custom provider (partial patch — omitted fields keep
    // their current value; apiKey is only overwritten if non-empty).
    app.put('/api/codex/config/providers/:id', async (req, reply) => {
        const id = req.params.id;
        if (id === CODEX_SYSTEM_PROVIDER_ID) {
            return reply.status(400).send({ error: 'system provider is not editable' });
        }
        try {
            await updateCodexProvider(id, pickCustomProviderPatch(req.body || {}));
        }
        catch (e) {
            return reply.status(404).send({ error: e.message });
        }
        return reply.send(await readPublicCodexSettings());
    });
    app.delete('/api/codex/config/providers/:id', async (req, reply) => {
        if (req.params.id === CODEX_SYSTEM_PROVIDER_ID) {
            return reply.status(400).send({ error: 'system provider cannot be deleted' });
        }
        await deleteCodexProvider(req.params.id);
        return reply.send(await readPublicCodexSettings());
    });
    // --- Engine banner -----------------------------------------------------
    function pickCustomProviderPatch(b) {
        const patch = {};
        if (typeof b.name === 'string')
            patch.name = b.name;
        if (typeof b.baseUrl === 'string')
            patch.baseUrl = b.baseUrl;
        if (typeof b.model === 'string')
            patch.model = b.model;
        if (typeof b.modelProvider === 'string')
            patch.modelProvider = b.modelProvider;
        if (b.wireApi === 'responses' || b.wireApi === 'chat')
            patch.wireApi = b.wireApi;
        if (typeof b.reasoningEffort === 'string')
            patch.reasoningEffort = b.reasoningEffort;
        if (typeof b.apiKey === 'string' && b.apiKey.length > 0)
            patch.apiKey = b.apiKey;
        if (typeof b.webSearchEnabled === 'boolean')
            patch.webSearchEnabled = b.webSearchEnabled;
        if (typeof b.disableResponseStorage === 'boolean')
            patch.disableResponseStorage = b.disableResponseStorage;
        if (typeof b.contextWindow === 'number')
            patch.contextWindow = b.contextWindow;
        if (typeof b.autoCompactTokenLimit === 'number')
            patch.autoCompactTokenLimit = b.autoCompactTokenLimit;
        return patch;
    }
    app.get('/api/engine', async () => ({
        engine: process.env.MACARON_ENGINE === 'codex' ? 'codex' : 'claude',
    }));
}
//# sourceMappingURL=codex.js.map