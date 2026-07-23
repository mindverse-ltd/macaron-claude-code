// Opt-in autonomous loop for Codex sessions (macaron-claude-code#107).
//
// codoxear popularized the "ralph loop": when the agent goes idle, the server
// re-injects a continue prompt so long tasks run unattended. codoxear's loop is
// hardcoded and forced — one prompt, no off switch. This is the *configurable*
// version: opt-in per session, editable prompt, and real stop conditions.
//
// It lives entirely server-side and drives the same configured transport a user
// turn uses. After any turn completes and the session is idle (active-runs has
// no controller for the sid), a timer fires the next iteration with the
// persisted loop prompt. Because it's detached from the POST request that
// started it, the loop keeps going after the browser closes; an open thread view
// re-attaches via `subscribeLoop` to watch it live.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodexPlanStatus, CodexApprovalKind, CodexDecision } from '@macaron/shared';
import { HOME } from '../config.js';
import type { RunnerEvent } from './claude-runner.js';
import { runCodexTurn } from './codex-transport.js';
import { registerRun, endRun, abortRun, isRunActive } from './active-runs.js';

export type CodexLoopConfig = {
  enabled: boolean;
  /** The continue prompt re-injected each iteration. NOT a baked-in string. */
  prompt: string;
  /** Stop after N loop-driven iterations. 0 = unlimited. */
  maxIterations: number;
  /** Stop after this many ms of wall-clock since the loop armed. 0 = no limit. */
  timeoutMs: number;
  /** Stop if the agent's turn output contains any of these substrings. */
  sentinels: string[];
};

export type CodexLoopStatus = 'idle' | 'armed' | 'running' | 'stopped';

export type CodexLoopSnapshot = {
  enabled: boolean;
  status: CodexLoopStatus;
  iterations: number;
  config: CodexLoopConfig;
  stopReason?: string;
};

// Events pushed to subscribers of a session's loop stream. The runner-shaped
// ones mirror the codex POST SSE 1:1 so the client's existing stream handlers
// render an auto-turn exactly like a manual one; `loop_status` carries lifecycle.
export type CodexLoopStreamEvent =
  | { type: 'loop_status'; snapshot: CodexLoopSnapshot }
  | { type: 'meta'; sessionId: string; cwd?: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; text: string; isError: boolean }
  | { type: 'usage'; outputTokens: number; thinkingTokens?: number }
  | { type: 'event'; subtype: string }
  | { type: 'codex_plan'; steps: Array<{ step: string; status: CodexPlanStatus }>; explanation?: string | null }
  | { type: 'codex_approval_request'; id: string; kind: CodexApprovalKind; command?: string; cwd?: string; reason?: string | null; fileChanges?: Array<{ path: string; kind: string; diff?: string }>; grantRoot?: string | null; network?: { host: string; protocol: string }; available: CodexDecision[] }
  | { type: 'codex_approval_resolved'; id: string; decision?: CodexDecision | 'stale' }
  | { type: 'error'; error: string }
  | { type: 'done'; exitCode: number };

export function mapLoopRunnerEvent(ev: RunnerEvent): CodexLoopStreamEvent | null {
  switch (ev.kind) {
    case 'session': return { type: 'meta', sessionId: ev.sessionId };
    case 'delta': return { type: 'delta', text: ev.text };
    case 'reasoning': return { type: 'reasoning', text: ev.text };
    case 'tool_use': return { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input };
    case 'tool_result': return { type: 'tool_result', tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError };
    case 'usage': return { type: 'usage', outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens };
    case 'message': return { type: 'event', subtype: ev.subtype };
    case 'codex_plan': return { type: 'codex_plan', steps: ev.steps, explanation: ev.explanation };
    case 'codex_approval_request': return { type: 'codex_approval_request', id: ev.id, kind: ev.approval, command: ev.command, cwd: ev.cwd, reason: ev.reason, fileChanges: ev.fileChanges, grantRoot: ev.grantRoot, network: ev.network, available: ev.available };
    case 'codex_approval_resolved': return { type: 'codex_approval_resolved', id: ev.id, decision: ev.decision };
    case 'error': return { type: 'error', error: ev.error };
    case 'done': return { type: 'done', exitCode: ev.exitCode };
    default: return null;
  }
}

// Delay between a turn completing and the next iteration firing. Small, but
// enough to let active-runs clear and give the user a window to interject.
const LOOP_TICK_MS = 1200;
const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-codex-loops.json');

