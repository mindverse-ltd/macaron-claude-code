// SSE helpers operate on fastify's `reply.raw` (the underlying Node res) so we
// can write incrementally and keep the connection open. Setting headers on
// reply.raw bypasses fastify's response pipeline, which is what we want for SSE.
export function startSSE(reply) {
    reply.hijack();
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    // Disable Nagle so deltas land at the client immediately rather than coalescing.
    reply.raw.socket?.setNoDelay(true);
}
export function sseSend(reply, payload) {
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}
export function sseDone(reply) {
    try {
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
    }
    catch {
        /* already closed */
    }
}
//# sourceMappingURL=sse.js.map