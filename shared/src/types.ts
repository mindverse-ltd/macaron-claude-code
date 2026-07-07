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

export type WorkspacesResponse = { workspaces: Workspace[] };
export type WorkspaceDetailResponse = { workspace: Workspace; sessions: SessionListItem[] };
export type HealthResponse = { ok: boolean; model: string };
export type ConfigResponse = {
  macaron: { base: string; model: string; configured: boolean };
};

// ---- Hooks viewer ------------------------------------------------------
// Read-only projection of the `hooks` block in a settings.json, flattened
// from Claude Code's three-level nesting (event → matcher group → handlers)
// into one row per handler so the WebUI can render a plain table. See
// https://code.claude.com/docs/en/hooks for the source schema.

// Which settings.json a hook came from. Scope decides precedence and lets
// the UI tag each row with where to edit it.
export type HookScope = 'user' | 'project' | 'local';

export type HookHandlerView = {
  // Event that triggers the hook, e.g. 'PreToolUse', 'PostToolUse', 'Stop'.
  event: string;
  // Matcher that narrows when it fires (tool name / glob). '' or '*' means
  // "every occurrence of the event".
  matcher: string;
  scope: HookScope;
  // Absolute path of the settings.json this handler was read from.
  source: string;
  // Handler kind: 'command' | 'http' | 'prompt' | 'agent' | future kinds.
  type: string;
  // The command line (command hooks), URL (http hooks), or a short label for
  // other kinds — whatever best identifies what runs.
  run: string;
  // Optional `if` sub-command filter that gates a single handler.
  condition?: string;
};

export type HooksResponse = {
  handlers: HookHandlerView[];
  // Which scopes were actually found on disk, so the UI can explain an empty
  // result ("no project settings.json") instead of just showing nothing.
  sources: Array<{ scope: HookScope; path: string; present: boolean; error?: string }>;
};