export function defaultLoopConfig(): CodexLoopConfig {
  return {
    enabled: false,
    prompt:
      'Continue working on the task autonomously. When everything is done, reply with COMPLETE on its own line. If you are stuck and need a human, reply with BLOCKED.',
    maxIterations: 25,
    timeoutMs: 30 * 60_000,
    sentinels: ['COMPLETE', 'BLOCKED'],
  };
}

type LoopRuntime = {
  config: CodexLoopConfig;
  iterations: number;
  armedAt: number;
  status: CodexLoopStatus;
  stopReason?: string;
  cwd: string;
  timer: ReturnType<typeof setTimeout> | null;
  subs: Set<(ev: CodexLoopStreamEvent) => void>;
  // Ring of the current iteration's events so a view opened mid-iteration
  // replays what's on screen. Cleared at each iteration start.
  buffer: CodexLoopStreamEvent[];
};

// Persisted config keyed by sid — only sids the user has ever touched land here.
const persisted = new Map<string, CodexLoopConfig>();
// Live runtime keyed by sid — counters, timer, subscribers.
const runtimes = new Map<string, LoopRuntime>();

function sanitize(patch: Partial<CodexLoopConfig>, base: CodexLoopConfig): CodexLoopConfig {
  const sentinels = Array.isArray(patch.sentinels)
    ? patch.sentinels.map((s) => String(s).trim()).filter(Boolean)
    : base.sentinels;
  return {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : base.enabled,
    prompt: typeof patch.prompt === 'string' && patch.prompt.trim() ? patch.prompt : base.prompt,
    maxIterations: Number.isFinite(patch.maxIterations) && patch.maxIterations! >= 0 ? Math.floor(patch.maxIterations!) : base.maxIterations,
    timeoutMs: Number.isFinite(patch.timeoutMs) && patch.timeoutMs! >= 0 ? Math.floor(patch.timeoutMs!) : base.timeoutMs,
    sentinels,
  };
}

async function persist(): Promise<void> {
  const obj: Record<string, CodexLoopConfig> = {};
  for (const [sid, cfg] of persisted) obj[sid] = cfg;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

export async function warmCodexLoopCache(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) as Record<string, Partial<CodexLoopConfig>>;
    for (const [sid, cfg] of Object.entries(raw)) {
      // A loop can't be mid-flight across a server restart — re-arming would
      // resume a thread the operator may not expect. Load config but force off.
      persisted.set(sid, sanitize({ ...cfg, enabled: false }, defaultLoopConfig()));
    }
  } catch {
    /* no file yet — defaults apply lazily */
  }
}

export function getLoopConfig(sid: string): CodexLoopConfig {
  return persisted.get(sid) ?? defaultLoopConfig();
}

function getRuntime(sid: string): LoopRuntime {
  let rt = runtimes.get(sid);
  if (!rt) {
    rt = { config: getLoopConfig(sid), iterations: 0, armedAt: 0, status: 'idle', cwd: '', timer: null, subs: new Set(), buffer: [] };
    runtimes.set(sid, rt);
  }
  return rt;
}

export function getLoopSnapshot(sid: string): CodexLoopSnapshot {
  const rt = runtimes.get(sid);
  const config = getLoopConfig(sid);
  if (!rt) return { enabled: config.enabled, status: config.enabled ? 'idle' : 'stopped', iterations: 0, config };
  return { enabled: rt.config.enabled, status: rt.status, iterations: rt.iterations, config: rt.config, stopReason: rt.stopReason };
}

function emit(rt: LoopRuntime, ev: CodexLoopStreamEvent): void {
  rt.buffer.push(ev);
  if (rt.buffer.length > 2000) rt.buffer.splice(0, rt.buffer.length - 2000);
  for (const cb of rt.subs) {
    try { cb(ev); } catch { rt.subs.delete(cb); }
  }
}

function broadcastStatus(sid: string): void {
  const rt = runtimes.get(sid);
  if (!rt) return;
  emit(rt, { type: 'loop_status', snapshot: getLoopSnapshot(sid) });
}

export function subscribeLoop(sid: string, cb: (ev: CodexLoopStreamEvent) => void): () => void {
  const rt = getRuntime(sid);
  // Status snapshot first (so a late subscriber flips its running flag before
  // the iteration events land), then replay the current iteration's buffer.
  cb({ type: 'loop_status', snapshot: getLoopSnapshot(sid) });
  for (const ev of rt.buffer) cb(ev);
  rt.subs.add(cb);
  return () => { rt.subs.delete(cb); };
}

// Match a sentinel only as its own trimmed line — the default prompt tells the
// model to "reply with COMPLETE on its own line", so a bare substring match
// would also fire on prose like "I won't write COMPLETE yet".
function hitsSentinel(text: string, sentinels: string[]): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (const s of sentinels) if (s && lines.includes(s)) return s;
  return null;
}

