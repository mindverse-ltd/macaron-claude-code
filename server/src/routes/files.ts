import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import ignore from 'ignore';
import type { FileEntry, FileListResponse, FileReadResponse } from '@macaron/shared';
import { resolveProjectCwd } from '../lib/session-store.js';

// Files this API never lists, regardless of .gitignore. .git/node_modules are
// noise; everything else the project's own .gitignore decides.
const ALWAYS_HIDE = ['.git', 'node_modules'];

// Reads capped at 1 MB — the editor is for source, not blobs. Writes ride the
// server's global 2 MB bodyLimit.
const MAX_READ_BYTES = 1024 * 1024;

// Confine a client-supplied relative path to the project root. Returns the
// absolute path, or null if it escapes (symlinks resolved via realpath). The
// root itself is realpath'd so a symlinked cwd still matches its children.
async function confine(root: string, rel: string): Promise<string | null> {
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const abs = path.resolve(realRoot, rel);
  if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) return null;
  return abs;
}

// Build a gitignore matcher from <root>/.gitignore (absent → empty matcher).
// Always augmented with ALWAYS_HIDE.
async function loadIgnore(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore().add(ALWAYS_HIDE);
  try {
    ig.add(await fs.readFile(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    /* no .gitignore — just the always-hidden set */
  }
  return ig;
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // List one directory (lazy — the tree fetches children on expand). `path`
  // is relative to the project cwd; '' or omitted = root.
  app.get<{ Params: { project: string }; Querystring: { path?: string } }>(
    '/api/files/:project/list',
    async (req, reply) => {
      const root = await resolveProjectCwd(req.params.project);
      const rel = req.query.path || '';
      const abs = await confine(root, rel);
      if (!abs) return reply.status(403).send({ error: 'path escapes project root' });

      let dirents;
      try {
        dirents = await fs.readdir(abs, { withFileTypes: true });
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }

      const ig = await loadIgnore(root);
      const entries: FileEntry[] = [];
      for (const d of dirents) {
        const childRel = path.join(rel, d.name);
        const isDir = d.isDirectory();
        // ignore matches on posix-style relative paths; dirs need a trailing
        // slash for directory-only patterns to catch.
        const test = childRel.split(path.sep).join('/') + (isDir ? '/' : '');
        if (ig.ignores(test)) continue;
        const entry: FileEntry = { name: d.name, path: childRel, type: isDir ? 'dir' : 'file' };
        if (!isDir) {
          try {
            const st = await fs.stat(abs + path.sep + d.name);
            entry.size = st.size;
            entry.mtime = st.mtimeMs;
          } catch {
            /* stat may race a delete — list it without size */
          }
        }
        entries.push(entry);
      }
      // Directories first, then case-insensitive name order.
      entries.sort((a, b) =>
        a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
      );
      return { root, path: rel, entries } satisfies FileListResponse;
    },
  );

  // Read a file as utf8 text. Rejects oversized (413) and binary (415) files —
  // the editor only handles text.
  app.get<{ Params: { project: string }; Querystring: { path?: string } }>(
    '/api/files/:project/read',
    async (req, reply) => {
      const root = await resolveProjectCwd(req.params.project);
      const rel = req.query.path || '';
      if (!rel) return reply.status(400).send({ error: 'path required' });
      const abs = await confine(root, rel);
      if (!abs) return reply.status(403).send({ error: 'path escapes project root' });

      let st;
      try {
        st = await fs.stat(abs);
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
      if (!st.isFile()) return reply.status(400).send({ error: 'not a file' });
      if (st.size > MAX_READ_BYTES) {
        return reply.status(413).send({ error: `file too large (${st.size} bytes, max ${MAX_READ_BYTES})` });
      }

      const buf = await fs.readFile(abs);
      // NUL byte in the head → treat as binary (same heuristic git uses).
      if (buf.subarray(0, 8000).includes(0)) {
        return reply.status(415).send({ error: 'binary file', binary: true });
      }
      return { path: rel, content: buf.toString('utf8'), size: st.size } satisfies FileReadResponse;
    },
  );

  // Overwrite an existing-or-new file under the project root. The parent
  // directory must already exist (no recursive mkdir — keep writes boring).
  app.put<{ Params: { project: string }; Body: { path?: string; content?: string } }>(
    '/api/files/:project/write',
    async (req, reply) => {
      const root = await resolveProjectCwd(req.params.project);
      const rel = String(req.body?.path || '');
      if (!rel) return reply.status(400).send({ error: 'path required' });
      if (typeof req.body?.content !== 'string') {
        return reply.status(400).send({ error: 'content required' });
      }
      const abs = await confine(root, rel);
      if (!abs) return reply.status(403).send({ error: 'path escapes project root' });

      try {
        const parent = await fs.stat(path.dirname(abs));
        if (!parent.isDirectory()) throw new Error('parent is not a directory');
      } catch (e) {
        return reply.status(400).send({ error: `parent directory unusable: ${(e as Error).message}` });
      }
      try {
        await fs.writeFile(abs, req.body.content, 'utf8');
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
      return { ok: true, bytes: Buffer.byteLength(req.body.content, 'utf8') };
    },
  );
}
