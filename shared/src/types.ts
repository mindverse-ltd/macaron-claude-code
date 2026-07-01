// Domain types shared by both the Fastify server and the Vite/React webui.

export type Workspace = {
  cwd: string;
  project: string;
  name: string;
  sessionCount: number;
  lastActivity: number;
  lastSessionId: string;
  lastPreview: string;
};

export type SessionListItem = {
  kind: 'claude';
  project: string;
  cwd: string;
  gitBranch?: string;
  sessionId: string;
  preview: string;
  messageCount: number;
  messageCountSuffix?: string;
  mtime: number;
  size?: number;
  resumeCommand: string;
};

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId?: string; text: string };

export type Message = {
  role: 'user' | 'assistant';
  blocks: Block[];
  model?: string;
  timestamp?: string;
  uuid?: string;
};

export type SessionDetail = {
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch?: string;
  messages: Message[];
  truncated?: boolean;
  totalBytes?: number;
};

export type WorkspacesResponse = { workspaces: Workspace[] };
export type WorkspaceDetailResponse = { workspace: Workspace; sessions: SessionListItem[] };
export type HealthResponse = { ok: boolean; model: string };
export type ConfigResponse = {
  macaron: { base: string; model: string; configured: boolean };
};
