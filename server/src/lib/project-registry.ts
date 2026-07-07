// Bridges a claude project-dir name back to its real cwd.
//
// claude encodes a cwd into a project-dir name by replacing every non-alnum
// char with '-' (verified against ~/.claude/projects: `encodeClaudeProjectName`
// below reproduces every existing dir). That encoding is LOSSY — '/', '_' and
// '.' all collapse to '-' — so a freshly created project dir that has no
// session jsonl yet can't have its cwd recovered by decoding alone.
//
// The "New Project" wizard knows the real cwd at creation time, so it registers
// it here. The session-start route consults this map before falling back to the
// lossy decode, so the very first session lands in the right directory.

export function encodeClaudeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const cwdByProject = new Map<string, string>();

export function registerProjectCwd(cwd: string): string {
  const project = encodeClaudeProjectName(cwd);
  cwdByProject.set(project, cwd);
  return project;
}

export function lookupProjectCwd(project: string): string | undefined {
  return cwdByProject.get(project);
}
