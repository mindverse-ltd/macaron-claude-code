import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, basename, type Message, type SessionDetail } from '../lib/api';
import { streamSession } from '../lib/sse';
import { getLive, subscribeLive, clearLive, subscribeFollowup, startNewSession } from '../lib/liveStore';
import { hasActiveModal } from '../lib/modal';
import { extractPartialCode, parseFollowups } from '../lib/partialJson';
import {
  THINKING_VERBS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  thinkingTail,
  formatDuration,
  easeTowards,
} from '../lib/thinkingVerbs';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { StatusBar, type PermissionMode } from '../components/StatusBar';
import { loadHistory, pushHistory } from '../lib/history';
import { ensureNotificationPermission, notify } from '../lib/notify';
import StaticGenUIRenderer from '../macaron-vendor/StaticGenUIRenderer';

const RENDER_UI_TOOL = 'mcp__macaron__render_ui';
const isRenderUITool = (name: string) => name === RENDER_UI_TOOL || name.endsWith('__render_ui');

const PAGE_SIZE = 80;

type AttachedImage = { id: string; name: string; mimeType: string; dataUrl: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// ---- Flatten Claude's per-block messages into a TUI-style item list -------

// A "part" is a sub-block inside a single user or live-user message card:
// text and image blocks the CLI persisted (or the current live turn is
// accumulating) belong to the same message and should render inside a
// single "❯"-gutter card in their original order.
export type MsgPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; data: string };

export type TodoEntry = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
};

type Item =
  // uuid is the jsonl `uuid` of the source user message — used as the
  // rewind cutoff (drop this line and everything after).
  | { id: string; kind: 'user'; parts: MsgPart[]; uuid?: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; name: string; input: unknown; result?: string }
  | { id: string; kind: 'todo'; todos: TodoEntry[] }
  | { id: string; kind: 'system_event'; eventType: string; text: string }
  | { id: string; kind: 'genui'; toolUseId: string; prompt: string; code?: string; status: 'pending' | 'ready' | 'error'; error?: string }
  // Assistant-side inline image (rare — only when the model emits one).
  | { id: string; kind: 'assistant-image'; mimeType: string; data: string }
  | { id: string; kind: 'live-user'; parts: MsgPart[] }
  | { id: string; kind: 'live-assistant'; text: string }
  // Pending / resolved permission gate. Rendered as an inline card with
  // Allow/Deny buttons while `status === 'pending'`.
  | { id: string; kind: 'permission'; permissionId: string; toolName: string; input: unknown; suggestion?: { label: string }; status: 'pending' | 'allow' | 'deny' };

const TODO_WRITE_NAMES = new Set(['TodoWrite', 'todo_write']);
const isTodoWriteTool = (name: string) => TODO_WRITE_NAMES.has(name);

function isNoisyUserText(t: string): boolean {
  if (!t) return true;
  if (t.startsWith('<')) return true;
  if (/^The file .* (has been (updated|created) successfully|file state is current)/.test(t)) return true;
  if (/^Tool .* failed/.test(t)) return true;
  return false;
}

function flatten(messages: Message[]): Item[] {
  const out: Item[] = [];
  let i = 0;
  let lastTool: Extract<Item, { kind: 'tool' }> | null = null;
  // TodoWrite fires repeatedly with the full task list each time. Only the
  // latest snapshot is meaningful, so we track its slot in `out` and splice
  // out the previous one when a new one arrives — this mirrors the CLI which
  // shows a single up-to-date todo card and status-bar summary.
  let latestTodoIdx = -1;
  for (const mi in messages) {
    const m = messages[mi]!;
    // System-role messages carry synthetic events (recap after /compact,
    // resume markers). Render each block as its own inline `※` item.
    if (m.role === 'system') {
      for (const b of m.blocks) {
        if (b.kind === 'system_event') {
          out.push({ id: `sys${i++}`, kind: 'system_event', eventType: b.eventType, text: b.text });
        }
      }
      lastTool = null;
      continue;
    }
    // Collect any text + image blocks the user sent in this message into a
    // SINGLE user Item so they render inside one card in original order
    // (the CLI stores them interleaved; splitting them into separate cards
    // makes one message look like three).
    if (m.role === 'user') {
      const parts: MsgPart[] = [];
      for (const b of m.blocks) {
        if (b.kind === 'text' && !isNoisyUserText(b.text)) parts.push({ kind: 'text', text: b.text });
        else if (b.kind === 'image') parts.push({ kind: 'image', mimeType: b.mimeType, data: b.data });
      }
      if (parts.length) out.push({ id: `u${i++}-msg${mi}`, kind: 'user', parts, uuid: m.uuid });
    }
    // Non-user blocks (assistant text/thinking/tool_*) still emit one Item
    // per block so their per-block visuals (tool cards, thinking boxes, code
    // panes) stay independent.
    for (const b of m.blocks) {
      if (m.role !== 'user' && b.kind === 'text') {
        if (b.text.trim()) out.push({ id: `a${i++}`, kind: 'assistant', text: b.text });
        lastTool = null;
      } else if (b.kind === 'thinking') {
        if (b.text.trim()) out.push({ id: `t${i++}`, kind: 'thinking', text: b.text });
        lastTool = null;
      } else if (m.role !== 'user' && b.kind === 'image') {
        // Very rare — assistant emitting an image. Keep in its own row.
        out.push({ id: `img${i++}`, kind: 'assistant-image', mimeType: b.mimeType, data: b.data });
        lastTool = null;
      } else if (b.kind === 'tool_use') {
        if (isTodoWriteTool(b.name)) {
          const input = (b.input || {}) as { todos?: TodoEntry[] };
          const todos = Array.isArray(input?.todos) ? input.todos : [];
          // Drop the previous todo card — a fresh TodoWrite always replaces
          // it (CLI shows only the latest state).
          if (latestTodoIdx >= 0) {
            out.splice(latestTodoIdx, 1);
            latestTodoIdx = -1;
          }
          latestTodoIdx = out.length;
          out.push({ id: `todo${i++}`, kind: 'todo', todos });
          // TodoWrite's tool_result is just an ACK — don't chain it to
          // anything real.
          lastTool = null;
        } else if (isRenderUITool(b.name)) {
          // Claude writes the TSX directly into the tool_use input.code field;
          // jsonl persists it. We use that as the rendered code immediately.
          const input = (b.input || {}) as { code?: string; prompt?: string };
          const code = typeof input.code === 'string' ? input.code : '';
          const prompt = code
            ? `${code.split('\n')[0] || ''} … (${code.length} chars)`
            : (typeof input.prompt === 'string' ? input.prompt : JSON.stringify(input));
          const toolUseId = (b as unknown as { id?: string }).id || `synthetic-${i}`;
          // Stable key by toolUseId so the live placeholder (created on tool_use)
          // and the post-load jsonl render reconcile into the same component —
          // otherwise StaticGenUIRenderer would unmount/remount and flash.
          i++;
          const it: Extract<Item, { kind: 'genui' }> = {
            id: `genui-${toolUseId}`,
            kind: 'genui',
            toolUseId,
            prompt,
            code: code || undefined,
            status: code ? 'ready' : 'pending',
          };
          out.push(it);
          // Reuse lastTool slot so the next tool_result lands here.
          lastTool = it as unknown as Extract<Item, { kind: 'tool' }>;
        } else {
          const it: Extract<Item, { kind: 'tool' }> = {
            id: `tool${i++}`,
            kind: 'tool',
            name: b.name,
            input: b.input,
          };
          out.push(it);
          lastTool = it;
        }
      } else if (b.kind === 'tool_result') {
        if (lastTool) {
          if ((lastTool as unknown as Item).kind === 'genui') {
            const g = lastTool as unknown as Extract<Item, { kind: 'genui' }>;
            const t = b.text || '';
            if (t.startsWith('render_ui failed:')) {
              g.status = 'error';
              g.error = t.slice('render_ui failed:'.length).trim();
            } else {
              g.status = 'ready';
            }
          } else {
            lastTool.result = (lastTool.result ? lastTool.result + '\n' : '') + b.text;
          }
        }
      }
    }
  }
  return out;
}

