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

// Which agent engine produced this session. `claude` = claude-agent-sdk
// jsonl under ~/.claude/projects. `codex` = @openai/codex-sdk rollout files
// under ~/.codex/sessions. Both are grouped by cwd into the same
// Workspace list; the tile UI dispatches to the appropriate backend
// route based on this discriminator.
export type SessionKind = 'claude' | 'codex';

export type SessionListItem = {
  kind: SessionKind;
  project: string;
  cwd: string;
  gitBranch?: string;
  sessionId: string;
  preview: string;
  // Generated human-readable label. Codex-only for now (see codex-title.ts);
  // the sidebar prefers it over `preview` when present.
  title?: string;
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
  | { kind: 'tool_result'; toolUseId?: string; text: string }
  // Base64-encoded image attached to a user message. Preserved in jsonl by
  // the CLI; the WebUI renders it inline where it appears in the block order,
  // so pastes/attachments interleaved with text stay in position.
  | { kind: 'image'; mimeType: string; data: string }
  // Emitted by the server when it recognises a CLI-generated meta entry such
  // as a `summary` line (post-`/compact` recap) or a "Continue from…" resume
  // marker. Rendered as a dim `※` line by the WebUI, matching CLI.
  | { kind: 'system_event'; eventType: 'summary' | 'compact' | 'resume' | 'meta'; text: string };

export type Message = {
  role: 'user' | 'assistant' | 'system';
  blocks: Block[];
  model?: string;
  timestamp?: string;
  uuid?: string;
};

// Token usage snapshot taken from the last assistant message's `usage`
// field in the jsonl. Cache tokens count toward the context window too, so
// the WebUI sums them for its Context bar.
export type UsageSnapshot = {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  model?: string;
};

export type SessionDetail = {
  kind: SessionKind;
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch?: string;
  messages: Message[];
  truncated?: boolean;
  totalBytes?: number;
  latestUsage?: UsageSnapshot;
  // Environment counters for the status bar. Both are best-effort: MCPs
  // read from ~/.claude/settings.json; CLAUDE.md walks known locations.
  claudeMdCount?: number;
  mcpCount?: number;
};

// ---- File explorer -------------------------------------------------------
// A single entry in a directory listing. `path` is relative to the project
// cwd (root = ''), so the web tree can request children without knowing the
// absolute path (the server re-resolves + confines it).
export type FileEntry = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  mtime?: number;
};

export type FileListResponse = { root: string; path: string; entries: FileEntry[] };
export type FileReadResponse = { path: string; content: string; size: number };

export type WorkspacesResponse = { workspaces: Workspace[] };
export type WorkspaceDetailResponse = { workspace: Workspace; sessions: SessionListItem[] };
export type HealthResponse = { ok: boolean; model: string };
export type AuthStatusResponse = { required: boolean };
export type ConfigResponse = {
  macaron: { base: string; model: string; configured: boolean };
};

// Browser-editable Claude Code config files (user scope, under ~/.claude).
// `settings` is JSON (schema-guarded on write); `memory` is the free-form
// CLAUDE.md markdown. `format` tells the editor which validation to apply.
export type ConfigFileId = 'user-settings' | 'user-memory';
export type ConfigFileFormat = 'json' | 'markdown';

export type ConfigFileMeta = {
  id: ConfigFileId;
  label: string;
  path: string;
  format: ConfigFileFormat;
  exists: boolean;
};

// Full content of one file. `content` is '' when the file doesn't exist yet —
// saving then creates it.
export type ConfigFile = ConfigFileMeta & { content: string };

export type ConfigFilesResponse = { files: ConfigFileMeta[] };
