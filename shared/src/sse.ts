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
