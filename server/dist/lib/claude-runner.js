// Wraps the Claude Agent SDK so the rest of the app sees a normalized stream of
// {sessionId, deltas, events, done}. Replaces the previous child_process.spawn
// approach — same UX, no CLI stdout parsing, typed events, no IPC buffering.
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { macaronMcpServer } from './macaron-mcp.js';
import { registerPending } from './permission-registry.js';
import { getYoloMode } from './settings-store.js';
function buildPromptInput(opts) {
    if (!opts.images || opts.images.length === 0)
        return opts.prompt;
    // When images are attached we must pass content blocks via an async iterable.
    // Strip the data-URL prefix so the SDK sees raw base64.
    const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    const imageBlocks = opts.images.map((img) => {
        const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
        const detected = m?.[1] || img.mimeType || 'image/png';
        const mediaType = (allowed.has(detected) ? detected : 'image/png');
        const data = m?.[2] || '';
        return {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data },
        };
    });
    const content = [
        ...imageBlocks,
        ...(opts.prompt ? [{ type: 'text', text: opts.prompt }] : []),
    ];
    const msg = {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
    };
    return (async function* () { yield msg; })();
}
export async function* runClaude(opts) {
    // Queue-based generator: both the SDK's async iterator loop and the
    // canUseTool callback push here. canUseTool needs to *both* emit a
    // permission_request event AND await a client decision — a plain
    // `yield` inside a callback context can't do that, so we drain a shared
    // queue from the outer generator.
    const queue = [];
    const waiters = [];
    let ended = false;
    const push = (ev) => {
        const w = waiters.shift();
        if (w)
            w({ value: ev, done: false });
        else
            queue.push(ev);
    };
    const finish = () => {
        ended = true;
        while (waiters.length)
            waiters.shift()({ value: undefined, done: true });
    };
    const next = () => {
        if (queue.length)
            return Promise.resolve({ value: queue.shift(), done: false });
        if (ended)
            return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => waiters.push(res));
    };
    // Per-content-block context for streaming tool input. The SDK fires
    // content_block_start/delta/stop with an `index`; we use that to pair
    // input_json_delta chunks with the originating tool_use's id+name.
    const toolBlocks = new Map();
    const e = opts.envOverrides;
    const routedBase = e?.ANTHROPIC_BASE_URL || '(inherited from process.env)';
    const cfgDir = e?.CLAUDE_CONFIG_DIR || '(user default ~/.claude)';
    console.log(`[claude-runner] starting  model=${opts.model ?? '(sdk default)'}  base=${routedBase}  CLAUDE_CONFIG_DIR=${cfgDir}  resume=${opts.resume ? opts.resume.slice(0, 8) : '(new)'}`);
    // Launch the SDK stream in the background. Both success and error paths
    // eventually push a `done` and call `finish()` so the outer drain loop
    // can exit cleanly.
    void (async () => {
        let sessionEmitted = false;
        try {
            // YOLO mode (global Settings toggle) forces bypassPermissions for
            // every run, regardless of what the WebUI requested. This is the
            // single server-side override point — route handlers stay ignorant.
            const effectivePermissionMode = getYoloMode()
                ? 'bypassPermissions'
                : (opts.permissionMode ?? 'default');
            const stream = query({
                prompt: buildPromptInput(opts),
                options: {
                    cwd: opts.cwd,
                    resume: opts.resume,
                    model: opts.model,
                    permissionMode: effectivePermissionMode,
                    // The SDK passes `permissionMode` to the CLI as `--permission-mode`,
                    // but the CLI refuses to actually enter `bypassPermissions` unless
                    // `--allow-dangerously-skip-permissions` is also on the arg list (or
                    // `skipDangerousModePermissionPrompt: true` is in the config dir's
                    // settings.json). Our subprocess runs against an isolated
                    // CLAUDE_CONFIG_DIR (/tmp/macaron-plugin-isolated-claude) that has
                    // no settings.json, so neither condition is met and the CLI silently
                    // falls back to default mode — canUseTool fires for every tool call
                    // and the "Bypass all" toggle in the WebUI does nothing. Pass the
                    // flag explicitly so bypass mode actually takes effect.
                    allowDangerouslySkipPermissions: effectivePermissionMode === 'bypassPermissions',
                    includePartialMessages: true,
                    abortController: opts.abortController,
                    mcpServers: { macaron: macaronMcpServer },
                    allowedTools: ['mcp__macaron__render_ui'],
                    // canUseTool: pause the SDK, ask the client, resume once decided.
                    // A promise is registered under a random id; the client's POST to
                    // /permission-decision looks the id up and resolves it.
                    // NOTE: when permissionMode === 'bypassPermissions' (and
                    // allowDangerouslySkipPermissions is true), the SDK does NOT invoke
                    // this callback — every tool auto-approves. That's the intended
                    // "yolo" UX.
                    canUseTool: async (toolName, input) => {
                        const id = randomUUID();
                        const decision = await new Promise((resolve) => {
                            registerPending(id, resolve);
                            push({ kind: 'permission_request', id, toolName, input });
                        });
                        if (decision.decision === 'allow') {
                            push({ kind: 'permission_resolved', id, decision: 'allow' });
                            return { behavior: 'allow', updatedInput: input };
                        }
                        push({ kind: 'permission_resolved', id, decision: 'deny' });
                        return { behavior: 'deny', message: decision.reason || 'denied by user', interrupt: false };
                    },
                    ...(opts.envOverrides ? { env: opts.envOverrides } : {}),
                },
            });
            for await (const m of stream) {
                if (!sessionEmitted && 'session_id' in m && m.session_id) {
                    sessionEmitted = true;
                    push({ kind: 'session', sessionId: m.session_id });
                }
                if (m.type === 'stream_event') {
                    const ev = m.event;
                    if (ev.type === 'message_delta') {
                        const usage = ev.usage;
                        if (usage && typeof usage.output_tokens === 'number') {
                            push({ kind: 'usage', outputTokens: usage.output_tokens });
                        }
                    }
                    if (ev.type === 'content_block_start') {
                        const cb = ev.content_block;
                        if (cb?.type === 'tool_use' && cb.id && cb.name) {
                            toolBlocks.set(ev.index, { id: cb.id, name: cb.name, json: '' });
                            push({ kind: 'tool_use', id: cb.id, name: cb.name, input: cb.input ?? {} });
                        }
                    }
                    else if (ev.type === 'content_block_delta') {
                        const d = ev.delta;
                        if (d?.type === 'text_delta' && d.text) {
                            push({ kind: 'delta', text: d.text });
                        }
                        else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
                            const tb = toolBlocks.get(ev.index);
                            if (tb) {
                                tb.json += d.partial_json;
                                push({
                                    kind: 'tool_input_delta',
                                    id: tb.id,
                                    name: tb.name,
                                    partial_json: d.partial_json,
                                    accumulated: tb.json,
                                });
                            }
                        }
                    }
                    else if (ev.type === 'content_block_stop') {
                        const tb = toolBlocks.get(ev.index);
                        if (tb) {
                            push({ kind: 'tool_input_done', id: tb.id, name: tb.name, final_json: tb.json });
                            toolBlocks.delete(ev.index);
                        }
                    }
                }
                else if (m.type === 'user') {
                    const blocks = (m.message?.content || []);
                    for (const b of blocks) {
                        if (b.type === 'tool_result' && b.tool_use_id) {
                            const c = b.content;
                            const text = typeof c === 'string'
                                ? c
                                : Array.isArray(c)
                                    ? c.map((x) => x.text || '').join('')
                                    : '';
                            push({ kind: 'tool_result', tool_use_id: b.tool_use_id, text, isError: Boolean(b.is_error) });
                        }
                    }
                }
                else if (m.type === 'system') {
                    if (m.subtype === 'thinking_tokens') {
                        const est = m.estimated_tokens;
                        if (typeof est === 'number') {
                            push({ kind: 'usage', outputTokens: 0, thinkingTokens: est });
                        }
                    }
                    push({ kind: 'message', subtype: m.subtype || 'system' });
                }
                else if (m.type === 'result') {
                    if (m.is_error) {
                        const r = m;
                        const detail = (r.errors && r.errors.length ? r.errors.join(' | ') : '') ||
                            r.result ||
                            [r.subtype, r.stop_reason, r.api_error_status ? `http ${r.api_error_status}` : '']
                                .filter(Boolean)
                                .join(' · ') ||
                            'unknown SDK error';
                        console.log('[claude-runner] SDK error result:', JSON.stringify(r, null, 2));
                        push({ kind: 'error', error: detail });
                    }
                    push({ kind: 'done', exitCode: m.is_error ? 1 : 0 });
                    finish();
                    return;
                }
            }
            push({ kind: 'done', exitCode: 0 });
        }
        catch (err) {
            push({ kind: 'error', error: err.message });
            push({ kind: 'done', exitCode: -1 });
        }
        finally {
            finish();
        }
    })();
    while (true) {
        const r = await next();
        if (r.done)
            return;
        yield r.value;
    }
}
//# sourceMappingURL=claude-runner.js.map