function stop(sid: string, reason: string): void {
  const rt = runtimes.get(sid);
  if (!rt) return;
  if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
  rt.config = { ...rt.config, enabled: false };
  rt.status = 'stopped';
  rt.stopReason = reason;
  persisted.set(sid, rt.config);
  void persist();
  broadcastStatus(sid);
}

// Arm the next iteration if the loop should still run. Called after every turn
// completes (user or loop-driven) and on enable when the session is already idle.
function arm(sid: string, cwd: string): void {
  const rt = runtimes.get(sid);
  if (!rt || !rt.config.enabled) return;
  if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
  if (rt.config.maxIterations > 0 && rt.iterations >= rt.config.maxIterations) return stop(sid, `reached max iterations (${rt.config.maxIterations})`);
  if (rt.config.timeoutMs > 0 && rt.armedAt > 0 && Date.now() - rt.armedAt >= rt.config.timeoutMs) return stop(sid, 'wall-clock timeout');
  rt.cwd = cwd || rt.cwd;
  rt.status = 'armed';
  broadcastStatus(sid);
  rt.timer = setTimeout(() => void fire(sid), LOOP_TICK_MS);
}

async function fire(sid: string): Promise<void> {
  const rt = runtimes.get(sid);
  if (!rt || !rt.config.enabled) return;
  rt.timer = null;
  // Idle-gate: if the user sent a message in the tick window, the session is
  // busy — bail and let that turn's completion re-arm us.
  if (isRunActive(sid)) return;
  await driveIteration(sid);
}

async function driveIteration(sid: string): Promise<void> {
  const rt = runtimes.get(sid);
  if (!rt || !rt.config.enabled) return;
  rt.iterations += 1;
  rt.status = 'running';
  rt.buffer = [];
  broadcastStatus(sid);

  const ac = new AbortController();
  registerRun(sid, ac); // counts as busy + lets the /stop route abort the loop
  let agentText = '';
  let failed = false;
  try {
    for await (const ev of runCodexTurn({ prompt: rt.config.prompt, cwd: rt.cwd, resume: sid, abortController: ac })) {
      if (ev.kind === 'delta') agentText += ev.text;
      if (ev.kind === 'error') failed = true;
      const streamed = mapLoopRunnerEvent(ev);
      if (streamed) emit(rt, streamed);
    }
  } catch (e) {
    failed = true;
    emit(rt, { type: 'error', error: (e as Error).message });
  } finally {
    endRun(sid, ac);
  }

  // The /stop route aborts via active-runs — treat that as a user halt, not an
  // error, and stop the loop cleanly.
  if (ac.signal.aborted) return stop(sid, 'stopped by user');
  if (!rt.config.enabled) return; // disabled mid-iteration — don't re-arm
  if (failed) return stop(sid, 'iteration errored');
  noteCodexTurnComplete(sid, rt.cwd, agentText);
}

// Driver entry point. The codex routes call this when ANY turn finishes (user
// or loop). If the loop is enabled and no stop condition is met, it arms the
// next iteration; a completion sentinel in the just-finished output stops it.
export function noteCodexTurnComplete(sid: string, cwd: string, agentText: string): void {
  const rt = runtimes.get(sid);
  if (!rt || !rt.config.enabled) return;
  const hit = hitsSentinel(agentText, rt.config.sentinels);
  if (hit) return stop(sid, `sentinel "${hit}"`);
  arm(sid, cwd);
}

// Update a session's loop config. Enabling resets the counters and arms the loop
// when the session is already idle; disabling aborts any in-flight iteration.
export function setLoopConfig(sid: string, patch: Partial<CodexLoopConfig>, cwd: string): CodexLoopSnapshot {
  const rt = getRuntime(sid);
  const wasEnabled = rt.config.enabled;
  rt.config = sanitize(patch, rt.config);
  persisted.set(sid, rt.config);
  void persist();

  if (rt.config.enabled && !wasEnabled) {
    rt.iterations = 0;
    rt.armedAt = Date.now();
    rt.stopReason = undefined;
    rt.status = 'idle';
    if (cwd) rt.cwd = cwd;
    if (!isRunActive(sid)) arm(sid, rt.cwd); // kick off immediately if free
    else broadcastStatus(sid);
  } else if (!rt.config.enabled && wasEnabled) {
    if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
    if (rt.status === 'running') abortRun(sid); // stop the in-flight iteration
    rt.status = 'stopped';
    rt.stopReason = 'disabled';
    broadcastStatus(sid);
  } else {
    broadcastStatus(sid);
  }
  return getLoopSnapshot(sid);
}
