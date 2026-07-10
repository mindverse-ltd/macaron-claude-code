// Codex thread view. Layout is the same left→right rail we had in the
// ChatGPT-style pass, but the paper-theme CSS pulls it into the Macaron
// look. Every visual detail — background, borders, tool cards, code
// blocks — is tuned to match the claude WebUI's palette (see styles.css).

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SessionDetail, Message, Block } from '@macaron/shared';
import { codexApi } from './api';
import { sendCodexMessage, startCodexThread, subscribeCodexLive } from './stream';
import { CodexComposer, type ComposerImage } from './CodexComposer';
import { notify } from '../lib/notify';
import {
  THINKING_VERBS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  thinkingTail,
  formatDuration,
} from '../lib/thinkingVerbs';

// GenuiPreview + its vendored runtime (~500KB gzip) is behind a lazy
// import so the default codex bundle stays small. First render_ui in a
// thread triggers the load; subsequent ones use the cached chunk.
const GenuiPreview = lazy(() =>
  import('../genui-runtime').then((m) => ({ default: m.GenuiPreview })),
);

const RENDER_UI_TOOL_NAME = 'mcp:macaron/render_ui';
const isRenderUiTool = (name: string): boolean =>
  name === RENDER_UI_TOOL_NAME || name === 'mcp__macaron__render_ui';

type Item =
  | { id: string; kind: 'user'; text: string; images?: ComposerImage[] }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'reasoning'; text: string }
  | { id: string; kind: 'tool'; name: string; input: unknown; result?: string; isError?: boolean }
  // GenUI render_ui tool call. Codex hands us the full `code` at
  // tool_use time (arguments are already aggregated by the CLI), so we
  // render immediately — no pending phase in practice. The tool_result
  // (checkGenUI diagnostics) may flip `status` to 'error' with details.
  | { id: string; kind: 'genui'; toolUseId: string; code: string; status: 'ready' | 'error'; error?: string };

function toolInputToCmd(name: string, input: unknown): string {
  if (name === 'Bash') {
    const cmd = (input as { command?: string } | null)?.command;
    return cmd || JSON.stringify(input);
  }
  if (name === 'Edit') {
    const changes = (input as { changes?: Array<{ path: string; kind: string }> } | null)?.changes;
    if (Array.isArray(changes)) {
      return changes
        .map((c) => `${c.kind === 'add' ? '＋' : c.kind === 'delete' ? '－' : '△'} ${c.path}`)
        .join('\n');
    }
  }
  if (name === 'WebSearch') {
    const q = (input as { query?: string } | null)?.query;
    return q ? q : JSON.stringify(input);
  }
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
}

function historyToItems(detail: SessionDetail): Item[] {
  const out: Item[] = [];
  let seq = 0;
  const next = () => `h-${seq++}`;
  const walk = (blocks: Block[], role: Message['role']) => {
    for (const b of blocks) {
      if (b.kind === 'text' && b.text.trim()) {
        if (role === 'user') out.push({ id: next(), kind: 'user', text: b.text });
        else out.push({ id: next(), kind: 'assistant', text: b.text });
      } else if (b.kind === 'thinking' && b.text.trim()) {
        out.push({ id: next(), kind: 'reasoning', text: b.text });
      } else if (b.kind === 'tool_use') {
        if (isRenderUiTool(b.name)) {
          const code = String((b.input as { code?: unknown } | null)?.code || '');
          out.push({
            id: `genui-${b.id}`,
            kind: 'genui',
            toolUseId: b.id,
            code,
            status: 'ready',
          });
        } else {
          out.push({ id: b.id, kind: 'tool', name: b.name, input: b.input });
        }
      } else if (b.kind === 'tool_result') {
        const target = [...out].reverse().find(
          (it) =>
            (it.kind === 'tool' && it.result === undefined && (b.toolUseId ? it.id === b.toolUseId : true))
            || (it.kind === 'genui' && it.toolUseId === b.toolUseId),
        );
        if (target?.kind === 'tool') target.result = b.text;
        else if (target?.kind === 'genui') {
          const flagged = b.text.startsWith('Rendered inline, but the TSX has issues');
          if (flagged) { target.status = 'error'; target.error = b.text; }
        }
      }
    }
  };
  for (const m of detail.messages) walk(m.blocks, m.role);
  return out;
}

