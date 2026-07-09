import type { FastifyReply } from 'fastify';
import { spawn, type IPty } from 'node-pty';
import type { TerminalStreamEvent } from '@macaron/shared';
import { sseSend } from './sse.js';

// Per-terminal registry of real PTYs. Mirrors live-registry.ts: one PTY per
// `tid`, multiplexed to any number of SSE subscribers, with a capped
// scrollback buffer replayed to each newly-attached client so reconnects
// (and React StrictMode double-mounts) reproduce the screen exactly.

type PtySession = {
  proc: IPty;
  cwd: string;
  cols: number;
  rows: number;
  scrollback: string;
  subs: Set<FastifyReply>;
  exited: boolean;
  exitCode: number;
  reaper?: NodeJS.Timeout;
};

const SCROLLBACK_CAP = 256 * 1024; // trailing bytes kept for replay (adeotek uses the same)
const IDLE_GRACE_MS = 5 * 60_000; // kill a PTY left with no subscribers this long
const KEEP_AFTER_EXIT_MS = 30_000; // linger after exit so a late subscriber still sees the tail

const shell = process.env.SHELL || 'bash';
const sessions = new Map<string, PtySession>();

function broadcast(s: PtySession, ev: TerminalStreamEvent): void {
  for (const sub of s.subs) {
    try {
      sseSend(sub, ev);
    } catch {
      s.subs.delete(sub);
    }
  }
}

export function getOrCreatePty(tid: string, opts: { cwd: string; cols: number; rows: number }): PtySession {
  const existing = sessions.get(tid);
  if (existing) return existing;

  const proc = spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env: process.env as Record<string, string>,
  });
  const s: PtySession = {
    proc,
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    scrollback: '',
    subs: new Set(),
    exited: false,
    exitCode: 0,
  };
  sessions.set(tid, s);

  proc.onData((data) => {
    s.scrollback += data;
    if (s.scrollback.length > SCROLLBACK_CAP) s.scrollback = s.scrollback.slice(-SCROLLBACK_CAP);
    broadcast(s, { type: 'output', data });
  });
  proc.onExit(({ exitCode }) => {
    s.exited = true;
    s.exitCode = exitCode;
    broadcast(s, { type: 'exit', exitCode });
    for (const sub of s.subs) {
      try {
        sub.raw.write('data: [DONE]\n\n');
        sub.raw.end();
      } catch {
        /* already closed */
      }
    }
    s.subs.clear();
    if (s.reaper) clearTimeout(s.reaper);
    setTimeout(() => sessions.delete(tid), KEEP_AFTER_EXIT_MS);
  });

  return s;
}

// Attach an SSE reply: replay the full scrollback snapshot as one `history`
// frame BEFORE adding the subscriber, so no live `output` can slip in between
// the snapshot and the live tap.
export function ptySubscribe(tid: string, reply: FastifyReply): boolean {
  const s = sessions.get(tid);
  if (!s) return false;
  if (s.reaper) { clearTimeout(s.reaper); s.reaper = undefined; }
  try {
    sseSend(reply, { type: 'history', data: s.scrollback });
  } catch {
    return false;
  }
  if (s.exited) {
    try {
      sseSend(reply, { type: 'exit', exitCode: s.exitCode });
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    } catch {
      /* closed */
    }
    return true;
  }
  s.subs.add(reply);
  reply.raw.on('close', () => {
    s.subs.delete(reply);
    // No viewers left — schedule a reap so an abandoned tile can't leak a shell.
    if (s.subs.size === 0 && !s.exited && !s.reaper) {
      s.reaper = setTimeout(() => killPty(tid), IDLE_GRACE_MS);
    }
  });
  return true;
}

export function ptyInput(tid: string, data: string): boolean {
  const s = sessions.get(tid);
  if (!s || s.exited) return false;
  s.proc.write(data);
  return true;
}

export function ptyResize(tid: string, cols: number, rows: number): boolean {
  const s = sessions.get(tid);
  if (!s || s.exited) return false;
  // NaN slips past a plain `< 1` guard (NaN < 1 === false), so an empty
  // resize body would reach node-pty's resize() with NaN — reject explicitly.
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return false;
  s.cols = cols;
  s.rows = rows;
  try {
    s.proc.resize(cols, rows);
  } catch {
    return false;
  }
  return true;
}

export function killPty(tid: string): boolean {
  const s = sessions.get(tid);
  if (!s) return false;
  if (s.reaper) { clearTimeout(s.reaper); s.reaper = undefined; }
  try {
    s.proc.kill();
  } catch {
    /* already dead */
  }
  return true;
}
