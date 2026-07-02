import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, basename, type Message, type SessionDetail } from '../lib/api';
import { streamSession } from '../lib/sse';
import { getLive, subscribeLive, clearLive, startNewSession } from '../lib/liveStore';
import { extractPartialCode } from '../lib/partialJson';
import {
  THINKING_VERBS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  thinkingTail,
  formatDuration,
  easeTowards,
} from '../lib/thinkingVerbs';
import { useToast } from '../components/Toast';
import { ProviderPicker } from '../components/ProviderPicker';
import StaticGenUIRenderer from '../macaron-vendor/StaticGenUIRenderer';

const RENDER_UI_TOOL = 'mcp__macaron__render_ui';
const isRenderUITool = (name: string) => name === RENDER_UI_TOOL || name.endsWith('__render_ui');

const PAGE_SIZE = 80;

type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'default', label: 'Default (ask)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'bypassPermissions', label: 'Bypass all' },
];
type AttachedImage = { id: string; name: string; mimeType: string; dataUrl: string };

// Chip-styled permission-mode picker for the input toolbar. Native <select>
// sits invisibly on top of the pill so the OS-native menu handles keyboard
// nav + accessibility for free.
function PermissionChip({
  value,
  onChange,
  disabled,
}: {
  value: PermissionMode;
  onChange: (v: PermissionMode) => void;
  disabled: boolean;
}) {
  const active = PERMISSION_OPTIONS.find((o) => o.value === value);
  return (
    <div className={`provider-chip${disabled ? ' disabled' : ''}`} title={`Permission · ${active?.label ?? value}`}>
      <svg className="provider-chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
      <span className="provider-chip-label">{active?.label ?? value}</span>
      <svg className="provider-chip-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <select
        className="provider-chip-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as PermissionMode)}
        aria-label="Permission mode"
      >
        {PERMISSION_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// ---- Flatten Claude's per-block messages into a TUI-style item list -------

type Item =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; name: string; input: unknown; result?: string }
  | { id: string; kind: 'genui'; toolUseId: string; prompt: string; code?: string; status: 'pending' | 'ready' | 'error'; error?: string }
  | { id: string; kind: 'live-user'; text: string }
  | { id: string; kind: 'live-assistant'; text: string };

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
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === 'text') {
        if (m.role === 'user') {
          if (!isNoisyUserText(b.text)) out.push({ id: `u${i++}`, kind: 'user', text: b.text });
        } else {
          if (b.text.trim()) out.push({ id: `a${i++}`, kind: 'assistant', text: b.text });
        }
        lastTool = null;
      } else if (b.kind === 'thinking') {
        if (b.text.trim()) out.push({ id: `t${i++}`, kind: 'thinking', text: b.text });
        lastTool = null;
      } else if (b.kind === 'tool_use') {
        if (isRenderUITool(b.name)) {
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

function UserItem({ text }: { text: string }) {
  return (
    <div className="ti-user">
      <span className="ti-chev">❯</span>
      <div className="ti-user-body">{text}</div>
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

const PREVIEW_LINES = 4;

function ToolItem({ name, input, result }: { name: string; input: unknown; result?: string }) {
  const [open, setOpen] = useState(false);
  const header = toolHeader(name, input);
  const allLines = (result ?? '').split('\n');
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
      {result !== undefined && (
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

function ItemView({ it }: { it: Item }) {
  switch (it.kind) {
    case 'user':
    case 'live-user':
      return <UserItem text={it.text} />;
    case 'assistant':
      return <AssistantItem text={it.text} />;
    case 'live-assistant':
      return <LiveAssistantItem text={it.text} />;
    case 'thinking':
      return <ThinkingItem text={it.text} />;
    case 'tool':
      return <ToolItem name={it.name} input={it.input} result={it.result} />;
    case 'genui':
      return <GenuiItem it={it} />;
  }
}

// ---- Session view ---------------------------------------------------------

export function Session() {
  const { project = '', sid = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const isNew = !sid;
  const isPending = Boolean((location.state as { pending?: boolean } | null)?.pending);
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [polling, setPolling] = useState(false);
  const [liveAssistant, setLiveAssistant] = useState<string>('');
  const [liveUser, setLiveUser] = useState<string>('');
  // Tool calls that started during the current send but haven't been merged
  // into jsonl yet. Indexed by tool_use_id for in-place tool_result patching.
  const [liveTools, setLiveTools] = useState<Array<Extract<Item, { kind: 'genui' | 'tool' }>>>([]);
  // -1 = no usage signal yet (Macaron path or pre-first-delta). Indicator
  // falls back to a len/4 estimate when this is < 0.
  const [outputTokens, setOutputTokens] = useState<number>(-1);
  // Completed turns held in-memory between refreshes. We used to re-fetch the
  // jsonl after each `done` event to promote live buffers into canonical
  // data.messages, but the CLI flushes the jsonl asynchronously — sometimes
  // the file is still stale when we load, and users see the just-streamed
  // reply vanish. Instead: freeze the live buffers into this list on the
  // NEXT send (or on unmount), and let a full page refresh be the only
  // trigger that pulls the canonical data back.
  const [completedTurns, setCompletedTurns] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const accepted: AttachedImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        toast(`${f.name}: too big (>${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MB)`);
        continue;
      }
      const dataUrl: string = await new Promise((res, rej) => {
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
    setLiveAssistant('');
    setLiveUser('');
    setShown(PAGE_SIZE);
    if (isNew) return; // no jsonl yet — empty state until first send
    // For brand-new sessions the jsonl may not exist yet — suppress the 404 error.
    load({ silent: isPending });
  }, [project, sid, load, isPending, isNew]);

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
      setLiveAssistant(s.assistantBuf);
      setOutputTokens(s.outputTokens);
      // Project liveStore tools → Session Item shape (a copy so React notices).
      setLiveTools(
        s.tools.map((t) =>
          t.kind === 'genui'
            ? { id: `genui-${t.toolUseId}`, kind: 'genui', toolUseId: t.toolUseId, prompt: 'TSX rendering…', code: t.code || undefined, status: t.status, error: t.error }
            : { id: t.id, kind: 'tool', name: t.name, input: t.input, result: t.result },
        ),
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
  }, [isPending, sid, load]);

  const items = useMemo(() => (data ? flatten(data.messages) : []), [data]);
  const total = items.length;
  const hidden = Math.max(0, total - shown);
  const tail = items.slice(-shown);

  // Note: no auto-scroll useEffect. The thread uses flex-direction:
  // column-reverse so the browser anchors scroll at the visual bottom
  // automatically — new content pushes existing content up without us
  // touching scrollTop. The user can freely scroll up to read history.

  const cwd = data?.cwd || '';
  const name = cwd ? basename(cwd) : 'Session';

  // Snapshot the current live buffers (from the last completed turn) into
  // completedTurns, then reset live state for the next turn. Called just
  // before we start streaming a new message so users don't lose the
  // previous turn's assistant reply/tools when they type another prompt.
  const rollLiveIntoHistory = useCallback(() => {
    const frozen: Item[] = [];
    if (liveUser) frozen.push({ id: `hist-u-${Date.now()}`, kind: 'user', text: liveUser });
    frozen.push(...liveTools);
    if (liveAssistant) frozen.push({ id: `hist-a-${Date.now()}`, kind: 'assistant', text: liveAssistant });
    if (frozen.length) setCompletedTurns((cur) => [...cur, ...frozen]);
    setLiveUser('');
    setLiveAssistant('');
    setLiveTools([]);
    setOutputTokens(-1);
  }, [liveUser, liveAssistant, liveTools]);

  const send = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const text = input.trim();
      if ((!text && images.length === 0) || sending) return;
      const sentImages = images;
      setInput('');
      setImages([]);
      // Roll the *previous* turn's live buffers into history before we
      // clobber them with this turn's user text — otherwise typing a second
      // message erases the first reply until the next page refresh.
      rollLiveIntoHistory();
      setSending(true);
      setLiveUser(text || (sentImages.length ? `(${sentImages.length} image${sentImages.length > 1 ? 's' : ''})` : ''));
      setLiveAssistant('');
      setLiveTools([]);
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
          navigate(
            `/w/${encodeURIComponent(project)}/s/${encodeURIComponent(newSid)}`,
            { replace: true, state: { pending: true } },
          );
        } catch (err) {
          toast(`error: ${(err as Error).message}`);
          setSending(false);
        }
        return;
      }

      let buf = '';
      await streamSession(
        `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/message`,
        {
          text,
          permissionMode,
          images: sentImages.map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl })),
        },
        {
          onDelta: (t) => {
            buf += t;
            setLiveAssistant(buf);
          },
          onToolUse: ({ id, name, input: toolInput }) => {
            if (isRenderUITool(name)) {
              setLiveTools((cur) => [
                ...cur,
                { id: `genui-${id}`, kind: 'genui', toolUseId: id, prompt: 'TSX rendering…', status: 'pending' },
              ]);
            } else {
              setLiveTools((cur) => [
                ...cur,
                { id: `live-${id}`, kind: 'tool', name, input: toolInput },
              ]);
            }
          },
          onToolInputDelta: ({ id, name, accumulated }) => {
            if (!isRenderUITool(name)) return;
            const partial = extractPartialCode(accumulated);
            if (!partial) return;
            setLiveTools((cur) =>
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
                setLiveTools((cur) =>
                  cur.map((t) =>
                    t.kind === 'genui' && t.toolUseId === id
                      ? { ...t, status: 'ready', code: obj.code }
                      : t,
                  ),
                );
              }
            } catch { /* tolerate parse fail; stream still delivers */ }
          },
          onToolResult: ({ tool_use_id, text: resultText, isError }) => {
            setLiveTools((cur) =>
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
            setLiveAssistant((cur) => cur + `\n[error] ${err}`);
          },
          onDone: () => {
            // Don't re-read the jsonl here — the CLI writes it asynchronously
            // and it's often still stale at this point, which made the
            // just-streamed reply flicker or vanish. Keep the live buffers
            // visible; the next send() rolls them into `completedTurns`,
            // and a page refresh reloads the canonical jsonl.
            setSending(false);
          },
        },
      );
    },
    [project, sid, input, sending, load, images, permissionMode, isNew, navigate, toast],
  );

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <section className="view session-view">
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

      {/*
        flex-direction: column-reverse on .thread. DOM order must be newest →
        oldest. Everything that should appear at the visual TOP (load-earlier
        button, banners, error/empty placeholders) goes at the END of the DOM.
      */}
      <div className="thread tui" ref={threadRef}>
        {(sending || polling) && <ThinkingIndicator assistantLen={liveAssistant.length} outputTokens={outputTokens} />}
        {/* Render whenever there's text — not just while sending. Since we no
            longer reload the jsonl on `done`, this line has to survive until
            either the next send() (which rolls it into completedTurns) or a
            manual page refresh (which loads canonical data). */}
        {liveAssistant && <ItemView it={{ id: 'live-a', kind: 'live-assistant', text: liveAssistant }} />}
        {[...liveTools].reverse().map((t) => <ItemView key={t.id} it={t} />)}
        {liveUser && <ItemView it={{ id: 'live-u', kind: 'live-user', text: liveUser }} />}
        {[...completedTurns].reverse().map((it) => (
          <ItemView key={it.id} it={it} />
        ))}
        {[...tail].reverse().map((it) => (
          <ItemView key={it.id} it={it} />
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
          !liveAssistant &&
          liveTools.length === 0 &&
          completedTurns.length === 0 && (
            <div className="muted">Loading…</div>
          )}
        {error && <div className="ti-error">error: {error}</div>}
      </div>

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
          placeholder="Reply to Claude…"
          value={input}
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
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
          <div className="session-input-spacer" />
          <PermissionChip
            value={permissionMode}
            onChange={setPermissionMode}
            disabled={sending}
          />
          <ProviderPicker />
          <button
            className="primary send-btn"
            type="submit"
            disabled={sending || (!input.trim() && images.length === 0)}
            aria-label="Send"
          >
            {sending ? (
              <span className="send-dot" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            )}
          </button>
        </div>
      </form>
    </section>
  );
}
