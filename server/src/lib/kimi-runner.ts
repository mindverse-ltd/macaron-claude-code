// Spawns the Kimi Code CLI (`kimi -p <prompt> --output-format stream-json`)
// and translates its stdout JSONL into the same RunnerEvent stream shape as
// claude-runner.ts / codex-runner.ts, so the SSE handlers and client store
// don't need to know which engine produced the events.
//
// stream-json line shapes (one JSON per line):
//   {"role":"assistant","content":"..."}                                   → delta
//   {"role":"assistant","tool_calls":[{"id","function":{name,arguments}}]} → tool_use
//   {"role":"tool","tool_call_id":"...","content":"..."}                   → tool_result
//   {"role":"meta","type":"session.resume_hint","session_id":"session_…"}  → session
//
// The meta line only arrives at stream end, so for NEW sessions we detect
// the sid early by snapshotting the session tree before spawn and polling
// for the new dir whose state.json workDir matches ours (kimi creates it
// within a few hundred ms). The meta line stays as fallback.
//
// stream-json carries no token usage; after the process closes we sum the
// final turn's step.end usage from the session's wire.jsonl (best effort —
// skipped entirely when the wire can't be read).

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getActiveKimiProviderEnv } from './kimi-config.js';
import { findKimiSessionDir, findNewKimiSession, snapshotKimiSessionIds } from './kimi-store.js';
import type { RunnerEvent, AttachedImage } from './claude-runner.js';

