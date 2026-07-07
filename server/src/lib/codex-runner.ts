// Wraps @openai/codex-sdk into the same RunnerEvent stream shape as
// claude-runner.ts so the SSE handlers and client store don't need to know
// which engine produced the events. Codex's SDK emits ThreadEvents over
// JSONL (via a spawned codex CLI); we translate them 1:1 into
// {kind:'delta'|'tool_use'|'tool_result'|...}.
//
// Key mapping choices:
//   - `thread.started`               → session (thread_id = our sessionId)
//   - `item.completed { agent_message }` → single delta with full text
//   - `item.completed { reasoning }`     → thinking-tagged event
//   - `item.started/updated/completed { command_execution }` → tool_use +
//     streamed tool_result (Bash-shaped card in the WebUI)
//   - `item.completed { file_change }`   → tool_use + tool_result (patch)
//   - `item.completed { todo_list }`     → synthesized TodoWrite tool_use
//   - `turn.completed`                    → usage + done
//   - `turn.failed` / `error`             → error + done
//
// Streaming caveat: the Codex SDK delivers agent_message text as a single
// `item.completed` (full text landed) rather than a token-level delta
// stream. We emit it as one `delta` for now — good enough for the WebUI
// bubble to render; can be split later if the SDK adds mid-turn updates.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type {
  CodexOptions,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
} from '@openai/codex-sdk';
import { getCodexConfig } from './codex-config.js';
import type { RunnerEvent, AttachedImage } from './claude-runner.js';

