import { deleteSession, duplicateSession, readSessionMessages, resolveSessionCwd, rewindSession, writeCompactedSession, } from '../lib/session-store.js';
import { startSSE, sseSend, sseDone } from '../lib/sse.js';
import { liveGet } from '../lib/live-registry.js';
import { runClaude, runFollowup } from '../lib/claude-runner.js';
import { getActiveProviderEnv, getActiveProviderRaw, getFollowupSuggestionsEnabled } from '../lib/settings-store.js';
import { registerRun, abortRun, endRun } from '../lib/active-runs.js';
import { resolvePending } from '../lib/permission-registry.js';
export async function registerSessionRoutes(app) {
    app.get('/api/sessions/claude/:project/:sid', async ({ params }, reply) => {
        try {
            return await readSessionMessages(params.project, params.sid);
        }
        catch (e) {
            return reply.status(404).send({ error: e.message });
        }
    });
    app.delete('/api/sessions/claude/:project/:sid', async ({ params }, reply) => {
        try {
            await deleteSession(params.project, params.sid);
            return { ok: true };
        }
        catch (e) {
            return reply.status(404).send({ error: e.message });
        }
    });
    // Duplicate: clone the jsonl to a fresh sid so both can be resumed
    // independently. Sidebar's context menu wires to this.
    app.post('/api/sessions/claude/:project/:sid/duplicate', async ({ params }, reply) => {
        try {
            const r = await duplicateSession(params.project, params.sid);
            return { ok: true, ...r };
        }
        catch (e) {
            return reply.status(404).send({ error: e.message });
        }
    });
    // Resolve a pending canUseTool call — { id, decision:'allow'|'deny', reason? }.
    app.post('/api/permission-decision', async (req, reply) => {
        const id = String(req.body?.id || '').trim();
        const dec = req.body?.decision;
        if (!id || (dec !== 'allow' && dec !== 'deny')) {
            return reply.status(400).send({ error: 'id + decision required' });
        }
        const ok = resolvePending(id, dec === 'allow' ? { decision: 'allow' } : { decision: 'deny', reason: req.body?.reason });
        return reply.send({ ok });
    });
    // Stop: abort the in-flight SDK stream for this session. No-op if no
    // stream is currently running under that sid.
    app.post('/api/sessions/claude/:project/:sid/stop', async ({ params }, reply) => {
        const ok = abortRun(params.sid);
        return reply.send({ ok, running: ok });
    });
    // Rewind: truncate the jsonl at the given message uuid — that message and
    // everything after it is dropped (with a .rewind-<ts>.jsonl.bak backup).
    app.post('/api/sessions/claude/:project/:sid/rewind', async (req, reply) => {
        const uuid = String(req.body?.uuid || '').trim();
        if (!uuid)
            return reply.status(400).send({ error: 'uuid required' });
        try {
            const r = await rewindSession(req.params.project, req.params.sid, uuid);
            return { ok: true, ...r };
        }
        catch (e) {
            return reply.status(400).send({ error: e.message });
        }
    });
    // Compact: replace transcript with a summary from the active provider.
    // Only works with a custom provider (system provider has no server-side
    // credentials to call an API directly).
    app.post('/api/sessions/claude/:project/:sid/compact', async (req, reply) => {
        const provider = getActiveProviderRaw();
        if (!provider) {
            return reply.status(400).send({
                error: 'compact requires an active custom provider (system provider is unsupported)',
            });
        }
        let detail;
        try {
            detail = await readSessionMessages(req.params.project, req.params.sid);
        }
        catch (e) {
            return reply.status(404).send({ error: e.message });
        }
        const msgs = [];
        for (const m of detail.messages) {
            if (m.role !== 'user' && m.role !== 'assistant')
                continue;
            const text = m.blocks
                .map((b) => (b.kind === 'text' ? b.text : b.kind === 'thinking' ? '' : ''))
                .filter(Boolean)
                .join('\n')
                .trim();
            if (!text)
                continue;
            // Merge consecutive same-role turns so the request is a strict
            // alternating sequence (Anthropic's constraint).
            const prev = msgs[msgs.length - 1];
            if (prev && prev.role === m.role)
                prev.content += '\n\n' + text;
            else
                msgs.push({ role: m.role, content: text });
        }
        if (msgs.length === 0) {
            return reply.status(400).send({ error: 'nothing to compact — session has no text messages' });
        }
        // Cap each message at ~40k chars to stay within the summariser's
        // window even for very long sessions. Truncated tails are marked
        // explicitly so the model knows content was elided.
        const CAP = 40_000;
        for (const m of msgs) {
            if (m.content.length > CAP) {
                m.content = m.content.slice(0, CAP) + '\n\n[…truncated for summarization]';
            }
        }
        msgs.push({
            role: 'user',
            content: 'Please write a concise recap of the entire conversation above. ' +
                'Focus on: goals, key decisions, remaining tasks, and the current in-progress work. ' +
                'One paragraph, no more than 250 words.',
        });
        const endpoint = provider.endpoint.replace(/\/+$/, '');
        const url = endpoint.endsWith('/v1') ? `${endpoint}/messages` : `${endpoint}/v1/messages`;
        let apiRes;
        try {
            apiRes = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': provider.apiKey,
                    authorization: `Bearer ${provider.apiKey}`,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: provider.model,
                    max_tokens: 1024,
                    system: 'You are a conversation summarizer. Output ONLY the recap paragraph — no preamble, no headers, no bullet lists.',
                    messages: msgs,
                }),
            });
        }
        catch (e) {
            return reply.status(502).send({ error: `provider fetch failed: ${e.message}` });
        }
        if (!apiRes.ok) {
            const body = await apiRes.text().catch(() => '');
            return reply.status(502).send({
                error: `provider returned ${apiRes.status}: ${body.slice(0, 500)}`,
            });
        }
        const json = (await apiRes.json().catch(() => null));
        const summary = json?.content
            ?.filter((b) => b?.type === 'text')
            .map((b) => b?.text || '')
            .join('\n')
            .trim() || '';
        if (!summary) {
            return reply.status(502).send({ error: 'provider returned no summary text' });
        }
        try {
            const r = await writeCompactedSession(req.params.project, req.params.sid, summary);
            return { ok: true, summary, ...r };
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    // SSE: subscribe to a live spawn registered by /api/workspaces/.../sessions.
    // Replays buffered events, then forwards new ones until the spawn closes.
    app.get('/api/sessions/claude/:project/:sid/live', async (req, reply) => {
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
            }
            catch {
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
    // Proactive follow-ups for an already-idle session: resume + runFollowup
    // with NO main turn, so merely opening a finished conversation surfaces
    // suggestions too — not only the instant a turn ends. Same cache-hit prefix
    // as the post-turn path. Best-effort; gated on the global toggle.
    app.post('/api/sessions/claude/:project/:sid/followups', async ({ params }, reply) => {
        const { project, sid } = params;
        startSSE(reply);
        if (!getFollowupSuggestionsEnabled()) {
            sseDone(reply);
            return;
        }
        const cwd = await resolveSessionCwd(project, sid);
        const { model: providerModel, env: providerEnv } = getActiveProviderEnv();
        let clientGone = false;
        reply.raw.on('close', () => { clientGone = true; });
        try {
            for await (const delta of runFollowup({ resume: sid, cwd, model: providerModel, envOverrides: providerEnv })) {
                if (clientGone)
                    break;
                try {
                    sseSend(reply, { type: 'followup_delta', text: delta });
                }
                catch {
                    clientGone = true;
                    break;
                }
            }
        }
        catch { /* swallow: follow-up is enrichment, never fatal */ }
        if (!clientGone)
            sseDone(reply);
    });
    // Send a message into an existing session (`claude -p --resume <sid>`).
    app.post('/api/sessions/claude/:project/:sid/message', async (req, reply) => {
        const { project, sid } = req.params;
        const text = String(req.body?.text || '').trim();
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const model = req.body?.model || 'claude-opus-4-7';
        const permissionMode = req.body?.permissionMode || 'default';
        if (!text && images.length === 0) {
            return reply.status(400).send({ error: 'text or images required' });
        }
        // Prefer the cwd embedded in the jsonl's first line, else the decoded
        // project name (which claude-cli derives from the cwd).
        const cwd = await resolveSessionCwd(project, sid);
        startSSE(reply);
        sseSend(reply, { type: 'meta', cwd, sessionId: sid });
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
        // The Settings-selected active provider determines which
        // Anthropic-compatible endpoint the SDK talks to (default = ambient
        // Claude login). Same tools, same jsonl, same everything.
        const { model: providerModel, env: providerEnv } = getActiveProviderEnv();
        void model; // eslint: kept in body for future per-message override
        // Register an abort controller so `/stop` can interrupt this stream.
        const abortController = new AbortController();
        registerRun(sid, abortController);
        (async () => {
            for await (const ev of runClaude({ prompt: text, cwd, resume: sid, model: providerModel, permissionMode, images, envOverrides: providerEnv, abortController })) {
                if (ev.kind === 'delta')
                    safeSend({ type: 'delta', text: ev.text });
                else if (ev.kind === 'tool_use') {
                    safeSend({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
                }
                else if (ev.kind === 'tool_input_delta') {
                    safeSend({ type: 'tool_input_delta', id: ev.id, name: ev.name, partial_json: ev.partial_json, accumulated: ev.accumulated });
                }
                else if (ev.kind === 'tool_input_done') {
                    safeSend({ type: 'tool_input_done', id: ev.id, name: ev.name, final_json: ev.final_json });
                }
                else if (ev.kind === 'tool_result')
                    safeSend({ type: 'tool_result', tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
                else if (ev.kind === 'permission_request')
                    safeSend({ type: 'permission_request', id: ev.id, toolName: ev.toolName, input: ev.input });
                else if (ev.kind === 'permission_resolved')
                    safeSend({ type: 'permission_resolved', id: ev.id, decision: ev.decision });
                else if (ev.kind === 'usage')
                    safeSend({ type: 'usage', outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
                else if (ev.kind === 'message')
                    safeSend({ type: 'event', event: 'system', subtype: ev.subtype });
                else if (ev.kind === 'error')
                    safeSend({ type: 'error', error: ev.error });
                else if (ev.kind === 'done') {
                    safeSend({ type: 'done', exitCode: ev.exitCode });
                    endRun(sid);
                    // After the main turn: stream a throwaway follow-up-suggestions
                    // query resuming the same session (shared prefix → provider cache
                    // hit, near-free). persistSession:false keeps it off disk. Each
                    // text delta is forwarded as a `followup_delta` event; the WebUI
                    // accumulates + parses incrementally with partial-json. Best-effort
                    // — any failure is swallowed, never blocks the turn's close.
                    // Only on a clean finish (exitCode 0): a Stop (abort → -1) or a
                    // mid-turn error must stay byte-identical to pre-feature behavior,
                    // never spinning up a follow-up query on an aborted transcript.
                    if (!clientGone && ev.exitCode === 0 && getFollowupSuggestionsEnabled()) {
                        try {
                            for await (const delta of runFollowup({ resume: sid, cwd, model: providerModel, envOverrides: providerEnv })) {
                                if (clientGone)
                                    break;
                                safeSend({ type: 'followup_delta', text: delta });
                            }
                        }
                        catch {
                            /* swallow: follow-up is enrichment, never fatal */
                        }
                    }
                    if (!clientGone)
                        sseDone(reply);
                }
            }
        })().catch((e) => {
            endRun(sid);
            const msg = e.message;
            safeSend({ type: 'error', error: msg });
            if (!clientGone)
                sseDone(reply);
        });
    });
}
//# sourceMappingURL=sessions.js.map