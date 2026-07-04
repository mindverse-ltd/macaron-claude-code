import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api, basename, type SessionListItem, type Workspace as Wk } from '../lib/api';
import { useToast } from '../components/Toast';
import {
  useCanvas,
  CANVAS_COLS,
  MIN_COL_SPAN,
  MAX_COL_SPAN,
  MIN_ROW_SPAN,
  MAX_ROW_SPAN,
  type TileGeom,
} from '../lib/canvas';
import { Session } from './Session';
import { startNewSession } from '../lib/liveStore';

// One row cell in the canvas grid (px). CSS grid-auto-rows uses this; a
// tile's rowSpan is a multiplier. Kept in sync with `.ws-canvas-grid-v2`
// in styles.css.
const ROW_UNIT_PX = 48;

// Nominal column pixel width used for translating pixel-based resize deltas
// into integer column-span changes. We recompute from the grid's actual
// bounding rect on each drag so the snap is accurate.
type ResizeState = {
  sid: string;
  startX: number;
  startY: number;
  startColSpan: number;
  startRowSpan: number;
  colPx: number; // width of one grid column at drag start
};

export function Workspace() {
  const { project = '', sid: sidFromUrl = '' } = useParams();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Wk | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState('');
  const [showNewInput, setShowNewInput] = useState(false);
  const [newPrompt, setNewPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const canvas = useCanvas(project);
  const gridRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  const load = useCallback(() => {
    api
      .workspace(project)
      .then((d) => {
        setWorkspace(d.workspace);
        setSessions(d.sessions);
      })
      .catch((e) => setError((e as Error).message));
  }, [project]);

  useEffect(() => {
    setWorkspace(null);
    setSessions(null);
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [project, load]);

  // Back-compat: URLs like /w/:project/s/:sid pin + focus + rewrite.
  useEffect(() => {
    if (!sidFromUrl) return;
    if (!canvas.isOnCanvas(sidFromUrl)) canvas.add(sidFromUrl);
    canvas.focus(sidFromUrl);
    navigate(`/w/${encodeURIComponent(project)}`, { replace: true });
  }, [sidFromUrl, project, canvas, navigate]);

  const name = workspace?.name || basename(workspace?.cwd || '') || project;

  const handleNewSession = async () => {
    if (!newPrompt.trim() || creating) return;
    setCreating(true);
    try {
      const newSid = await startNewSession(project, { text: newPrompt.trim() });
      setNewPrompt('');
      setShowNewInput(false);
      canvas.add(newSid);
      canvas.focus(newSid);
      load();
    } catch (e) {
      toast(`failed: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  // dnd-kit reorder. rectSortingStrategy handles multi-column grids; the
  // sortable transform + transition on each tile give the FLIP animation
  // as siblings slide into place. Pointer sensor with a 6px activation
  // distance keeps the resize handle click from starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const sids = useMemo(() => canvas.tiles.map((t) => t.sid), [canvas.tiles]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = sids.indexOf(String(active.id));
    const to = sids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    canvas.reorder(from, to);
  };

  // Pointer-driven resize on the SE handle. dnd-kit doesn't cover resizing
  // — we bind pointermove/pointerup to `window` so the drag survives past
  // the tile bounds. Grid geometry (`colPx`) is captured at drag start.
  const startResize = (sid: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const tile = canvas.tiles.find((t) => t.sid === sid);
    if (!tile) return;
    const grid = gridRef.current;
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const gapPx = 12;
    const colPx = (gridRect.width - gapPx * (CANVAS_COLS - 1)) / CANVAS_COLS;
    resizeRef.current = {
      sid,
      startX: e.clientX,
      startY: e.clientY,
      startColSpan: tile.colSpan,
      startRowSpan: tile.rowSpan,
      colPx,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd, { once: true });
  };

  const onResizeMove = useCallback(
    (e: PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const dxCols = Math.round((e.clientX - r.startX) / (r.colPx + 12));
      const dyRows = Math.round((e.clientY - r.startY) / (ROW_UNIT_PX + 12));
      const nextCol = Math.max(MIN_COL_SPAN, Math.min(MAX_COL_SPAN, r.startColSpan + dxCols));
      const nextRow = Math.max(MIN_ROW_SPAN, Math.min(MAX_ROW_SPAN, r.startRowSpan + dyRows));
      canvas.resize(r.sid, { colSpan: nextCol, rowSpan: nextRow });
    },
    [canvas],
  );

  const onResizeEnd = useCallback(() => {
    resizeRef.current = null;
    window.removeEventListener('pointermove', onResizeMove);
  }, [onResizeMove]);

  if (error) {
    return (
      <section className="view">
        <div className="placeholder">Error: {error}</div>
      </section>
    );
  }

  if (!sessions) {
    return (
      <section className="view">
        <div className="muted">Loading…</div>
      </section>
    );
  }

  return (
    <section className="ws-canvas-v2">
      <header className="ws-canvas-head">
        <div className="ws-canvas-title">
          <span className="ws-canvas-name">{name}</span>
          <span className="ws-canvas-meta">
            {canvas.tiles.length} pinned · {sessions.length} in workspace
          </span>
        </div>
        <div className="ws-canvas-actions">
          <button className="ghost small" onClick={() => setShowNewInput((v) => !v)}>
            + New Session
          </button>
        </div>
      </header>

      {showNewInput && (
        <div className="ws-new-input">
          <textarea
            autoFocus
            placeholder="What do you want to work on?"
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleNewSession();
              }
            }}
          />
          <button className="primary small" disabled={creating} onClick={handleNewSession}>
            {creating ? 'Creating…' : 'Start'}
          </button>
        </div>
      )}

      {canvas.tiles.length === 0 ? (
        <div className="ws-canvas-empty">
          <p>Canvas is empty.</p>
          <p className="muted">
            Pick sessions from the sidebar (hover a session and click <code>+</code>) or
            start a new one.
          </p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={sids} strategy={rectSortingStrategy}>
            <div
              className="ws-canvas-grid-v2"
              ref={gridRef}
              style={{
                gridTemplateColumns: `repeat(${CANVAS_COLS}, 1fr)`,
                gridAutoRows: `${ROW_UNIT_PX}px`,
              }}
            >
              {canvas.tiles.map((tile) => {
                const meta = sessions.find((x) => x.sessionId === tile.sid);
                const isFocused = canvas.focusedSid === tile.sid;
                return (
                  <SortableTile
                    key={tile.sid}
                    tile={tile}
                    label={meta?.preview?.slice(0, 60) || tile.sid.slice(0, 8)}
                    isFocused={isFocused}
                    project={project}
                    onFocus={() => canvas.focus(tile.sid)}
                    onRemove={() => canvas.remove(tile.sid)}
                    onResizeStart={(e) => startResize(tile.sid, e)}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

// Individual sortable tile. Wraps Session in a grid item that responds to
// dnd-kit's drag transform. The whole grip bar is the drag handle; the SE
// corner is the resize handle.
function SortableTile({
  tile,
  label,
  isFocused,
  project,
  onFocus,
  onRemove,
  onResizeStart,
}: {
  tile: TileGeom;
  label: string;
  isFocused: boolean;
  project: string;
  onFocus: () => void;
  onRemove: () => void;
  onResizeStart: (e: React.PointerEvent) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tile.sid });
  // Incremented by the tile's refresh button — Session watches this prop
  // and re-runs its jsonl load, saving us from cross-component refs.
  const [refreshKey, setRefreshKey] = useState(0);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (n: HTMLDivElement | null) => {
      nodeRef.current = n;
      setNodeRef(n);
    },
    [setNodeRef],
  );

  // Sidebar → tile focus intent. Scrolls this tile into view and focuses
  // its composer textarea when a matching event fires. Uses querySelector
  // rather than an imperative handle since Session already lives behind
  // props — simpler and one-shot.
  useEffect(() => {
    const onFocusEvent = (ev: Event) => {
      const d = (ev as CustomEvent<{ project: string; sid: string }>).detail;
      if (!d || d.project !== project || d.sid !== tile.sid) return;
      const node = nodeRef.current;
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // Delay the focus until after the input-area expansion transition
      // (grid-template-rows 300ms) — otherwise the textarea's caret jumps
      // while the container is still animating open.
      window.setTimeout(() => {
        const ta = node.querySelector<HTMLTextAreaElement>('.session-input textarea');
        ta?.focus();
      }, 320);
    };
    window.addEventListener('macaron:focus-tile', onFocusEvent);
    return () => window.removeEventListener('macaron:focus-tile', onFocusEvent);
  }, [project, tile.sid]);

  const style: React.CSSProperties = {
    gridColumn: `span ${tile.colSpan}`,
    gridRow: `span ${tile.rowSpan}`,
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 5 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  const copyResume = () => {
    const cmd = `claude --resume ${tile.sid}`;
    void navigator.clipboard.writeText(cmd);
  };

  return (
    <div
      ref={setRef}
      className={`ws-tile${isFocused ? ' focused' : ''}${isDragging ? ' dragging' : ''}`}
      style={style}
      onClick={() => {
        if (!isFocused) onFocus();
      }}
    >
      <div className="ws-tile-grip" {...attributes} {...listeners} title="Drag to reorder">
        <span className="ws-tile-grip-dots">⋮⋮</span>
        <span className="ws-tile-grip-label">{label}</span>
        <button
          className="ws-tile-action"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            copyResume();
          }}
          title="Copy claude --resume command"
          aria-label="Copy resume command"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <button
          className="ws-tile-action"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setRefreshKey((k) => k + 1);
          }}
          title="Refresh"
          aria-label="Refresh"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
            <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
            <polyline points="21 3 21 8 16 8" />
            <polyline points="3 21 3 16 8 16" />
          </svg>
        </button>
        <button
          className="ws-tile-x"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove from canvas"
          aria-label="Remove from canvas"
        >
          ×
        </button>
      </div>
      <div className="ws-tile-body">
        <Session
          project={project}
          sid={tile.sid}
          focused={isFocused}
          onFocus={onFocus}
          hideBar
          refreshKey={refreshKey}
        />
      </div>
      <div
        className="ws-tile-resize"
        onPointerDown={onResizeStart}
        title="Drag to resize"
      />
    </div>
  );
}
