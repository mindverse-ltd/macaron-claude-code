// Codex WebUI ↔ server API. Namespaced under /api/codex/*.

import type {
  SessionListItem,
  SessionDetail,
  Workspace,
} from '@macaron/shared';

export type CodexThread = SessionListItem;
export type CodexWorkspace = Workspace;

export type PublicCodexProvider = {
  name: string;
  baseUrl: string;
  model: string;
  wireApi: 'responses' | 'chat';
  modelProvider: string;
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  webSearchEnabled: boolean;
  contextWindow: number;
  autoCompactTokenLimit: number;
  disableResponseStorage: boolean;
  configured: boolean;
};

export type PublicCodexSettings = { provider: PublicCodexProvider };

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json() as Promise<T>;
}

async function reqJSON<T>(url: string, init: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`http ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

export const codexApi = {
  threads: () => getJSON<{ threads: CodexThread[] }>('/api/codex/threads'),
  workspaces: () => getJSON<{ workspaces: CodexWorkspace[] }>('/api/codex/workspaces'),
  workspace: (project: string) =>
    getJSON<{ workspace: CodexWorkspace; sessions: CodexThread[] }>(
      `/api/codex/workspaces/${encodeURIComponent(project)}`,
    ),
  thread: (sid: string) => getJSON<SessionDetail>(`/api/codex/threads/${encodeURIComponent(sid)}`),
  deleteThread: async (sid: string): Promise<void> => {
    const r = await fetch(`/api/codex/threads/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`http ${r.status}`);
  },
  stopThread: (sid: string) =>
    reqJSON<{ ok: boolean; running: boolean }>(
      `/api/codex/threads/${encodeURIComponent(sid)}/stop`,
      { method: 'POST' },
    ),
  config: () => getJSON<PublicCodexSettings>('/api/codex/config'),
  saveConfig: (patch: Partial<PublicCodexProvider> & { apiKey?: string }) =>
    reqJSON<PublicCodexSettings>('/api/codex/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  engine: () => getJSON<{ engine: 'claude' | 'codex' }>('/api/engine'),
};
