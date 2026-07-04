// In-memory registry of the AbortController for each in-flight SDK stream,
// keyed by sessionId. The /stop route looks up the controller and fires
// `.abort()`, which the SDK subprocess honours by killing the child and
// throwing on the async iterator — the surrounding SSE handler then closes.

const runs = new Map<string, AbortController>();

export function registerRun(sid: string, ac: AbortController): void {
  runs.set(sid, ac);
}

export function abortRun(sid: string): boolean {
  const ac = runs.get(sid);
  if (!ac) return false;
  ac.abort();
  runs.delete(sid);
  return true;
}

export function endRun(sid: string): void {
  runs.delete(sid);
}
