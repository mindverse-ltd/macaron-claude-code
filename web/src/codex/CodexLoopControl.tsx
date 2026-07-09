// Compact autonomous-loop control for the Codex composer. A chip that shows
// the loop state (off / armed / running · iteration count) and opens a popover
// to toggle it and edit every dimension — prompt, stop conditions, thread mode.
// Everything is configurable; nothing about the prompt is baked in.

import { useEffect, useRef, useState } from 'react';
import { codexApi, type CodexLoopConfig, type CodexLoopSnapshot } from './api';

const STATUS_LABEL: Record<CodexLoopSnapshot['status'], string> = {
  idle: 'idle',
  armed: 'armed',
  running: 'running',
  stopped: 'off',
};

export function CodexLoopControl({ sid, snapshot }: { sid: string; snapshot: CodexLoopSnapshot | null }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CodexLoopConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Seed the editable draft from the live snapshot whenever the popover opens.
  useEffect(() => {
    if (open && snapshot) setDraft(snapshot.config);
  }, [open, snapshot]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!snapshot) return null;
  const { enabled, status, iterations } = snapshot;

  const save = async (patch: Partial<CodexLoopConfig>) => {
    setBusy(true);
    setErr('');
    try {
      await codexApi.setLoop(sid, patch);
    } catch (e) {
      setErr((e as Error).message);
      window.setTimeout(() => setErr(''), 2400);
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => void save({ enabled: !enabled });

  const applyDraft = () => {
    if (!draft) return;
    void save(draft);
  };

  const chipLabel = enabled
    ? `Loop · ${STATUS_LABEL[status]}${iterations > 0 ? ` · ${iterations}` : ''}`
    : 'Loop';

  return (
    <div className={'cx-loop' + (enabled ? ' on' : '')} ref={wrapRef}>
      <button
        className={'cx-loop-chip' + (enabled ? ' on' : '') + (status === 'running' ? ' running' : '')}
        onClick={() => setOpen((v) => !v)}
        title={snapshot.stopReason ? `Loop stopped: ${snapshot.stopReason}` : 'Autonomous loop'}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 2l4 4-4 4" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <path d="M7 22l-4-4 4-4" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
        <span className="cx-loop-chip-label">{chipLabel}</span>
      </button>

      {open && draft && (
        <div className="cx-loop-pop">
          <div className="cx-loop-pop-head">
            <span className="cx-loop-pop-title">Autonomous loop</span>
            <label className="cx-loop-switch">
              <input type="checkbox" checked={enabled} disabled={busy} onChange={toggle} />
              <span>{enabled ? 'On' : 'Off'}</span>
            </label>
          </div>
          <p className="cx-loop-pop-sub">
            When a turn finishes and the session is idle, re-injects the prompt below to keep working
            unattended. Stops on any condition.
          </p>

          <label className="cx-loop-field">
            <span>Loop prompt</span>
            <textarea
              value={draft.prompt}
              rows={3}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </label>

          <div className="cx-loop-row">
            <label className="cx-loop-field">
              <span>Max iterations (0 = ∞)</span>
              <input
                type="number"
                min={0}
                value={draft.maxIterations}
                onChange={(e) => setDraft({ ...draft, maxIterations: Number(e.target.value) })}
              />
            </label>
            <label className="cx-loop-field">
              <span>Timeout (min, 0 = none)</span>
              <input
                type="number"
                min={0}
                value={Math.round(draft.timeoutMs / 60_000)}
                onChange={(e) => setDraft({ ...draft, timeoutMs: Math.max(0, Number(e.target.value)) * 60_000 })}
              />
            </label>
          </div>

          <label className="cx-loop-field">
            <span>Completion sentinels (comma-separated)</span>
            <input
              type="text"
              value={draft.sentinels.join(', ')}
              placeholder="COMPLETE, BLOCKED"
              onChange={(e) => setDraft({ ...draft, sentinels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
          </label>

          <label className="cx-loop-field">
            <span>Thread mode</span>
            <select
              value={draft.mode}
              onChange={(e) => setDraft({ ...draft, mode: e.target.value === 'fresh-thread' ? 'fresh-thread' : 'same-thread' })}
            >
              <option value="same-thread">Same thread (context grows)</option>
              <option value="fresh-thread">Fresh thread each iteration</option>
            </select>
          </label>

          {err && <div className="cx-loop-err">{err}</div>}
          <div className="cx-loop-pop-foot">
            <button className="cx-loop-save" disabled={busy} onClick={applyDraft}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
