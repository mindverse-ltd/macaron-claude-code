// Wraps the Claude Agent SDK so the rest of the app sees a normalized stream of
// {sessionId, deltas, events, done}. Replaces the previous child_process.spawn
// approach — same UX, no CLI stdout parsing, typed events, no IPC buffering.

import { randomUUID } from 'node:crypto';
import { query, type SDKMessage, type PermissionMode, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { macaronMcpServer } from './macaron-mcp.js';
import { registerPending } from './permission-registry.js';

export type AttachedImage = { mimeType: string; dataUrl: string };

export type RunnerEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'delta'; text: string }
  // Emitted when the model starts a tool_use block (carries id+name).
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  // Token-level streaming of the tool's JSON input. partial_json is a chunk
  // of the in-progress arguments JSON; consumers may concat them and try a
  // tolerant parse to extract a partial `code` field for live rendering.
  | { kind: 'tool_input_delta'; id: string; name: string; partial_json: string; accumulated: string }
  // Tool's JSON input is fully streamed (content_block_stop fired). Carries
  // the complete accumulated JSON so consumers can finalize state.
  | { kind: 'tool_input_done'; id: string; name: string; final_json: string }
  | { kind: 'tool_result'; tool_use_id: string; text: string; isError: boolean }
  // Live usage. Emitted from Anthropic's `message_delta` streaming events
  // (authoritative cumulative output_tokens) and from thinking-phase ping
  // digests (estimated tokens burned during silent extended thinking).
  | { kind: 'usage'; outputTokens: number; thinkingTokens?: number }
  | { kind: 'message'; subtype: string }
  // Fired when the SDK's canUseTool asks whether to run a tool. The client
  // must POST /permission-decision with { id, decision } — canUseTool is
  // parked on a Promise until that arrives.
  | { kind: 'permission_request'; id: string; toolName: string; input: unknown }
  | { kind: 'permission_resolved'; id: string; decision: 'allow' | 'deny' }
  | { kind: 'error'; error: string }
  | { kind: 'done'; exitCode: number };

export type RunOptions = {
  prompt: string;
  cwd: string;
  /** Resume an existing sessionId. Omit for a new session. */
  resume?: string;
  abortController?: AbortController;
  permissionMode?: PermissionMode;
  model?: string;
  images?: AttachedImage[];
  /**
   * Env vars to pass to the Claude Code SDK subprocess. Setting
   * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN here reroutes the SDK to a
   * different Anthropic-compatible endpoint (e.g. Macaron). When null, the
   * subprocess inherits process.env unchanged (default Anthropic path).
   */
  envOverrides?: Record<string, string> | null;
};

function buildPromptInput(opts: RunOptions): string | AsyncIterable<SDKUserMessage> {
  if (!opts.images || opts.images.length === 0) return opts.prompt;
  // When images are attached we must pass content blocks via an async iterable.
  // Strip the data-URL prefix so the SDK sees raw base64.
  const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const imageBlocks = opts.images.map((img) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
    const detected = m?.[1] || img.mimeType || 'image/png';
    const mediaType = (allowed.has(detected) ? detected : 'image/png') as
      'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    const data = m?.[2] || '';
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: mediaType, data },
    };
  });
  const content = [
    ...imageBlocks,
    ...(opts.prompt ? [{ type: 'text' as const, text: opts.prompt }] : []),
  ];
  const msg: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
  return (async function* () { yield msg; })();
}

