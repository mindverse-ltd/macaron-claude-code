// One-shot Macaron GenUI call: prompt → complete TSX string. Used both by
// the standalone /api/genui SSE route and by the `render_ui` MCP tool that
// Claude Code sessions can invoke to inline GenUI blocks into the chat.
import { GENUI_SYSTEM_PROMPT_URL, MACARON_API_BASE, MACARON_API_KEY, MACARON_MODEL, } from '../config.js';
const APP_FIRST_ADDENDUM = `\n\n# ADDITIONAL CONSTRAINTS (highest priority)\n\n` +
    `- Emit code via the display_tsx tool. Do NOT wrap in markdown fences. Do NOT prepend prose.\n` +
    `- ORDER MATTERS for streaming preview: write \`export default function App()\` IMMEDIATELY after the imports. ` +
    `Put data constants INSIDE the function body (\`const METRICS = [...]\` lives after \`function App() {\`, not at module scope).\n` +
    `- This lets the host paint a shell as soon as the JSX begins, instead of waiting for data arrays to finish streaming.`;
let cachedPrompt = null;
let cachedPromptAt = 0;
export async function getGenuiSystemPrompt() {
    const ttl = 10 * 60_000;
    if (cachedPrompt && Date.now() - cachedPromptAt < ttl)
        return cachedPrompt;
    try {
        const r = await fetch(GENUI_SYSTEM_PROMPT_URL, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
            cachedPrompt = await r.text();
            cachedPromptAt = Date.now();
            return cachedPrompt;
        }
    }
    catch {
        /* fall through */
    }
    cachedPrompt =
        'You generate one self-contained TSX module with `export default function App()`. ' +
            "Use components from `$macaron/ui`. Keep output streamable. Don't import external runtime data. " +
            'Avoid full-page shells. Render embeddable surfaces only.';
    cachedPromptAt = Date.now();
    return cachedPrompt;
}
const DISPLAY_TSX_TOOL = {
    type: 'function',
    function: {
        name: 'display_tsx',
        description: 'Render a streaming TSX module inline. The `code` field MUST start with imports and then `export default function App()`. ' +
            'Declare ALL data INSIDE the function body so the preview can emerge while data is still streaming.',
        parameters: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Complete TSX module source.' },
            },
            required: ['code'],
        },
    },
};
/**
 * Streaming variant: invokes onPartial(code) every time more code is decoded
 * from the streaming tool_call args. Returns the final code on completion.
 * Throws on API errors. The onPartial callback may receive incomplete (but
 * still parseable) TSX — the host renderer handles partial code gracefully.
 */
export async function streamTsx(prompt, onPartial, signal) {
    const systemPrompt = (await getGenuiSystemPrompt()) + APP_FIRST_ADDENDUM;
    const requestBody = {
        model: MACARON_MODEL,
        stream: true,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
        ],
        tools: [DISPLAY_TSX_TOOL],
        tool_choice: { type: 'function', function: { name: 'display_tsx' } },
    };
    const upstream = await fetch(`${MACARON_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${MACARON_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
        signal,
    });
    if (!upstream.ok || !upstream.body) {
        const txt = await upstream.text().catch(() => '');
        throw new Error(`Macaron API error ${upstream.status}: ${txt.slice(0, 300)}`);
    }
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let toolArgs = '';
    let lastEmittedLen = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split(/\r?\n\r?\n/);
        buf = events.pop() || '';
        let changed = false;
        for (const ev of events) {
            const data = ev
                .split(/\r?\n/)
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trimStart())
                .join('\n')
                .trim();
            if (!data || data === '[DONE]')
                continue;
            try {
                const payload = JSON.parse(data);
                const tc = payload.choices?.[0]?.delta?.tool_calls?.[0];
                if (tc?.function?.arguments) {
                    toolArgs += tc.function.arguments;
                    changed = true;
                }
            }
            catch {
                /* skip */
            }
        }
        if (changed) {
            const partial = extractCodePrefix(toolArgs);
            if (partial && partial.length > lastEmittedLen) {
                lastEmittedLen = partial.length;
                onPartial(partial);
            }
        }
    }
    return parseFinalCode(toolArgs);
}
// Pulls out the in-progress `code` string from a (likely incomplete) JSON
// blob like `{"code":"import {Bu`. Returns '' if no `code` key seen yet.
function extractCodePrefix(raw) {
    const m = /"code"\s*:\s*"((?:\\.|[^"\\])*)/.exec(raw);
    if (!m)
        return '';
    return unescapeJsonString(m[1]);
}
function parseFinalCode(toolArgs) {
    try {
        const obj = JSON.parse(toolArgs);
        if (typeof obj?.code === 'string')
            return obj.code;
    }
    catch {
        /* fall through */
    }
    const m = /"code"\s*:\s*"((?:\\.|[^"\\])*)"/s.exec(toolArgs);
    if (!m)
        throw new Error('Macaron did not produce a `code` field. Args: ' + toolArgs.slice(0, 200));
    return unescapeJsonString(m[1]);
}
function unescapeJsonString(s) {
    return s
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\//g, '/')
        .replace(/\\\\/g, '\\');
}
/**
 * Convenience wrapper around streamTsx for callers that don't need partials.
 */
export async function generateTsx(prompt, signal) {
    return streamTsx(prompt, () => { }, signal);
}
//# sourceMappingURL=macaron-genui.js.map