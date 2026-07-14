// A single file rendered inside a canvas tile. Shares the tile chrome
// (grip / actions / close) with Session and Terminal; the body toggles
// between preview (markdown / image / plain text with syntax colors) and
// edit (Monaco). Default = preview.
//
// Fetches on mount and on refreshKey change. Save writes back via
// api.writeFile; unsaved changes are indicated by a dot and confirmed
// before switching files.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import { useToast } from './Toast';

// Monaco is heavy — only load it when the user flips to Edit mode.
const CodeEditor = lazy(() => import('./CodeEditor'));

const MAX_INLINE_PREVIEW_BYTES = 512 * 1024;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const BINARY_EXTS = new Set(['pdf', 'zip', 'tar', 'gz', 'bin', 'exe', 'dll', 'so', 'dylib', 'wasm', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'mov', 'avi']);

function extOf(path: string): string {
  return (path.split('.').pop() || '').toLowerCase();
}

function basenameOf(path: string): string {
  return path.split('/').pop() || path;
}

export function FileTile({
  project,
  path,
  focused,
  refreshKey,
}: {
  project: string;
  path: string;
  focused: boolean;
  refreshKey?: number;
}) {
  const toast = useToast();
  const [content, setContent] = useState<string>('');
  const [original, setOriginal] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'preview' | 'split' | 'edit'>('preview');
  const [saving, setSaving] = useState(false);
  const dirty = content !== original;

  const ext = extOf(path);
  const isImage = IMAGE_EXTS.has(ext);
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const isBinary = BINARY_EXTS.has(ext);

  const load = useCallback(() => {
    if (isImage || isBinary) {
      setLoading(false);
      setContent('');
      setOriginal('');
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    api.readFile(project, path)
      .then((d) => {
        setContent(d.content ?? '');
        setOriginal(d.content ?? '');
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [project, path, isImage, isBinary]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api.writeFile(project, path, content);
      setOriginal(content);
      toast('Saved');
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [project, path, content, dirty, saving, toast]);

  // Cmd/Ctrl+S — only the focused tile handles it. Split mode is editable,
  // so it shares the same save shortcut as the full editor.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!focused || mode === 'preview') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, mode]);

  const tooBig = content.length > MAX_INLINE_PREVIEW_BYTES;

  const previewNode = useMemo(() => {
    if (isImage) {
      // Image preview via authed GET — reuse the read endpoint's raw path.
      // Server returns text for text files; for images we use an <img> with
      // a proxied URL so the browser handles decoding.
      const src = `/api/files/${encodeURIComponent(project)}/raw?path=${encodeURIComponent(path)}`;
      return (
        <div className="ft-image-wrap">
          <img src={src} alt={basenameOf(path)} />
        </div>
      );
    }
    if (isBinary) {
      return <div className="ft-placeholder">Binary file · {basenameOf(path)}</div>;
    }
    if (error) return <div className="ft-placeholder err">Can't read: {error}</div>;
    if (loading) return <div className="ft-placeholder">Loading…</div>;
    if (tooBig) return <div className="ft-placeholder">File larger than 512 KB — switch to Edit mode to view.</div>;
    if (isMarkdown) {
      return (
        <div className="ft-preview md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      );
    }
    // Plain preview — monospace, no syntax highlight (CodeMirror is only in Edit).
    return <pre className="ft-preview code">{content}</pre>;
  }, [isImage, isBinary, isMarkdown, error, loading, tooBig, content, project, path]);

  const editorNode = error ? (
    <div className="ft-placeholder err">Can't read: {error}</div>
  ) : (
    <Suspense fallback={<div className="ft-placeholder">Loading editor…</div>}>
      <CodeEditor
        path={path}
        value={content}
        onChange={setContent}
      />
    </Suspense>
  );

  return (
    <div className="ft-root">
      {/* Redundant tile-header replaced by a compact floating action strip
          in the body's top-right corner — the outer SortableTile chrome
          already shows the filename, so we don't repeat the path here. */}
      <div className="ft-body">
        {!isImage && !isBinary && (
          <div className="ft-actions">
            <div className="ft-mode-toggle" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'preview'}
                className={'ft-mode-btn' + (mode === 'preview' ? ' active' : '')}
                onClick={() => setMode('preview')}
              >
                Preview
              </button>
              {isMarkdown && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'split'}
                  className={'ft-mode-btn' + (mode === 'split' ? ' active' : '')}
                  onClick={() => setMode('split')}
                >
                  Split
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'edit'}
                className={'ft-mode-btn' + (mode === 'edit' ? ' active' : '')}
                onClick={() => setMode('edit')}
              >
                Edit
                {dirty && <span className="ft-dirty" title="Unsaved changes">●</span>}
              </button>
            </div>
            {mode !== 'preview' && (
              <button
                type="button"
                className="ft-save"
                disabled={!dirty || saving}
                onClick={save}
                title={dirty ? 'Save (⌘S)' : 'Saved'}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        )}
        {mode === 'preview' && previewNode}
        {mode === 'edit' && (
          <div className="ft-editor-pane">{editorNode}</div>
        )}
        {mode === 'split' && (
          <div className="ft-split">
            <div className="ft-editor-pane">{editorNode}</div>
            {previewNode}
          </div>
        )}
      </div>
    </div>
  );
}
