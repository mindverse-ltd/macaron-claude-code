import { sseSend } from './sse.js';
const LIVE_RING = 4000;
const KEEP_AROUND_MS = 60_000;
const sessions = new Map();
export function liveStart(sid, meta) {
    sessions.set(sid, {
        events: [{ type: 'meta', cwd: meta.cwd, sessionId: sid }],
        subs: new Set(),
        ended: false,
    });
}
export function livePush(sid, payload) {
    const ls = sessions.get(sid);
    if (!ls || ls.ended)
        return;
    ls.events.push(payload);
    if (ls.events.length > LIVE_RING)
        ls.events.splice(0, ls.events.length - LIVE_RING);
    for (const sub of ls.subs) {
        try {
            sseSend(sub, payload);
        }
        catch {
            ls.subs.delete(sub);
        }
    }
}
export function liveEnd(sid, payload) {
    const ls = sessions.get(sid);
    if (!ls)
        return;
    ls.ended = true;
    ls.events.push(payload);
    for (const sub of ls.subs) {
        try {
            sseSend(sub, payload);
            sub.raw.write('data: [DONE]\n\n');
            sub.raw.end();
        }
        catch {
            /* already closed */
        }
    }
    ls.subs.clear();
    setTimeout(() => sessions.delete(sid), KEEP_AROUND_MS);
}
export function liveGet(sid) {
    return sessions.get(sid);
}
//# sourceMappingURL=live-registry.js.map