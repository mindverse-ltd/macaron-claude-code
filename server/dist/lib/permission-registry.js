// Pending permission decisions keyed by request id. When the SDK's
// canUseTool callback fires, the runner records a resolver here and yields
// a `permission_request` event. The client posts back to
// `/permission-decision`, which invokes the resolver so canUseTool returns
// and the SDK proceeds.
const pending = new Map();
export function registerPending(id, resolve) {
    pending.set(id, resolve);
}
export function resolvePending(id, decision) {
    const r = pending.get(id);
    if (!r)
        return false;
    r(decision);
    pending.delete(id);
    return true;
}
export function forgetPending(id) {
    pending.delete(id);
}
//# sourceMappingURL=permission-registry.js.map