import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtAgo, type Workspace } from '../lib/api';
import {
  loadBoard,
  saveBoard,
  deriveStatus,
  livePreview,
  COLUMNS,
  TERMINAL,
  type BoardCard,
  type BoardColumn,
} from '../lib/board';
import { getLive, subscribeLive, startNewSession } from '../lib/liveStore';
import { useToast } from '../components/Toast';

let cardSeq = 0;
function newCardId(): string {
  return `card-${Date.now().toString(36)}-${cardSeq++}`;
}

// Dispatch board: launch N parallel agent sessions from one prompt and watch
// them flow across status columns. Each card is a normal macaron session under
// the hood (same /sessions spawn + SSE stream), so nothing new is needed on the
// server — the board is a pure client-side orchestration surface over the
// existing per-sid liveStore. Prior art: nadeko0/claude-code-studio "Dispatch"
// mode (Kanban of task cards). DAG dependencies + auto-retry are deferred (#53).
export function Board() {
  const navigate = useNavigate();
  const toast = useToast();
  const [cards, setCards] = useState<BoardCard[]>(() => loadBoard());
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [project, setProject] = useState('');
  const [task, setTask] = useState('');
  const [count, setCount] = useState(3);

  // Persist on every change so a reload keeps the board. Live tracking only
  // resumes for sessions launched in the current page load (cross-reload SSE
  // reconnect is a deferred stretch goal); detached in-flight cards show a hint.
  useEffect(() => saveBoard(cards), [cards]);

  useEffect(() => {
    api
      .workspaces()
      .then((d) => {
        setWorkspaces(d.workspaces);
        setProject((p) => p || d.workspaces[0]?.project || '');
      })
      .catch(() => {});
  }, []);

  const patchCard = useCallback((id: string, patch: Partial<BoardCard>) => {
    setCards((cur) => cur.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  // One liveStore subscription per card sid. Re-derives the column, preview and
  // token count on every stream tick. Terminal status sticks even after the
  // liveStore entry is cleared, because we've already captured it here.
  const subs = useRef(new Map<string, () => void>());
  useEffect(() => {
    for (const c of cards) {
      if (!c.sid || subs.current.has(c.sid)) continue;
      if (TERMINAL.includes(c.status)) continue;
      const sid = c.sid;
      const id = c.id;
      const apply = (s: ReturnType<typeof getLive>) => {
        if (!s) return;
        patchCard(id, {
          status: deriveStatus(s),
          preview: livePreview(s) || undefined,
          tokens: s.outputTokens >= 0 ? s.outputTokens : undefined,
          error: s.error,
        });
      };
      apply(getLive(sid));
      subs.current.set(sid, subscribeLive(sid, apply));
    }
    const alive = new Set(cards.map((c) => c.sid).filter(Boolean));
    for (const [sid, unsub] of subs.current) {
      if (!alive.has(sid)) {
        unsub();
        subs.current.delete(sid);
      }
    }
  }, [cards, patchCard]);

  useEffect(() => () => { for (const unsub of subs.current.values()) unsub(); }, []);

  const dispatch = () => {
    const text = task.trim();
    if (!text) { toast('enter a task first'); return; }
    if (!project) { toast('pick a workspace first'); return; }
    const n = Math.max(1, Math.min(8, count));
    const fresh: BoardCard[] = Array.from({ length: n }, () => ({
      id: newCardId(),
      project,
      task: text,
      status: 'queued' as BoardColumn,
      createdAt: Date.now(),
    }));
    setCards((cur) => [...fresh, ...cur]);
    setTask('');
    for (const card of fresh) {
      // startNewSession opens the SSE + feeds liveStore; it resolves with the
      // sid once the server emits meta. The per-sid subscription (above) then
      // picks up the stream on the next render.
      startNewSession(project, { text })
        .then((sid) => patchCard(card.id, { sid, status: 'running' }))
        .catch((e) => patchCard(card.id, { status: 'failed', error: (e as Error).message }));
    }
  };

  const openCard = (c: BoardCard) => {
    if (!c.sid) return;
    navigate(`/w/${encodeURIComponent(c.project)}/s/${encodeURIComponent(c.sid)}`);
  };

  const removeCard = (id: string) => setCards((cur) => cur.filter((c) => c.id !== id));
  const clearTerminal = () => setCards((cur) => cur.filter((c) => !TERMINAL.includes(c.status)));

  const byColumn = (col: BoardColumn) => cards.filter((c) => c.status === col);
  const activeCount = cards.filter((c) => !TERMINAL.includes(c.status)).length;

  return (
    <section className="board-view">
      <header className="board-head">
        <div className="board-title">
          <h1>Dispatch</h1>
          <span className="board-sub">
            {cards.length} card{cards.length === 1 ? '' : 's'}
            {activeCount > 0 && <span className="board-active"> · {activeCount} active</span>}
          </span>
        </div>
        {cards.some((c) => TERMINAL.includes(c.status)) && (
          <button className="ghost small" onClick={clearTerminal}>Clear finished</button>
        )}
      </header>

      <div className="board-dispatch">
        <textarea
          className="board-task"
          placeholder="Describe a task to run in parallel across N fresh sessions…"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); dispatch(); }
          }}
        />
        <div className="board-dispatch-row">
          <label className="board-field">
            <span>Workspace</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              {workspaces.length === 0 && <option value="">No workspaces</option>}
              {workspaces.map((w) => (
                <option key={w.project} value={w.project}>{w.name || w.project}</option>
              ))}
            </select>
          </label>
          <label className="board-field">
            <span>Sessions</span>
            <input
              type="number"
              min={1}
              max={8}
              value={count}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
            />
          </label>
          <span className="board-hint">⌘↵ to dispatch</span>
          <button className="primary" onClick={dispatch} disabled={!task.trim() || !project}>
            Dispatch {Math.max(1, Math.min(8, count))} →
          </button>
        </div>
      </div>

      <div className="board-columns">
        {COLUMNS.map((col) => {
          const items = byColumn(col.key);
          return (
            <div key={col.key} className={`board-col board-col-${col.key}`}>
              <div className="board-col-head">
                <span className="board-col-name">{col.label}</span>
                <span className="board-col-count">{items.length}</span>
              </div>
              <div className="board-col-body">
                {items.length === 0 && <div className="board-col-empty">{col.hint}</div>}
                {items.map((c) => (
                  <BoardCardTile
                    key={c.id}
                    card={c}
                    detached={!TERMINAL.includes(c.status) && Boolean(c.sid) && !getLive(c.sid!)}
                    onOpen={() => openCard(c)}
                    onRemove={() => removeCard(c.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BoardCardTile({
  card,
  detached,
  onOpen,
  onRemove,
}: {
  card: BoardCard;
  detached: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const running = card.status === 'running';
  return (
    <div
      className={`board-card${running ? ' running' : ''}${card.sid ? ' clickable' : ''}`}
      onClick={card.sid ? onOpen : undefined}
      role={card.sid ? 'button' : undefined}
      tabIndex={card.sid ? 0 : undefined}
    >
      {running && <div className="board-card-bar" aria-hidden />}
      <div className="board-card-task">{card.task}</div>
      {(card.preview || card.error) && (
        <div className={`board-card-preview${card.error ? ' err' : ''}`}>
          {card.error || card.preview}
        </div>
      )}
      <div className="board-card-foot">
        <span className="board-card-sid">{card.sid ? card.sid.slice(0, 8) : 'spawning…'}</span>
        {typeof card.tokens === 'number' && <span className="board-card-tok">{card.tokens} tok</span>}
        {detached && <span className="board-card-detached" title="Live tracking resumes only for sessions launched this page-load — open the session to see current state">detached</span>}
        <span className="board-card-time">{fmtAgo(card.createdAt)}</span>
        <button
          className="board-card-x"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove card"
          aria-label="Remove card"
        >×</button>
      </div>
    </div>
  );
}
