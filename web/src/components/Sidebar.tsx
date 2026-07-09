import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, basename, type Workspace, type SessionListItem } from '../lib/api';
import { useToast } from './Toast';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { RateLimitMeters } from './RateLimitMeters';
import {
  getCanvasSids,
  toggleCanvasSid,
  focusCanvasSid,
  subscribeCanvas,
} from '../lib/canvas';
import { subscribeSystemEvents } from '../lib/systemEvents';

type WsData = Workspace & { sessions: SessionListItem[] };

function sessStatus(mtime: number): 'completed' | 'running' {
  return Date.now() - mtime < 60_000 ? 'running' : 'completed';
}

export function Sidebar() {
  const [workspaces, setWorkspaces] = useState<WsData[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'connecting' | 'ok' | 'bad'>('connecting');
  const [model, setModel] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null);
  // Per-workspace set of canvas-pinned sids, so the session rows can show
  // + / ✓ toggles. Re-reads from localStorage whenever a canvas changes.
  const [canvasBy, setCanvasBy] = useState<Record<string, string[]>>({});
  // sid currently in inline-rename mode (its name span becomes an <input>).
  const [renamingSid, setRenamingSid] = useState<string>('');
  const [renameDraft, setRenameDraft] = useState<string>('');
  const renameDoneRef = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const loadData = useCallback(async () => {
    try {
      const d = await api.workspaces();
      const results = await Promise.all(
        d.workspaces.map(async (w) => {
          try {
            const detail = await api.workspace(w.project);
            return { ...w, sessions: detail.sessions } as WsData;
          } catch {
            return { ...w, sessions: [] } as WsData;
          }
        }),
      );
      setWorkspaces(results);
    } catch {}
  }, []);

  useEffect(() => {
    api
      .health()
      .then((j) => {
        setStatus('ok');
        setModel(j.model);
      })
      .catch(() => setStatus('bad'));
    loadData();
    const t = setInterval(loadData, 10_000);
    // Refresh immediately when a claude session changes on disk (e.g. a
    // terminal run) — the interval above stays as a fallback.
    const unsub = subscribeSystemEvents((ev) => {
      if (ev.engine === 'claude') void loadData();
    });
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [loadData]);

  // Track canvas state per workspace. On every workspaces refresh (or
  // canvas mutation) re-read the sids so the +/✓ toggles stay accurate.
  useEffect(() => {
    const refresh = () => {
      const next: Record<string, string[]> = {};
      for (const w of workspaces) next[w.project] = getCanvasSids(w.project);
      setCanvasBy(next);
    };
    refresh();
    const unsubs = workspaces.map((w) => subscribeCanvas(w.project, refresh));
    return () => {
      for (const u of unsubs) u();
    };
  }, [workspaces]);

  // Auto-expand workspace from URL
  useEffect(() => {
    const m = location.pathname.match(/^\/w\/([^/]+)/);
    if (m) {
      const proj = decodeURIComponent(m[1]!);
      setExpanded((s) => {
        if (s.has(proj)) return s;
        const next = new Set(s);
        next.add(proj);
        return next;
      });
    }
  }, [location.pathname]);

  const toggleExpand = (project: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  };

  const activeProject = (() => {
    const m = location.pathname.match(/^\/w\/([^/]+)/);
    return m ? decodeURIComponent(m[1]!) : '';
  })();


  const wsMenu = (w: WsData, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          icon: '＋',
          label: 'New Session',
          onClick: () => navigate(`/w/${encodeURIComponent(w.project)}`),
        },
        {
          icon: '📋',
          label: 'Copy Path',
          onClick: () => {
            navigator.clipboard.writeText(w.cwd || w.project);
            toast('path copied');
          },
        },
        'separator',
        {
          icon: '✕',
          label: 'Delete Workspace',
          danger: true,
          onClick: () => toast('delete not yet implemented'),
        },
      ],
    });
  };

  const startRename = (s: SessionListItem) => {
    renameDoneRef.current = false;
    setRenamingSid(s.sessionId);
    setRenameDraft(s.label || '');
  };

  const commitRename = async (project: string, sid: string) => {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
    const name = renameDraft.trim();
    setRenamingSid('');
    try {
      await api.setSessionLabel(project, sid, name);
      loadData();
    } catch (err) {
      toast(`rename failed: ${(err as Error).message}`);
    }
  };

  const sessMenu = (w: WsData, s: SessionListItem, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          icon: '◎',
          label: 'Focus Session',
          onClick: () =>
            navigate(
              `/w/${encodeURIComponent(w.project)}/s/${encodeURIComponent(s.sessionId)}`,
            ),
        },
        {
          icon: '✎',
          label: 'Rename',
          onClick: () => startRename(s),
        },
        {
          icon: '⊕',
          label: 'Duplicate',
          onClick: async () => {
            try {
              const r = await api.duplicateSession(w.project, s.sessionId);
              toast(`duplicated → ${r.newSid.slice(0, 8)}`);
              loadData();
              navigate(
                `/w/${encodeURIComponent(w.project)}/s/${encodeURIComponent(r.newSid)}`,
              );
            } catch (err) {
              toast(`duplicate failed: ${(err as Error).message}`);
            }
          },
        },
        {
          icon: '🔗',
          label: 'Copy share link',
          onClick: async () => {
            try {
              const { token } = await api.createShare(w.project, s.sessionId);
              // Build the URL from the browser's own origin so it works over
              // LAN/tunnel, not just the server's 127.0.0.1 bind.
              const url = `${window.location.origin}/#/share/${token}`;
              await navigator.clipboard.writeText(url);
              toast('share link copied');
            } catch (err) {
              toast(`share failed: ${(err as Error).message}`);
            }
          },
        },
        {
          icon: '🚫',
          label: 'Unshare',
          onClick: async () => {
            try {
              const { ok } = await api.revokeShare(w.project, s.sessionId);
              toast(ok ? 'share link revoked' : 'was not shared');
            } catch (err) {
              toast(`unshare failed: ${(err as Error).message}`);
            }
          },
        },
        'separator',
        {
          icon: '✕',
          label: 'Delete Session',
          danger: true,
          onClick: async () => {
            try {
              await api.deleteSession(w.project, s.sessionId);
              toast(`deleted ${s.sessionId.slice(0, 8)}`);
              loadData();
            } catch (err) {
              toast(`delete failed: ${(err as Error).message}`);
            }
          },
        },
      ],
    });
  };

  return (
    <aside className="sidebar-v2">
      <Link className="sb-brand" to="/">
        <img className="sb-logo" src="/mindlab-symbol.svg" alt="" />
        <div>
          <div className="sb-brand-name">Macaron</div>
          <div className="sb-brand-sub">Claude Code plugin</div>
        </div>
      </Link>

      <div className="sb-label">
        <span>WORKSPACES</span>
      </div>

      <div className="sb-ws-list">
        {workspaces.map((w) => {
          const name = w.name || basename(w.cwd) || w.project;
          const isExpanded = expanded.has(w.project);
          const isActive = activeProject === w.project;
          const runCount = w.sessions.filter((s) => sessStatus(s.mtime) === 'running').length;

          return (
            <div key={w.project} className={'sb-ws' + (isActive ? ' active' : '')}>
              <div
                className="sb-ws-head"
                onClick={() => {
                  toggleExpand(w.project);
                  navigate(`/w/${encodeURIComponent(w.project)}`);
                }}
                onContextMenu={(e) => wsMenu(w, e)}
              >
                <span className="sb-arrow">{isExpanded ? '▾' : '▸'}</span>
                <span className="sb-ws-name">{name}</span>
                <span className="sb-spacer" />
                {runCount > 0 && !isExpanded && (
                  <span className="sb-badge sb-badge-running">{runCount}</span>
                )}
                <button
                  className="sb-dots"
                  onClick={(e) => wsMenu(w, e)}
                  title="Workspace actions"
                >
                  ···
                </button>
              </div>
              {isExpanded && (
                <div className="sb-ws-sessions">
                  {w.sessions.map((s) => {
                    const st = sessStatus(s.mtime);
                    const pinned = (canvasBy[w.project] || []).includes(s.sessionId);
                    return (
                      <div
                        key={s.sessionId}
                        className={'sb-sess' + (pinned ? ' pinned' : '')}
                        onClick={() => {
                          // First click adds to canvas. Subsequent click on a
                          // pinned row focuses it (and navigates so the URL
                          // matches — canvas view handles the sid).
                          if (!pinned) toggleCanvasSid(w.project, s.sessionId);
                          else focusCanvasSid(w.project, s.sessionId);
                          if (activeProject !== w.project) {
                            navigate(`/w/${encodeURIComponent(w.project)}`);
                          }
                          // Ask the matching tile to scroll into view + focus
                          // its composer. Custom event fires regardless of
                          // whether the focused sid actually changed, so
                          // re-clicking the same row still re-scrolls.
                          window.dispatchEvent(
                            new CustomEvent('macaron:focus-tile', {
                              detail: { project: w.project, sid: s.sessionId },
                            }),
                          );
                        }}
                        onContextMenu={(e) => sessMenu(w, s, e)}
                      >
                        <span className={'sb-sess-dot sb-sess-dot-' + st} />
                        {renamingSid === s.sessionId ? (
                          <input
                            className="sb-sess-rename"
                            value={renameDraft}
                            autoFocus
                            placeholder={s.preview || s.sessionId.slice(0, 8)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={() => commitRename(w.project, s.sessionId)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(w.project, s.sessionId);
                              else if (e.key === 'Escape') {
                                renameDoneRef.current = true;
                                setRenamingSid('');
                              }
                            }}
                          />
                        ) : (
                          <span className="sb-sess-name">
                            {s.label || s.preview || s.sessionId.slice(0, 8)}
                          </span>
                        )}
                        <button
                          type="button"
                          className={'sb-sess-pin' + (pinned ? ' pinned' : '')}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCanvasSid(w.project, s.sessionId);
                            if (activeProject !== w.project) {
                              navigate(`/w/${encodeURIComponent(w.project)}`);
                            }
                          }}
                          title={pinned ? 'Remove from canvas' : 'Add to canvas'}
                          aria-label={pinned ? 'Remove from canvas' : 'Add to canvas'}
                        >
                          {pinned ? '✓' : '+'}
                        </button>
                      </div>
                    );
                  })}
                  {w.sessions.length === 0 && (
                    <div className="sb-sess empty">No sessions</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {workspaces.length === 0 && (
          <div className="sb-empty">No workspaces</div>
        )}
      </div>

      <div className="sb-spacer-grow" />

      <Link className="sb-settings-link" to="/mcp">
        <span>🧩</span>
        <span>MCP servers</span>
      </Link>

      <button
        type="button"
        className="sb-settings-link sb-shortcuts-btn"
        onClick={() => window.dispatchEvent(new CustomEvent('macaron:shortcuts'))}
        title="Keyboard shortcuts"
      >
        <span aria-hidden="true">⌨</span>
        <span>Shortcuts</span>
        <span className="sb-spacer" />
        <kbd className="sb-shortcuts-kbd" aria-hidden="true">?</kbd>
      </button>

      <Link className="sb-settings-link" to="/settings">
        <span>⚙</span>
        <span>Settings</span>
      </Link>

      <footer className="sb-footer">
        <RateLimitMeters />
        <div className={'sb-status sb-status-' + status}>
          {status === 'ok'
            ? `online · ${model}`
            : status === 'bad'
              ? 'offline'
              : 'connecting…'}
        </div>
      </footer>

      {ctxMenu && (
        <ContextMenu
          items={ctxMenu.items}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  );
}
