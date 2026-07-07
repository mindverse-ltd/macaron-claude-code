// Codex thread view. Layout is the same left→right rail we had in the
// ChatGPT-style pass, but the paper-theme CSS pulls it into the Macaron
// look. Every visual detail — background, borders, tool cards, code
// blocks — is tuned to match the claude WebUI's palette (see styles.css).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { SessionDetail, Message, Block } from '@macaron/shared';
import { codexApi } from './api';
import { sendCodexMessage, startCodexThread } from './stream';
import { CodexComposer } from './CodexComposer';

type Item =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'reasoning'; text: string }
  | { id: string; kind: 'tool'; name: string; input: unknown; result?: string; isError?: boolean };

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
        out.push({ id: b.id, kind: 'tool', name: b.name, input: b.input });
      } else if (b.kind === 'tool_result') {
        const target = [...out].reverse().find(
          (it) => it.kind === 'tool' && it.result === undefined && (b.toolUseId ? it.id === b.toolUseId : true),
        );
        if (target && target.kind === 'tool') target.result = b.text;
      }
    }
  };
  for (const m of detail.messages) walk(m.blocks, m.role);
  return out;
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

function MessageRow({ it }: { it: Item }) {
  if (it.kind === 'reasoning') return <Reasoning text={it.text} />;
  if (it.kind === 'tool') return <ToolCard it={it} />;
  const isUser = it.kind === 'user';
  return (
    <div className={'cx-msg ' + (isUser ? 'user' : 'assistant')}>
      <div className="cx-msg-avatar">{isUser ? 'You' : 'cx'}</div>
      <div className="cx-msg-body">
        <div className="cx-msg-role">{isUser ? 'You' : 'Codex'}</div>
        <div className="cx-msg-text">{it.text}</div>
      </div>
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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { onSendingChange?.(sending); }, [sending, onSendingChange]);

  useEffect(() => {
    if (isNew) { setDetail(null); setLive([]); setError(''); return; }
    setLive([]);
    codexApi.thread(sid).then(setDetail).catch((e) => setError((e as Error).message));
  }, [sid, isNew, refreshKey]);

  const history = useMemo(() => (detail ? historyToItems(detail) : []), [detail]);
  const items = useMemo(() => [...history, ...live], [history, live]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, live[live.length - 1]]);

  const appendUser = (text: string) =>
    setLive((cur) => [...cur, { id: `u-${Date.now()}`, kind: 'user', text }]);
  const appendAssistantDelta = (text: string) => {
    setLive((cur) => {
      const last = cur[cur.length - 1];
      if (last?.kind === 'assistant') {
        return [...cur.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...cur, { id: `a-${Date.now()}-${cur.length}`, kind: 'assistant', text }];
    });
  };
  const appendTool = (id: string, name: string, input: unknown) => {
    setLive((cur) => [...cur, { id, kind: 'tool', name, input }]);
  };
  const applyToolResult = (toolUseId: string, text: string, isError: boolean) => {
    setLive((cur) => cur.map((it) =>
      it.kind === 'tool' && it.id === toolUseId ? { ...it, result: text, isError } : it,
    ));
  };

  const stop = useCallback(async () => {
    if (!sid) return;
    try { await codexApi.stopThread(sid); } catch { /* nop */ }
  }, [sid]);

  const submit = useCallback(async () => {
    const text = pending.trim();
    if (!text || sending) return;
    setPending('');
    setSending(true);
    setError('');
    appendUser(text);
    try {
      if (isNew) {
        let newSid = '';
        await startCodexThread({ text }, {
          onMeta: (s) => { newSid = s; },
          onDelta: appendAssistantDelta,
          onToolUse: (ev) => appendTool(ev.id, ev.name, ev.input),
          onToolResult: (ev) => applyToolResult(ev.tool_use_id, ev.text, ev.isError),
          onError: (m) => setError(m),
          onDone: () => {
            setSending(false);
            if (newSid) navigate(`/t/${encodeURIComponent(newSid)}`, { replace: true });
          },
        });
      } else {
        await sendCodexMessage(sid, { text }, {
          onDelta: appendAssistantDelta,
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
  }, [pending, sending, isNew, sid, navigate]);

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
