import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { api, basename } from '../lib/api';

// Find an active @-mention token immediately before the caret. Matches an `@`
// that starts at the very beginning or right after whitespace, followed by a
// run of non-whitespace "query" chars. Returns the @'s index and the query, or
// null when the caret isn't inside a mention token.
export function detectMention(value: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i]!;
    if (ch === '@') {
      const before = i === 0 ? '' : value[i - 1]!;
      if (i === 0 || /\s/.test(before)) return { start: i, query: value.slice(i + 1, caret) };
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

type MentionState = { start: number; query: string } | null;

export function useFileMention(opts: {
  project: string;
  value: string;
  setValue: (v: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  // The composer's live IME-composition flag. The popup must not swallow the
  // Enter/Tab that confirms a CJK candidate (see onKeyDown).
  composingRef: RefObject<boolean>;
}) {
  const { project, value, setValue, textareaRef, composingRef } = opts;
  const [mention, setMention] = useState<MentionState>(null);
  const [results, setResults] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const reqSeq = useRef(0);

  const open = mention !== null;

  // Re-detect the mention token from the textarea's live DOM value + caret.
  // Reading the element directly (not the closure `value`) avoids lagging one
  // keystroke behind React's state update inside onChange.
  const refresh = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const m = detectMention(ta.value, ta.selectionStart ?? ta.value.length);
    setMention(m);
    if (!m) setResults([]);
  }, [textareaRef]);

  // Debounced fetch whenever the mention query changes.
  useEffect(() => {
    if (!mention) return;
    const seq = ++reqSeq.current;
    const t = setTimeout(() => {
      api
        .searchFiles(project, mention.query, 50)
        .then((r) => {
          if (seq !== reqSeq.current) return; // a newer query superseded us
          setResults(r.results);
          setActive(0);
        })
        .catch(() => {
          if (seq === reqSeq.current) setResults([]);
        });
    }, 120);
    return () => clearTimeout(t);
  }, [project, mention]);

  const close = useCallback(() => {
    setMention(null);
    setResults([]);
    reqSeq.current++;
  }, []);

  const choose = useCallback(
    (rel: string) => {
      if (!mention) return;
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? value.length;
      const next = value.slice(0, mention.start) + '@' + rel + ' ' + value.slice(caret);
      setValue(next);
      close();
      // Restore the caret just past the inserted "@path ".
      const pos = mention.start + rel.length + 2;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      });
    },
    [mention, value, setValue, textareaRef, close],
  );

  // Intercept navigation keys while the popup is open. Returns true when the
  // key was consumed so the composer's own onKey should bail.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || results.length === 0) return false;
      // Enter/Tab mid-IME-composition confirm a CJK candidate — don't hijack
      // them to insert a file. Mirror the composer's guard and let it through.
      if ((e.key === 'Enter' || e.key === 'Tab') && (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229)) return false;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % results.length); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(results[active]!); return true; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
      return false;
    },
    [open, results, active, choose, close, composingRef],
  );

  const popup = useMemo(() => {
    if (!open || results.length === 0) return null;
    return (
      <div className="mention-popup" role="listbox" aria-label="File mentions">
        {results.map((rel, i) => (
          <button
            key={rel}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`mention-item${i === active ? ' active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); choose(rel); }}
            onMouseEnter={() => setActive(i)}
          >
            <span className="mention-name">{basename(rel)}</span>
            <span className="mention-path">{rel}</span>
          </button>
        ))}
      </div>
    );
  }, [open, results, active, choose]);

  return { popup, onKeyDown, refresh, open };
}
