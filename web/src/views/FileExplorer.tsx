import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import CodeMirror, { type Extension } from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { api, type FileEntry } from '../lib/api';
import { useToast } from '../components/Toast';

// Pick a CodeMirror language by file extension; unknown types get plain text.
function langFor(name: string): Extension[] {
  const ext = name.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs': return [javascript({ jsx: true })];
    case 'ts': case 'tsx': return [javascript({ jsx: true, typescript: true })];
    case 'py': return [python()];
    case 'html': case 'htm': case 'vue': case 'svelte': return [html()];
    case 'css': case 'scss': case 'less': return [cssLang()];
    case 'json': return [json()];
    case 'md': case 'markdown': return [markdown()];
    default: return [];
  }
}

// One node in the lazy file tree. Directories fetch their children the first
// time they're expanded; files just report clicks up to the editor pane.
function TreeNode({
  entry,
  project,
  depth,
  selectedPath,
  onSelect,
}: {
  entry: FileEntry;
  project: string;
  depth: number;
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const toggle = useCallback(() => {
    if (entry.type === 'file') return onSelect(entry.path);
    const next = !open;
    setOpen(next);
    if (next && children === null && !loading) {
      setLoading(true);
      api
        .listFiles(project, entry.path)
        .then((d) => setChildren(d.entries))
        .catch((e) => setError((e as Error).message))
        .finally(() => setLoading(false));
    }
  }, [entry, open, children, loading, project, onSelect]);

  const isDir = entry.type === 'dir';
  const selected = selectedPath === entry.path;
  return (
    <div className="fx-node">
      <button
        className={`fx-row${selected ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
        title={entry.path}
      >
        <span className="fx-caret">{isDir ? (open ? '▾' : '▸') : ''}</span>
        <span className="fx-icon">{isDir ? '📁' : '📄'}</span>
        <span className="fx-name">{entry.name}</span>
      </button>
      {isDir && open && (
        <div className="fx-children">
          {loading && <div className="fx-hint" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>Loading…</div>}
          {error && <div className="fx-hint error" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>{error}</div>}
          {children?.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              project={project}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
          {children && children.length === 0 && (
            <div className="fx-hint" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>empty</div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer() {
  const { project = '' } = useParams();
  const toast = useToast();
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [rootError, setRootError] = useState('');

  const [openPath, setOpenPath] = useState('');
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [openError, setOpenError] = useState(''); // binary / too-large / read fail
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty = openPath !== '' && !openError && content !== original;

  useEffect(() => {
    api
      .listFiles(project, '')
      .then((d) => setRoots(d.entries))
      .catch((e) => setRootError((e as Error).message));
  }, [project]);

  const openFile = useCallback(
    (path: string) => {
      if (path === openPath) return;
      if (dirty && !window.confirm('Discard unsaved changes?')) return;
      setOpenPath(path);
      setLoadingFile(true);
      setOpenError('');
      api
        .readFile(project, path)
        .then((d) => {
          setContent(d.content);
          setOriginal(d.content);
        })
        .catch((e) => {
          setContent('');
          setOriginal('');
          setOpenError((e as Error).message);
        })
        .finally(() => setLoadingFile(false));
    },
    [project, openPath, dirty],
  );

  const save = useCallback(() => {
    if (!openPath || openError || saving) return;
    setSaving(true);
    api
      .writeFile(project, openPath, content)
      .then(() => {
        setOriginal(content);
        toast('Saved');
      })
      .catch((e) => toast(`Save failed: ${(e as Error).message}`))
      .finally(() => setSaving(false));
  }, [openPath, openError, saving, project, content, toast]);

  // Cmd/Ctrl+S saves the open file. Bound to window so it fires regardless of
  // where focus sits (tree, editor, or the Save button).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section className="fx">
      <header className="fx-head">
        <Link className="ghost small" to={`/w/${encodeURIComponent(project)}`}>
          ← Workspace
        </Link>
        <span className="fx-path">{openPath || 'Files'}</span>
        {dirty && <span className="fx-dirty" title="Unsaved changes">●</span>}
        <div className="fx-head-actions">
          <button className="ghost small" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>
      <div className="fx-body">
        <aside className="fx-tree">
          {rootError && <div className="fx-hint error">{rootError}</div>}
          {!roots && !rootError && <div className="fx-hint">Loading…</div>}
          {roots?.map((e) => (
            <TreeNode
              key={e.path}
              entry={e}
              project={project}
              depth={0}
              selectedPath={openPath}
              onSelect={openFile}
            />
          ))}
        </aside>
        <div className="fx-editor">
          {!openPath && <div className="fx-placeholder">Select a file to view or edit.</div>}
          {openPath && loadingFile && <div className="fx-placeholder">Loading…</div>}
          {openPath && !loadingFile && openError && (
            <div className="fx-placeholder">Can’t open this file: {openError}</div>
          )}
          {openPath && !loadingFile && !openError && (
            <CodeMirror
              value={content}
              onChange={setContent}
              extensions={langFor(openPath)}
              theme={oneDark}
              height="100%"
              style={{ height: '100%' }}
              basicSetup={{ lineNumbers: true, highlightActiveLine: true }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
