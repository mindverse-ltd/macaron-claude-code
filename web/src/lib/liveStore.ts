// Module-level live-session store. Owned by the WebUI, not React — survives
// the Workspace → Session route transition (a React unmount would otherwise
// abort the in-flight fetch and force the Session page to re-subscribe via
// server-side /live, which causes the "first reply isn't streamed" jank.)
//
// Workspace calls startNewSession() → fetch starts → deltas accumulate here
// → the returned promise resolves with the sessionId so Workspace can navigate.
// Session subscribes and gets the current buffer + live updates.

import { extractPartialCode } from './partialJson';
import { authedFetch } from './auth';

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'str_replace', 'str_replace_editor', 'str_replace_based_edit_tool']);
const isDiffTool = (name: string) => DIFF_TOOLS.has(name);

// A single item on the timeline. Text chunks and tool calls are stored in
// one ordered list so the UI renders them in the exact interleaved order
// they arrive (Claude often emits `text → tool → text → tool → text`, and
// separating them makes the render look re-ordered).
export type LiveTurnItem =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | {
      kind: 'genui';
      id: string;
      toolUseId: string;
      code: string;
      status: 'pending' | 'ready' | 'error';
      error?: string;
    }
  | {
      kind: 'permission';
      id: string;
      permissionId: string;
      toolName: string;
      input: unknown;
      suggestion?: { label: string };
      status: 'pending' | 'allow' | 'deny';
    };

export type LiveState = {
  cwd: string;
  userText: string;
  // Single ordered timeline. On each `delta`, we either append to the
  // last text item (if the previous entry was text) or push a new text
  // item; tool events push their own entries; text entries never merge
  // across a tool boundary. This preserves Claude's original ordering.
  timeline: LiveTurnItem[];
  // Authoritative cumulative output_tokens from Anthropic's message_delta
  // usage events. -1 = no signal received yet (indicator falls back to a
  // len/4 estimate). Reset to -1 at the start of each new turn.
  outputTokens: number;
  done: boolean;
  error?: string;
};

let liveTextIdSeq = 0;
function appendText(items: LiveTurnItem[], text: string): void {
  const last = items[items.length - 1];
  if (last && last.kind === 'text') {
    last.text += text;
    return;
  }
  items.push({ kind: 'text', id: `live-t-${++liveTextIdSeq}`, text });
}

