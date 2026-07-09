import { useState } from 'react';
import { formatDuration } from '../lib/thinkingVerbs';

export type TimelineStatus = 'ok' | 'error' | 'pending';

export type TimelineEntry = {
  // Matches the `data-item-id` on the target row so a click can scroll to it.
  id: string;
  icon: string;
  label: string;
  // Compact "target" line (Bash command, file path, pattern…) for the tooltip.
  summary: string;
  durationMs?: number;
  status: TimelineStatus;
};

// Tool name → glyph, ported from EdanStarfire/claudecode_webui's toolSummary.js
// icon table (the reference impl in the issue). Unknown tools fall back to 🔧.
export function toolIcon(name: string): string {
  if (name.startsWith('mcp__')) return name.endsWith('__render_ui') ? '🎨' : '🔌';
  switch (name) {
    case 'Bash': return '💻';
    case 'Read': return '📄';
    case 'Edit':
    case 'MultiEdit': return '✏️';
    case 'Write': return '📝';
    case 'Grep':
    case 'Glob': return '🔍';
    case 'WebFetch':
    case 'WebSearch': return '🌐';
    case 'TodoWrite': return '📋';
    case 'Task': return '🤖';
    case 'NotebookEdit': return '📓';
    default: return '🔧';
  }
}

// Display label: drop a trailing "Tool", and for mcp tools keep the last
// `__`-segment (mcp__macaron__render_ui → render_ui) — same rule as the ref.
export function toolLabel(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts[parts.length - 1] || name;
  }
  return name.replace(/Tool$/, '');
}

// A one-line horizontally-scrolling rail of every tool call in the session,
// newest last. Each node jumps to its message card in the thread. Compact by
// design (one row) so it fits even inside a canvas tile; collapsible when the
// user wants the space back.
export function ActivityTimeline({
  entries,
  activeId,
  onJump,
}: {
  entries: TimelineEntry[];
  activeId?: string | null;
  onJump: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (entries.length === 0) return null;
  const failed = entries.filter((e) => e.status === 'error').length;
  return (
    <div className={`ti-timeline${open ? '' : ' collapsed'}`}>
      <button
        type="button"
        className="ti-timeline-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Collapse activity timeline' : 'Expand activity timeline'}
      >
        <span className="ti-timeline-caret">{open ? '▾' : '▸'}</span>
        <span className="ti-timeline-title">
          {entries.length} tool {entries.length === 1 ? 'call' : 'calls'}
        </span>
        {failed > 0 && <span className="ti-timeline-failed">· {failed} failed</span>}
      </button>
      {open && (
        <div className="ti-timeline-rail">
          {entries.map((e) => {
            const dur = e.durationMs != null ? formatDuration(e.durationMs) : '';
            const tip = `${e.label}${e.summary ? ': ' + e.summary : ''}${dur ? '  ·  ' + dur : ''}`;
            return (
              <button
                key={e.id}
                type="button"
                className={`ti-node ti-node-${e.status}${activeId === e.id ? ' active' : ''}`}
                title={tip}
                onClick={() => onJump(e.id)}
              >
                <span className="ti-node-icon" aria-hidden>{e.icon}</span>
                <span className="ti-node-label">{e.label}</span>
                {dur && <span className="ti-node-dur">{dur}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
