// Carries the directory picked in the Sidebar to the point where the first
// message actually creates the session (Session.tsx's isNew send path). These
// live in different components across a route change, so a module-level map —
// same idiom as liveStore/canvas — is the simplest hand-off.

// claude-cli encodes a cwd to its ~/.claude/projects dir name by replacing
// every non-alphanumeric char with '-'. We mirror it so a freshly picked
// folder maps to the same project key the SDK will file the jsonl under.
export function encodeClaudeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const PENDING_TTL_MS = 10 * 60_000;
const pending = new Map<string, { cwd: string; expiresAt: number }>(); // encoded project -> chosen abs cwd

export function setPendingCwd(project: string, cwd: string): void {
  pending.set(project, { cwd, expiresAt: Date.now() + PENDING_TTL_MS });
}

export function peekPendingCwd(project: string): string | undefined {
  const v = pending.get(project);
  if (!v) return undefined;
  if (v.expiresAt > Date.now()) return v.cwd;
  pending.delete(project);
  return undefined;
}

export function takePendingCwd(project: string): string | undefined {
  const v = peekPendingCwd(project);
  pending.delete(project);
  return v;
}