// Central event → state mutation. Shared between startNewSession (POST body
// consumer) and attachLive (SSE reattach after page refresh) — both surfaces
// speak the exact same event vocabulary, so keep the switch here and just
// call `applyLiveEvent(sid, event)` from each stream loop.
function applyLiveEvent(sid: string, p: { type?: string; [k: string]: unknown }): void {
  if (p.type === 'meta') {
    const s = states.get(sid);
    if (s && typeof p.cwd === 'string') s.cwd = p.cwd;
  } else if (p.type === 'user-text') {
    const s = states.get(sid);
    if (s) { s.userText = String(p.text || ''); notify(sid); }
  } else if (p.type === 'delta') {
    const s = states.get(sid);
    if (s) { appendText(s.timeline, String(p.text || '')); notify(sid); }
  } else if (p.type === 'tool_use') {
    const s = states.get(sid);
    if (s) {
      if (p.name === 'mcp__macaron__render_ui') {
        s.timeline.push({ kind: 'genui', id: `live-${p.id}`, toolUseId: String(p.id), code: '', status: 'pending' });
      } else {
        s.timeline.push({ kind: 'tool', id: `live-${p.id}`, name: String(p.name), input: p.input });
      }
      notify(sid);
    }
  } else if (p.type === 'tool_input_delta') {
    const s = states.get(sid);
    if (s && p.name === 'mcp__macaron__render_ui') {
      const partial = extractPartialCode(String(p.accumulated || ''));
      if (partial) {
        const t = s.timeline.find((x) => x.kind === 'genui' && x.toolUseId === p.id);
        if (t && t.kind === 'genui' && partial.length > t.code.length) {
          t.code = partial;
          notify(sid);
        }
      }
    }
  } else if (p.type === 'tool_input_done') {
    const s = states.get(sid);
    if (s && p.name === 'mcp__macaron__render_ui') {
      try {
        const obj = JSON.parse(String(p.final_json || ''));
        if (typeof obj?.code === 'string') {
          const t = s.timeline.find((x) => x.kind === 'genui' && x.toolUseId === p.id);
          if (t && t.kind === 'genui') { t.code = obj.code; t.status = 'ready'; }
          notify(sid);
        }
      } catch { /* tolerate */ }
    } else if (s && isDiffTool(String(p.name))) {
      try {
        const obj = JSON.parse(String(p.final_json || ''));
        const t = s.timeline.find((x) => x.kind === 'tool' && x.id === `live-${p.id}`);
        if (t && t.kind === 'tool') { t.input = obj; notify(sid); }
      } catch { /* tolerate */ }
    }
  } else if (p.type === 'tool_result') {
    const s = states.get(sid);
    if (s) {
      const t = s.timeline.find((x) =>
        (x.kind === 'genui' && x.toolUseId === p.tool_use_id) ||
        (x.kind === 'tool' && x.id === `live-${p.tool_use_id}`),
      );
      if (t) {
        if (t.kind === 'tool') { t.result = String(p.text || ''); t.isError = Boolean(p.isError); }
        else if (t.kind === 'genui') {
          if (p.isError || String(p.text || '').startsWith('render_ui failed:')) {
            t.status = 'error';
            t.error = String(p.text || '').replace(/^render_ui failed:/, '').trim();
          } else if (t.status === 'pending') {
            t.status = 'ready';
          }
        }
        notify(sid);
      }
    }
  } else if (p.type === 'permission_request') {
    const s = states.get(sid);
    if (s) {
      s.timeline.push({
        kind: 'permission',
        id: `perm-${p.id}`,
        permissionId: String(p.id),
        toolName: String(p.toolName),
        input: p.input,
        suggestion: p.suggestion as { label: string } | undefined,
        status: 'pending',
      });
      notify(sid);
    }
  } else if (p.type === 'permission_resolved') {
    const s = states.get(sid);
    if (s) {
      const t = s.timeline.find((x) => x.kind === 'permission' && x.permissionId === p.id);
      if (t && t.kind === 'permission') {
        t.status = p.decision as 'allow' | 'deny';
        notify(sid);
      }
    }
  } else if (p.type === 'usage') {
    const s = states.get(sid);
    if (s && typeof p.outputTokens === 'number' && p.outputTokens >= s.outputTokens) {
      s.outputTokens = p.outputTokens;
      notify(sid);
    }
  } else if (p.type === 'followup_delta') {
    followupWatchers.get(sid)?.forEach((cb) => cb(String(p.text || '')));
  } else if (p.type === 'done') {
    const s = states.get(sid);
    if (s) { s.done = true; notify(sid); }
  } else if (p.type === 'error') {
    const s = states.get(sid);
    if (s) { s.error = String(p.error || ''); notify(sid); }
  }
}

const states = new Map<string, LiveState>();
const watchers = new Map<string, Set<(s: LiveState) => void>>();
type AttachResult = 'attached' | 'not-live';
type LiveAttachment = { ready: Promise<AttachResult> };
// A reattach reader stays alive after `ready` resolves. Keep it registered
// until the SSE closes so StrictMode/remount probes join the same reader
// instead of replaying the ring into `states` a second time.
const liveAttachments = new Map<string, LiveAttachment>();
// Follow-up suggestions are an "add-on" stream: they arrive AFTER the main
// turn's `done` (which clears the live store), so they ride a separate
// channel with its own subscribers — independent of `states`/`watchers`
// lifecycle. This keeps the main turn's stop semantics untouched.
const followupWatchers = new Map<string, Set<(text: string) => void>>();

export function getLive(sid: string): LiveState | undefined {
  return states.get(sid);
}

export function subscribeLive(sid: string, cb: (s: LiveState) => void): () => void {
  let set = watchers.get(sid);
  if (!set) {
    set = new Set();
    watchers.set(sid, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) watchers.delete(sid);
  };
}

function notify(sid: string): void {
  const s = states.get(sid);
  if (!s) return;
  watchers.get(sid)?.forEach((cb) => cb(s));
}

// Discard buffered state once the consumer has merged it into the canonical
// jsonl-derived data (Session.tsx calls this after load()).
export function clearLive(sid: string): void {
  states.delete(sid);
  watchers.delete(sid);
}

// Subscribe to the add-on follow-up stream for a session. Callback fires per
// text delta. Independent of clearLive — the main turn may finish (and clear
// the live store) before any follow-up arrives, so this channel outlives it.
export function subscribeFollowup(sid: string, cb: (text: string) => void): () => void {
  let set = followupWatchers.get(sid);
  if (!set) {
    set = new Set();
    followupWatchers.set(sid, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) followupWatchers.delete(sid);
  };
}

