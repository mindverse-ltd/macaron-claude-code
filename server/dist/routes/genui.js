import { MACARON_API_BASE, MACARON_API_KEY, MACARON_MODEL, GENUI_SYSTEM_PROMPT_URL, isMacaronConfigured, MACARON_CONFIG_HINT, } from '../config.js';
const DISPLAY_TSX_TOOL = {
    type: 'function',
    function: {
        name: 'display_tsx',
        description: 'Render a streaming TSX module inline. The host parses progressively — earlier-arriving JSX paints first. ' +
            'The `code` field MUST start with imports and then `export default function App()`. Declare ALL data INSIDE the function body so the preview can emerge while data is still streaming.',
        parameters: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Complete TSX module source.' },
            },
            required: ['code'],
        },
    },
};
const APP_FIRST_ADDENDUM = `\n\n# ADDITIONAL CONSTRAINTS (highest priority)\n\n` +
    `- Emit code via the display_tsx tool. Do NOT wrap in markdown fences. Do NOT prepend prose.\n` +
    `- ORDER MATTERS for streaming preview: write \`export default function App()\` IMMEDIATELY after the imports. ` +
    `Put data constants INSIDE the function body (\`const METRICS = [...]\` lives after \`function App() {\`, not at module scope).\n` +
    `- This lets the host paint a shell as soon as the JSX begins, instead of waiting for data arrays to finish streaming.`;
let cachedGenuiPrompt = null;
let cachedGenuiPromptAt = 0;
async function getGenuiSystemPrompt() {
    const ttl = 10 * 60_000;
    if (cachedGenuiPrompt && Date.now() - cachedGenuiPromptAt < ttl)
        return cachedGenuiPrompt;
    try {
        const r = await fetch(GENUI_SYSTEM_PROMPT_URL, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
            cachedGenuiPrompt = await r.text();
            cachedGenuiPromptAt = Date.now();
            return cachedGenuiPrompt;
        }
    }
    catch {
        /* fall through to baked-in prompt */
    }
    cachedGenuiPrompt =
        'You generate one self-contained TSX module with `export default function App()`. ' +
            "Use components from `$macaron/ui`. Keep output streamable. Don't import external runtime data. " +
            'Avoid full-page shells. Render embeddable surfaces only.';
    cachedGenuiPromptAt = Date.now();
    return cachedGenuiPrompt;
}
export async function registerGenuiRoutes(app) {
    app.post('/api/genui', async (req, reply) => {
        const userPrompt = String(req.body?.prompt || '').trim();
        if (!userPrompt)
            return reply.status(400).send({ error: 'prompt required' });
        if (!isMacaronConfigured()) {
            return reply
                .status(503)
                .send({ error: `Macaron API not configured. ${MACARON_CONFIG_HINT}` });
        }
        const useTool = req.body?.useTool !== false;
        // Pipe upstream SSE bytes through unchanged — the OpenAI-compatible stream
        // format is already what the client parses.
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const systemPrompt = (await getGenuiSystemPrompt()) + APP_FIRST_ADDENDUM;
        const requestBody = {
            model: MACARON_MODEL,
            stream: true,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        };
        if (useTool) {
            requestBody.tools = [DISPLAY_TSX_TOOL];
            requestBody.tool_choice = { type: 'function', function: { name: 'display_tsx' } };
        }
        let upstream;
        try {
            upstream = await fetch(`${MACARON_API_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${MACARON_API_KEY}`,
                },
                body: JSON.stringify(requestBody),
            });
        }
        catch (e) {
            reply.raw.write(`data: ${JSON.stringify({ error: `upstream fetch failed: ${e.message}` })}\n\n`);
            reply.raw.end();
            return;
        }
        if (!upstream.ok || !upstream.body) {
            const txt = await upstream.text().catch(() => '');
            reply.raw.write(`data: ${JSON.stringify({ error: `upstream ${upstream.status}: ${txt.slice(0, 500)}` })}\n\n`);
            reply.raw.end();
            return;
        }
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                reply.raw.write(dec.decode(value, { stream: true }));
            }
        }
        catch (e) {
            reply.raw.write(`data: ${JSON.stringify({ error: `stream error: ${e.message}` })}\n\n`);
        }
        reply.raw.end();
    });
}
//# sourceMappingURL=genui.js.map