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

// Cost & usage analytics. Rolled up from the same `message.usage` fields
// session-store already reads, priced by the server's model rate table.
// Token counts are summed across every assistant message in the window;
// costUsd is the sum of per-message cost (input/output/cache-write/cache-read
// each at their own rate). `known` on a per-model row is false when the model
// string didn't match the rate table and a default estimate was used.
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  messageCount: number;
  sessionCount: number;
};
export type UsageDaily = { date: string } & Omit<UsageTotals, 'sessionCount'>;
export type UsageByModel = { model: string; known: boolean } & Omit<UsageTotals, 'sessionCount'>;
export type UsageBySession = {
  project: string;
  sessionId: string;
  preview: string;
  model: string;
  lastActivity: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messageCount: number;
};
export type UsageResponse = {
  window: string;
  since: number;
  until: number;
  totals: UsageTotals;
  daily: UsageDaily[];
  byModel: UsageByModel[];
  bySession: UsageBySession[];
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
