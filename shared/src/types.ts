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
  // User-assigned human label, stored in a macaron sidecar (not in the
  // Claude-owned jsonl). Takes display precedence over `preview` when set.
  label?: string;
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
  | { kind: 'tool_result'; toolUseId?: string; text: string; isError?: boolean }
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

// A transcript-search match — one message whose text contains the query.
// The palette deep-links into the session via project+sessionId, and uses
// `uuid` to scroll to the exact message when the session view is mounted.
export type MessageSearchHit = {
  project: string;
  sessionId: string;
  uuid?: string;
  role: 'user' | 'assistant';
  snippet: string;
  preview: string;
  mtime: number;
};

export type DirEntry = { name: string; path: string };
export type DirListing = { path: string; parent: string | null; home: string; entries: DirEntry[] };
// Web Push. `subscription` is the browser PushSubscription.toJSON() shape sent
// to /api/push/subscribe and stored server-side; `notify` is the JSON payload
// the server ships to the SW's `push` handler (see web/public/sw.js).
export type PushSubscriptionPayload = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
export type PushNotifyPayload = {
  title: string;
  body?: string;
  tag?: string;
  requireInteraction?: boolean;
  // Hash-route the SW opens/focuses on click, e.g. `#/w/:project/s/:sid`.
  url?: string;
};

// A per-session git worktree: the session's agent runs with cwd pointing at
// `worktreePath` (a dedicated branch off `baseBranch`), so parallel sessions
// in one repo never stomp each other's uncommitted changes. `exists` reflects
// whether the worktree dir is still on disk (users can delete it manually);
// `dirty` is set from `git status --porcelain` when the tree is present.
export type WorktreeInfo = {
  sessionId: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  status: 'active' | 'merged' | 'discarded';
  exists: boolean;
  dirty?: boolean;
};

// Rate-limit / usage state for the active Claude subscription, read from the
// ambient OAuth login (~/.claude/.credentials.json) via the oauth/usage
// endpoint. `utilization` is 0-100; `resetsAt` is an ISO timestamp (null when
// the window is empty). Only the 5-hour and weekly windows are surfaced — the
// two the always-visible meters need.
export type RateLimitWindow = { utilization: number; resetsAt: string | null };

// `available` is false when there's no ambient OAuth login to read (e.g. the
// user runs on a custom provider), so the client can hide the widget without
// treating it as an error.
export type UsageResponse = {
  available: boolean;
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
};

// A saved cron/one-time prompt. The scheduler fires it by spawning a fresh
// session (runClaude/runCodex, no resume) at `nextRunAt`, exactly as the
// "+ New Session" POST does — just with no client attached.
export type Schedule = {
  id: string;
  name: string;
  prompt: string;
  engine: SessionKind;
  cwd: string;
  // 5-field cron string (recurring) OR an ISO-8601 local datetime (one-time).
  // croner parses both; `oneShot` only records which input mode the user chose
  // (for the UI badge + create-time validation) — after a one-shot fires,
  // its nextRun() is naturally null, so the same fire path ends it.
  pattern: string;
  oneShot: boolean;
  status: 'active' | 'paused' | 'done';
  nextRunAt: number | null; // unix ms; null when paused/done or unschedulable
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastSessionId: string | null; // sid of the most recent fired session
  createdAt: number;
  updatedAt: number;
};

export type ScheduleInput = {
  name: string;
  prompt: string;
  engine: SessionKind;
  cwd: string;
  pattern: string;
  oneShot: boolean;
};

// A slash command surfaced in the composer palette. `name` is the bare
// command (no leading slash). `builtin` = a CLI command worth listing;
// `project`/`user` come from `.claude/commands/**/*.md` (cwd / $HOME). A
// subdirectory becomes `namespace` for display only — it does NOT change the
// command name the SDK expands.
export type SlashCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  source: 'builtin' | 'project' | 'user';
  namespace?: string;
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
export type MessageSearchResponse = { hits: MessageSearchHit[] };
export type WorkspaceDetailResponse = { workspace: Workspace; sessions: SessionListItem[] };
export type SchedulesResponse = { schedules: Schedule[] };
export type HealthResponse = { ok: boolean; model: string };
export type AuthStatusResponse = { required: boolean };

// Share links: a session is published behind an unguessable token. The token
// is the capability — possession grants read access, no login. The token URL
// never leaks the on-disk project/sid, but resolving it returns the full
// SessionDetail (sid, project, absolute cwd) to whoever holds the link.
export type CreateShareResponse = { token: string };
export type SharedSessionResponse = { sessionId: string; createdAt: number; detail: SessionDetail };
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
export type CommandsResponse = { commands: SlashCommand[] };
