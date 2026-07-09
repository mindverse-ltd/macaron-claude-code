// SSE protocol shared by the Fastify server (publisher) and the React client
// (consumer). All events flowing through /api/workspaces/.../sessions (POST),
// /api/sessions/.../message (POST) and /api/sessions/.../live (GET) match one
// of these shapes.

export type SessionStreamEvent =
  | { type: 'meta'; cwd: string; sessionId: string }
  | { type: 'starting'; cwd: string }
  | { type: 'user-text'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_input_delta'; id: string; name: string; partial_json: string; accumulated: string }
  | { type: 'tool_input_done'; id: string; name: string; final_json: string }
  | { type: 'tool_result'; tool_use_id: string; text: string; isError: boolean }
  | { type: 'permission_request'; id: string; toolName: string; input: unknown; suggestion?: { label: string } }
  | { type: 'permission_resolved'; id: string; decision: 'allow' | 'deny' }
  | { type: 'usage'; outputTokens: number; thinkingTokens?: number }
  | { type: 'event'; event: string; subtype: string | null }
  | { type: 'log'; text: string }
  | { type: 'warn'; text: string }
  | { type: 'error'; error: string }
  | { type: 'done'; exitCode: number; error?: string }
  | { type: 'followup_delta'; text: string }
  | { type: 'live-end'; reason?: string };

// System-wide event stream (GET /api/events). The server watches the claude
// and codex jsonl trees and pushes a debounced nudge whenever a transcript
// file changes on disk — including sessions started outside the WebUI in a
// terminal. Clients refetch their workspace list on receipt, so external
// sessions surface live instead of on the next slow poll.
export type SystemEvent = { type: 'sessions-changed'; engine: 'claude' | 'codex' };
// PTY terminal protocol, streamed over /api/terminal/.../stream (SSE).
// `history` is the FULL scrollback snapshot (client applies reset+write, so
// replay on (re)connect is idempotent); `output` is an incremental chunk.
// Client→server input/resize go over sibling POST routes, not this stream.
export type TerminalStreamEvent =
  | { type: 'history'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; error: string };
