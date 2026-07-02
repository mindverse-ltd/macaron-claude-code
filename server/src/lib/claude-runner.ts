// Wraps the Claude Agent SDK so the rest of the app sees a normalized stream of
// {sessionId, deltas, events, done}. Replaces the previous child_process.spawn
// approach — same UX, no CLI stdout parsing, typed events, no IPC buffering.

import { query, type SDKMessage, type PermissionMode, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { macaronMcpServer } from './macaron-mcp.js';

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
  let sessionEmitted = false;
  // Per-content-block context for streaming tool input. The SDK fires
  // content_block_start/delta/stop with an `index`; we use that to pair
  // input_json_delta chunks with the originating tool_use's id+name.
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
  // Confirm which provider a call is actually hitting — useful when
  // debugging "is Macaron really being used" questions.
  const e = opts.envOverrides;
  const routedBase = e?.ANTHROPIC_BASE_URL || '(inherited from process.env)';
  const cfgDir = e?.CLAUDE_CONFIG_DIR || '(user default ~/.claude)';
  console.log(
    `[claude-runner] starting  model=${opts.model ?? '(sdk default)'}  base=${routedBase}  CLAUDE_CONFIG_DIR=${cfgDir}  resume=${opts.resume ? opts.resume.slice(0, 8) : '(new)'}`,
  );
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
        // Inject the Macaron GenUI bridge so Claude can call `render_ui` to
        // produce inline TSX previews in the chat.
        mcpServers: { macaron: macaronMcpServer },
        // Auto-allow render_ui — we *want* Claude to call it freely. Don't
        // bypass permissions globally because the session still needs the
        // default gating for Bash/Edit/Write etc.
        allowedTools: ['mcp__macaron__render_ui'],
        // Provider switch: when envOverrides is set (Macaron backend),
        // hand the SDK subprocess a custom env with ANTHROPIC_BASE_URL etc.
        ...(opts.envOverrides ? { env: opts.envOverrides } : {}),
      },
    });
    for await (const m of stream as AsyncIterable<SDKMessage>) {
      // Emit sessionId on the very first message that carries one (typically
      // the system/init frame).
      if (!sessionEmitted && 'session_id' in m && m.session_id) {
        sessionEmitted = true;
        yield { kind: 'session', sessionId: m.session_id };
      }
      // Token-level deltas live inside stream_event / content_block_delta.
      if (m.type === 'stream_event') {
        const ev = m.event;
        // Anthropic streams cumulative output_tokens inside `message_delta`
        // events during the turn — perfect for a live badge, avoids the
        // len/4 English heuristic (which underestimates ~2.5x for Chinese).
        if (ev.type === 'message_delta') {
          const usage = (ev as unknown as { usage?: { output_tokens?: number } }).usage;
          if (usage && typeof usage.output_tokens === 'number') {
            yield { kind: 'usage', outputTokens: usage.output_tokens };
          }
        }
        if (ev.type === 'content_block_start') {
          // Track tool_use blocks by their content-block index so subsequent
          // input_json_delta events can be routed back to the right tool.
          // Yield tool_use NOW (not on the later assistant message) so the
          // client can create the placeholder before tool_input_delta arrives.
          const cb = ev.content_block as {
            type?: string; id?: string; name?: string; input?: unknown;
          };
          if (cb?.type === 'tool_use' && cb.id && cb.name) {
            toolBlocks.set(ev.index, { id: cb.id, name: cb.name, json: '' });
            yield { kind: 'tool_use', id: cb.id, name: cb.name, input: cb.input ?? {} };
          }
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta as { type?: string; text?: string; partial_json?: string };
          if (d?.type === 'text_delta' && d.text) {
            yield { kind: 'delta', text: d.text };
          } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const tb = toolBlocks.get(ev.index);
            if (tb) {
              tb.json += d.partial_json;
              yield {
                kind: 'tool_input_delta',
                id: tb.id,
                name: tb.name,
                partial_json: d.partial_json,
                accumulated: tb.json,
              };
            }
          }
        } else if (ev.type === 'content_block_stop') {
          const tb = toolBlocks.get(ev.index);
          if (tb) {
            yield { kind: 'tool_input_done', id: tb.id, name: tb.name, final_json: tb.json };
            toolBlocks.delete(ev.index);
          }
        }
      } else if (m.type === 'user') {
        // tool_result blocks come back as user messages in the SDK protocol.
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
            yield { kind: 'tool_result', tool_use_id: b.tool_use_id, text, isError: Boolean(b.is_error) };
          }
        }
      } else if (m.type === 'system') {
        // The SDK emits `thinking_tokens` frames during silent extended-thinking
        // phases so consumers can show progress even before any text streams.
        if (m.subtype === 'thinking_tokens') {
          const est = (m as unknown as { estimated_tokens?: number }).estimated_tokens;
          if (typeof est === 'number') {
            yield { kind: 'usage', outputTokens: 0, thinkingTokens: est };
          }
        }
        yield { kind: 'message', subtype: m.subtype || 'system' };
      } else if (m.type === 'result') {
        yield {
          kind: 'done',
          exitCode: m.is_error ? 1 : 0,
        };
        return;
      }
    }
    yield { kind: 'done', exitCode: 0 };
  } catch (e) {
    yield { kind: 'error', error: (e as Error).message };
    yield { kind: 'done', exitCode: -1 };
  }
}
