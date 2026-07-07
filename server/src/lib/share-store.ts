// Persisted session-share mappings, held in ~/.claude/macaron-shares.json.
//
// A share publishes a session behind an unguessable random token. The token
// is the capability — whoever holds the link can read the transcript; there
// is no login. The real project/sid live only on this side of the map, so a
// share URL never leaks the on-disk session id.
//
// Cache is warmed lazily on first access and persisted to disk on every
// mutation, mirroring settings-store.ts.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HOME } from '../config.js';

export type ShareEntry = { token: string; project: string; sid: string; createdAt: number };

const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-shares.json');

let cache: ShareEntry[] | null = null;

async function load(): Promise<ShareEntry[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const j = JSON.parse(raw) as { shares?: ShareEntry[] };
    cache = Array.isArray(j.shares) ? j.shares : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify({ shares: cache }, null, 2), 'utf8');
}

// Idempotent: reuse an existing token for the same project+sid so re-sharing
// doesn't mint duplicates (and an old link keeps working).
export async function createShare(project: string, sid: string): Promise<string> {
  const shares = await load();
  const existing = shares.find((s) => s.project === project && s.sid === sid);
  if (existing) return existing.token;
  const token = randomUUID();
  shares.push({ token, project, sid, createdAt: Date.now() });
  await persist();
  return token;
}

export async function resolveShare(token: string): Promise<ShareEntry | null> {
  const shares = await load();
  return shares.find((s) => s.token === token) || null;
}

// Unshare by session — the owning UI (sidebar) holds project+sid, not the
// token, so revocation keys on the session. No-op if it was never shared.
export async function deleteShareBySession(project: string, sid: string): Promise<boolean> {
  const shares = await load();
  const i = shares.findIndex((s) => s.project === project && s.sid === sid);
  if (i < 0) return false;
  shares.splice(i, 1);
  await persist();
  return true;
}
