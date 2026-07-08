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

// A custom subagent definition (~/.claude/agents/<name>.md). `prompt` is the
// markdown body after the frontmatter — it becomes the agent's system prompt.
// `tools` is the frontmatter allowlist; empty = inherit all tools.
export type AgentFile = {
  name: string;
  description: string;
  tools: string[];
  model: string;
  prompt: string;
  // Frontmatter keys the UI doesn't model (e.g. permissionMode), preserved
  // verbatim across an edit so a UI save never silently drops them.
  extra?: Record<string, string>;
};

export type AgentsResponse = { agents: AgentFile[] };

// One subagent (child session) spawned from a parent transcript. The parent's
// assistant `tool_use` block whose `name === 'Agent'` carries the same
// `toolUseId`; the child's own transcript lives in a sibling
// `<sid>/subagents/agent-<agentId>.jsonl` file.
export type SubagentInfo = {
  agentId: string;
  agentType: string;
  description: string;
  toolUseId: string;
};

export type SubagentsResponse = { subagents: SubagentInfo[] };