// @openai/codex-sdk ships the `codex` binary via optional deps; if it's not
// present the SDK throws at construction time. Fall back to the user's
// system `codex` (installed via Homebrew or a global npm install) so the
// runner works with the CLI they already use in the terminal.
function detectCodexBinary(): string | undefined {
  // Prefer explicit env override, then a couple of common install paths,
  // then `which codex`.
  if (process.env.MACARON_CODEX_PATH && existsSync(process.env.MACARON_CODEX_PATH)) {
    return process.env.MACARON_CODEX_PATH;
  }
  for (const p of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex']) {
    if (existsSync(p)) return p;
  }
  try {
    return execSync('which codex', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || undefined;
  } catch {
    return undefined;
  }
}
const CODEX_BINARY = detectCodexBinary();

export type CodexRunOptions = {
  prompt: string;
  cwd: string;
  /** Resume an existing thread_id. Omit for a new thread. */
  resume?: string;
  abortController?: AbortController;
  images?: AttachedImage[];
};

// Build the CodexOptions + ThreadOptions from our persisted settings. Kept
// here (not exported) so the runner is the single caller — settings changes
// take effect on the next `runCodex()` without hot-reload plumbing.
function buildOptions(): { codex: CodexOptions; thread: ThreadOptions } {
  const p = getCodexConfig().provider;
  return {
    codex: {
      codexPathOverride: CODEX_BINARY,
      apiKey: p.apiKey || undefined,
      baseUrl: p.baseUrl || undefined,
      // Flattened into `--config key=value` args by the SDK. Mirrors what
      // the user would put in ~/.codex/config.toml for CLI use.
      config: {
        model_provider: p.modelProvider,
        model: p.model,
        review_model: p.model,
        model_reasoning_effort: p.reasoningEffort,
        model_context_window: p.contextWindow,
        model_auto_compact_token_limit: p.autoCompactTokenLimit,
        disable_response_storage: p.disableResponseStorage,
        network_access: 'enabled',
        // The bearer_token pathway; the SDK also sets OPENAI_API_KEY.
        [`model_providers.${p.modelProvider}.name`]: p.modelProvider,
        [`model_providers.${p.modelProvider}.base_url`]: p.baseUrl,
        [`model_providers.${p.modelProvider}.wire_api`]: p.wireApi,
        [`model_providers.${p.modelProvider}.experimental_bearer_token`]: p.apiKey,
      },
    },
    thread: {
      model: p.model,
      sandboxMode: p.sandboxMode,
      approvalPolicy: p.approvalPolicy,
      modelReasoningEffort: p.reasoningEffort,
      webSearchEnabled: p.webSearchEnabled,
      skipGitRepoCheck: true,
    },
  };
}

// Build the SDK Input from a text prompt + optional base64 images. Codex
// only supports `local_image` (path on disk), not inline data URLs — we
// write each attached image to a temp file first. For MVP we skip images.
function buildInput(opts: CodexRunOptions): string {
  // TODO: write opts.images to tmp and pass [{type:'local_image', path}, {type:'text', text}]
  return opts.prompt;
}

export async function* runCodex(opts: CodexRunOptions): AsyncGenerator<RunnerEvent> {
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

  const { codex: codexOpts, thread: threadOpts } = buildOptions();
  console.log(
    `[codex-runner] starting  model=${threadOpts.model}  base=${codexOpts.baseUrl || '(sdk default)'}  resume=${opts.resume ? opts.resume.slice(0, 8) : '(new)'}  cwd=${opts.cwd}`,
  );

  // De-dupe tool cards: item.started and item.updated may fire multiple
  // times before item.completed. We emit tool_use once (started), streaming
  // partial tool_result on updates (command_execution's aggregated_output),
  // then a final tool_result on completed.
  const emittedToolUse = new Set<string>();

  const handleItemEvent = (
    phase: 'started' | 'updated' | 'completed',
    item: ThreadItem,
  ) => {
    switch (item.type) {
      case 'agent_message': {
        // Codex emits agent_message as one atomic item (full text). Emit
        // once on completed so streaming ordering with tool_use events is
        // preserved.
        if (phase !== 'completed') return;
        const text = item.text?.trim();
        if (text) push({ kind: 'delta', text });
        return;
      }
      case 'reasoning': {
        if (phase !== 'completed') return;
        const text = item.text?.trim();
        if (!text) return;
        // Reuse the tool-input event shape to carry a thinking block.
        // Actually the WebUI has no first-class "thinking delta" event on
        // the runner yet — we fold reasoning into a delta prefixed with a
        // marker the WebUI can recognise. Simpler: emit as message subtype
        // 'thinking' so downstream can render or ignore.
        push({ kind: 'message', subtype: 'codex_reasoning' });
        push({ kind: 'delta', text });
        return;
      }
      case 'command_execution': {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: 'tool_use',
            id,
            name: 'Bash',
            input: { command: item.command },
          });
        }
        if (phase === 'completed') {
          push({
            kind: 'tool_result',
            tool_use_id: id,
            text: item.aggregated_output || `(exit ${item.exit_code ?? '?'})`,
            isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0,
          });
        }
        return;
      }
      case 'file_change': {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: 'tool_use',
            id,
            name: 'Edit',
            input: { changes: item.changes },
          });
        }
        if (phase === 'completed') {
          const summary = item.changes
            .map((c) => `${c.kind === 'add' ? '＋' : c.kind === 'delete' ? '－' : '△'} ${c.path}`)
            .join('\n');
          push({
            kind: 'tool_result',
            tool_use_id: id,
            text: summary || '(no changes)',
            isError: item.status === 'failed',
          });
        }
        return;
      }
      case 'mcp_tool_call': {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: 'tool_use',
            id,
            name: `mcp:${item.server}/${item.tool}`,
            input: item.arguments ?? {},
          });
        }
        if (phase === 'completed') {
          const text = item.error?.message
            ?? JSON.stringify(item.result?.content ?? item.result?.structured_content ?? '', null, 2);
          push({
            kind: 'tool_result',
            tool_use_id: id,
            text: (text || '').slice(0, 8000),
            isError: item.status === 'failed',
          });
        }
        return;
      }
      case 'web_search': {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: 'tool_use',
            id,
            name: 'WebSearch',
            input: { query: item.query },
          });
        }
        if (phase === 'completed') {
          push({ kind: 'tool_result', tool_use_id: id, text: '(search dispatched)', isError: false });
        }
        return;
      }
      case 'todo_list': {
        // Emit as a synthetic TodoWrite so the WebUI's existing todo card
        // renders. Only on completed to avoid churn.
        if (phase !== 'completed') return;
        const id = item.id;
        push({
          kind: 'tool_use',
          id,
          name: 'TodoWrite',
          input: {
            todos: item.items.map((t, i) => ({
              content: t.text,
              status: t.completed ? 'completed' : 'pending',
              activeForm: t.text,
              id: `codex-todo-${i}`,
            })),
          },
        });
        push({ kind: 'tool_result', tool_use_id: id, text: 'todo list updated', isError: false });
        return;
      }
      case 'error': {
        if (phase !== 'completed') return;
        push({ kind: 'error', error: item.message || 'unknown codex item error' });
        return;
      }
      default:
        return;
    }
  };

  void (async () => {
    let sessionEmitted = false;
    try {
      // Lazy-import so the default (claude) engine never loads @openai/codex-sdk
      // — the bundled tarball (server/dist/index.js only) has no node_modules, so
      // a top-level import would crash boot with ERR_MODULE_NOT_FOUND.
      const { Codex } = await import('@openai/codex-sdk');
      const codex = new Codex(codexOpts);
      const thread = opts.resume
        ? codex.resumeThread(opts.resume, { ...threadOpts, workingDirectory: opts.cwd })
        : codex.startThread({ ...threadOpts, workingDirectory: opts.cwd });

      // Emit the session id as soon as we can. resumeThread already knows
      // the id; startThread learns it via thread.started below.
      if (opts.resume) {
        sessionEmitted = true;
        push({ kind: 'session', sessionId: opts.resume });
      }

      const streamed = await thread.runStreamed(buildInput(opts), {
        signal: opts.abortController?.signal,
      });

      for await (const ev of streamed.events as AsyncIterable<ThreadEvent>) {
        switch (ev.type) {
          case 'thread.started':
            if (!sessionEmitted) {
              sessionEmitted = true;
              push({ kind: 'session', sessionId: ev.thread_id });
            }
            break;
          case 'turn.started':
            push({ kind: 'message', subtype: 'codex_turn_started' });
            break;
          case 'item.started':
            handleItemEvent('started', ev.item);
            break;
          case 'item.updated':
            handleItemEvent('updated', ev.item);
            break;
          case 'item.completed':
            handleItemEvent('completed', ev.item);
            break;
          case 'turn.completed':
            push({
              kind: 'usage',
              outputTokens: ev.usage.output_tokens,
              thinkingTokens: ev.usage.reasoning_output_tokens,
            });
            push({ kind: 'done', exitCode: 0 });
            finish();
            return;
          case 'turn.failed':
            push({ kind: 'error', error: ev.error?.message || 'codex turn failed' });
            push({ kind: 'done', exitCode: 1 });
            finish();
            return;
          case 'error':
            push({ kind: 'error', error: ev.message || 'codex stream error' });
            push({ kind: 'done', exitCode: 1 });
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
