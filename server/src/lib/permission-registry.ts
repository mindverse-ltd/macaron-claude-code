// Pending permission decisions keyed by request id. When the SDK's
// canUseTool callback fires, the runner records a resolver here and yields
// a `permission_request` event. The client posts back to
// `/permission-decision`, which invokes the resolver so canUseTool returns
// and the SDK proceeds.

// scope on an `allow`: 'once' (default) runs the tool this one time; 'session'
// remembers it for the rest of this server session; 'always' persists it for
// this project cwd. The runner's canUseTool acts on scope after resolving.
export type PermissionDecision =
  | { decision: 'allow'; scope?: 'once' | 'session' | 'always' }
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
