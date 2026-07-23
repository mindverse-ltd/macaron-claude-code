// In-memory registry of the AbortController for each in-flight SDK stream,
// keyed by sessionId. The /stop route looks up the controller and fires
// `.abort()`, which the SDK subprocess honours by killing the child and
// throwing on the async iterator — the surrounding SSE handler then closes.

const runs = new Map<string, AbortController>();

export function registerRun(sid: string, ac: AbortController): void {
  runs.set(sid, ac);
}

export function claimRun(sid: string, ac: AbortController): boolean {
  if (runs.has(sid)) return false;
  runs.set(sid, ac);
  return true;
}

export function abortRun(sid: string): boolean {
  const ac = runs.get(sid);
  if (!ac || ac.signal.aborted) return false;
  ac.abort();
  return true;
}

// Only the owner may release a claim. Aborting deliberately keeps the claim
// until this cleanup runs, preventing stop/reclaim/stale-cleanup ABA races.
export function endRun(sid: string, ac: AbortController): boolean {
  if (runs.get(sid) !== ac) return false;
  return runs.delete(sid);
}

// Idle-gate for the autonomous loop: true while a turn (user or loop) is in
// flight for this sid, so the loop driver only fires when the session is free.
export function isRunActive(sid: string): boolean {
  return runs.has(sid);
}
