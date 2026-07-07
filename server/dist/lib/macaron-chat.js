// Macaron model chat backend. When the user picks Macaron-0.6 in the model
// dropdown, we bypass the Claude Agent SDK and call Macaron's OpenAI-compatible
// /chat/completions endpoint directly. To keep the session view consistent with
// the Claude path, we read prior messages from the same jsonl and append the
// new user/assistant turns to it (same schema the SDK writes).
//
// Limitations vs Claude path: no tools (Bash/Edit/render_ui), no resume state
// other than what's in the jsonl, images are dropped silently.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLAUDE_PROJECTS, MACARON_API_BASE, MACARON_API_KEY, MACARON_MODEL, isMacaronConfigured, MACARON_CONFIG_HINT, } from '../config.js';
function isoNow() {
    return new Date().toISOString();
}
function randId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
async function readPriorMessages(filePath) {
    let raw = '';
    try {
        raw = await fs.readFile(filePath, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const o = JSON.parse(line);
            if (o.isMeta)
                continue;
            if (o.type !== 'user' && o.type !== 'assistant')
                continue;
            const c = o.message?.content;
            let text = '';
            if (typeof c === 'string')
                text = c;
            else if (Array.isArray(c)) {
                text = c
                    .filter((b) => b.type === 'text' && b.text)
                    .map((b) => b.text)
                    .join('\n');
            }
            if (text.trim())
                out.push({ role: o.type, content: text });
        }
        catch {
            /* skip malformed */
        }
    }
    return out;
}
async function appendJsonlLine(filePath, obj) {
    await fs.appendFile(filePath, JSON.stringify(obj) + '\n', 'utf8');
}
export async function runMacaronChat(args, send) {
    if (!isMacaronConfigured()) {
        send({ type: 'error', error: `Macaron API not configured. ${MACARON_CONFIG_HINT}` });
        send({ type: 'done', exitCode: 1 });
        return;
    }
    const filePath = path.join(CLAUDE_PROJECTS, args.project, `${args.sid}.jsonl`);
    if (args.images.length > 0) {
        send({ type: 'warn', text: 'Macaron-0.6 does not accept images yet — dropped.' });
    }
    const prior = await readPriorMessages(filePath);
    const messages = [
        ...prior,
        { role: 'user', content: args.text },
    ];
    // Persist the user turn immediately so a mid-stream refresh sees it.
    await appendJsonlLine(filePath, {
        type: 'user',
        uuid: randId('umsg'),
        timestamp: isoNow(),
        message: { role: 'user', content: [{ type: 'text', text: args.text }] },
    });
    let upstream;
    try {
        upstream = await fetch(`${MACARON_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${MACARON_API_KEY}`,
            },
            body: JSON.stringify({ model: MACARON_MODEL, stream: true, messages }),
        });
    }
    catch (e) {
        send({ type: 'error', error: `macaron fetch failed: ${e.message}` });
        send({ type: 'done', exitCode: -1 });
        return;
    }
    if (!upstream.ok || !upstream.body) {
        const txt = await upstream.text().catch(() => '');
        send({ type: 'error', error: `macaron ${upstream.status}: ${txt.slice(0, 400)}` });
        send({ type: 'done', exitCode: -1 });
        return;
    }
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let assistantBuf = '';
    outer: for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith('data:'))
                continue;
            const data = s.slice(5).trim();
            if (!data || data === '[DONE]') {
                if (data === '[DONE]')
                    break outer;
                continue;
            }
            try {
                const p = JSON.parse(data);
                const delta = p?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta) {
                    assistantBuf += delta;
                    send({ type: 'delta', text: delta });
                }
            }
            catch {
                /* skip malformed */
            }
        }
    }
    // Persist the assistant turn so the next /api/sessions/.../sid render shows it.
    if (assistantBuf) {
        await appendJsonlLine(filePath, {
            type: 'assistant',
            uuid: randId('amsg'),
            timestamp: isoNow(),
            message: {
                role: 'assistant',
                model: MACARON_MODEL,
                content: [{ type: 'text', text: assistantBuf }],
            },
        });
    }
    send({ type: 'done', exitCode: 0 });
}
//# sourceMappingURL=macaron-chat.js.map