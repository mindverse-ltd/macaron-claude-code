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
  ConfigFileId,
  ConfigFileFormat,
  ConfigFileMeta,
  ConfigFile,
  FileEntry,
  FileListResponse,
  FileReadResponse,
} from '@macaron/shared';

import type {
  WorkspacesResponse,
  WorkspaceDetailResponse,
  SessionDetail,
  HealthResponse,
  ConfigFileId,
  ConfigFileMeta,
  ConfigFile,
  FileListResponse,
  FileReadResponse,
} from '@macaron/shared';
import { authedFetch } from './auth';

export async function getJSON<T>(url: string): Promise<T> {
  const r = await authedFetch(url);
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json() as Promise<T>;
}

export type PublicBuiltinProvider = {
  id: 'system';
  name: string;
  description: string;
  detectedEndpoint: string | null;
};
export type PublicCustomProvider = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  configured: boolean;
};
export type PublicSettings = {
  activeProviderId: string;
  builtins: PublicBuiltinProvider[];
  customProviders: PublicCustomProvider[];
  yoloMode: boolean;
  followupSuggestions: boolean;
};

export type ProviderInput = {
  name: string;
  endpoint: string;
  model: string;
  apiKey?: string;
};

export type McpTransport = 'stdio' | 'http' | 'sse';
export type PublicMcpServer = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
};
export type McpServerInput = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

async function req<T>(url: string, init: RequestInit): Promise<T> {
  const r = await authedFetch(url, init);
  if (!r.ok) throw new Error(`http ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

export const api = {
  health: () => getJSON<HealthResponse>('/api/health'),
  settings: () => getJSON<PublicSettings>('/api/settings'),

  addProvider: (input: ProviderInput) =>
    req<{ id: string; settings: PublicSettings }>('/api/settings/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateProvider: (id: string, patch: Partial<ProviderInput>) =>
    req<PublicSettings>(`/api/settings/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  deleteProvider: (id: string) =>
    req<PublicSettings>(`/api/settings/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  setActiveProvider: (providerId: string) =>
    req<PublicSettings>('/api/settings/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId }),
    }),
  setYoloMode: (enabled: boolean) =>
    req<PublicSettings>('/api/settings/yolo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  setFollowupSuggestions: (enabled: boolean) =>
    req<PublicSettings>('/api/settings/followups', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  mcpServers: () => getJSON<{ servers: PublicMcpServer[] }>('/api/mcp/servers'),
  addMcpServer: (input: McpServerInput) =>
    req<{ servers: PublicMcpServer[] }>('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateMcpServer: (name: string, input: McpServerInput) =>
    req<{ servers: PublicMcpServer[] }>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  deleteMcpServer: (name: string) =>
    req<{ servers: PublicMcpServer[] }>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  configFiles: () => getJSON<{ files: ConfigFileMeta[] }>('/api/config-files'),
  configFile: (id: ConfigFileId) => getJSON<ConfigFile>(`/api/config-files/${id}`),
  saveConfigFile: async (id: ConfigFileId, content: string): Promise<ConfigFile> => {
    const r = await fetch(`/api/config-files/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) {
      // Surface the server's validation message (e.g. "Invalid JSON: …")
      // verbatim so the editor can show it inline.
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `http ${r.status}`);
    }
    return r.json() as Promise<ConfigFile>;
  },
  workspaces: () => getJSON<WorkspacesResponse>('/api/workspaces'),
  workspace: (project: string) =>
    getJSON<WorkspaceDetailResponse>(`/api/workspaces/${encodeURIComponent(project)}`),
  session: (project: string, sid: string) =>
    getJSON<SessionDetail>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}`,
    ),
  deleteSession: async (project: string, sid: string): Promise<void> => {
    const r = await authedFetch(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}`,
      { method: 'DELETE' },
    );
    if (!r.ok) throw new Error(`http ${r.status}`);
  },
  duplicateSession: (project: string, sid: string) =>
    req<{ ok: true; newSid: string }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/duplicate`,
      { method: 'POST' },
    ),
  permissionDecision: (
    id: string,
    decision: 'allow' | 'deny',
    opts?: { scope?: 'once' | 'session' | 'always'; reason?: string },
  ) =>
    req<{ ok: boolean }>('/api/permission-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, decision, scope: opts?.scope, reason: opts?.reason }),
    }),
  stopSession: (project: string, sid: string) =>
    req<{ ok: boolean; running: boolean }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/stop`,
      { method: 'POST' },
    ),
  rewindSession: (project: string, sid: string, uuid: string) =>
    req<{ ok: true; dropped: number; backupPath: string }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/rewind`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid }),
      },
    ),
  forkSession: (project: string, sid: string, uuid: string) =>
    req<{ ok: true; newSid: string; kept: number }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/fork`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid }),
      },
    ),
  compactSession: (project: string, sid: string) =>
    req<{ ok: true; summary: string; backupPath: string; kept: number }>(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/compact`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  listFiles: (project: string, path = '') =>
    getJSON<FileListResponse>(
      `/api/files/${encodeURIComponent(project)}/list?path=${encodeURIComponent(path)}`,
    ),
  readFile: async (project: string, path: string): Promise<FileReadResponse> => {
    const r = await authedFetch(
      `/api/files/${encodeURIComponent(project)}/read?path=${encodeURIComponent(path)}`,
    );
    if (!r.ok) {
      // Surface the server's reason (e.g. "binary file", "file too large") so
      // the editor can show a helpful placeholder instead of "http 415".
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `http ${r.status}`);
    }
    return r.json() as Promise<FileReadResponse>;
  },
  writeFile: (project: string, path: string, content: string) =>
    req<{ ok: true; bytes: number }>(`/api/files/${encodeURIComponent(project)}/write`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }),
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
