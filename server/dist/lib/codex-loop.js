// Opt-in autonomous loop for Codex sessions (macaron-claude-code#107).
//
// codoxear popularized the "ralph loop": when the agent goes idle, the server
// re-injects a continue prompt so long tasks run unattended. codoxear's loop is
// hardcoded and forced — one prompt, no off switch. This is the *configurable*
// version: opt-in per session, editable prompt, and real stop conditions.
//
// It lives entirely server-side and drives the same `runCodex` generator a user
// turn uses — no app-server, no steer method. After any turn completes and the
// session is idle (active-runs has no controller for the sid), a timer fires the
// next iteration with the persisted loop prompt. Because it's detached from the
// POST request that started it, the loop keeps going after the browser closes;
// an open thread view re-attaches via `subscribeLoop` to watch it live.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';
import { runCodex } from './codex-runner.js';
import { registerRun, endRun, abortRun, isRunActive } from './active-runs.js';
// Delay between a turn completing and the next iteration firing. Small, but
// enough to let active-runs clear and give the user a window to interject.
const LOOP_TICK_MS = 1200;
const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-codex-loops.json');
export function defaultLoopConfig() {
    return {
        enabled: false,
        prompt: 'Continue working on the task autonomously. When everything is done, reply with COMPLETE on its own line. If you are stuck and need a human, reply with BLOCKED.',
        maxIterations: 25,
        timeoutMs: 30 * 60_000,
        sentinels: ['COMPLETE', 'BLOCKED'],
    };
}
// Persisted config keyed by sid — only sids the user has ever touched land here.
const persisted = new Map();
// Live runtime keyed by sid — counters, timer, subscribers.
const runtimes = new Map();
function sanitize(patch, base) {
    const sentinels = Array.isArray(patch.sentinels)
        ? patch.sentinels.map((s) => String(s).trim()).filter(Boolean)
        : base.sentinels;
    return {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : base.enabled,
        prompt: typeof patch.prompt === 'string' && patch.prompt.trim() ? patch.prompt : base.prompt,
        maxIterations: Number.isFinite(patch.maxIterations) && patch.maxIterations >= 0 ? Math.floor(patch.maxIterations) : base.maxIterations,
        timeoutMs: Number.isFinite(patch.timeoutMs) && patch.timeoutMs >= 0 ? Math.floor(patch.timeoutMs) : base.timeoutMs,
        sentinels,
    };
}
async function persist() {
    const obj = {};
    for (const [sid, cfg] of persisted)
        obj[sid] = cfg;
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
}
export async function warmCodexLoopCache() {
    try {
        const raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        for (const [sid, cfg] of Object.entries(raw)) {
            // A loop can't be mid-flight across a server restart — re-arming would
            // resume a thread the operator may not expect. Load config but force off.
            persisted.set(sid, sanitize({ ...cfg, enabled: false }, defaultLoopConfig()));
        }
    }
    catch {
        /* no file yet — defaults apply lazily */
    }
}
export function getLoopConfig(sid) {
    return persisted.get(sid) ?? defaultLoopConfig();
}
function getRuntime(sid) {
    let rt = runtimes.get(sid);
    if (!rt) {
        rt = { config: getLoopConfig(sid), iterations: 0, armedAt: 0, status: 'idle', cwd: '', timer: null, subs: new Set(), buffer: [] };
        runtimes.set(sid, rt);
    }
    return rt;
}
export function getLoopSnapshot(sid) {
    const rt = runtimes.get(sid);
    const config = getLoopConfig(sid);
    if (!rt)
        return { enabled: config.enabled, status: config.enabled ? 'idle' : 'stopped', iterations: 0, config };
    return { enabled: rt.config.enabled, status: rt.status, iterations: rt.iterations, config: rt.config, stopReason: rt.stopReason };
}
function emit(rt, ev) {
    rt.buffer.push(ev);
    if (rt.buffer.length > 2000)
        rt.buffer.splice(0, rt.buffer.length - 2000);
    for (const cb of rt.subs) {
        try {
            cb(ev);
        }
        catch {
            rt.subs.delete(cb);
        }
    }
}
function broadcastStatus(sid) {
    const rt = runtimes.get(sid);
    if (!rt)
        return;
    emit(rt, { type: 'loop_status', snapshot: getLoopSnapshot(sid) });
}
export function subscribeLoop(sid, cb) {
    const rt = getRuntime(sid);
    // Status snapshot first (so a late subscriber flips its running flag before
    // the iteration events land), then replay the current iteration's buffer.
    cb({ type: 'loop_status', snapshot: getLoopSnapshot(sid) });
    for (const ev of rt.buffer)
        cb(ev);
    rt.subs.add(cb);
    return () => { rt.subs.delete(cb); };
}
// Match a sentinel only as its own trimmed line — the default prompt tells the
// model to "reply with COMPLETE on its own line", so a bare substring match
// would also fire on prose like "I won't write COMPLETE yet".
function hitsSentinel(text, sentinels) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    for (const s of sentinels)
        if (s && lines.includes(s))
            return s;
    return null;
}
function stop(sid, reason) {
    const rt = runtimes.get(sid);
    if (!rt)
        return;
    if (rt.timer) {
        clearTimeout(rt.timer);
        rt.timer = null;
    }
    rt.config = { ...rt.config, enabled: false };
    rt.status = 'stopped';
    rt.stopReason = reason;
    persisted.set(sid, rt.config);
    void persist();
    broadcastStatus(sid);
}
// Arm the next iteration if the loop should still run. Called after every turn
// completes (user or loop-driven) and on enable when the session is already idle.
function arm(sid, cwd) {
    const rt = runtimes.get(sid);
    if (!rt || !rt.config.enabled)
        return;
    if (rt.timer) {
        clearTimeout(rt.timer);
        rt.timer = null;
    }
    if (rt.config.maxIterations > 0 && rt.iterations >= rt.config.maxIterations)
        return stop(sid, `reached max iterations (${rt.config.maxIterations})`);
    if (rt.config.timeoutMs > 0 && rt.armedAt > 0 && Date.now() - rt.armedAt >= rt.config.timeoutMs)
        return stop(sid, 'wall-clock timeout');
    rt.cwd = cwd || rt.cwd;
    rt.status = 'armed';
    broadcastStatus(sid);
    rt.timer = setTimeout(() => void fire(sid), LOOP_TICK_MS);
}
async function fire(sid) {
    const rt = runtimes.get(sid);
    if (!rt || !rt.config.enabled)
        return;
    rt.timer = null;
    // Idle-gate: if the user sent a message in the tick window, the session is
    // busy — bail and let that turn's completion re-arm us.
    if (isRunActive(sid))
        return;
    await driveIteration(sid);
}
async function driveIteration(sid) {
    const rt = runtimes.get(sid);
    if (!rt || !rt.config.enabled)
        return;
    rt.iterations += 1;
    rt.status = 'running';
    rt.buffer = [];
    broadcastStatus(sid);
    const ac = new AbortController();
    registerRun(sid, ac); // counts as busy + lets the /stop route abort the loop
    let agentText = '';
    // The runner emits reasoning and the final reply as the same {kind:'delta'};
    // a reasoning delta is always immediately preceded by a `codex_reasoning`
    // marker. Only the reply feeds sentinel matching, else the model's own
    // "reply with COMPLETE" reasoning would stop the loop on iteration 1.
    let reasoningNext = false;
    let failed = false;
    try {
        for await (const ev of runCodex({ prompt: rt.config.prompt, cwd: rt.cwd, resume: sid, abortController: ac })) {
            switch (ev.kind) {
                case 'session':
                    emit(rt, { type: 'meta', sessionId: ev.sessionId });
                    break;
                case 'delta':
                    if (!reasoningNext)
                        agentText += ev.text;
                    reasoningNext = false;
                    emit(rt, { type: 'delta', text: ev.text });
                    break;
                case 'tool_use':
                    emit(rt, { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
                    break;
                case 'tool_result':
                    emit(rt, { type: 'tool_result', tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
                    break;
                case 'usage':
                    emit(rt, { type: 'usage', outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
                    break;
                case 'message':
                    if (ev.subtype === 'codex_reasoning')
                        reasoningNext = true;
                    emit(rt, { type: 'event', subtype: ev.subtype });
                    break;
                case 'error':
                    failed = true;
                    emit(rt, { type: 'error', error: ev.error });
                    break;
                case 'done':
                    emit(rt, { type: 'done', exitCode: ev.exitCode });
                    break;
            }
        }
    }
    catch (e) {
        failed = true;
        emit(rt, { type: 'error', error: e.message });
    }
    finally {
        endRun(sid);
    }
    // The /stop route aborts via active-runs — treat that as a user halt, not an
    // error, and stop the loop cleanly.
    if (ac.signal.aborted)
        return stop(sid, 'stopped by user');
    if (!rt.config.enabled)
        return; // disabled mid-iteration — don't re-arm
    if (failed)
        return stop(sid, 'iteration errored');
    noteCodexTurnComplete(sid, rt.cwd, agentText);
}
// Driver entry point. The codex routes call this when ANY turn finishes (user
// or loop). If the loop is enabled and no stop condition is met, it arms the
// next iteration; a completion sentinel in the just-finished output stops it.
export function noteCodexTurnComplete(sid, cwd, agentText) {
    const rt = runtimes.get(sid);
    if (!rt || !rt.config.enabled)
        return;
    const hit = hitsSentinel(agentText, rt.config.sentinels);
    if (hit)
        return stop(sid, `sentinel "${hit}"`);
    arm(sid, cwd);
}
// Update a session's loop config. Enabling resets the counters and arms the loop
// when the session is already idle; disabling aborts any in-flight iteration.
export function setLoopConfig(sid, patch, cwd) {
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
        if (cwd)
            rt.cwd = cwd;
        if (!isRunActive(sid))
            arm(sid, rt.cwd); // kick off immediately if free
        else
            broadcastStatus(sid);
    }
    else if (!rt.config.enabled && wasEnabled) {
        if (rt.timer) {
            clearTimeout(rt.timer);
            rt.timer = null;
        }
        if (rt.status === 'running')
            abortRun(sid); // stop the in-flight iteration
        rt.status = 'stopped';
        rt.stopReason = 'disabled';
        broadcastStatus(sid);
    }
    else {
        broadcastStatus(sid);
    }
    return getLoopSnapshot(sid);
}
//# sourceMappingURL=codex-loop.js.map