function reconcileHistoryWithLive(history: Item[], live: Item[]): Item[] {
  const liveUser = live.find((it): it is Extract<Item, { kind: 'user' }> => it.kind === 'user');
  const liveText = liveUser?.text.trim();
  if (!liveText) return history;

  // Codex may have already appended part of the in-flight turn to its rollout.
  // When that latest user bubble matches the live snapshot, let the snapshot own
  // the whole turn so partial disk blocks are not rendered a second time.
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]!;
    if (item.kind !== 'user') continue;
    return item.text.trim() === liveText ? history.slice(0, i) : history;
  }
  return history;
}

function withUser(cur: Item[], text: string, images?: ComposerImage[]): Item[] {
  return [
    ...cur,
    { id: `u-${Date.now()}-${cur.length}`, kind: 'user', text, images: images?.length ? images : undefined },
  ];
}

function withAssistantDelta(cur: Item[], text: string): Item[] {
  const last = cur[cur.length - 1];
  if (last?.kind === 'assistant') {
    return [...cur.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...cur, { id: `a-${Date.now()}-${cur.length}`, kind: 'assistant', text }];
}

function withTool(cur: Item[], id: string, name: string, input: unknown): Item[] {
  if (isRenderUiTool(name)) {
    const code = String((input as { code?: unknown } | null)?.code || '');
    return [
      ...cur,
      {
        id: `genui-${id}`,
        kind: 'genui',
        toolUseId: id,
        code,
        status: 'ready',
      },
    ];
  }
  return [...cur, { id, kind: 'tool', name, input }];
}

function withToolResult(cur: Item[], toolUseId: string, text: string, isError: boolean): Item[] {
  return cur.map((it) => {
    if (it.kind === 'tool' && it.id === toolUseId) return { ...it, result: text, isError };
    if (it.kind === 'genui' && it.toolUseId === toolUseId) {
      const flagged = isError || text.startsWith('Rendered inline, but the TSX has issues');
      return flagged
        ? { ...it, status: 'error' as const, error: text }
        : it;
    }
    return it;
  });
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cx-reasoning">
      <div className="cx-reasoning-head" onClick={() => setOpen((v) => !v)}>
        <span className="cx-reasoning-caret">{open ? '▾' : '▸'}</span>
        <span>Reasoning</span>
      </div>
      {open && <div className="cx-reasoning-body">{text}</div>}
    </div>
  );
}

function toolGlyph(name: string): string {
  if (name === 'Bash') return '$';
  if (name === 'Edit') return '△';
  if (name === 'WebSearch') return '⌕';
  if (name.startsWith('mcp:')) return '⬡';
  if (name === 'TodoWrite') return '☰';
  return '⚙';
}