// ---- Tool header formatting (Bash → command first line, etc.) -------------

function toolHeader(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Bash') {
    return String(input.command || '').replace(/\s+/g, ' ').slice(0, 240);
  }
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    const p = String(input.file_path || '');
    return p ? '…' + p.split('/').slice(-2).join('/') : '';
  }
  if (name === 'Glob') return String(input.pattern || '');
  if (name === 'Grep') return String(input.pattern || '');
  if (name === 'TaskCreate') return String(input.subject || '');
  if (name === 'TaskUpdate') return `#${input.taskId || ''} → ${input.status || input.subject || ''}`;
  if (name === 'WebFetch' || name === 'WebSearch') return String(input.url || input.query || '');
  const s = JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// ---- Items ----------------------------------------------------------------

// Dim italic header at the top of the thread (visually the top because the
// thread renders column-reverse, so it must be the LAST DOM child of .thread).
function SessionHeader({ cwd, startedAt }: { cwd: string; startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const shownCwd = cwd ? cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~') : '';
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const elapsed = startedAt ? formatElapsed(elapsedMs) : '';
  return (
    <div className="ti-session-head">
      <span className="ti-session-cwd">{shownCwd || '(unknown cwd)'}</span>
      {elapsed && <span className="ti-session-elapsed">({elapsed})</span>}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ---- Todo card ------------------------------------------------------------

const TODO_STATUS_ORDER: Record<TodoEntry['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

function TodoItem({ todos }: { todos: TodoEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const inProg = todos.filter((t) => t.status === 'in_progress').length;
  const open = todos.filter((t) => t.status === 'pending').length;

  const sorted = [...todos].sort(
    (a, b) => TODO_STATUS_ORDER[a.status] - TODO_STATUS_ORDER[b.status],
  );
  // Show all non-completed, plus up to first 3 completed. Overflow rolls
  // into a "… +N completed" footer.
  const shown: TodoEntry[] = [];
  let completedShown = 0;
  const COMPLETED_LIMIT = expanded ? Infinity : 3;
  for (const t of sorted) {
    if (t.status === 'completed') {
      if (completedShown < COMPLETED_LIMIT) {
        shown.push(t);
        completedShown++;
      }
    } else {
      shown.push(t);
    }
  }
  const hiddenCompleted = Math.max(0, done - completedShown);

  return (
    <div className="ti-todo">
      <div className="ti-todo-stats">
        <strong>{total} tasks</strong> ({done} done, {inProg} in progress, {open} open)
      </div>
      <ul className="ti-todo-list">
        {shown.map((t, idx) => {
          const label =
            t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
          return (
            <li key={idx} className={`ti-todo-li ti-todo-${t.status}`}>
              <span className="ti-todo-icon">
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▪' : '☐'}
              </span>
              <span className="ti-todo-text">{label}</span>
            </li>
          );
        })}
      </ul>
      {hiddenCompleted > 0 && (
        <button className="ti-expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '↑ collapse' : `… +${hiddenCompleted} completed`}
        </button>
      )}
    </div>
  );
}

// ---- System event ---------------------------------------------------------

function SystemEventItem({ eventType, text }: { eventType: string; text: string }) {
  const [open, setOpen] = useState(false);
  const label =
    eventType === 'summary'
      ? 'recap'
      : eventType === 'resume'
        ? 'resume'
        : eventType === 'compact'
          ? 'compact'
          : eventType;
  const isLong = text.length > 200;
  const shown = open || !isLong ? text : text.slice(0, 200) + '…';
  return (
    <div className="ti-sysevent">
      <span className="ti-sysevent-mark">※</span>
      <span className="ti-sysevent-label">{label}:</span> {shown}
      {isLong && (
        <button className="ti-expand ti-sysevent-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? ' ↑ collapse' : ' expand'}
        </button>
      )}
    </div>
  );
}

// One user message = one visual card, no matter how many text or image
// blocks it holds. The "❯" chevron sits at top-left; parts stack in
// original order so pasted "image → text → image" reads naturally.
function UserItem({
  parts,
  onRewind,
}: {
  parts: MsgPart[];
  onRewind?: () => void;
}) {
  const hasNonEmptyText = parts.some((p) => p.kind === 'text' && p.text);
  const hasImage = parts.some((p) => p.kind === 'image');
  if (!hasNonEmptyText && !hasImage) return null;
  return (
    <div className="ti-user">
      <span className="ti-chev">❯</span>
      <div className="ti-user-body">
        {parts.map((p, idx) =>
          p.kind === 'text' ? (
            <div key={idx} className="ti-user-text">{p.text}</div>
          ) : (
            <div key={idx} className="ti-user-image">
              <img className="ti-image" src={`data:${p.mimeType};base64,${p.data}`} alt="attachment" />
            </div>
          ),
        )}
      </div>
      {onRewind && (
        <button
          type="button"
          className="ti-user-rewind"
          onClick={onRewind}
          title="Rewind to before this message"
          aria-label="Rewind"
        >
          ↩ rewind
        </button>
      )}
    </div>
  );
}

function AssistantItem({ text }: { text: string }) {
  return (
    <div className="ti-text md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function LiveAssistantItem({ text }: { text: string }) {
  return (
    <div className="ti-text md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function ThinkingItem({ text }: { text: string }) {
  return <div className="ti-thinking">💭 {text}</div>;
}

// Assistant-side inline image (rare — some models emit vision output).
// User-side images render inside UserItem's parts instead of here.
function AssistantImageItem({ mimeType, data }: { mimeType: string; data: string }) {
  const src = `data:${mimeType};base64,${data}`;
  return (
    <div className="ti-image-row">
      <div className="ti-image-wrap">
        <img className="ti-image" src={src} alt="attachment" />
      </div>
    </div>
  );
}

const PREVIEW_LINES = 2;

function ToolItem({ name, input, result }: { name: string; input: unknown; result?: string }) {
  const [open, setOpen] = useState(false);
  const header = toolHeader(name, input);
  const resultText = (result ?? '').replace(/\n+$/, '');
  const allLines = resultText ? resultText.split('\n') : [];
  const previewLines = open ? allLines : allLines.slice(0, PREVIEW_LINES);
  const extra = Math.max(0, allLines.length - PREVIEW_LINES);

  return (
    <div className="ti-tool">
      <div className="ti-tool-head">
        <span className="ti-dot">●</span>
        <span className="ti-tool-name">{name}</span>
        {header && (
          <span className="ti-tool-args" title={header}>
            ({header})
          </span>
        )}
      </div>
      {result !== undefined && allLines.length > 0 && (
        <div className="ti-tool-out">
          <span className="ti-rail">└</span>
          <div className="ti-tool-body">
            {previewLines.length > 0 && <pre>{previewLines.join('\n')}</pre>}
            {extra > 0 && (
              <button className="ti-expand" onClick={() => setOpen((v) => !v)}>
                {open ? '↑ collapse' : `… +${extra} ${extra === 1 ? 'line' : 'lines'} (expand)`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 1:1 clone of Claude Code CLI's thinking spinner. All constants (verb list,
// spinner frames, tail-phrase thresholds, duration format, token easing) are
// extracted byte-for-byte from the shipped `claude` binary — see
// `../lib/thinkingVerbs.ts` for source offsets.
function ThinkingIndicator({
  assistantLen,
  outputTokens,
}: {
  assistantLen: number;
  // Authoritative cumulative output_tokens from the SDK's message_delta
  // usage stream. -1 = no signal yet (Macaron path or pre-first-delta); in
  // that case we fall back to the CLI's len/4 English estimate.
  outputTokens: number;
}) {
  const startRef = useRef(Date.now());
  const verbRef = useRef<string>(THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)]!);
  const [now, setNow] = useState(() => Date.now());
  const [frameIdx, setFrameIdx] = useState(0);
  // Animated token count: eases toward the true target at 50ms cadence with
  // the same step schedule the CLI uses (3/tick close, ~15% medium, 50/tick
  // far behind). The target is real tokens when available, else len/4.
  const [displayTokens, setDisplayTokens] = useState(0);
  const targetTokensRef = useRef(0);
  targetTokensRef.current =
    outputTokens >= 0 ? outputTokens : Math.round(assistantLen / 4);

  useEffect(() => {
    startRef.current = Date.now();
    setNow(Date.now());
    setDisplayTokens(0);
    const clockId = window.setInterval(() => setNow(Date.now()), 500);
    const frameId = window.setInterval(
      () => setFrameIdx((i) => (i + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    const easeId = window.setInterval(() => {
      setDisplayTokens((cur) => easeTowards(cur, targetTokensRef.current));
    }, 50);
    return () => {
      window.clearInterval(clockId);
      window.clearInterval(frameId);
      window.clearInterval(easeId);
    };
  }, []);

  const elapsedMs = Math.max(0, now - startRef.current);
  const tokens = displayTokens;
  const tail = thinkingTail(elapsedMs);

  return (
    <div className="ti-thinking-line">
      <span className="ti-thinking-star">{SPINNER_FRAMES[frameIdx]}</span>
      <span className="ti-thinking-verb">{verbRef.current}…</span>
      <span className="ti-thinking-parens">(</span>
      <span className="ti-thinking-meta">{formatDuration(elapsedMs)}</span>
      {tokens > 0 && (
        <>
          <span className="ti-thinking-sep">·</span>
          <span className="ti-thinking-meta">↓ {tokens.toLocaleString()} tokens</span>
        </>
      )}
      {tail && (
        <>
          <span className="ti-thinking-sep">·</span>
          <span className="ti-thinking-tail">{tail} with high effort</span>
        </>
      )}
      <span className="ti-thinking-parens">)</span>
    </div>
  );
}

function GenuiItem({ it }: { it: Extract<Item, { kind: 'genui' }> }) {
  const code = it.code || '';
  const streaming = it.status === 'pending' && Boolean(code);

  if (it.status === 'error') {
    return (
      <div className="ti-genui">
        <div className="ti-genui-error">render_ui failed: {it.error || 'unknown error'}</div>
      </div>
    );
  }
  if (!code) {
    return (
      <div className="ti-genui">
        <div className="ti-genui-pending">generating UI…</div>
      </div>
    );
  }
  return (
    <div className="ti-genui">
      <StaticGenUIRenderer
        code={code}
        active
        streaming={streaming}
        preserveStateOnUpdate={streaming}
        flushMode="immediate"
        className="ti-genui-renderer macaron-genui-scope"
      />
    </div>
  );
}

// Inline permission gate. Deny / Allow-once always show; Session / Always
// appear when the server sent a `suggestion` (i.e. there's a concrete rule to
// remember) and POST the decision with a scope so canUseTool persists it.
function PermissionItem({
  it,
  onDecide,
}: {
  it: Extract<Item, { kind: 'permission' }>;
  onDecide: (permissionId: string, decision: 'allow' | 'deny', scope?: 'once' | 'session' | 'always') => void;
}) {
  // Only pending gates are worth showing — once resolved, the tool block
  // above already tells the story (Bash ran / didn't run).
  if (it.status !== 'pending') return null;
  const header = toolHeader(it.toolName, it.input);
  const remember = it.suggestion?.label;
  return (
    <div className="ti-perm">
      <span className="ti-perm-icon">🔒</span>
      <span className="ti-perm-title">
        Run <strong>{it.toolName}</strong>?
      </span>
      {header && (
        <span className="ti-perm-args" title={header}>
          ({header})
        </span>
      )}
      <span className="ti-perm-actions">
        <button
          type="button"
          className="ghost small"
          onClick={() => onDecide(it.permissionId, 'deny')}
        >
          Deny
        </button>
        <button
          type="button"
          className="ghost small"
          onClick={() => onDecide(it.permissionId, 'allow', 'once')}
        >
          Allow once
        </button>
        {remember && (
          <button
            type="button"
            className="ghost small"
            title={`Don't ask again this session for: ${remember}`}
            onClick={() => onDecide(it.permissionId, 'allow', 'session')}
          >
            Session
          </button>
        )}
        {remember && (
          <button
            type="button"
            className="primary small"
            title={`Always allow in this project: ${remember}`}
            onClick={() => onDecide(it.permissionId, 'allow', 'always')}
          >
            Always
          </button>
        )}
      </span>
    </div>
  );
}

function ItemView({
  it,
  onRewind,
  onPermissionDecide,
}: {
  it: Item;
  onRewind?: (uuid: string) => void;
  onPermissionDecide?: (permissionId: string, decision: 'allow' | 'deny', scope?: 'once' | 'session' | 'always') => void;
}) {
  switch (it.kind) {
    case 'user':
      return (
        <UserItem
          parts={it.parts}
          onRewind={
            onRewind && it.uuid ? () => onRewind(it.uuid!) : undefined
          }
        />
      );
    case 'live-user':
      return <UserItem parts={it.parts} />;
    case 'assistant':
      return <AssistantItem text={it.text} />;
    case 'live-assistant':
      return <LiveAssistantItem text={it.text} />;
    case 'thinking':
      return <ThinkingItem text={it.text} />;
    case 'tool':
      return <ToolItem name={it.name} input={it.input} result={it.result} />;
    case 'todo':
      return <TodoItem todos={it.todos} />;
    case 'system_event':
      return <SystemEventItem eventType={it.eventType} text={it.text} />;
    case 'genui':
      return <GenuiItem it={it} />;
    case 'assistant-image':
      return <AssistantImageItem mimeType={it.mimeType} data={it.data} />;
    case 'permission':
      return onPermissionDecide ? (
        <PermissionItem it={it} onDecide={onPermissionDecide} />
      ) : (
        <PermissionItem it={it} onDecide={() => {}} />
      );
  }
}

// Session-level actions dropdown ("···" button). Extra items get added
// here — the button intentionally does nothing on its own; each menu row
// carries its own click handler.
function SessionActionsMenu({
  disabled,
  busyCompact,
  onCompact,
}: {
  disabled: boolean;
  busyCompact: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: Event) => {
      const ke = e as unknown as { key: string };
      if (ke.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  return (
    <div className="actions-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn"
        title="Session actions"
        aria-label="Session actions"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="5" cy="12" r="1.4" fill="currentColor" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" />
          <circle cx="19" cy="12" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="actions-menu">
          <button
            type="button"
            className="actions-menu-item"
            disabled={disabled || busyCompact}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            <span className="actions-menu-body">
              <span className="actions-menu-label">
                {busyCompact ? 'Compacting…' : 'Compact'}
              </span>
              <span className="actions-menu-sub">Summarise → replace transcript</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Session view ---------------------------------------------------------

export type SessionProps = {
  // When rendered as a canvas tile the parent passes project + sid directly
  // instead of relying on the URL params (multiple tiles on one route can't
  // share params). `focused` gates the global Shift+Tab handler so only the
  // active tile responds.
  project?: string;
  sid?: string;
  focused?: boolean;
  onFocus?: () => void;
  onRemove?: () => void;
  // Suppress the top breadcrumb + copy/refresh bar — the tile grip already
  // hosts those actions in canvas mode.
  hideBar?: boolean;
  // Incrementing this from the parent forces a fresh reload of the jsonl
  // (used by the tile's refresh button).
  refreshKey?: number;
  // Fired when the streaming state flips so a canvas tile can wrap itself
  // in a flowing-light animation while a turn is in-flight.
  onSendingChange?: (sending: boolean) => void;
  // Canvas-path "the first turn is already streaming" flag — parent sets
  // this when a draft tile just got promoted to a real sid. Session then
  // subscribes to the liveStore stream instead of GET-ing the (not-yet-
  // written) jsonl (which would 404). Equivalent to the `/s/new` route's
  // `state: { pending: true }`.
  initialPending?: boolean;
  onPendingConsumed?: () => void;
  // Called by the isNew send path (draft tile) with the real sid the server
  // assigned. The parent swaps the draft sentinel for this sid in place, so
  // the tile keeps its grid position and Session remounts under the real
  // sid with `initialPending=true`.
  onCreated?: (newSid: string) => void;
};

export function Session(props: SessionProps = {}) {
  const params = useParams();
  const project = props.project ?? params.project ?? '';
  const sid = props.sid ?? params.sid ?? '';
  const location = useLocation();
  const navigate = useNavigate();
  const isNew = !sid;
  const routePending = Boolean((location.state as { pending?: boolean } | null)?.pending);
  const isPending = routePending || Boolean(props.initialPending);
  const onCreated = props.onCreated;
  const onPendingConsumed = props.onPendingConsumed;
  // When mounted as a canvas tile the parent decides focus. Standalone
  // (single-URL) mount is always focused.
  const focused = props.focused ?? true;
  const hideBar = props.hideBar ?? false;
  const refreshKey = props.refreshKey ?? 0;
  const onSendingChange = props.onSendingChange;
  // Ref rather than closure — send() captures props once, but permission
  // notifications may fire long after the send call. Ref lets the click
  // handler always dispatch to the current onFocus.
  const onFocusRef = useRef(props.onFocus);
  onFocusRef.current = props.onFocus;
  // Marked true once a stream has started so the done-notification only
  // fires for turns the user actually initiated (not initial jsonl load).
  const streamedRef = useRef(false);
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [polling, setPolling] = useState(false);
  // Notify the parent tile whenever the effective "running" state flips
  // (either an in-flight send OR the initial new-session SSE poll). Debounced
  // by a microtask so React batches state updates naturally.
  useEffect(() => {
    onSendingChange?.(sending || polling);
  }, [sending, polling, onSendingChange]);
  // Browser notification on stream completion. Tracks the running edge:
  // fires on true→false when we actually streamed this turn (avoids
  // pinging on the initial jsonl load when everything starts at false).
  useEffect(() => {
    const running = sending || polling;
    if (running) {
      streamedRef.current = true;
      return;
    }
    if (!streamedRef.current) return;
    streamedRef.current = false;
    notify({
      title: 'Macaron · session ready',
      body: `${sid.slice(0, 8)} finished a turn`,
      tag: `macaron-done-${sid}`,
      project,
      sid,
      onClick: () => onFocusRef.current?.(),
    });
  }, [sending, polling, sid, project]);
  const [liveUser, setLiveUser] = useState<string>('');
  // Raw follow-up text streamed after each turn (a throwaway cache-hit
  // query). Parsed incrementally with partial-json. Deltas can arrive from a
  // stream that a newer send / session switch already superseded (e.g. click
  // a chip and send while the previous follow-up is still streaming), so
  // every producer captures its generation and stale deltas are dropped.
  const [followupRaw, setFollowupRaw] = useState('');
  const followupGen = useRef(0);
  const followups = useMemo(() => parseFollowups(followupRaw), [followupRaw]);
  // The row keeps a reserved slot (so streaming chips don't shove the thread
  // up) ONLY while the feature is on — when it's off there's nothing to wait
  // for, so we collapse the space entirely. Fetched once on mount.
  const [followupsEnabled, setFollowupsEnabled] = useState(false);
  useEffect(() => { api.settings().then((s) => setFollowupsEnabled(s.followupSuggestions)).catch(() => {}); }, []);
  // Clear the chips and invalidate any deltas still streaming from a superseded
  // follow-up query, atomically. Returns the new generation so a producer can
  // capture it as its token; call sites that only need to reset ignore it.
  const resetFollowups = useCallback(() => { setFollowupRaw(''); return ++followupGen.current; }, []);
  // First-turn follow-ups stream over an independent live-store channel that
  // outlives the main turn's `done` (which clears the live store). 2nd+ turns
  // deliver follow-ups via streamSession's onFollowupDelta instead. Not gated
  // on isPending — the canvas path flips it right at `done`, before the
  // follow-up stream even starts.
  useEffect(() => {
    const gen = resetFollowups();
    return subscribeFollowup(sid, (text) => {
      if (followupGen.current !== gen) return;
      setFollowupRaw((prev) => prev + text);
    });
  }, [sid]);
  // Single ordered timeline for the current turn: text chunks and tool
  // calls/permissions are interleaved in the same array so the render
  // matches Claude's actual "text → tool → text → tool" sequencing. Previous
  // implementation kept `liveAssistant: string` separate and rendered it
  // as one block ABOVE `liveTools`, which visually flipped the order.
  type LiveTurnItem = Extract<Item, { kind: 'live-assistant' | 'tool' | 'genui' | 'permission' }>;
  const [liveTurn, setLiveTurn] = useState<LiveTurnItem[]>([]);
  // Cumulative assistant text length across the timeline — the thinking
  // indicator uses this as its len/4 fallback estimate.
  const liveAssistantLen = useMemo(
    () =>
      liveTurn.reduce(
        (sum, it) => (it.kind === 'live-assistant' ? sum + it.text.length : sum),
        0,
      ),
    [liveTurn],
  );
  // -1 = no usage signal yet (Macaron path or pre-first-delta). Indicator
  // falls back to a len/4 estimate when this is < 0.
  const [outputTokens, setOutputTokens] = useState<number>(-1);
  // Images the user attached to the CURRENT in-flight turn. Rendered inline
  // (above the user text) while streaming and rolled into completedTurns on
  // the next send — same pattern as liveUser / liveAssistant / liveTools.
  const [liveUserImages, setLiveUserImages] = useState<AttachedImage[]>([]);
  // Completed turns held in-memory between refreshes. We used to re-fetch the
  // jsonl after each `done` event to promote live buffers into canonical
  // data.messages, but the CLI flushes the jsonl asynchronously — sometimes
  // the file is still stale when we load, and users see the just-streamed
  // reply vanish. Instead: freeze the live buffers into this list on the
  // NEXT send (or on unmount), and let a full page refresh be the only
  // trigger that pulls the canonical data back.
  const [completedTurns, setCompletedTurns] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  // Shell-style prompt history, per project. Latest at the end. Loaded
  // lazily so each new mount picks up entries appended by sibling tiles.
  const [history, setHistory] = useState<string[]>(() => loadHistory(project));
  useEffect(() => { setHistory(loadHistory(project)); }, [project]);
  // Navigation state. null = user is composing a fresh draft; otherwise
  // 0 = latest sent, 1 = one before, … history.length-1 = oldest. When we
  // enter history navigation we stash the draft so ArrowDown-past-latest
  // can restore it.
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const draftInputRef = useRef<string>('');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  // Shift+Tab cycles through permission modes globally on the Session view
  // (mirrors claude-cli). The toast surfaces the change since the status bar
  // may be off-screen when the user scrolls up through history.
  const permissionModeRef = useRef<PermissionMode>('default');
  permissionModeRef.current = permissionMode;
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const toast = useToast();
  const confirm = useConfirm();
  const [busyCompact, setBusyCompact] = useState(false);
  const [busyRewind, setBusyRewind] = useState(false);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const accepted: AttachedImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        toast(`${f.name}: too big (>${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MB)`);
        continue;
      }
      const dataUrl: string = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ''));
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      }).catch((e) => { toast(`${f.name}: read failed (${(e as Error).message})`); return ''; });
      if (!dataUrl) continue;
      accepted.push({ id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name, mimeType: f.type, dataUrl });
    }
    if (accepted.length) setImages((cur) => [...cur, ...accepted]);
  }, [toast]);

  // Rewind: drop the picked message + everything after it. Server backs up
  // the discarded tail to a .rewind-<ts>.jsonl.bak sibling so it's
  // recoverable. Fresh jsonl means we drop completedTurns too and reload.
  const handleRewind = useCallback(
    async (uuid: string) => {
      if (busyRewind) return;
      const ok = await confirm({
        title: 'Rewind to before this message?',
        body: (
          <>
            This message and every reply / tool call after it will be removed
            from the transcript. A backup is kept next to the jsonl.
          </>
        ),
        confirmLabel: 'Rewind',
        destructive: true,
      });
      if (!ok) return;
      setBusyRewind(true);
      try {
        const r = await api.rewindSession(project, sid, uuid);
        setCompletedTurns([]);
        setLiveUser('');
        setLiveTurn([]);
        const d = await api.session(project, sid);
        setData(d);
        setShown(PAGE_SIZE);
        toast(`Rewound · dropped ${r.dropped} lines`);
      } catch (e) {
        toast(`rewind failed: ${(e as Error).message}`);
      } finally {
        setBusyRewind(false);
      }
    },
    [busyRewind, confirm, project, sid, toast],
  );

  // Compact: replace the transcript with a provider-generated recap.
  const handleCompact = useCallback(async () => {
    if (busyCompact) return;
    const ok = await confirm({
      title: 'Compact this session?',
      body: (
        <>
          The current transcript will be replaced with a single recap
          paragraph generated by your active provider. A full backup is kept
          next to the jsonl.
        </>
      ),
      confirmLabel: 'Compact',
      destructive: true,
    });
    if (!ok) return;
    setBusyCompact(true);
    try {
      await api.compactSession(project, sid);
      setCompletedTurns([]);
      setLiveUser('');
      setLiveTurn([]);
      const d = await api.session(project, sid);
      setData(d);
      setShown(PAGE_SIZE);
      toast('Session compacted');
    } catch (e) {
      toast(`compact failed: ${(e as Error).message}`);
    } finally {
      setBusyCompact(false);
    }
  }, [busyCompact, confirm, project, sid, toast]);

  // Permission decision: POST to server; server resolves the pending
  // canUseTool promise. Optimistically update the local card so it doesn't
  // linger in "pending" — the server will echo a permission_resolved event
  // that overwrites the same status field anyway.
  const handlePermissionDecide = useCallback(
    (permissionId: string, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always' = 'once') => {
      setLiveTurn((cur) =>
        cur.map((t) =>
          t.kind === 'permission' && t.permissionId === permissionId
            ? { ...t, status: decision }
            : t,
        ),
      );
      api.permissionDecision(permissionId, decision, { scope }).catch((e) => {
        toast(`permission ${decision} failed: ${(e as Error).message}`);
      });
    },
    [toast],
  );

  // Stop: signal the server to abort the in-flight SDK stream for this
  // session. The SSE will close as a result and `sending` flips off via
  // the existing `done` handler.
  const handleStop = useCallback(async () => {
    if (!sid) return;
    try {
      await api.stopSession(project, sid);
      toast('Stop requested');
    } catch (e) {
      toast(`stop failed: ${(e as Error).message}`);
    }
  }, [project, sid, toast]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setError('');
    try {
      const d = await api.session(project, sid);
      setData(d);
      setShown(PAGE_SIZE);
      // A successful load means the jsonl is now canonical; drop any
      // in-memory completedTurns that were carrying the tail across a stale
      // "done" event.
      setCompletedTurns([]);
    } catch (e) {
      if (!opts?.silent) setError((e as Error).message);
    }
  }, [project, sid]);

  useEffect(() => {
    setData(null);
    setLiveTurn([]);
    setLiveUser('');
    setShown(PAGE_SIZE);
    if (isNew) return; // no jsonl yet — empty state until first send
    // For brand-new sessions the jsonl may not exist yet — suppress the 404 error.
    load({ silent: isPending });
    // refreshKey included so an incrementing parent nonce forces reload.
  }, [project, sid, load, isPending, isNew, refreshKey]);

  // Global Shift+Tab → cycle permission mode, matching claude-cli's binding.
  // The browser's own "reverse focus" behaviour is preempted; we surface the
  // switch via toast because the status bar might be scrolled out of view.
  useEffect(() => {
    const CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
    const LABELS: Record<PermissionMode, string> = {
      default: 'Default (ask)',
      acceptEdits: 'Accept edits',
      plan: 'Plan mode',
      bypassPermissions: 'Bypass all',
    };
    const onKey = (e: Event) => {
      if (!focused || hasActiveModal()) return; // canvas tiles only respond when active and no modal is covering them
      const ke = e as unknown as { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; preventDefault: () => void };
      if (ke.key !== 'Tab' || !ke.shiftKey || ke.ctrlKey || ke.metaKey || ke.altKey) return;
      ke.preventDefault();
      const cur = permissionModeRef.current;
      const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length]!;
      setPermissionMode(next);
      toast(`Permission → ${LABELS[next]}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast, focused]);

  // When we arrived from "+ New session", the in-browser live store already
  // has the fetch open and is collecting deltas (this survived the route
  // change, unlike the previous Workspace-local fetch). Subscribe and render.
  useEffect(() => {
    if (!isPending) return;
    setPolling(true);
    // Seed from whatever has already arrived before this view mounted.
    const seed = getLive(sid);
    const applyState = (s: typeof seed) => {
      if (!s) return;
      setLiveUser(s.userText);
      setOutputTokens(s.outputTokens);
      // Project liveStore timeline → Session Item shape (fresh objects so
      // React notices identity changes even when the underlying entry was
      // mutated in-place).
      setLiveTurn(
        s.timeline.map((t) => {
          if (t.kind === 'genui') {
            return {
              id: `genui-${t.toolUseId}`,
              kind: 'genui' as const,
              toolUseId: t.toolUseId,
              prompt: 'TSX rendering…',
              code: t.code || undefined,
              status: t.status,
              error: t.error,
            };
          }
          if (t.kind === 'permission') {
            return {
              id: t.id,
              kind: 'permission' as const,
              permissionId: t.permissionId,
              toolName: t.toolName,
              input: t.input,
              suggestion: t.suggestion,
              status: t.status,
            };
          }
          if (t.kind === 'tool') {
            return {
              id: t.id,
              kind: 'tool' as const,
              name: t.name,
              input: t.input,
              result: t.result,
            };
          }
          return {
            id: t.id,
            kind: 'live-assistant' as const,
            text: t.text,
          };
        }),
      );
    };
    if (seed) applyState(seed);
    let rafScheduled = false;
    let pendingState = seed;
    const flush = () => {
      rafScheduled = false;
      applyState(pendingState);
    };
    const unsub = subscribeLive(sid, (s) => {
      pendingState = s;
      if (s.done) {
        applyState(s);
        unsub();
        // Don't reload from jsonl here — CLI flushes asynchronously and the
        // file is often still stale, which would erase the just-streamed
        // reply. The live buffers we already have in memory are the truth
        // for this turn; they roll into completedTurns on the next send.
        setPolling(false);
        setSending(false);
        clearLive(sid);
        // Follow-up suggestions stream AFTER `done` over an independent
        // channel (subscribeFollowup), so clearing the live store here is
        // safe — the stop semantics are identical to before the feature.
        // Let the parent (draft-tile owner) drop this sid from its
        // pending set so a later refresh doesn't re-enter this branch.
        onPendingConsumed?.();
        return;
      }
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flush);
      }
    });
    // Safety: if we're on a stale URL whose live store entry is gone (e.g.
    // page refresh after streaming finished), fall back to plain load.
    if (!seed) {
      load({ silent: true }).then(() => { setPolling(false); setSending(false); });
    }
    return () => {
      unsub();
    };
  }, [isPending, sid, load, onPendingConsumed]);

  const items = useMemo(() => (data ? flatten(data.messages) : []), [data]);
  const total = items.length;
  const hidden = Math.max(0, total - shown);
  const tail = items.slice(-shown);

  // Opening an already-idle session (last item is an assistant reply, nothing
  // streaming) surfaces follow-ups too — not only the instant a turn ends.
  // Fires once per sid: after our OWN turn `onDone` flips `sending` false while
  // the message stream is still open, so without this latch the effect would
  // re-run and fire a duplicate /followups query — bumping the generation and
  // starving the in-flight post-turn deltas. sid change ⇒ remount ⇒ ref resets.
  const lastItemKind = items[items.length - 1]?.kind;
  const idleFollowupFired = useRef(false);
  useEffect(() => {
    if (isNew || isPending || sending || polling) return;
    if (lastItemKind !== 'assistant' || followupRaw || idleFollowupFired.current) return;
    idleFollowupFired.current = true;
    const gen = ++followupGen.current;
    void streamSession(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/followups`,
      {},
      { onFollowupDelta: (t) => { if (followupGen.current === gen) setFollowupRaw((prev) => prev + t); } },
    );
  }, [project, sid, isNew, isPending, sending, polling, lastItemKind]);

  // Latest TodoWrite snapshot (flatten dedupes to keep only one at any time).
  // The status bar mirrors the current in-progress task + progress fraction.
  const currentTodo = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === 'todo') {
        const inProg = it.todos.find((t) => t.status === 'in_progress');
        const done = it.todos.filter((t) => t.status === 'completed').length;
        if (!inProg) return null;
        return {
          text: inProg.activeForm || inProg.content,
          done,
          total: it.todos.length,
        };
      }
    }
    return null;
  }, [items]);

  // Note: no auto-scroll useEffect. The thread uses flex-direction:
  // column-reverse so the browser anchors scroll at the visual bottom
  // automatically — new content pushes existing content up without us
  // touching scrollTop. The user can freely scroll up to read history.

  const cwd = data?.cwd || '';
  const name = cwd ? basename(cwd) : 'Session';
  // Session start time from the earliest message timestamp — mirrors the CLI's
  // "cwd (elapsed)" header. Null before any messages arrive.
  const startedAt = useMemo(() => {
    const first = data?.messages?.find((m) => m.timestamp);
    if (!first?.timestamp) return null;
    const t = new Date(first.timestamp).getTime();
    return Number.isFinite(t) ? t : null;
  }, [data]);

  // Snapshot the current live buffers (from the last completed turn) into
  // completedTurns, then reset live state for the next turn. Called just
  // before we start streaming a new message so users don't lose the
  // previous turn's assistant reply/tools when they type another prompt.
  const rollLiveIntoHistory = useCallback(() => {
    const frozen: Item[] = [];
    const ts = Date.now();
    // Freeze the user turn (images + text) into ONE Item so it renders as
    // a single card in history — matches how a page-refresh load groups
    // them via flatten() from the jsonl.
    const parts: MsgPart[] = [];
    for (const img of liveUserImages) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
      const mimeType = m?.[1] || img.mimeType || 'image/png';
      const data = m?.[2] || '';
      if (data) parts.push({ kind: 'image', mimeType, data });
    }
    if (liveUser) parts.push({ kind: 'text', text: liveUser });
    if (parts.length) frozen.push({ id: `hist-u-${ts}`, kind: 'user', parts });
    // Walk the timeline in order — convert `live-assistant` chunks into
    // final `assistant` items so completedTurns rendering is uniform.
    for (const it of liveTurn) {
      if (it.kind === 'live-assistant') {
        if (it.text) frozen.push({ id: `${it.id}-hist`, kind: 'assistant', text: it.text });
      } else {
        frozen.push(it);
      }
    }
    if (frozen.length) setCompletedTurns((cur) => [...cur, ...frozen]);
    setLiveUser('');
    setLiveTurn([]);
    setLiveUserImages([]);
    setOutputTokens(-1);
  }, [liveUser, liveTurn, liveUserImages]);

  const send = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const text = input.trim();
      if ((!text && images.length === 0) || sending) return;
      const sentImages = images;
      setInput('');
      setImages([]);
      // New turn ⇒ new follow-up generation: clears the chips and invalidates
      // any deltas still streaming from the previous turn's follow-up query.
      const fGen = resetFollowups();
      // Persist to prompt history + reset navigation state.
      const nextHistory = pushHistory(project, text);
      setHistory(nextHistory);
      setHistoryIdx(null);
      draftInputRef.current = '';
      // Roll the *previous* turn's live buffers into history before we
      // clobber them with this turn's user text — otherwise typing a second
      // message erases the first reply until the next page refresh.
      rollLiveIntoHistory();
      setSending(true);
      // First send in a session triggers a permission request — one-time
      // per user, cached across sessions. Silently no-ops if denied.
      void ensureNotificationPermission();
      // Live text is just what the user typed; images render inline via
      // liveUserImages instead of a placeholder string.
      setLiveUser(text);
      setLiveUserImages(sentImages);
      setLiveTurn([]);
      setOutputTokens(-1);

      if (isNew) {
        // First message of a brand-new session. liveStore opens the SSE,
        // buffers deltas, and resolves with the real sid as soon as meta lands.
        try {
          const newSid = await startNewSession(project, {
            text,
            permissionMode,
            images: sentImages.map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl })),
          });
          if (onCreated) {
            // Canvas draft-tile path: hand the real sid to the parent so it
            // can swap the draft sentinel in place. Session then remounts
            // with the real sid + `initialPending=true` and picks up the
            // in-flight SSE stream via subscribeLive.
            onCreated(newSid);
          } else {
            // Standalone /s/new route: navigate keeps the existing behaviour.
            navigate(
              `/w/${encodeURIComponent(project)}/s/${encodeURIComponent(newSid)}`,
              { replace: true, state: { pending: true } },
            );
          }
        } catch (err) {
          toast(`error: ${(err as Error).message}`);
          setSending(false);
        }
        return;
      }

      await streamSession(
        `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/message`,
        {
          text,
          permissionMode,
          images: sentImages.map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl })),
        },
        {
          onDelta: (t) => {
            setLiveTurn((cur) => {
              const last = cur[cur.length - 1];
              if (last?.kind === 'live-assistant') {
                return [
                  ...cur.slice(0, -1),
                  { ...last, text: last.text + t },
                ];
              }
              return [
                ...cur,
                { id: `live-a-${Date.now()}-${cur.length}`, kind: 'live-assistant', text: t },
              ];
            });
          },
          onToolUse: ({ id, name, input: toolInput }) => {
            setLiveTurn((cur) =>
              isRenderUITool(name)
                ? [
                    ...cur,
                    { id: `genui-${id}`, kind: 'genui', toolUseId: id, prompt: 'TSX rendering…', status: 'pending' },
                  ]
                : [
                    ...cur,
                    { id: `live-${id}`, kind: 'tool', name, input: toolInput },
                  ],
            );
          },
          onToolInputDelta: ({ id, name, accumulated }) => {
            if (!isRenderUITool(name)) return;
            const partial = extractPartialCode(accumulated);
            if (!partial) return;
            setLiveTurn((cur) =>
              cur.map((t) =>
                t.kind === 'genui' && t.toolUseId === id && (!t.code || partial.length > t.code.length)
                  ? { ...t, code: partial }
                  : t,
              ),
            );
          },
          onToolInputDone: ({ id, name, final_json }) => {
            if (!isRenderUITool(name)) return;
            try {
              const obj = JSON.parse(final_json);
              if (typeof obj?.code === 'string') {
                setLiveTurn((cur) =>
                  cur.map((t) =>
                    t.kind === 'genui' && t.toolUseId === id
                      ? { ...t, status: 'ready', code: obj.code }
                      : t,
                  ),
                );
              }
            } catch { /* tolerate parse fail; stream still delivers */ }
          },
          onPermissionRequest: ({ id, toolName, input, suggestion }) => {
            // Nudge the user via native notification when a tool needs
            // approval — otherwise a session in a background tab can
            // silently stall. requireInteraction keeps it visible until
            // acted on.
            notify({
              title: 'Macaron · permission needed',
              body: `${toolName} wants to run` + (
                typeof (input as { command?: string })?.command === 'string'
                  ? `: ${(input as { command?: string }).command!.slice(0, 80)}`
                  : ''
              ),
              tag: `macaron-perm-${sid}`,
              requireInteraction: true,
              project,
              sid,
              onClick: () => onFocusRef.current?.(),
            });
            setLiveTurn((cur) => [
              ...cur,
              {
                id: `perm-${id}`,
                kind: 'permission',
                permissionId: id,
                toolName,
                input,
                suggestion,
                status: 'pending',
              },
            ]);
          },
          onPermissionResolved: ({ id, decision }) => {
            setLiveTurn((cur) =>
              cur.map((t) =>
                t.kind === 'permission' && t.permissionId === id ? { ...t, status: decision } : t,
              ),
            );
          },
          onToolResult: ({ tool_use_id, text: resultText, isError }) => {
            setLiveTurn((cur) =>
              cur.map((t) => {
                if (t.kind === 'genui' && t.toolUseId === tool_use_id) {
                  if (isError || resultText.startsWith('render_ui failed:')) {
                    return { ...t, status: 'error', error: resultText.replace(/^render_ui failed:/, '').trim() };
                  }
                  return { ...t, status: 'ready' };
                }
                if (t.kind === 'tool' && (t.id === `live-${tool_use_id}`)) {
                  return { ...t, result: resultText };
                }
                return t;
              }),
            );
          },
          onUsage: ({ outputTokens: ot }) => {
            setOutputTokens((cur) => (ot > cur ? ot : cur));
          },
          onError: (err) => {
            setLiveTurn((cur) => {
              const last = cur[cur.length - 1];
              const chunk = `\n[error] ${err}`;
              if (last?.kind === 'live-assistant') {
                return [...cur.slice(0, -1), { ...last, text: last.text + chunk }];
              }
              return [
                ...cur,
                { id: `live-a-err-${Date.now()}`, kind: 'live-assistant', text: chunk },
              ];
            });
          },
          onDone: () => {
            // Don't re-read the jsonl here — the CLI writes it asynchronously
            // and it's often still stale at this point, which made the
            // just-streamed reply flicker or vanish. Keep the live buffers
            // visible; the next send() rolls them into `completedTurns`,
            // and a page refresh reloads the canonical jsonl.
            setSending(false);
          },
          onFollowupDelta: (t) => {
            if (followupGen.current === fGen) setFollowupRaw((prev) => prev + t);
          },
        },
      );
    },
    [project, sid, input, sending, load, images, permissionMode, isNew, navigate, toast, onCreated, rollLiveIntoHistory, history],
  );

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Some IMEs emit the confirming Enter just after compositionend; keep it
      // reserved for candidate selection instead of submitting the prompt.
      if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return;
      if (compositionEndedAtRef.current > 0 && performance.now() - compositionEndedAtRef.current < 80) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      send();
      return;
    }
    // Shell-style history navigation: ArrowUp when already in history mode
    // OR when the textarea is empty / cursor is at position 0 recalls an
    // earlier prompt. Escape bails back to the draft the user was typing.
    if (e.key === 'ArrowUp') {
      const ta = e.currentTarget;
      const canEnter =
        historyIdx !== null || input === '' || ta.selectionStart === 0;
      if (!canEnter || history.length === 0) return;
      e.preventDefault();
      const nextIdx = historyIdx === null ? 0 : Math.min(historyIdx + 1, history.length - 1);
      if (historyIdx === null) draftInputRef.current = input;
      setHistoryIdx(nextIdx);
      setInput(history[history.length - 1 - nextIdx]!);
      return;
    }
    if (e.key === 'ArrowDown') {
      if (historyIdx === null) return;
      e.preventDefault();
      if (historyIdx === 0) {
        setHistoryIdx(null);
        setInput(draftInputRef.current);
        return;
      }
      const nextIdx = historyIdx - 1;
      setHistoryIdx(nextIdx);
      setInput(history[history.length - 1 - nextIdx]!);
      return;
    }
    if (e.key === 'Escape' && historyIdx !== null) {
      e.preventDefault();
      setHistoryIdx(null);
      setInput(draftInputRef.current);
    }
  };

  return (
    <section className="view session-view">
      {!hideBar && (
        <div className="session-bar">
          <div className="session-bar-left">
            <Link to="/" className="crumb-link">Workspaces</Link>
            <span className="sep">›</span>
            <Link to={`/w/${encodeURIComponent(project)}`} className="crumb-link">{name}</Link>
            <span className="sep">›</span>
            <span className="sess-id-crumb">{isNew ? 'new' : sid.slice(0, 8)}</span>
            {data?.gitBranch && <span className="sess-branch">{data.gitBranch}</span>}
          </div>
          <div className="session-bar-right">
            {!isNew && (
              <button
                className="ghost small"
                onClick={() => navigator.clipboard.writeText(`claude --resume ${sid}`).then(() => toast(`copied: claude --resume ${sid}`))}
                title="Copy claude --resume command"
              >
                Copy resume
              </button>
            )}
            <button
              className="icon-btn"
              onClick={() => load()}
              title="Refresh"
              aria-label="Refresh"
              disabled={isNew}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
                <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
                <polyline points="21 3 21 8 16 8" />
                <polyline points="3 21 3 16 8 16" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/*
        flex-direction: column-reverse on .thread. DOM order must be newest →
        oldest. Everything that should appear at the visual TOP (load-earlier
        button, banners, error/empty placeholders) goes at the END of the DOM.
      */}
      <div className="thread tui" ref={threadRef}>
        {(sending || polling) && <ThinkingIndicator assistantLen={liveAssistantLen} outputTokens={outputTokens} />}
        {/* Suggested follow-ups from the throwaway cache-hit query. Rendered
            ABOVE liveTurn in DOM (so BELOW it visually — column-reverse)
            i.e. just above the input area, right under the latest reply.
            Clicking fills the textarea (setInput), doesn't auto-send. The row
            stays mounted (reserving its height) whenever the feature is on so
            chips streaming in never shift the thread; off ⇒ no slot at all. */}
        {followupsEnabled && !isNew && (
          <div className="ti-followups">
            {followups.map((q, i) => (
              <button
                key={`${q}-${i}`}
                className="ti-followup-chip"
                onClick={() => {
                  resetFollowups();
                  setInput(q);
                }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {/* Single ordered timeline for the current turn. Items are appended
            to `liveTurn` in exact SSE arrival order, so reversing here
            (thread is column-reverse) puts the newest at the visual bottom
            while preserving relative text/tool interleaving. */}
        {[...liveTurn].reverse().map((t) => (
          <ItemView key={t.id} it={t} onPermissionDecide={handlePermissionDecide} />
        ))}
        {/* Current-turn user message = one card. Images stack ABOVE the
            text (Claude-web ordering: attachments before prose). */}
        {(liveUser || liveUserImages.length > 0) && (
          <ItemView
            it={{
              id: 'live-u',
              kind: 'live-user',
              parts: [
                ...liveUserImages.map((img) => ({
                  kind: 'image' as const,
                  mimeType: img.mimeType,
                  data: /^data:[^;]+;base64,(.*)$/.exec(img.dataUrl)?.[1] || '',
                })),
                ...(liveUser ? [{ kind: 'text' as const, text: liveUser }] : []),
              ],
            }}
          />
        )}
        {[...completedTurns].reverse().map((it) => (
          <ItemView key={it.id} it={it} />
        ))}
        {[...tail].reverse().map((it) => (
          <ItemView key={it.id} it={it} onRewind={handleRewind} />
        ))}
        {hidden > 0 && (
          <button className="ghost load-earlier" onClick={() => setShown((s) => s + PAGE_SIZE)}>
            Load {Math.min(hidden, PAGE_SIZE)} earlier · {hidden} hidden
          </button>
        )}
        {data?.truncated && (
          <div className="thread-banner">Showing tail only — full session is {(data.totalBytes! / 1024 / 1024).toFixed(1)} MB.</div>
        )}
        {data && total === 0 && !polling && !liveUser && <div className="placeholder">No messages yet.</div>}
        {isNew && !liveUser && !sending && (
          <div className="placeholder">Start a new session — set permissions below and send your first message.</div>
        )}
        {/* Only show "Loading…" if we truly have nothing to render — hide it
            when live buffers or completed turns already show content, since
            the canonical jsonl may just be a beat behind the CLI. */}
        {!isNew &&
          !data &&
          !error &&
          !polling &&
          !liveUser &&
          liveTurn.length === 0 &&
          completedTurns.length === 0 && (
            <div className="muted">Loading…</div>
          )}
        {error && <div className="ti-error">error: {error}</div>}
        {/* CLI-parity: cwd + elapsed line at the visual top of the thread.
            Rendered LAST in DOM because .thread is column-reverse. */}
        {(cwd || startedAt) && <SessionHeader cwd={cwd} startedAt={startedAt} />}
      </div>

      {/* Input area always mounted — collapses to a zero-fr grid row
          when the tile isn't focused so a click-focus animates in
          smoothly against the content's natural height, and the user's
          typed draft survives focus changes. */}
      <div className={`session-input-area${focused ? '' : ' collapsed'}`}>
      <div className="session-input-inner">
      <form
        className={`session-input${dragOver ? ' drag-over' : ''}`}
        onSubmit={send}
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={(e) => {
          // Only clear when leaving the form itself, not when entering a child
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
      >
        {images.length > 0 && (
          <div className="img-chips">
            {images.map((img) => (
              <div key={img.id} className="img-chip" title={img.name}>
                <img src={img.dataUrl} alt={img.name} />
                <button
                  type="button"
                  className="img-chip-x"
                  onClick={() => setImages((cur) => cur.filter((c) => c.id !== img.id))}
                  aria-label="Remove image"
                >×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          rows={2}
          placeholder={sending ? 'Draft next message…' : 'Reply to Claude…'}
          value={input}
          onChange={(e) => {
            if (followupRaw) resetFollowups();
            setInput(e.target.value);
            // Any manual edit exits history-navigation mode — pressing
            // Send now sends the (possibly edited) text as a fresh entry.
            if (historyIdx !== null) setHistoryIdx(null);
          }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => {
            composingRef.current = false;
            compositionEndedAtRef.current = performance.now();
          }}
          onPaste={(e) => {
            const files: File[] = [];
            for (const item of Array.from(e.clipboardData.items)) {
              if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f && f.type.startsWith('image/')) files.push(f);
              }
            }
            if (files.length) { e.preventDefault(); void addFiles(files); }
          }}
          onKeyDown={onKey}
        />
        {/*
          Claude-web-style toolbar. Attach on the far left. Model (provider)
          and permission chips grouped on the right next to Send. Each chip
          is a small pill button with icon + label + caret; a real <select>
          sits on top of it (opacity:0) to get native picker behaviour.
        */}
        <div className="session-input-tools">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="icon-btn"
            title="Attach image"
            aria-label="Attach image"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <SessionActionsMenu
            disabled={isNew || sending}
            busyCompact={busyCompact}
            onCompact={() => void handleCompact()}
          />
          <div className="session-input-spacer" />
          {sending ? (
            <button
              type="button"
              className="primary send-btn stop-btn"
              onClick={() => void handleStop()}
              disabled={!sid}
              title="Stop generation"
              aria-label="Stop"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              className="primary send-btn"
              type="submit"
              disabled={!input.trim() && images.length === 0}
              aria-label="Send"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </form>

      <StatusBar
        projectName={name}
        permissionMode={permissionMode}
        onPermissionChange={setPermissionMode}
        sending={sending}
        currentTodo={currentTodo}
        latestUsage={data?.latestUsage}
        claudeMdCount={data?.claudeMdCount}
        mcpCount={data?.mcpCount}
      />
      </div>
      </div>
    </section>
  );
}
