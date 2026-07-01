// Re-export shared types so existing imports keep working unchanged.
export type {
  Workspace,
  SessionListItem,
  Block,
  Message,
  SessionDetail,
  WorkspacesResponse,
  WorkspaceDetailResponse,
  HealthResponse,
  ConfigResponse,
} from '@macaron/shared';

import type {
  WorkspacesResponse,
  WorkspaceDetailResponse,
  SessionDetail,
  HealthResponse,
  ConfigResponse,
} from '@macaron/shared';

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  health: () => getJSON<HealthResponse>('/api/health'),
  config: () => getJSON<ConfigResponse>('/api/config'),
  workspaces: () => getJSON<WorkspacesResponse>('/api/workspaces'),
  workspace: (project: string) =>
    getJSON<WorkspaceDetailResponse>(`/api/workspaces/${encodeURIComponent(project)}`),
  session: (project: string, sid: string) =>
    getJSON<SessionDetail>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}`,
    ),
  deleteSession: async (project: string, sid: string): Promise<void> => {
    const r = await fetch(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}`,
      { method: 'DELETE' },
    );
    if (!r.ok) throw new Error(`http ${r.status}`);
  },
};

export function basename(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function fmtAgo(ms: number): string {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}
