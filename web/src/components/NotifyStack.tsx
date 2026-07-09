import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  dismissNotify,
  getNotifyItems,
  subscribeNotify,
  type NotifyItem,
} from '../lib/notify';

// Auto-dismiss duration for non-sticky notifications.
const AUTO_DISMISS_MS = 6000;

// Top-right stack of in-app notifications. Renderless when empty. Sits
// under App so `useNavigate` is available for click routing.
export function NotifyStack() {
  const [items, setItems] = useState<NotifyItem[]>(() => getNotifyItems());
  const navigate = useNavigate();

  useEffect(() => {
    // Snap to whatever the store holds now, then re-render on every emit.
    setItems(getNotifyItems());
    return subscribeNotify(() => setItems(getNotifyItems()));
  }, []);

  // Per-id timers for auto-dismiss. Sticky items (requireInteraction) skip.
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const known = new Set(items.map((i) => i.id));
    // Cancel timers for items that are gone.
    for (const [id, t] of timers.current) {
      if (!known.has(id)) {
        window.clearTimeout(t);
        timers.current.delete(id);
      }
    }
    // Schedule for any new item that doesn't yet have a timer.
    for (const it of items) {
      if (it.requireInteraction) continue;
      if (timers.current.has(it.id)) continue;
      const t = window.setTimeout(() => {
        timers.current.delete(it.id);
        dismissNotify(it.id);
      }, AUTO_DISMISS_MS);
      timers.current.set(it.id, t);
    }
  }, [items]);

  useEffect(() => {
    // Cleanup on unmount — clear all pending timers.
    const map = timers.current;
    return () => {
      for (const t of map.values()) window.clearTimeout(t);
      map.clear();
    };
  }, []);

  if (items.length === 0) return null;

  const handleClick = (it: NotifyItem) => {
    // Priority order for click target — see NotifyOptions for the rationale.
    // Codex passes `href` (its routes differ from Claude's `/w/:project/s/:sid`).
    if (it.href) {
      navigate(it.href);
    } else if (it.project && it.sid) {
      navigate(`/w/${encodeURIComponent(it.project)}/s/${encodeURIComponent(it.sid)}`);
    }
    try {
      it.onClick?.();
    } catch {
      /* swallow — click side-effects shouldn't crash the stack */
    }
    dismissNotify(it.id);
  };

  return (
    <div className="notify-stack" aria-live="polite">
      {items.map((it) => (
        <button
          type="button"
          key={it.id}
          className="notify-card"
          onClick={() => handleClick(it)}
        >
          <span className="notify-card-close"
            onClick={(e) => {
              // Explicit dismiss shouldn't also fire the card click.
              e.stopPropagation();
              dismissNotify(it.id);
            }}
            aria-label="dismiss"
          >
            ×
          </span>
          <div className="notify-card-title">{it.title}</div>
          {it.body ? <div className="notify-card-body">{it.body}</div> : null}
        </button>
      ))}
    </div>
  );
}