// Resolution order: explicit env override, common global install paths, then
// `which kimi`. No bundled fallback — the kimi CLI has no SDK vendor copy.
function detectKimiBinary(): string | undefined {
  if (process.env.MACARON_KIMI_PATH && existsSync(process.env.MACARON_KIMI_PATH)) {
    return process.env.MACARON_KIMI_PATH;
  }
  for (const p of ['/opt/homebrew/bin/kimi', '/usr/local/bin/kimi', '/usr/bin/kimi']) {
    if (existsSync(p)) return p;
  }
  try {
    const which = execSync('which kimi', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (which) return which;
  } catch { /* not on PATH */ }
  return undefined;
}
export const KIMI_BINARY = detectKimiBinary();

export type KimiRunOptions = {
  prompt: string;
  cwd: string;
  /** Resume an existing sessionId. Omit for a new session. */
  resume?: string;
  abortController?: AbortController;
  images?: AttachedImage[];
};

// Sum the output tokens of the LAST turn recorded in the session's
// wire.jsonl. step.end carries per-step usage keyed by turnId; the current
// turn is the highest turnId in the file. Returns null on any failure —
// usage is nice-to-have and must never break the stream.
async function readLastTurnOutputTokens(sessionDir: string): Promise<number | null> {
  try {
    const wp = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const st = await fs.stat(wp);
    const fh = await fs.open(wp, 'r');
    let text: string;
    try {
      const cap = Math.min(st.size, 512 * 1024);
      const buf = Buffer.alloc(cap);
      await fh.read(buf, 0, cap, st.size - cap);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
    let lastTurn = -1;
    const usages: Array<{ turnId: number; output: number }> = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || !t.includes('"step.end"')) continue;
      try {
        const o = JSON.parse(t) as { type?: string; event?: { type?: string; turnId?: string; usage?: { output?: number } } };
        const ev = o.event;
        if (o.type !== 'context.append_loop_event' || ev?.type !== 'step.end') continue;
        const turnId = Number(ev.turnId ?? -1);
        if (!Number.isFinite(turnId) || turnId < 0) continue;
        if (turnId > lastTurn) lastTurn = turnId;
        usages.push({ turnId, output: Number(ev.usage?.output ?? 0) });
      } catch { /* skip malformed line */ }
    }
    if (lastTurn < 0) return null;
    const total = usages.filter((u) => u.turnId === lastTurn).reduce((s, u) => s + u.output, 0);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

export async function* runKimi(opts: KimiRunOptions): AsyncGenerator<RunnerEvent> {
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

  void (async () => {
    if (!KIMI_BINARY) {
      push({ kind: 'error', error: 'kimi CLI not found — install Kimi Code or set MACARON_KIMI_PATH' });
      push({ kind: 'done', exitCode: -1 });
      finish();
      return;
    }
    let sessionEmitted = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
    try {
      const args = ['-p', opts.prompt, '--output-format', 'stream-json'];
      // Emit the session id as soon as we can. A resume already knows it; a
      // new session learns it via the snapshot-diff poll / meta line below.
      if (opts.resume) {
        args.push('-r', opts.resume);
        sessionEmitted = true;
        push({ kind: 'session', sessionId: opts.resume });
      }
      const providerEnv = getActiveKimiProviderEnv();
      console.log(
        `[kimi-runner] starting  model=${providerEnv.KIMI_MODEL_NAME || '(system)'}  base=${providerEnv.KIMI_MODEL_BASE_URL || '(ambient)'}  resume=${opts.resume ? opts.resume.slice(0, 8) : '(new)'}  cwd=${opts.cwd}`,
      );

      // Snapshot BEFORE spawning so any session dir appearing afterwards is
      // ours (matched on state.json workDir to rule out concurrent runs).
      const before = opts.resume ? null : await snapshotKimiSessionIds();
      const child = spawn(KIMI_BINARY, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...providerEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (before) {
        pollTimer = setInterval(() => {
          void findNewKimiSession(before, opts.cwd).then((hit) => {
            if (!hit || sessionEmitted) return;
            sessionEmitted = true;
            stopPoll();
            push({ kind: 'session', sessionId: hit.sessionId });
          }).catch(() => {});
        }, 200);
        pollTimer.unref();
      }

      const onAbort = () => {
        child.kill('SIGTERM');
        // A hung child shouldn't pin the turn forever — escalate.
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000).unref();
      };
      if (opts.abortController?.signal.aborted) onAbort();
      else opts.abortController?.signal.addEventListener('abort', onAbort, { once: true });

      let stderrTail = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
      });

      let capturedSid = opts.resume || '';
      let syntheticId = 0;
      let buf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let o: {
            role?: string;
            type?: string;
            content?: unknown;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
            tool_call_id?: string;
            is_error?: boolean;
            session_id?: string;
          };
          try { o = JSON.parse(t); } catch { continue; }

          if (o.role === 'meta') {
            // Final line of every stream — the authoritative sid for NEW
            // sessions when the snapshot-diff poll hasn't fired yet.
            if (o.session_id && !sessionEmitted) {
              sessionEmitted = true;
              capturedSid = o.session_id;
              stopPoll();
              push({ kind: 'session', sessionId: o.session_id });
            } else if (o.session_id) {
              capturedSid = o.session_id;
            }
            continue;
          }

          if (o.role === 'assistant') {
            if (typeof o.content === 'string' && o.content) {
              push({ kind: 'delta', text: o.content });
            } else if (Array.isArray(o.content)) {
              const text = o.content
                .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: string }).text || '') : ''))
                .filter(Boolean)
                .join('');
              if (text) push({ kind: 'delta', text });
            }
            for (const call of o.tool_calls || []) {
              const fn = call.function || {};
              let input: unknown = fn.arguments;
              if (typeof input === 'string') {
                try { input = JSON.parse(input); } catch { /* keep as string */ }
              }
              push({ kind: 'tool_use', id: String(call.id || `kimi-${syntheticId++}`), name: String(fn.name || 'tool'), input: input ?? {} });
            }
            continue;
          }

          if (o.role === 'tool') {
            const text = typeof o.content === 'string' ? o.content : JSON.stringify(o.content ?? '');
            push({ kind: 'tool_result', tool_use_id: String(o.tool_call_id || ''), text: text.slice(0, 8000), isError: Boolean(o.is_error) });
            continue;
          }
        }
      });

      const exitCode: number = await new Promise((resolve) => {
        child.on('error', () => resolve(-1));
        child.on('close', (code) => resolve(code ?? -1));
      });
      stopPoll();

      const aborted = Boolean(opts.abortController?.signal.aborted);
      if (exitCode === 0 || aborted) {
        // Live usage meter: stream-json has none, so sum the final turn's
        // step.end usage off the wire.jsonl the CLI just flushed.
        if (!aborted && capturedSid) {
          const dir = await findKimiSessionDir(capturedSid);
          const outputTokens = dir ? await readLastTurnOutputTokens(dir) : null;
          if (outputTokens !== null) push({ kind: 'usage', outputTokens });
        }
        push({ kind: 'done', exitCode: aborted ? -1 : 0 });
      } else {
        const detail = stderrTail.trim().split('\n').slice(-3).join('\n').trim();
        push({ kind: 'error', error: detail || `kimi exited with code ${exitCode}` });
        push({ kind: 'done', exitCode });
      }
    } catch (err) {
      push({ kind: 'error', error: (err as Error).message });
      push({ kind: 'done', exitCode: -1 });
    } finally {
      stopPoll();
      finish();
    }
  })();

  while (true) {
    const r = await next();
    if (r.done) return;
    yield r.value;
  }
}
