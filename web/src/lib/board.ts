// Dispatch board state: a flat list of task cards, each backed by a normal
// macaron session. Cards flow across status columns derived live from the
// session's SSE stream. Persisted to localStorage so the board survives a
// reload (live updates resume only while the browser liveStore holds the
// stream — cross-reload SSE reconnect is a deferred stretch goal, see #53).

import type { LiveState } from './liveStore';

// Column = lifecycle state. Ordered left→right the way work actually moves:
// queued → running → (paused for a human) → terminal.
export type BoardColumn = 'queued' | 'running' | 'input' | 'done' | 'failed';

export const COLUMNS: Array<{ key: BoardColumn; label: string; hint: string }> = [
  { key: 'queued', label: 'Queued', hint: 'spawn in flight' },
  { key: 'running', label: 'Running', hint: 'streaming' },
  { key: 'input', label: 'Needs Input', hint: 'waiting on a permission decision' },
  { key: 'done', label: 'Done', hint: 'finished cleanly' },
  { key: 'failed', label: 'Failed', hint: 'errored or stopped' },
];

export const TERMINAL: BoardColumn[] = ['done', 'failed'];

export type BoardCard = {
  id: string; // stable client id, independent of the (later-assigned) sid
  project: string; // target workspace this task was dispatched into
  task: string; // the prompt that launched the session
  sid?: string; // assigned once the server emits its meta event
  status: BoardColumn;
  preview?: string; // latest streamed text snippet, for the card body
  tokens?: number; // cumulative output tokens (live usage)
  error?: string;
  createdAt: number;
};

const STORAGE_KEY = 'macaron.board';

export function loadBoard(): BoardCard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw) as unknown;
    if (!Array.isArray(j)) return [];
    return j
      .filter((c): c is BoardCard => Boolean(c) && typeof (c as BoardCard).id === 'string' && typeof (c as BoardCard).task === 'string')
      .map((c) => ({ ...c, status: normalizeStatus(c.status) }));
  } catch {
    return [];
  }
}

export function saveBoard(cards: BoardCard[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  } catch {
    /* quota exceeded / disabled — silently ignore, matches canvas.ts */
  }
}

function normalizeStatus(s: unknown): BoardColumn {
  return s === 'queued' || s === 'running' || s === 'input' || s === 'done' || s === 'failed' ? s : 'running';
}

// Map a live SSE state onto a column. Error wins over done (a run can emit
// both), a pending permission parks the card in "Needs Input", otherwise it's
// still streaming.
export function deriveStatus(s: LiveState): BoardColumn {
  if (s.error) return 'failed';
  if (s.done) return 'done';
  if (s.timeline.some((t) => t.kind === 'permission' && t.status === 'pending')) return 'input';
  return 'running';
}

// Latest non-empty assistant text on the timeline — the card's one-line pulse.
export function livePreview(s: LiveState): string {
  for (let i = s.timeline.length - 1; i >= 0; i--) {
    const t = s.timeline[i]!;
    if (t.kind === 'text' && t.text.trim()) return t.text.trim();
  }
  return '';
}