export type NewSessionOptions = {
  text: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  images?: Array<{ mimeType: string; dataUrl: string }>;
  // Run the new session in a dedicated git worktree + branch off the repo's
  // HEAD. No-ops server-side if cwd isn't a git work tree.
  isolate?: boolean;
  // Absolute directory to start in — set by the directory picker for a
  // brand-new workspace. Omitted for sessions started inside an existing one.
  cwd?: string;
};

/**
 * POSTs the first prompt and consumes the resulting SSE stream into the live
 * store. Resolves with the new sessionId as soon as the server emits its meta
 * event, so the UI can navigate immediately while deltas keep accumulating.
 */
export function startNewSession(project: string, opts: NewSessionOptions): Promise<string> {
  const { text } = opts;
  return new Promise((resolve, reject) => {
    let resolved = false;
    let sid = '';
    authedFetch(`/api/workspaces/${encodeURIComponent(project)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        permissionMode: opts.permissionMode,
        images: opts.images,
        isolate: opts.isolate,
        cwd: opts.cwd,
      }),
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) {
          const txt = await resp.text().catch(() => '');
          if (!resolved) {
            resolved = true;
            reject(new Error(`http ${resp.status}: ${txt.slice(0, 200)}`));
          }
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
            try {
              const p = JSON.parse(data);
              if (p.type === 'meta' && p.sessionId) {
                sid = p.sessionId;
                if (!states.has(sid)) {
                  states.set(sid, {
                    cwd: p.cwd || '',
                    userText: text,
                    timeline: [],
                    outputTokens: -1,
                    done: false,
                  });
                }
                notify(sid);
                if (!resolved) {
                  resolved = true;
                  resolve(sid);
                }
              } else if (sid && p.type === 'delta') {
                const s = states.get(sid);
                if (s) {
                  appendText(s.timeline, p.text);
                  notify(sid);
                }
              } else if (sid && p.type === 'tool_use') {
                const s = states.get(sid);
                if (s) {
                  if (p.name === 'mcp__macaron__render_ui') {
                    s.timeline.push({ kind: 'genui', id: `live-${p.id}`, toolUseId: p.id, code: '', status: 'pending' });
                  } else {
                    s.timeline.push({ kind: 'tool', id: `live-${p.id}`, name: p.name, input: p.input });
                  }
                  notify(sid);
                }
              } else if (sid && p.type === 'tool_input_delta') {
                const s = states.get(sid);
                if (s && p.name === 'mcp__macaron__render_ui') {
                  const partial = extractPartialCode(p.accumulated);
                  if (partial) {
                    const t = s.timeline.find((x) => x.kind === 'genui' && x.toolUseId === p.id);
                    if (t && t.kind === 'genui' && partial.length > t.code.length) {
                      t.code = partial;
                      notify(sid);
                    }
                  }
                }
              } else if (sid && p.type === 'tool_input_done') {
                const s = states.get(sid);
                if (s && p.name === 'mcp__macaron__render_ui') {
                  try {
                    const obj = JSON.parse(p.final_json);
                    if (typeof obj?.code === 'string') {
                      const t = s.timeline.find((x) => x.kind === 'genui' && x.toolUseId === p.id);
                      if (t && t.kind === 'genui') { t.code = obj.code; t.status = 'ready'; }
                      notify(sid);
                    }
                  } catch { /* tolerate */ }
                } else if (s && isDiffTool(p.name)) {
                  try {
                    const obj = JSON.parse(p.final_json);
                    const t = s.timeline.find((x) => x.kind === 'tool' && x.id === `live-${p.id}`);
                    if (t && t.kind === 'tool') {
                      t.input = obj;
                      notify(sid);
                    }
                  } catch { /* tolerate */ }
                }
              } else if (sid && p.type === 'tool_result') {
                const s = states.get(sid);
                if (s) {
                  const t = s.timeline.find((x) =>
                    (x.kind === 'genui' && x.toolUseId === p.tool_use_id) ||
                    (x.kind === 'tool' && x.id === `live-${p.tool_use_id}`),
                  );
                  if (t) {
                    if (t.kind === 'tool') { t.result = p.text; t.isError = Boolean(p.isError); }
                    else if (t.kind === 'genui') {
                      if (p.isError || String(p.text).startsWith('render_ui failed:')) {
                        t.status = 'error';
                        t.error = String(p.text).replace(/^render_ui failed:/, '').trim();
                      } else if (t.status === 'pending') {
                        t.status = 'ready';
                      }
                    }
                    notify(sid);
                  }
                }
              } else if (sid && p.type === 'permission_request') {
                const s = states.get(sid);
                if (s) {
                  s.timeline.push({
                    kind: 'permission',
                    id: `perm-${p.id}`,
                    permissionId: p.id,
                    toolName: p.toolName,
                    input: p.input,
                    suggestion: p.suggestion,
                    status: 'pending',
                  });
                  notify(sid);
                }
              } else if (sid && p.type === 'permission_resolved') {
                const s = states.get(sid);
                if (s) {
                  const t = s.timeline.find(
                    (x) => x.kind === 'permission' && x.permissionId === p.id,
                  );
                  if (t && t.kind === 'permission') {
                    t.status = p.decision;
                    notify(sid);
                  }
                }
              } else if (sid && p.type === 'usage') {
                const s = states.get(sid);
                if (s && typeof p.outputTokens === 'number' && p.outputTokens >= s.outputTokens) {
                  s.outputTokens = p.outputTokens;
                  notify(sid);
                }
              } else if (sid && p.type === 'followup_delta') {
                // Rides the independent follow-up channel — survives clearLive
                // (the main turn's `done` clears states before this arrives).
                followupWatchers.get(sid)?.forEach((cb) => cb(p.text));
              } else if (sid && p.type === 'done') {
                const s = states.get(sid);
                if (s) {
                  s.done = true;
                  notify(sid);
                }
              } else if (sid && p.type === 'error') {
                const s = states.get(sid);
                if (s) {
                  s.error = p.error;
                  notify(sid);
                }
              }
            } catch {
              /* skip malformed event */
            }
          }
        }
      })
      .catch((e: unknown) => {
        if (!resolved) {
          resolved = true;
          reject(e);
        }
      });
  });
}

/**
 * Reattach to a server-side live run for an existing sid. Used on page
 * refresh: if the CLI is still mid-turn, the server's /live SSE replays
 * the buffered events and forwards new ones, so we can rebuild the same
 * streaming UI without racing the jsonl flush.
 *
 * Resolves with 'attached' if the server had an active run (state is now
 * seeded in the module store and subscribers will start receiving deltas),
 * or 'not-live' if the run had already ended (nothing to do; caller falls
 * back to reading the jsonl).
 */
export function attachLive(project: string, sid: string): Promise<AttachResult> {
  const state = states.get(sid);
  if (state) return Promise.resolve(state.done ? 'not-live' : 'attached');

  const active = liveAttachments.get(sid);
  if (active) return active.ready;

  let settleReady!: (result: AttachResult) => void;
  let readySettled = false;
  const ready = new Promise<AttachResult>((resolve) => { settleReady = resolve; });
  const attachment: LiveAttachment = { ready };
  const settle = (result: AttachResult) => {
    if (readySettled) return;
    readySettled = true;
    settleReady(result);
  };
  liveAttachments.set(sid, attachment);

  void (async () => {
    let seenAnyEvent = false;
    try {
      const resp = await authedFetch(`/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/live`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      });
      if (!resp.ok || !resp.body) {
        settle('not-live');
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
          try {
            const p = JSON.parse(data);
            if (p.type === 'live-end' && p.reason === 'not-live' && !seenAnyEvent) {
              settle('not-live');
              await reader.cancel();
              return;
            }
            if (!seenAnyEvent) {
              seenAnyEvent = true;
              states.set(sid, {
                cwd: p.type === 'meta' && typeof p.cwd === 'string' ? p.cwd : '',
                userText: '',
                timeline: [],
                outputTokens: -1,
                done: false,
              });
              settle('attached');
            }
            applyLiveEvent(sid, p);
          } catch {
            /* skip malformed event */
          }
        }
      }

      if (!seenAnyEvent) settle('not-live');
      const current = states.get(sid);
      if (current && !current.done) { current.done = true; notify(sid); }
    } catch {
      settle('not-live');
      const current = states.get(sid);
      if (current && !current.done) { current.done = true; notify(sid); }
    } finally {
      if (liveAttachments.get(sid) === attachment) liveAttachments.delete(sid);
    }
  })();

  return ready;
}
