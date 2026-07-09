// In-memory registry of the AbortController for each in-flight SDK stream,
// keyed by sessionId. The /stop route looks up the controller and fires
// `.abort()`, which the SDK subprocess honours by killing the child and
// throwing on the async iterator — the surrounding SSE handler then closes.
const runs = new Map();
export function registerRun(sid, ac) {
    runs.set(sid, ac);
}
export function abortRun(sid) {
    const ac = runs.get(sid);
    if (!ac)
        return false;
    ac.abort();
    runs.delete(sid);
    return true;
}
export function endRun(sid) {
    runs.delete(sid);
}
// Idle-gate for the autonomous loop: true while a turn (user or loop) is in
// flight for this sid, so the loop driver only fires when the session is free.
export function isRunActive(sid) {
    return runs.has(sid);
}
//# sourceMappingURL=active-runs.js.map