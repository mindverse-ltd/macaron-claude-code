import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PROJECTS_ROOT } from '../config.js';
import { registerProjectCwd } from '../lib/project-registry.js';

type CreateBody = { name?: string; gitUrl?: string };

// A project name that's safe as a single path segment: no separators, no
// traversal, no leading dot/dash. Mirrors the slug git itself derives from a
// clone URL, so a cloned repo and a hand-typed name validate the same way.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Accept the URL forms `git clone` handles over the network. Local-path and
// `file://` clones are rejected — this endpoint is for pulling remote repos
// into the workspace root, not copying arbitrary local dirs.
function isAllowedGitUrl(url: string): boolean {
  if (url.startsWith('-')) return false; // never let the URL be read as a flag
  return /^https:\/\/[^\s]+$/.test(url) || /^git@[^\s]+:[^\s]+$/.test(url) || /^ssh:\/\/[^\s]+$/.test(url);
}

// `https://github.com/owner/repo(.git)` → `repo`. Undefined if no usable slug.
function repoNameFromUrl(url: string): string | undefined {
  const tail = url.replace(/[/]+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || '';
  return NAME_RE.test(tail) ? tail : undefined;
}

function runGitClone(gitUrl: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // argv form + shell:false → the URL can never be interpreted by a shell.
    // `--` stops flag parsing; GIT_TERMINAL_PROMPT=0 fails fast instead of
    // hanging on a credentials prompt for a private repo.
    const child = spawn('git', ['clone', '--depth', '1', '--', gitUrl, dest], {
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').pop() || `git clone exited ${code}`));
    });
  });
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  // Create a new project directory (optionally by cloning a git repo) under
  // PROJECTS_ROOT, then hand back the claude project id + real cwd so the UI
  // can start a session there. The dir must not already exist.
  app.post<{ Body: CreateBody }>('/api/projects', async (req, reply) => {
    const gitUrl = String(req.body?.gitUrl || '').trim();
    let name = String(req.body?.name || '').trim();

    if (gitUrl) {
      if (!isAllowedGitUrl(gitUrl)) {
        return reply.status(400).send({ error: 'gitUrl must be an https/ssh git remote' });
      }
      if (!name) name = repoNameFromUrl(gitUrl) || '';
      if (!name) return reply.status(400).send({ error: 'could not derive a name from gitUrl — pass name explicitly' });
    }

    if (!NAME_RE.test(name)) {
      return reply.status(400).send({ error: 'name must start alphanumeric and contain only letters, digits, . _ -' });
    }

    const dest = path.join(PROJECTS_ROOT, name);
    // Defense in depth: even though NAME_RE forbids separators, confirm the
    // resolved path is still a direct child of the root before touching disk.
    if (path.dirname(path.resolve(dest)) !== path.resolve(PROJECTS_ROOT)) {
      return reply.status(400).send({ error: 'resolved path escapes the projects root' });
    }

    try {
      await fs.mkdir(PROJECTS_ROOT, { recursive: true });
      // `mkdir` without recursive throws EEXIST if the dir is already there —
      // that's the guard against clobbering an existing project.
      await fs.mkdir(dest);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') return reply.status(409).send({ error: `already exists: ${dest}` });
      return reply.status(500).send({ error: `mkdir failed: ${err.message}` });
    }

    if (gitUrl) {
      try {
        // git clone refuses a non-empty target, so clone into a temp sibling
        // and move its contents in — keeps `dest` as the stable project root.
        const tmp = path.join(dest, '.macaron-clone');
        await runGitClone(gitUrl, tmp);
        for (const entry of await fs.readdir(tmp)) {
          await fs.rename(path.join(tmp, entry), path.join(dest, entry));
        }
        await fs.rmdir(tmp);
      } catch (e) {
        await fs.rm(dest, { recursive: true, force: true }); // don't leave a half-cloned dir behind
        return reply.status(422).send({ error: `git clone failed: ${(e as Error).message}` });
      }
    }

    // Register the real cwd so the (lossy) project→cwd decode in the session
    // route resolves correctly for this brand-new, session-less directory.
    const project = registerProjectCwd(dest);
    return { project, cwd: dest, name };
  });
}
