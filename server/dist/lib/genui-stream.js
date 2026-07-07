// Routes streaming TSX from a `render_ui` MCP tool invocation to client
// subscribers. Keyed by tool_use_id so the WebUI's GenuiItem (which sees the
// tool_use event before the handler even returns) can subscribe via SSE and
// render partial code as it comes in.
//
// The route layer pushes a tool_use_id onto a FIFO queue right after the SDK
// emits the matching tool_use block; the MCP handler pops one as it starts —
// order is guaranteed because the SDK dispatches tool calls sequentially per
// turn and the route's stream loop sees the tool_use event before the SDK
// finishes dispatching.
import { sseSend, sseDone } from './sse.js';
const streams = new Map();
const KEEP_FOR_MS = 5 * 60_000;
function ensure(id) {
    let s = streams.get(id);
    if (!s) {
        s = { code: '', done: false, subs: new Set() };
        streams.set(id, s);
    }
    return s;
}
export function pushCode(id, code) {
    const s = ensure(id);
    if (s.done)
        return;
    s.code = code;
    if (process.env.MACARON_DEBUG === '1') {
        console.log(`[genui-stream] pushCode id=${id.slice(0, 12)}… len=${code.length} subs=${s.subs.size}`);
    }
    for (const sub of s.subs) {
        try {
            sseSend(sub, { type: 'code', code, done: false });
        }
        catch {
            s.subs.delete(sub);
        }
    }
}
export function finish(id, code) {
    const s = ensure(id);
    s.code = code;
    s.done = true;
    for (const sub of s.subs) {
        try {
            sseSend(sub, { type: 'code', code, done: true });
            sub.raw.write('data: [DONE]\n\n');
            sub.raw.end();
        }
        catch {
            /* already closed */
        }
    }
    s.subs.clear();
    setTimeout(() => streams.delete(id), KEEP_FOR_MS);
}
export function setError(id, error) {
    const s = streams.get(id);
    if (!s)
        return;
    s.done = true;
    s.error = error;
    for (const sub of s.subs) {
        try {
            sseSend(sub, { type: 'error', error });
            sub.raw.write('data: [DONE]\n\n');
            sub.raw.end();
        }
        catch {
            /* already closed */
        }
    }
    s.subs.clear();
    setTimeout(() => streams.delete(id), KEEP_FOR_MS);
}
export function subscribe(id, reply) {
    const s = streams.get(id);
    if (process.env.MACARON_DEBUG === '1') {
        console.log(`[genui-stream] subscribe id=${id.slice(0, 12)}… exists=${Boolean(s)} done=${s?.done} code_len=${s?.code.length ?? 0}`);
    }
    if (!s) {
        // Memory cache evicted — client already has the final TSX in jsonl
        // (tool_result), so just tell it there's no live stream and bail.
        sseSend(reply, { type: 'missing' });
        sseDone(reply);
        return;
    }
    // Replay current state
    if (s.code)
        sseSend(reply, { type: 'code', code: s.code, done: s.done });
    if (s.error)
        sseSend(reply, { type: 'error', error: s.error });
    if (s.done) {
        sseDone(reply);
        return;
    }
    s.subs.add(reply);
    reply.raw.on('close', () => s.subs.delete(reply));
}
//# sourceMappingURL=genui-stream.js.map