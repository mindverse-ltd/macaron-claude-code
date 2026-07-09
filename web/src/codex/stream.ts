// SSE consumers for the /api/codex/threads endpoints. Parses `data:` frames
// into typed events the chat view can consume with simple callbacks.

import { authedFetch } from '../lib/auth';

export type CodexStreamEvent =
  | { type: 'starting'; cwd?: string }
  | { type: 'meta'; sessionId: string; cwd?: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; text: string; isError: boolean }
  | { type: 'usage'; outputTokens: number; thinkingTokens?: number }
  | { type: 'event'; subtype: string }
  | { type: 'error'; error: string }
  | { type: 'done'; exitCode: number };

export type CodexStreamHandlers = {
  onMeta?: (sessionId: string, cwd?: string) => void;
  onDelta?: (text: string) => void;
  onToolUse?: (ev: Extract<CodexStreamEvent, { type: 'tool_use' }>) => void;
  onToolResult?: (ev: Extract<CodexStreamEvent, { type: 'tool_result' }>) => void;
  onEvent?: (subtype: string) => void;
  onUsage?: (out: number, thinking?: number) => void;
  onError?: (msg: string) => void;
  onDone?: (exitCode: number) => void;
};

type Body = { text: string; cwd?: string; images?: Array<{ mimeType: string; dataUrl: string }> };

async function pump(resp: Response, h: CodexStreamHandlers): Promise<void> {
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    h.onError?.(`http ${resp.status}: ${txt.slice(0, 200)}`);
    return;
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split(/\r?\n\r?\n/);
    buf = events.pop() || '';
    for (const ev of events) {
      const data = ev
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!data || data === '[DONE]') continue;
      let p: CodexStreamEvent;
      try { p = JSON.parse(data) as CodexStreamEvent; } catch { continue; }
      switch (p.type) {
        case 'meta': h.onMeta?.(p.sessionId, p.cwd); break;
        case 'delta': h.onDelta?.(p.text); break;
        case 'tool_use': h.onToolUse?.(p); break;
        case 'tool_result': h.onToolResult?.(p); break;
        case 'event': h.onEvent?.(p.subtype); break;
        case 'usage': h.onUsage?.(p.outputTokens, p.thinkingTokens); break;
        case 'error': h.onError?.(p.error); break;
        case 'done': h.onDone?.(p.exitCode); break;
      }
    }
  }
}

export async function startCodexThread(body: Body, h: CodexStreamHandlers): Promise<void> {
  const resp = await authedFetch('/api/codex/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await pump(resp, h);
}

export async function sendCodexMessage(sid: string, body: Body, h: CodexStreamHandlers): Promise<void> {
  const resp = await authedFetch(`/api/codex/threads/${encodeURIComponent(sid)}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await pump(resp, h);
}
