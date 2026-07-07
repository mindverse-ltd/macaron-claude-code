// Thin git/gh helpers for the Create-PR action. Everything runs through
// execFile with args as arrays and the cwd pinned — no shell interpolation,
// so a branch name or PR title can never be misread as a flag or command.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrContext, CreatePrResult } from '@macaron/shared';

const pexec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('gh', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

// Resolve the repo's default branch (main/master/…). Prefer the remote HEAD
// symref; fall back to `gh` and finally to "main" so a fresh clone that never
// set origin/HEAD still works.
async function resolveDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const name = ref.replace(/^origin\//, '').trim();
    if (name) return name;
  } catch {
    /* origin/HEAD not set — try gh */
  }
  try {
    const name = await gh(cwd, ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
    if (name.trim()) return name.trim();
  } catch {
    /* gh unavailable — fall back */
  }
  return 'main';
}

async function existingPrUrl(cwd: string, branch: string): Promise<string | undefined> {
  try {
    const out = await gh(cwd, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url']);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function getPrContext(cwd: string): Promise<PrContext> {
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const defaultBranch = await resolveDefaultBranch(cwd);
  const dirty = (await git(cwd, ['status', '--porcelain'])).length > 0;

  let hasRemote = false;
  try {
    await git(cwd, ['remote', 'get-url', 'origin']);
    hasRemote = true;
  } catch {
    /* no origin remote */
  }

  // Commits on this branch not on the default branch. Prefer the remote base
  // (origin/<default>) so "ahead" reflects what a PR would actually contain;
  // fall back to the local default branch, then 0.
  let ahead = 0;
  for (const base of [`origin/${defaultBranch}`, defaultBranch]) {
    try {
      const out = await git(cwd, ['rev-list', '--count', `${base}..HEAD`]);
      ahead = parseInt(out, 10) || 0;
      break;
    } catch {
      /* base ref missing — try next */
    }
  }

  const existing = branch !== defaultBranch ? await existingPrUrl(cwd, branch) : undefined;
  return { branch, defaultBranch, ahead, dirty, hasRemote, existingPrUrl: existing };
}

// Push the current branch and open a PR via gh. Idempotent: if a PR already
// exists for the branch, return its URL instead of erroring. The body is
// passed via a temp file so newlines/backticks/markdown survive intact.
export async function createPr(
  cwd: string,
  input: { title: string; body: string; draft: boolean },
): Promise<CreatePrResult> {
  const ctx = await getPrContext(cwd);
  if (ctx.branch === ctx.defaultBranch) {
    throw new Error(`can't open a PR from the default branch (${ctx.defaultBranch})`);
  }
  if (ctx.ahead === 0) {
    throw new Error(`branch ${ctx.branch} has no commits ahead of ${ctx.defaultBranch}`);
  }
  if (ctx.existingPrUrl) {
    return { url: ctx.existingPrUrl, created: false };
  }

  await git(cwd, ['push', '-u', 'origin', ctx.branch]);

  const dir = await mkdtemp(path.join(tmpdir(), 'mcc-pr-'));
  const bodyFile = path.join(dir, 'body.md');
  try {
    await writeFile(bodyFile, input.body ?? '', 'utf8');
    const args = [
      'pr', 'create',
      '--head', ctx.branch,
      '--base', ctx.defaultBranch,
      '--title', input.title,
      '--body-file', bodyFile,
    ];
    if (input.draft) args.push('--draft');
    const url = (await gh(cwd, args)).split('\n').map((l) => l.trim()).find((l) => l.startsWith('http')) || '';
    if (!url) throw new Error('gh pr create returned no URL');
    return { url, created: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
