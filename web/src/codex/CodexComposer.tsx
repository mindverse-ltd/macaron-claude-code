import { useEffect, useRef } from 'react';

export function CodexComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  disabled,
  running,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  disabled?: boolean;
  running?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [value]);

  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!disabled && value.trim()) onSubmit();
    }
  };

  return (
    <div className="cx-composer-wrap">
      <div className="cx-composer">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={key}
          placeholder={placeholder ?? 'Message Codex…'}
          rows={1}
        />
        {running && onStop ? (
          <button className="cx-send stop" onClick={onStop} title="Stop">■</button>
        ) : (
          <button
            className="cx-send"
            disabled={disabled || !value.trim()}
            onClick={onSubmit}
            title="Send (Enter)"
            aria-label="Send"
          >↑</button>
        )}
      </div>
      <div className="cx-composer-hint">Enter to send · Shift+Enter for newline</div>
    </div>
  );
}
