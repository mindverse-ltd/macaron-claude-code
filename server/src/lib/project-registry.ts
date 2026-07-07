// Bridges a claude project-dir name back to its real cwd.
//
// claude encodes a cwd into a project-dir name by replacing every non-alnum
// char with '-' (verified against ~/.claude/projects: `encodeClaudeProjectName`
// below reproduces every existing dir). That encoding is LOSSY — '/', '_' and
// '.' all collapse to '-' — so a freshly created project dir that has no
// session jsonl yet can't have its cwd recovered by decoding alone.
//
// The "New Project" wizard knows the real cwd at creation time, so it registers
// it here. Persist the bridge so a server restart between creation and the first
// session does not strand a session-less project behind lossy decoding.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECTS_ROOT } from '../config.js';

export function encodeClaudeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const REGISTRY_FILE = path.join(PROJECTS_ROOT, '.macaron-projects.json');
const cwdByProject = new Map<string, string>();
let loaded = false;

async function loadRegistry(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(await fs.readFile(REGISTRY_FILE, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return;
    for (const [project, cwd] of Object.entries(raw)) {
      if (typeof project === 'string' && typeof cwd === 'string') cwdByProject.set(project, cwd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Corrupt registry should not block existing session-backed projects.
    }
  }
}

async function persistRegistry(): Promise<void> {
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
  const data = Object.fromEntries(cwdByProject);
  const tmp = `${REGISTRY_FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, REGISTRY_FILE);
}

export async function registerProjectCwd(cwd: string): Promise<string> {
  await loadRegistry();
  const project = encodeClaudeProjectName(cwd);
  cwdByProject.set(project, cwd);
  await persistRegistry();
  return project;
}

export async function lookupProjectCwd(project: string): Promise<string | undefined> {
  await loadRegistry();
  return cwdByProject.get(project);
}