function ToolCard({ it }: { it: Extract<Item, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const cmd = toolInputToCmd(it.name, it.input);
  const out = it.result ?? '';
  const running = it.result === undefined;
  const long = out.split('\n').length > 8 || out.length > 600;
  const shown = expanded || !long ? out : out.split('\n').slice(0, 8).join('\n') + '\n…';
  return (
    <div className={'cx-tool' + (it.isError ? ' err' : '')}>
      <div className="cx-tool-head">
        <span className="cx-tool-glyph">{toolGlyph(it.name)}</span>
        <span className="cx-tool-name">{it.name}</span>
        <span className={'cx-tool-status' + (it.isError ? ' err' : '')}>
          {running ? 'running…' : it.isError ? 'failed' : 'done'}
        </span>
      </div>
      <div className="cx-tool-cmd">{cmd}</div>
      {out && (
        <>
          <div className={'cx-tool-out' + (it.isError ? ' err' : '')}>{shown}</div>
          {long && (
            <button className="cx-tool-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'collapse' : `expand (${out.split('\n').length} lines)`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function GenuiCard({ it }: { it: Extract<Item, { kind: 'genui' }> }) {
  return (
    <div className="cx-genui">
      <div className="cx-genui-head">
        <span className="cx-genui-glyph">◈</span>
        <span className="cx-genui-name">Rendered UI</span>
        {it.status === 'error' && <span className="cx-genui-status err">diagnostics failed</span>}
      </div>
      <Suspense fallback={<div className="cx-genui-loading">Loading GenUI runtime…</div>}>
        <GenuiPreview code={it.code} done />
      </Suspense>
      {it.status === 'error' && it.error && (
        <details className="cx-genui-details">
          <summary>Show diagnostics</summary>
          <pre>{it.error}</pre>
        </details>
      )}
    </div>
  );
}

function MessageRow({ it }: { it: Item }) {
  if (it.kind === 'reasoning') return <Reasoning text={it.text} />;
  if (it.kind === 'tool') return <ToolCard it={it} />;
  if (it.kind === 'genui') return <GenuiCard it={it} />;
  const isUser = it.kind === 'user';
  return (
    <div className={'cx-msg ' + (isUser ? 'user' : 'assistant')}>
      <div className="cx-msg-avatar">{isUser ? 'You' : 'cx'}</div>
      <div className="cx-msg-body">
        <div className="cx-msg-role">{isUser ? 'You' : 'Codex'}</div>
        {isUser && it.images && it.images.length > 0 && (
          <div className="cx-msg-imgs">
            {it.images.map((img) => <img key={img.id} src={img.dataUrl} alt={img.name} />)}
          </div>
        )}
        {/* User text stays as pre-wrap plain text (WYSIWYG for what they typed);
            assistant text renders as GitHub-flavored Markdown so headings,
            lists, tables, inline code, and links come through. */}
        {isUser ? (
          <div className="cx-msg-text">{it.text}</div>
        ) : (
          <div className="cx-msg-text md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

// Codex-side "thinking…" line — shown at the tail of the thread while a turn
// is in flight and nothing streamable has landed yet (or the last live item
// is a tool call still executing). Reuses the CLI-cloned spinner + verbs
// so it matches the Claude thread's rhythm.
function CxThinkingLine() {
  const startRef = useRef(Date.now());
  const verbRef = useRef<string>(THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)]!);
  const [now, setNow] = useState(() => Date.now());
  const [frameIdx, setFrameIdx] = useState(0);
  useEffect(() => {
    const clockId = window.setInterval(() => setNow(Date.now()), 500);
    const frameId = window.setInterval(
      () => setFrameIdx((i) => (i + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => { window.clearInterval(clockId); window.clearInterval(frameId); };
  }, []);
  const elapsedMs = Math.max(0, now - startRef.current);
  const tail = thinkingTail(elapsedMs);
  return (
    <div className="cx-thinking">
      <span className="cx-thinking-star">{SPINNER_FRAMES[frameIdx]}</span>
      <span className="cx-thinking-verb">{verbRef.current}…</span>
      <span className="cx-thinking-parens">(</span>
      <span className="cx-thinking-meta">{formatDuration(elapsedMs)}</span>
      {tail && (
        <>
          <span className="cx-thinking-sep">·</span>
          <span className="cx-thinking-tail">{tail}</span>
        </>
      )}
      <span className="cx-thinking-parens">)</span>
    </div>
  );
}

export type CodexChatProps = {
  /** Override sid from URL when rendered inside a canvas tile. */
  sid?: string;
  /** Suppress the top breadcrumb bar (tile grip carries the header). */
  hideBar?: boolean;
  /** Only render composer + reduce padding when this tile is the focused one. */
  focused?: boolean;
  /** Notify parent tile whenever the in-flight run flips (for running-bar animation). */
  onSendingChange?: (sending: boolean) => void;
  /** Bump this number from the parent to force a fresh transcript reload. */
  refreshKey?: number;
};

export function CodexChat(props: CodexChatProps = {}) {
  const params = useParams();
  const navigate = useNavigate();
  const sid = props.sid ?? params.sid ?? '';
  const isNew = !sid;
  const focused = props.focused ?? true;
  const hideBar = props.hideBar ?? false;
  const onSendingChange = props.onSendingChange;
  const refreshKey = props.refreshKey ?? 0;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [live, setLive] = useState<Item[]>([]);
  const [pending, setPending] = useState('');
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  // True only after the user kicks off a turn on THIS mount. A server-side
  // reattach also flips `sending`, but must not create a completion notification.
  const streamedRef = useRef(false);

  useEffect(() => { onSendingChange?.(sending); }, [sending, onSendingChange]);

  // In-app notification when a turn finishes — matches the Claude side
  // (NotifyStack is mounted in CodexApp). Click routes to the thread's
  // canvas view so the user lands on the right tile.
  useEffect(() => {
    if (sending) return;
    if (!streamedRef.current) return;
    streamedRef.current = false;
    if (!sid) return;
    const project = detail?.project;
    notify({
      title: 'Macaron · thread ready',
      body: `${sid.slice(0, 8)} finished a turn`,
      tag: `codex-done-${sid}`,
      href: project
        ? `/w/${encodeURIComponent(project)}/t/${encodeURIComponent(sid)}`
        : `/t/${encodeURIComponent(sid)}`,
    });
  }, [sending, sid, detail?.project]);

  useEffect(() => {
    if (isNew) {
      setDetail(null);
      setLive([]);
      setSending(false);
      setError('');
      return;
    }
    let active = true;
    let hasLiveSnapshot = false;
    setLive([]);
    setSending(false);
    setError('');
    void codexApi.thread(sid)
      .then((next) => { if (active) setDetail(next); })
      .catch((e) => { if (active && !hasLiveSnapshot) setError((e as Error).message); });

    const unsubscribe = subscribeCodexLive(sid, {
      // `meta` is present only when the registry has a snapshot. Reset first so
      // a fresh subscription is idempotent if this effect reruns.
      onMeta: () => {
        if (!active) return;
        hasLiveSnapshot = true;
        setLive([]);
        setSending(true);
        setError('');
      },
      onUserText: (text) => { if (active) setLive((cur) => withUser(cur, text)); },
      onDelta: (text) => { if (active) setLive((cur) => withAssistantDelta(cur, text)); },
      onToolUse: (ev) => { if (active) setLive((cur) => withTool(cur, ev.id, ev.name, ev.input)); },
      onToolResult: (ev) => {
        if (active) setLive((cur) => withToolResult(cur, ev.tool_use_id, ev.text, ev.isError));
      },
      onError: (message) => { if (active) setError(message); },
      onDone: () => {
        if (!active) return;
        setSending(false);
        // Keep the complete live buffer visible while the Codex rollout catches
        // up asynchronously; refresh metadata without clearing that buffer.
        void codexApi.thread(sid).then((next) => { if (active) setDetail(next); }).catch(() => {});
      },
      onLiveEnd: () => { if (active) setSending(false); },
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [sid, isNew, refreshKey]);

  const diskHistory = useMemo(() => (detail ? historyToItems(detail) : []), [detail]);
  const history = useMemo(
    () => reconcileHistoryWithLive(diskHistory, live),
    [diskHistory, live],
  );
  const items = useMemo(() => [...history, ...live], [history, live]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, live[live.length - 1]]);

  const appendUser = (text: string, imgs?: ComposerImage[]) =>
    setLive((cur) => withUser(cur, text, imgs));
  // Codex emits each reasoning item atomically on completed, so every event
  // is one full thinking block — append, don't concat.
  const appendReasoning = (text: string) =>
    setLive((cur) => [...cur, { id: `r-${Date.now()}-${cur.length}`, kind: 'reasoning', text }]);
  const appendAssistantDelta = (text: string) => setLive((cur) => withAssistantDelta(cur, text));
  const appendTool = (id: string, name: string, input: unknown) =>
    setLive((cur) => withTool(cur, id, name, input));
  const applyToolResult = (toolUseId: string, text: string, isError: boolean) => {
    setLive((cur) => withToolResult(cur, toolUseId, text, isError));
  };

  const stop = useCallback(async () => {
    if (!sid) return;
    try { await codexApi.stopThread(sid); } catch { /* nop */ }
  }, [sid]);

  const submit = useCallback(async (opts?: { text?: string }) => {
    // `opts.text` present ⇒ programmatic send (from the $macaron/chat bridge
    // or auto-continue). We don't consume composer state in that case, so a
    // user still typing something doesn't get their draft cleared.
    const programmatic = typeof opts?.text === 'string';
    const text = (programmatic ? opts!.text! : pending).trim();
    if ((!text && images.length === 0) || sending) return;
    const sentImages = programmatic ? [] : images;
    const wire = sentImages.map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl }));
    if (!programmatic) {
      setPending('');
      setImages([]);
    }
    streamedRef.current = true;
    setSending(true);
    setError('');
    appendUser(text, sentImages);
    try {
      if (isNew) {
        let newSid = '';
        await startCodexThread({ text, images: wire }, {
          onMeta: (s) => { newSid = s; },
          onDelta: appendAssistantDelta,
          onReasoning: appendReasoning,
          onToolUse: (ev) => appendTool(ev.id, ev.name, ev.input),
          onToolResult: (ev) => applyToolResult(ev.tool_use_id, ev.text, ev.isError),
          onError: (m) => setError(m),
          onDone: () => {
            setSending(false);
            if (newSid) navigate(`/t/${encodeURIComponent(newSid)}`, { replace: true });
          },
        });
      } else {
        await sendCodexMessage(sid, { text, images: wire }, {
          onDelta: appendAssistantDelta,
          onReasoning: appendReasoning,
          onToolUse: (ev) => appendTool(ev.id, ev.name, ev.input),
          onToolResult: (ev) => applyToolResult(ev.tool_use_id, ev.text, ev.isError),
          onError: (m) => setError(m),
          onDone: () => {
            setSending(false);
            codexApi.thread(sid).then(setDetail).catch(() => {}).finally(() => setLive([]));
          },
        });
      }
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  }, [pending, images, sending, isNew, sid, navigate]);

  // Chat bridge for render_ui widgets. Mirrors Claude side (Session.tsx):
  // a sandboxed widget imports `sendUserMessage` from '$macaron/chat',
  // the shim dispatches to globalThis['$app/chat'], and we relay into
  // submit() as a programmatic user turn. `sendUserMessage` is also bound
  // on globalThis so widgets that forget the import still work.
  useEffect(() => {
    if (!focused) return;
    const g = globalThis as unknown as {
      '$app/chat'?: (prompt: string) => void;
      sendUserMessage?: (prompt: string) => void;
    };
    const bridge = (prompt: string) => { void submit({ text: prompt }); };
    g['$app/chat'] = bridge;
    g.sendUserMessage = bridge;
    return () => {
      if (g['$app/chat'] === bridge) delete g['$app/chat'];
      if (g.sendUserMessage === bridge) delete g.sendUserMessage;
    };
  }, [focused, submit]);

  const title = isNew
    ? 'New thread'
    : detail?.cwd?.split('/').filter(Boolean).pop() || 'Thread';

  return (
    <div className={'cx-main' + (hideBar ? ' tile' : '')}>
      {!hideBar && (
        <div className="cx-main-head">
          <div className="cx-main-head-title">{title}</div>
          {!isNew && (
            <>
              <span className="cx-main-head-dot">·</span>
              <span className="cx-main-head-sub">{sid.slice(0, 8)}</span>
              {detail?.gitBranch && (
                <>
                  <span className="cx-main-head-dot">·</span>
                  <span className="cx-main-head-branch">⌥ {detail.gitBranch}</span>
                </>
              )}
            </>
          )}
        </div>
      )}
      <div className="cx-main-scroll" ref={scrollRef}>
        {isNew && items.length === 0 ? (
          <div className="cx-home">
            <div className="cx-home-inner">
              <h1 className="cx-home-title">What can I help with?</h1>
              <p className="cx-home-sub">
                Codex will run in your working directory with the sandbox / approval mode you
                configured in Settings.
              </p>
            </div>
          </div>
        ) : (
          <div className="cx-thread-body">
            {items.map((it) => <MessageRow key={it.id} it={it} />)}
            {/* Show the thinking spinner at the tail of the thread while a
                turn is in flight. Hide it once the last item is a live
                assistant message that has actually started emitting text —
                at that point the streaming text itself is the progress
                signal, so a second one is noise. */}
            {sending && (() => {
              const last = items[items.length - 1];
              const streamingText = last?.kind === 'assistant' && last.text.length > 0;
              return streamingText ? null : <CxThinkingLine />;
            })()}
            {error && (
              <div className="cx-tool err">
                <div className="cx-tool-head">
                  <span className="cx-tool-glyph">!</span>
                  <span className="cx-tool-name">Error</span>
                </div>
                <div className="cx-tool-out err">{error}</div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className={'cx-composer-grid' + (focused ? ' open' : '')}>
        <div className="cx-composer-inner">
          <CodexComposer
            value={pending}
            onChange={setPending}
            images={images}
            onImagesChange={setImages}
            onSubmit={submit}
            onStop={stop}
            disabled={sending}
            running={sending && !isNew}
            placeholder={sending ? 'Draft next message…' : undefined}
          />
        </div>
      </div>
    </div>
  );
}
