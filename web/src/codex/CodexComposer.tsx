import { useEffect, useRef, useState } from 'react';
import { CodexProviderPicker } from './CodexProviderPicker';

export type ComposerImage = { id: string; name: string; mimeType: string; dataUrl: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function CodexComposer({
  value,
  onChange,
  images,
  onImagesChange,
  onSubmit,
  onStop,
  disabled,
  running,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  images: ComposerImage[];
  onImagesChange: (next: ComposerImage[]) => void;
  onSubmit: () => void;
  onStop?: () => void;
  disabled?: boolean;
  running?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [value]);

  const addFiles = async (files: FileList | File[]) => {
    const accepted: ComposerImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/') || f.size > MAX_IMAGE_BYTES) continue;
      const dataUrl = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ''));
        r.onerror = () => res('');
        r.readAsDataURL(f);
      });
      if (dataUrl) accepted.push({ id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name, mimeType: f.type, dataUrl });
    }
    if (accepted.length) onImagesChange([...images, ...accepted]);
  };

  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!disabled && (value.trim() || images.length)) onSubmit();
    }
  };

  return (
    <div className="cx-composer-wrap">
      <div
        className={'cx-composer' + (dragOver ? ' drag-over' : '')}
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
      >
        {images.length > 0 && (
          <div className="cx-img-chips">
            {images.map((img) => (
              <div key={img.id} className="cx-img-chip" title={img.name}>
                <img src={img.dataUrl} alt={img.name} />
                <button
                  type="button"
                  className="cx-img-chip-x"
                  onClick={() => onImagesChange(images.filter((c) => c.id !== img.id))}
                  aria-label="Remove image"
                >×</button>
              </div>
            ))}
          </div>
        )}
        <div className="cx-composer-row">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            className="cx-attach"
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Attach image"
            aria-label="Attach image"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={key}
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
            placeholder={placeholder ?? 'Message Codex…'}
            rows={1}
          />
          {running && onStop ? (
            <button className="cx-send stop" onClick={onStop} title="Stop">■</button>
          ) : (
            <button
              className="cx-send"
              disabled={disabled || (!value.trim() && !images.length)}
              onClick={onSubmit}
              title="Send (Enter)"
              aria-label="Send"
            >↑</button>
          )}
        </div>
      </div>
      <div className="cx-composer-foot">
        <CodexProviderPicker />
        <span className="cx-composer-hint">Enter to send · Shift+Enter for newline</span>
      </div>
    </div>
  );
}
