// Per-workspace canvas state: pinned tiles with their grid geometry +
// which one has visual focus. Persisted to localStorage per project.
//
// Geometry model: a fixed 12-column CSS grid with row cells sized in units
// of `--tile-row-h` (default ~48px). Each tile carries an integer colSpan
// (1–12) and rowSpan (1–20). Auto-flow places tiles in order; a resize
// nudges the numbers, an animation smooths the transition.

import { useCallback, useEffect, useState } from 'react';

export type TileGeom = { sid: string; colSpan: number; rowSpan: number };

export const CANVAS_COLS = 12;
export const DEFAULT_COL_SPAN = 6;   // half-width by default
export const DEFAULT_ROW_SPAN = 10;  // ~480px tall by default
export const MIN_COL_SPAN = 3;
export const MAX_COL_SPAN = 12;
export const MIN_ROW_SPAN = 4;
export const MAX_ROW_SPAN = 24;

type CanvasState = {
  tiles: TileGeom[];
  focusedSid: string | null;
};

const STORAGE_PREFIX = 'macaron.canvas.';

function storageKey(project: string): string {
  return STORAGE_PREFIX + project;
}

function loadCanvas(project: string): CanvasState {
  try {
    const raw = localStorage.getItem(storageKey(project));
    if (!raw) return { tiles: [], focusedSid: null };
    const j = JSON.parse(raw) as Partial<CanvasState> & { sids?: string[] };
    // Back-compat: earlier versions stored `sids: string[]`. Convert.
    if (Array.isArray(j.sids) && !Array.isArray(j.tiles)) {
      return {
        tiles: j.sids
          .filter((s): s is string => typeof s === 'string')
          .map((sid) => ({ sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN })),
        focusedSid: typeof j.focusedSid === 'string' ? j.focusedSid : null,
      };
    }
    const tiles = Array.isArray(j.tiles)
      ? j.tiles
          .filter((t): t is TileGeom => Boolean(t) && typeof (t as TileGeom).sid === 'string')
          .map((t) => ({
            sid: t.sid,
            colSpan: clamp(t.colSpan ?? DEFAULT_COL_SPAN, MIN_COL_SPAN, MAX_COL_SPAN),
            rowSpan: clamp(t.rowSpan ?? DEFAULT_ROW_SPAN, MIN_ROW_SPAN, MAX_ROW_SPAN),
          }))
      : [];
    return {
      tiles,
      focusedSid: typeof j.focusedSid === 'string' ? j.focusedSid : null,
    };
  } catch {
    return { tiles: [], focusedSid: null };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function saveCanvas(project: string, state: CanvasState): void {
  try {
    localStorage.setItem(storageKey(project), JSON.stringify(state));
  } catch {
    /* quota exceeded / disabled — silently ignore */
  }
}

const listeners = new Map<string, Set<() => void>>();
function notify(project: string): void {
  listeners.get(project)?.forEach((cb) => cb());
}

// Plain helpers for callers that iterate over many workspaces (sidebar) —
// they can't call the hook once per project. Reads localStorage directly.
export function getCanvasSids(project: string): string[] {
  return loadCanvas(project).tiles.map((t) => t.sid);
}

export function toggleCanvasSid(project: string, sid: string): void {
  const cur = loadCanvas(project);
  const has = cur.tiles.some((t) => t.sid === sid);
  const next: CanvasState = has
    ? (() => {
        const tiles = cur.tiles.filter((t) => t.sid !== sid);
        const focusedSid =
          cur.focusedSid === sid ? tiles[0]?.sid || null : cur.focusedSid;
        return { tiles, focusedSid };
      })()
    : {
        tiles: [
          ...cur.tiles,
          { sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN },
        ],
        focusedSid: cur.focusedSid || sid,
      };
  saveCanvas(project, next);
  notify(project);
}

export function focusCanvasSid(project: string, sid: string): void {
  const cur = loadCanvas(project);
  if (!cur.tiles.some((t) => t.sid === sid)) return;
  if (cur.focusedSid === sid) return;
  saveCanvas(project, { ...cur, focusedSid: sid });
  notify(project);
}

export function subscribeCanvas(project: string, cb: () => void): () => void {
  let set = listeners.get(project);
  if (!set) {
    set = new Set();
    listeners.set(project, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(project);
  };
}

export function useCanvas(project: string): {
  tiles: TileGeom[];
  focusedSid: string | null;
  isOnCanvas: (sid: string) => boolean;
  add: (sid: string) => void;
  remove: (sid: string) => void;
  toggle: (sid: string) => void;
  reorder: (fromIdx: number, toIdx: number) => void;
  resize: (sid: string, patch: { colSpan?: number; rowSpan?: number }) => void;
  focus: (sid: string) => void;
} {
  const [state, setState] = useState<CanvasState>(() => loadCanvas(project));

  useEffect(() => {
    setState(loadCanvas(project));
    let set = listeners.get(project);
    if (!set) {
      set = new Set();
      listeners.set(project, set);
    }
    const cb = () => setState(loadCanvas(project));
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) listeners.delete(project);
    };
  }, [project]);

  const update = useCallback(
    (patch: (cur: CanvasState) => CanvasState) => {
      setState((cur) => {
        const next = patch(cur);
        saveCanvas(project, next);
        notify(project);
        return next;
      });
    },
    [project],
  );

  const isOnCanvas = useCallback(
    (sid: string) => state.tiles.some((t) => t.sid === sid),
    [state.tiles],
  );

  const add = useCallback(
    (sid: string) => {
      update((cur) => {
        if (cur.tiles.some((t) => t.sid === sid)) return cur;
        return {
          tiles: [
            ...cur.tiles,
            { sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN },
          ],
          focusedSid: cur.focusedSid || sid,
        };
      });
    },
    [update],
  );

  const remove = useCallback(
    (sid: string) => {
      update((cur) => {
        const tiles = cur.tiles.filter((t) => t.sid !== sid);
        const focusedSid =
          cur.focusedSid === sid ? tiles[0]?.sid || null : cur.focusedSid;
        return { tiles, focusedSid };
      });
    },
    [update],
  );

  const toggle = useCallback(
    (sid: string) => {
      update((cur) => {
        if (cur.tiles.some((t) => t.sid === sid)) {
          const tiles = cur.tiles.filter((t) => t.sid !== sid);
          const focusedSid =
            cur.focusedSid === sid ? tiles[0]?.sid || null : cur.focusedSid;
          return { tiles, focusedSid };
        }
        return {
          tiles: [
            ...cur.tiles,
            { sid, colSpan: DEFAULT_COL_SPAN, rowSpan: DEFAULT_ROW_SPAN },
          ],
          focusedSid: cur.focusedSid || sid,
        };
      });
    },
    [update],
  );

  const reorder = useCallback(
    (fromIdx: number, toIdx: number) => {
      update((cur) => {
        if (fromIdx === toIdx) return cur;
        const tiles = cur.tiles.slice();
        const [moved] = tiles.splice(fromIdx, 1);
        if (moved) tiles.splice(toIdx, 0, moved);
        return { ...cur, tiles };
      });
    },
    [update],
  );

  const resize = useCallback(
    (sid: string, patch: { colSpan?: number; rowSpan?: number }) => {
      update((cur) => ({
        ...cur,
        tiles: cur.tiles.map((t) =>
          t.sid !== sid
            ? t
            : {
                sid,
                colSpan:
                  patch.colSpan !== undefined
                    ? clamp(patch.colSpan, MIN_COL_SPAN, MAX_COL_SPAN)
                    : t.colSpan,
                rowSpan:
                  patch.rowSpan !== undefined
                    ? clamp(patch.rowSpan, MIN_ROW_SPAN, MAX_ROW_SPAN)
                    : t.rowSpan,
              },
        ),
      }));
    },
    [update],
  );

  const focus = useCallback(
    (sid: string) => {
      update((cur) => {
        if (!cur.tiles.some((t) => t.sid === sid)) return cur;
        if (cur.focusedSid === sid) return cur;
        return { ...cur, focusedSid: sid };
      });
    },
    [update],
  );

  return {
    tiles: state.tiles,
    focusedSid: state.focusedSid,
    isOnCanvas,
    add,
    remove,
    toggle,
    reorder,
    resize,
    focus,
  };
}
