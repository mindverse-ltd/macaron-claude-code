// Helpers around `child_process.spawn('claude', ...)`. Extracts the bits of
// claude-cli's stream-json output that the UI cares about: per-token text
// deltas (from partial-message events).
export function extractDeltaText(ev) {
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
        const d = ev.event.delta;
        if (d?.type === 'text_delta')
            return d.text || '';
    }
    return '';
}
export function extractSessionId(ev) {
    return ev.session_id || ev.sessionId || ev.message?.session_id;
}
//# sourceMappingURL=claude-spawn.js.map