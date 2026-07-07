// Pending permission decisions keyed by request id. When the SDK's
// canUseTool callback fires, the runner records a resolver here and yields
// a `permission_request` event. The client posts back to
// `/permission-decision`, which invokes the resolver so canUseTool returns
// and the SDK proceeds.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export type PermissionDecision =
  // `mode` (allow only) switches the session's permission mode as the tool is
  // approved — used by the plan-approval panel to exit plan mode into
  // acceptEdits ("auto-accept") or default ("manually approve each edit").
  | { decision: 'allow'; mode?: PermissionMode }
  | { decision: 'deny'; reason?: string };

const pending = new Map<string, (d: PermissionDecision) => void>();

export function registerPending(id: string, resolve: (d: PermissionDecision) => void): void {
  pending.set(id, resolve);
}

export function resolvePending(id: string, decision: PermissionDecision): boolean {
  const r = pending.get(id);
  if (!r) return false;
  r(decision);
  pending.delete(id);
  return true;
}

export function forgetPending(id: string): void {
  pending.delete(id);
}
