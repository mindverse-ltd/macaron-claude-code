// Pending permission decisions keyed by request id. When the SDK's
// canUseTool callback fires, the runner records a resolver here and yields
// a `permission_request` event. The client posts back to
// `/permission-decision`, which invokes the resolver so canUseTool returns
// and the SDK proceeds.

export type PermissionDecision =
  | { decision: 'allow' }
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