export async function* runClaude(opts: RunOptions): AsyncGenerator<RunnerEvent> {
  // Queue-based generator: both the SDK's async iterator loop and the
  // canUseTool callback push here. canUseTool needs to *both* emit a
  // permission_request event AND await a client decision — a plain
  // `yield` inside a callback context can't do that, so we drain a shared
  // queue from the outer generator.
  const queue: RunnerEvent[] = [];
  const waiters: Array<(v: IteratorResult<RunnerEvent>) => void> = [];
  let ended = false;
  const push = (ev: RunnerEvent) => {
    const w = waiters.shift();
    if (w) w({ value: ev, done: false });
    else queue.push(ev);
  };
  const finish = () => {
    ended = true;
    while (waiters.length) waiters.shift()!({ value: undefined as unknown as RunnerEvent, done: true });
  };
  const next = (): Promise<IteratorResult<RunnerEvent>> => {
    if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
    if (ended) return Promise.resolve({ value: undefined as unknown as RunnerEvent, done: true });
    return new Promise((res) => waiters.push(res));
  };

  // Per-content-block context for streaming tool input. The SDK fires
  // content_block_start/delta/stop with an `index`; we use that to pair
  // input_json_delta chunks with the originating tool_use's id+name.
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

  const e = opts.envOverrides;
  const routedBase = e?.ANTHROPIC_BASE_URL || '(inherited from process.env)';
  const cfgDir = e?.CLAUDE_CONFIG_DIR || '(user default ~/.claude)';
  console.log(
    `[claude-runner] starting  model=${opts.model ?? '(sdk default)'}  base=${routedBase}  CLAUDE_CONFIG_DIR=${cfgDir}  resume=${opts.resume ? opts.resume.slice(0, 8) : '(new)'}`,
  );

  // Launch the SDK stream in the background. Both success and error paths
  // eventually push a `done` and call `finish()` so the outer drain loop
  // can exit cleanly.
  void (async () => {
    let sessionEmitted = false;
    try {
      const stream = query({
        prompt: buildPromptInput(opts),
        options: {
          cwd: opts.cwd,
          resume: opts.resume,
          model: opts.model,
          permissionMode: opts.permissionMode,
          includePartialMessages: true,
          abortController: opts.abortController,
          mcpServers: { macaron: macaronMcpServer },
          allowedTools: ['mcp__macaron__render_ui'],
          // canUseTool: pause the SDK, ask the client, resume once decided.
          // A promise is registered under a random id; the client's POST to
          // /permission-decision looks the id up and resolves it.
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            const id = randomUUID();
            const decision = await new Promise<
              { decision: 'allow' } | { decision: 'deny'; reason?: string }
            >((resolve) => {
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
      for await (const m of stream as AsyncIterable<SDKMessage>) {
        if (!sessionEmitted && 'session_id' in m && m.session_id) {
          sessionEmitted = true;
          push({ kind: 'session', sessionId: m.session_id });
        }
        if (m.type === 'stream_event') {
          const ev = m.event;
          if (ev.type === 'message_delta') {
            const usage = (ev as unknown as { usage?: { output_tokens?: number } }).usage;
            if (usage && typeof usage.output_tokens === 'number') {
              push({ kind: 'usage', outputTokens: usage.output_tokens });
            }
          }
          if (ev.type === 'content_block_start') {
            const cb = ev.content_block as {
              type?: string; id?: string; name?: string; input?: unknown;
            };
            if (cb?.type === 'tool_use' && cb.id && cb.name) {
              toolBlocks.set(ev.index, { id: cb.id, name: cb.name, json: '' });
              push({ kind: 'tool_use', id: cb.id, name: cb.name, input: cb.input ?? {} });
            }
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta as { type?: string; text?: string; partial_json?: string };
            if (d?.type === 'text_delta' && d.text) {
              push({ kind: 'delta', text: d.text });
            } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
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
          } else if (ev.type === 'content_block_stop') {
            const tb = toolBlocks.get(ev.index);
            if (tb) {
              push({ kind: 'tool_input_done', id: tb.id, name: tb.name, final_json: tb.json });
              toolBlocks.delete(ev.index);
            }
          }
        } else if (m.type === 'user') {
          const blocks = ((m.message as { content?: unknown })?.content || []) as Array<{
            type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean;
          }>;
          for (const b of blocks) {
            if (b.type === 'tool_result' && b.tool_use_id) {
              const c = b.content;
              const text =
                typeof c === 'string'
                  ? c
                  : Array.isArray(c)
                    ? c.map((x: { text?: string }) => x.text || '').join('')
                    : '';
              push({ kind: 'tool_result', tool_use_id: b.tool_use_id, text, isError: Boolean(b.is_error) });
            }
          }
        } else if (m.type === 'system') {
          if (m.subtype === 'thinking_tokens') {
            const est = (m as unknown as { estimated_tokens?: number }).estimated_tokens;
            if (typeof est === 'number') {
              push({ kind: 'usage', outputTokens: 0, thinkingTokens: est });
            }
          }
          push({ kind: 'message', subtype: m.subtype || 'system' });
        } else if (m.type === 'result') {
          if (m.is_error) {
            const r = m as unknown as {
              subtype?: string;
              stop_reason?: string;
              api_error_status?: number | null;
              errors?: string[];
              result?: string;
            };
            const detail =
              (r.errors && r.errors.length ? r.errors.join(' | ') : '') ||
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
    } catch (err) {
      push({ kind: 'error', error: (err as Error).message });
      push({ kind: 'done', exitCode: -1 });
    } finally {
      finish();
    }
  })();

  while (true) {
    const r = await next();
    if (r.done) return;
    yield r.value;
  }
}

