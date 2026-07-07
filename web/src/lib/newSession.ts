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

const pending = new Map<string, string>(); // encoded project -> chosen abs cwd

export function setPendingCwd(project: string, cwd: string): void {
  pending.set(project, cwd);
}

export function peekPendingCwd(project: string): string | undefined {
  return pending.get(project);
}

export function takePendingCwd(project: string): string | undefined {
  const v = pending.get(project);
  pending.delete(project);
  return v;
}
