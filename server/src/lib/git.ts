// Thin wrapper around the `git` CLI for the WebUI git panel. Every call is
// execFile (argv array, shell:false) so file names / branch names / commit
// messages can never be shell-interpreted — no injection surface. All commands
// run in a workspace cwd resolved from the claude project name.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitFileStatus, GitStatus, GitBranches } from '@macaron/shared';
import { CLAUDE_PROJECTS } from '../config.js';
import { decodeClaudeProjectName, readSessionSummary } from './session-store.js';

const pExecFile = promisify(execFile);

// Same cwd derivation the /api/workspaces POST uses: decode the project name
// (claude-cli encodes the cwd into it), then prefer the real cwd embedded in
// any session's jsonl head if one exists.
export async function resolveProjectCwd(project: string): Promise<string> {
  let cwd = decodeClaudeProjectName(project);
  try {
    const projDir = path.join(CLAUDE_PROJECTS, project);
    const files = await fs.readdir(projDir);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const meta = await readSessionSummary(path.join(projDir, f));
      if (meta?.cwd) {
        cwd = meta.cwd;
        break;
      }
    }
  } catch {
    /* no sessions yet — fall back to decoded name */
  }
  return cwd;
}

export class GitError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
  }
}

// Run `git <args>` in cwd. Rejects with GitError carrying stderr on nonzero
// exit. `okExitCodes` lets callers accept git's "difference found" exit 1
// (used by `diff --no-index`, which exits 1 whenever it prints a diff).
async function git(
  cwd: string,
  args: string[],
  okExitCodes: number[] = [0],
): Promise<string> {
  try {
    const { stdout } = await pExecFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    if (typeof err.code === 'number' && okExitCodes.includes(err.code)) {
      // git overloads exit 1: `diff --no-index` uses it for "printed a diff"
      // (stdout set), but also for access errors (empty stdout, real stderr) —
      // only accept the former; let the latter fall through to a real error.
      const out = err.stdout || '';
      if (out || !(err.stderr || '').trim()) return out;
    }
    // Some git failures (e.g. an empty commit) report the reason on stdout with
    // an empty stderr, so fall back to stdout before the generic message.
    throw new GitError((err.stderr || err.stdout || err.message || 'git failed').trim(), err.code ?? null);
  }
}

// Everything git reports (porcelain paths) and everything we feed back
// (pathspecs) is repo-root-relative, so worktree/index commands must run from
// the repo root — the project cwd may be a subdirectory of the repo, in which
// case the paths won't match when run there.
async function gitRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

// Guard a caller-supplied relative path stays inside cwd. Git pathspecs are
// already repo-confined, but `diff --no-index` takes a raw filesystem path, so
// we reject anything that escapes the workspace.
function safeRelPath(cwd: string, rel: string): string {
  const abs = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new GitError(`path escapes workspace: ${rel}`, null);
  }
  return abs;
}

// Parse `git status --porcelain=v1 -z`. NUL-separated records; a rename record
// (R/C) is followed by a second NUL-terminated field carrying the old path.
function parseStatus(z: string): GitFileStatus[] {
  const parts = z.split('\0');
  const files: GitFileStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const x = rec[0]!;
    const y = rec[1]!;
    const rest = rec.slice(3);
    let renamedFrom: string | undefined;
    let filePath = rest;
    if (x === 'R' || x === 'C') {
      // Rename/copy: the old path is the NEXT NUL-separated field.
      renamedFrom = parts[++i] || undefined;
    }
    const untracked = x === '?' && y === '?';
    files.push({
      path: filePath,
      x,
      y,
      staged: !untracked && x !== ' ',
      unstaged: y !== ' ' && y !== '?',
      untracked,
      renamedFrom,
    });
  }
  return files;
}

export async function status(cwd: string): Promise<GitStatus> {
  // Cheap repo probe first — a non-repo cwd should render as an empty panel,
  // not a 500.
  let root = '';
  try {
    root = await gitRoot(cwd);
  } catch {
    return { isRepo: false, branch: '', detached: false, hasCommits: false, ahead: 0, behind: 0, files: [] };
  }

  const hasCommits = await git(cwd, ['rev-parse', '--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false);

  // `symbolic-ref` yields the branch name whenever HEAD is on one — including an
  // unborn branch (fresh `git init`, no commit yet), where `rev-parse --abbrev-ref
  // HEAD` errors and its 'HEAD' fallback would make a normal repo look detached.
  // It fails only when HEAD is genuinely detached, so an empty result is the signal.
  const onBranch = (await git(cwd, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
  const detached = !onBranch;
  let branch = onBranch;
  if (detached) branch = hasCommits ? (await git(cwd, ['rev-parse', '--short', 'HEAD']).catch(() => 'HEAD')).trim() : 'HEAD';

  let ahead = 0;
  let behind = 0;
  let upstream: string | undefined;
  if (hasCommits && !detached) {
    upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim() || undefined;
    if (upstream) {
      const counts = (await git(cwd, ['rev-list', '--count', '--left-right', `${upstream}...HEAD`]).catch(() => '')).trim();
      const m = counts.split(/\s+/);
      behind = Number(m[0]) || 0;
      ahead = Number(m[1]) || 0;
    }
  }

  // `--untracked-files=all` so a new directory expands into its individual
  // files (each of which the untracked diff path can render) instead of
  // collapsing to a single `?? dir/` row the diff endpoint can't handle.
  const z = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return { isRepo: true, branch, detached, hasCommits, ahead, behind, upstream, files: parseStatus(z) };
}

export async function diff(
  cwd: string,
  file: string,
  opts: { staged?: boolean; untracked?: boolean } = {},
): Promise<string> {
  const root = await gitRoot(cwd);
  if (opts.untracked) {
    // Untracked files have no HEAD side — diff against /dev/null so the panel
    // shows the whole file as additions. `--no-index` exits 1 when it prints.
    const abs = safeRelPath(root, file);
    return git(root, ['diff', '--no-index', '--', '/dev/null', abs], [0, 1]);
  }
  const args = ['diff', '--no-color'];
  if (opts.staged) args.push('--cached');
  args.push('--', file);
  return git(root, args);
}

export async function stage(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await git(await gitRoot(cwd), ['add', '--', ...files]);
}

export async function unstage(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const root = await gitRoot(cwd);
  // `restore --staged` needs a commit to compare against; on a repo with no
  // HEAD yet fall back to `rm --cached` to unstage the initial add.
  const hasCommits = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
  if (hasCommits) await git(root, ['restore', '--staged', '--', ...files]);
  else await git(root, ['rm', '--cached', '-r', '--', ...files]);
}

export async function commit(cwd: string, message: string, all: boolean): Promise<string> {
  const args = ['commit'];
  if (all) args.push('-a');
  args.push('-m', message);
  return git(await gitRoot(cwd), args);
}

export async function branches(cwd: string): Promise<GitBranches> {
  const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const out = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => '');
  const list = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return { current, branches: list };
}

export async function checkout(cwd: string, branch: string, create: boolean): Promise<string> {
  // `git switch` treats its argument as a ref, never a pathspec, so a value
  // like `.` or a real path can't trigger a worktree-discarding checkout the
  // way `git checkout <arg>` can. Reject leading-dash so it can't be read as a
  // flag (`--detach`, `-f`) either.
  if (branch.startsWith('-')) throw new GitError(`invalid branch name: ${branch}`, null);
  const args = create ? ['switch', '-c', branch] : ['switch', branch];
  return git(await gitRoot(cwd), args);
}
