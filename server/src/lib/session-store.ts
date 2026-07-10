import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  Block,
  ContextBreakdown,
  Message,
  MessageSearchHit,
  SessionDetail,
  SessionListItem,
  UsageSnapshot,
  Workspace,
} from '@macaron/shared';
import { CLAUDE_PROJECTS, HOME } from '../config.js';
import { getLabels } from './label-store.js';

export function basename(p: string): string {
  if (!p) return '';
  return p.split('/').filter(Boolean).pop() || p;
}

export function decodeClaudeProjectName(encoded: string): string {
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

type SessionSummary = {
  firstUserText: string;
  cwd: string;
  gitBranch: string;
  headLines: number;
  truncated: boolean;
  mtime: number;
  size: number;
};

type CacheEntry = { mtimeMs: number; size: number; summary: SessionSummary };

// File-keyed mtime cache so we only re-parse jsonl when claude appends to it.
const summaryCache = new Map<string, CacheEntry>();
const HEAD_BYTES = 96 * 1024;
const CWD_TAIL_BYTES = 64 * 1024;

export async function deleteSession(project: string, sid: string): Promise<void> {
  const filePath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  await fs.unlink(filePath);
  summaryCache.delete(filePath);
}

// Duplicate a claude session as a brand-new sid so both can be resumed
// independently. We rewrite every `sessionId` field inside the jsonl to the
// new uuid — otherwise `claude --resume` would still find the original when
// scanning by embedded sessionId.
export async function duplicateSession(
  project: string,
  sid: string,
): Promise<{ newSid: string }> {
  const srcPath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs.readFile(srcPath, 'utf8');
  const newSid = randomUUID();
  const destPath = path.join(CLAUDE_PROJECTS, project, `${newSid}.jsonl`);
  const outLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      outLines.push(line);
      continue;
    }
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.sessionId === 'string') o.sessionId = newSid;
      outLines.push(JSON.stringify(o));
    } catch {
      outLines.push(line);
    }
  }
  let next = outLines.join('\n');
  if (!next.endsWith('\n')) next += '\n';
  // wx = fail if a file with this uuid already exists (astronomically rare)
  await fs.writeFile(destPath, next, { encoding: 'utf8', flag: 'wx' });
  return { newSid };
}

// Truncate a session at the message identified by `uuid` — the picked entry
// and everything after it are removed. The dropped tail is copied to a
// timestamped `.rewind-<ts>.jsonl.bak` sibling so users can recover it if
// they change their mind. Returns count of jsonl lines dropped.
export async function rewindSession(
  project: string,
  sid: string,
  uuid: string,
): Promise<{ dropped: number; backupPath: string }> {
  const filePath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  let cutIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o.uuid === uuid) {
        cutIdx = i;
        break;
      }
    } catch {
      /* skip malformed */
    }
  }
  if (cutIdx < 0) {
    throw new Error(`uuid ${uuid} not found in session`);
  }
  const keptRaw = lines.slice(0, cutIdx).join('\n');
  const droppedRaw = lines.slice(cutIdx).join('\n');
  const ts = Date.now();
  const backupPath = filePath.replace(/\.jsonl$/, `.rewind-${ts}.jsonl.bak`);
  await fs.writeFile(backupPath, droppedRaw, 'utf8');
  const keptFinal = keptRaw.endsWith('\n') ? keptRaw : keptRaw + '\n';
  await fs.writeFile(filePath, keptFinal, 'utf8');
  summaryCache.delete(filePath);
  const dropped = droppedRaw.split('\n').filter((l) => l.trim()).length;
  return { dropped, backupPath };
}

// Fork = the non-destructive twin of rewind. Copy every line *before* the
// picked message (identified by `uuid`) into a brand-new sid, rewriting the
// embedded `sessionId` the way duplicateSession does so `claude --resume
// <newSid>` replays only that prefix. The original session is left untouched,
// so the user keeps the old branch and gets a fresh one to explore a different
// path from that point. Cut is exclusive: the picked message is not copied, so
// the fork opens ready for a new alternative to that turn.
export async function forkSession(
  project: string,
  sid: string,
  uuid: string,
): Promise<{ newSid: string; kept: number }> {
  const srcPath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs.readFile(srcPath, 'utf8');
  const lines = raw.split('\n');
  let cutIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      if (JSON.parse(line).uuid === uuid) {
        cutIdx = i;
        break;
      }
    } catch {
      /* skip malformed */
    }
  }
  if (cutIdx < 0) {
    throw new Error(`uuid ${uuid} not found in session`);
  }
  const newSid = randomUUID();
  const destPath = path.join(CLAUDE_PROJECTS, project, `${newSid}.jsonl`);
  const outLines: string[] = [];
  for (const line of lines.slice(0, cutIdx)) {
    if (!line.trim()) {
      outLines.push(line);
      continue;
    }
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.sessionId === 'string') o.sessionId = newSid;
      outLines.push(JSON.stringify(o));
    } catch {
      outLines.push(line);
    }
  }
  if (!outLines.some((l) => l.trim())) {
    throw new Error('nothing to fork before the first message');
  }
  let next = outLines.join('\n');
  if (next && !next.endsWith('\n')) next += '\n';
  // wx = fail if a file with this uuid already exists (astronomically rare)
  await fs.writeFile(destPath, next, { encoding: 'utf8', flag: 'wx' });
  return { newSid, kept: outLines.filter((l) => l.trim()).length };
}

// Compact = replace the transcript up to now with a single `type: "summary"`
// line generated by an LLM. The original jsonl is backed up to
// `.pre-compact-<ts>.jsonl.bak`. Metadata lines (anything before the first
// user/assistant message) are preserved so cwd/gitBranch still resolves.
export async function writeCompactedSession(
  project: string,
  sid: string,
  summary: string,
): Promise<{ backupPath: string; kept: number }> {
  const filePath = path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  const preamble: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      preamble.push(line);
      continue;
    }
    try {
      const o = JSON.parse(t);
      if (o.type === 'user' || o.type === 'assistant' || o.type === 'summary') break;
      preamble.push(line);
    } catch {
      preamble.push(line);
    }
  }
  const ts = Date.now();
  const backupPath = filePath.replace(/\.jsonl$/, `.pre-compact-${ts}.jsonl.bak`);
  await fs.writeFile(backupPath, raw, 'utf8');
  const summaryLine =
    JSON.stringify({
      type: 'summary',
      summary,
      timestamp: new Date().toISOString(),
      uuid: `compact-${ts}`,
    }) + '\n';
  const nextRaw =
    (preamble.length > 0 ? preamble.join('\n').replace(/\n+$/, '') + '\n' : '') + summaryLine;
  await fs.writeFile(filePath, nextRaw, 'utf8');
  summaryCache.delete(filePath);
  return { backupPath, kept: preamble.filter((l) => l.trim()).length };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function readSessionSummary(filePath: string): Promise<SessionSummary | null> {
  let st;
  try {
    st = await fs.stat(filePath);
  } catch {
    return null;
  }

  const cached = summaryCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.summary;
  }

  const summary: SessionSummary = {
    firstUserText: '',
    cwd: '',
    gitBranch: '',
    headLines: 0,
    truncated: st.size > HEAD_BYTES,
    mtime: st.mtimeMs,
    size: st.size,
  };

  try {
    const fh = await fs.open(filePath, 'r');
    try {
      const len = Math.min(st.size, HEAD_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const upto = summary.truncated ? lines.length - 1 : lines.length;
      for (let i = 0; i < upto; i++) {
        const line = lines[i]!;
        if (!line.trim()) continue;
        summary.headLines++;
        if (summary.firstUserText && summary.cwd) continue;
        try {
          const o = JSON.parse(line);
          if (!summary.cwd && o.cwd) summary.cwd = o.cwd;
          if (!summary.gitBranch && o.gitBranch) summary.gitBranch = o.gitBranch;
          if (!summary.firstUserText && o.type === 'user' && o.message?.content) {
            const c = o.message.content;
            const t =
              typeof c === 'string'
                ? c
                : Array.isArray(c)
                  ? c.map((b: { text?: string }) => b.text || '').join(' ')
                  : '';
            if (t && !t.startsWith('<') && !t.includes('tool_result')) summary.firstUserText = t;
          }
        } catch {
          /* skip malformed line */
        }
      }
    } finally {
      await fh.close();
    }
  } catch {
    /* swallow */
  }

  // cwd sits at the END of each jsonl line (after `message`), so a huge first
  // paste can push the head's only cwd-bearing line past HEAD_BYTES, truncating
  // it unparseably. The same cwd repeats on every later line, and trailing lines
  // are usually small — so when the head read came up empty on a truncated file,
  // recover cwd (and gitBranch) from a tail read instead.
  if (summary.truncated && !summary.cwd) {
    try {
      const fh = await fs.open(filePath, 'r');
      try {
        const len = Math.min(st.size, CWD_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        // Drop the first slice — it's a partial line cut by the seek offset.
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]!;
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o.cwd) summary.cwd = o.cwd;
            if (!summary.gitBranch && o.gitBranch) summary.gitBranch = o.gitBranch;
          } catch {
            /* skip malformed line */
          }
        }
      } finally {
        await fh.close();
      }
    } catch {
      /* swallow — fall back to decoded project name upstream */
    }
  }

  summaryCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}

// Resolve a session's working directory. The project name IS the cwd (encoded
// by claude-cli), so it's the safe default — the jsonl's head read is capped at
// HEAD_BYTES and a big first-line paste can push cwd out of range, so prefer
// the decoded name and only override with the embedded cwd when we got one.
export async function resolveSessionCwd(project: string, sid: string): Promise<string> {
  let cwd = decodeClaudeProjectName(project) || HOME || '/tmp';
  try {
    const head = await readSessionSummary(path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`));
    if (head?.cwd) cwd = head.cwd;
  } catch { /* fall back to decoded project name */ }
  return cwd;
}

// Resolve a claude project name to its working directory. Prefer the cwd
// embedded in an actual jsonl (a big first-line paste can push `cwd` past
// HEAD_BYTES, so decoding the name is the fallback). We only fall back to
// decodeClaudeProjectName when the project is actually registered under
// CLAUDE_PROJECTS: that decode (`-` -> `/`) is attacker-controllable, and
// callers that hand the result to the filesystem as a *root* (routes/files.ts)
// would otherwise turn the `:project` route param into an arbitrary-root
// traversal (e.g. `-etc` -> `/etc`). Returns null for an unregistered project;
// callers must treat null as "unknown project" (404), never as a servable root.
export async function resolveProjectCwd(project: string): Promise<string | null> {
  let files: string[];
  const projDir = path.join(CLAUDE_PROJECTS, project);
  try {
    files = await fs.readdir(projDir);
  } catch {
    return null; // no such project dir — reject rather than decode a root
  }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const meta = await readSessionSummary(path.join(projDir, f));
    if (meta?.cwd) return meta.cwd;
  }
  // Registered project whose cwd we couldn't recover from any jsonl: fall back
  // to the decoded name (the original big-paste behavior), now gated on the dir
  // existing above so an unregistered `-etc` can never reach this.
  return decodeClaudeProjectName(project);
}

export async function listAllSessions(): Promise<SessionListItem[]> {
  let projects;
  try {
    projects = await fs.readdir(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch {
    return [];
  }

  type Target = { project: string; file: string; sid: string };
  const targets: Target[] = [];
  await mapPool(
    projects.filter((p) => p.isDirectory()),
    16,
    async (p) => {
      const projDir = path.join(CLAUDE_PROJECTS, p.name);
      let files;
      try {
        files = await fs.readdir(projDir);
      } catch {
        return;
      }
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          targets.push({ project: p.name, file: path.join(projDir, f), sid: f.slice(0, -6) });
        }
      }
    },
  );

  const labels = await getLabels();
  const summaries = await mapPool(targets, 32, async (t): Promise<SessionListItem | null> => {
    const meta = await readSessionSummary(t.file);
    if (!meta) return null;
    const item: SessionListItem = {
      kind: 'claude',
      project: t.project,
      cwd: meta.cwd || decodeClaudeProjectName(t.project),
      gitBranch: meta.gitBranch || undefined,
      sessionId: t.sid,
      preview: (meta.firstUserText || '').slice(0, 220),
      label: labels[t.sid],
      messageCount: meta.headLines,
      messageCountSuffix: meta.truncated ? '+' : '',
      mtime: meta.mtime,
      size: meta.size,
      resumeCommand: `claude --resume ${t.sid}`,
    };
    return item;
  });

  const out = summaries.filter((s): s is SessionListItem => s !== null);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function groupWorkspaces(sessions: SessionListItem[]): Workspace[] {
  // Group by `project` (the encoded repo root), not cwd: a session running in a
  // worktree has cwd = <repo>/.claude/worktrees/<name>, but its `project` is the
  // repo root — grouping by cwd would split one repo into N sidebar entries that
  // share a project id and collide on React keys.
  const byProject = new Map<string, Workspace>();
  for (const s of sessions) {
    const key = s.project;
    if (!byProject.has(key)) {
      byProject.set(key, {
        cwd: s.cwd,
        project: s.project,
        name: basename(s.cwd) || s.project,
        sessionCount: 0,
        lastActivity: 0,
        lastSessionId: '',
        lastPreview: '',
      });
    }
    const w = byProject.get(key)!;
    w.sessionCount++;
    if (s.mtime > w.lastActivity) {
      w.lastActivity = s.mtime;
      w.lastSessionId = s.sessionId;
      w.lastPreview = s.preview;
      w.project = s.project;
    }
  }
  const arr = Array.from(byProject.values());
  arr.sort((a, b) => b.lastActivity - a.lastActivity);
  return arr;
}

const SESSION_TAIL_BYTES = 8 * 1024 * 1024;

export async function readSessionMessages(project: string, sid: string): Promise<SessionDetail> {
  const base = path.resolve(CLAUDE_PROJECTS);
  const filePath = path.resolve(base, project, `${sid}.jsonl`);
  // project/sid reach this sink from a JSON body via the share route, where a
  // `..` segment passes freely; assert the resolved path stays inside the
  // projects dir so a traversal can't read an arbitrary *.jsonl off disk.
  if (!(filePath + path.sep).startsWith(base + path.sep)) throw new Error('invalid session path');
  const st = await fs.stat(filePath);
  let raw: string;
  let truncated = false;
  if (st.size > SESSION_TAIL_BYTES) {
    truncated = true;
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(SESSION_TAIL_BYTES);
      await fh.read(buf, 0, SESSION_TAIL_BYTES, st.size - SESSION_TAIL_BYTES);
      raw = buf.toString('utf8');
      const nl = raw.indexOf('\n');
      if (nl !== -1) raw = raw.slice(nl + 1);
    } finally {
      await fh.close();
    }
  } else {
    raw = await fs.readFile(filePath, 'utf8');
  }
  const messages: Message[] = [];
  let cwd = '';
  let gitBranch = '';
  // Track the most recent assistant message's usage — the WebUI's Context
  // bar shows this / model window. Cache tokens are counted toward the
  // window fill because they take up real slots.
  let latestUsage: UsageSnapshot | undefined;
  // Char tallies for the estimated context breakdown. Accumulated here (not
  // client-side) because tool_result text is truncated to 4000 chars below
  // before it ships — a big file read would otherwise be misattributed to
  // system overhead. char/4 ≈ tokens; only the ratios between segments matter.
  let msgChars = 0;
  let thinkChars = 0;
  let toolCallChars = 0;
  let toolResultChars = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
      // Post-`/compact` recap the CLI writes as its own line. Show it as a
      // dim `※ recap: …` marker so users see where the conversation was
      // summarized instead of a silent gap.
      if (o.type === 'summary' && typeof o.summary === 'string') {
        messages.push({
          role: 'system',
          blocks: [{ kind: 'system_event', eventType: 'summary', text: o.summary }],
          timestamp: o.timestamp,
          uuid: o.uuid,
        });
        continue;
      }
      if (o.type === 'user' || o.type === 'assistant') {
        if (o.isMeta) {
          // Show the "Continue from where you left off." resume marker as a
          // dim `※` line — but *only* that. Other isMeta entries (image
          // cache pointers, tool_result echoes) are noise and stay hidden.
          if (o.type === 'user') {
            const c = o.message?.content;
            const t =
              typeof c === 'string'
                ? c
                : Array.isArray(c)
                  ? c
                      .map((b: { text?: string; type?: string }) =>
                        b.type === 'text' ? b.text || '' : '',
                      )
                      .join('')
                      .trim()
                  : '';
            if (/^Continue from where you left off/i.test(t)) {
              messages.push({
                role: 'system',
                blocks: [{ kind: 'system_event', eventType: 'resume', text: t }],
                timestamp: o.timestamp,
                uuid: o.uuid,
              });
            }
          }
          continue;
        }
        const blocks: Block[] = [];
        const c = o.message?.content;
        if (typeof c === 'string') {
          blocks.push({ kind: 'text', text: c });
          msgChars += c.length;
        } else if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'text' && b.text) { blocks.push({ kind: 'text', text: b.text }); msgChars += b.text.length; }
            else if (b.type === 'thinking' && b.thinking) {
              blocks.push({ kind: 'thinking', text: b.thinking });
              thinkChars += b.thinking.length;
            }
            else if (b.type === 'tool_use') {
              blocks.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
              toolCallChars += (b.name?.length || 0) + JSON.stringify(b.input ?? '').length;
            }
            else if (b.type === 'image' && b.source?.type === 'base64' && b.source?.data) {
              // The CLI persists user-attached images as base64 in the
              // jsonl. Ship them through so the WebUI can render inline
              // where they appear (preserving interleaved order with text).
              blocks.push({
                kind: 'image',
                mimeType: String(b.source.media_type || 'image/png'),
                data: String(b.source.data),
              });
            }
            else if (b.type === 'tool_result') {
              const t =
                typeof b.content === 'string'
                  ? b.content
                  : Array.isArray(b.content)
                    ? b.content.map((x: { text?: string }) => x.text || '').join('\n')
                    : '';
              blocks.push({ kind: 'tool_result', toolUseId: b.tool_use_id, text: t.slice(0, 4000), isError: b.is_error === true });
              toolResultChars += t.length;
            }
          }
        }
        messages.push({
          role: o.type,
          blocks,
          model: o.message?.model,
          timestamp: o.timestamp,
          uuid: o.uuid,
        });
        if (o.type === 'assistant' && o.message?.usage) {
          const u = o.message.usage;
          latestUsage = {
            inputTokens: Number(u.input_tokens) || 0,
            cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0,
            cacheReadInputTokens: Number(u.cache_read_input_tokens) || 0,
            outputTokens: Number(u.output_tokens) || 0,
            model: o.message?.model,
          };
        }
      }
    } catch {
      /* skip malformed */
    }
  }

  const [claudeMdCount, mcpCount] = await Promise.all([
    countClaudeMd(cwd),
    countMcpServers(),
  ]);

  // Tail reads intentionally drop the oldest bytes, so the measured visible
  // transcript can no longer explain the aggregate usage. Keep the accurate
  // flat Context bar instead of showing a misleading all-system residual.
  const contextBreakdown = truncated ? undefined : buildContextBreakdown(latestUsage, {
    msgChars,
    thinkChars,
    toolCallChars,
    toolResultChars,
  });

  return {
    kind: 'claude',
    sessionId: sid,
    project,
    cwd,
    gitBranch,
    messages,
    truncated,
    totalBytes: st.size,
    latestUsage,
    contextBreakdown,
    claudeMdCount,
    mcpCount,
  };
}

// Extract plain text from a jsonl user/assistant line's message content,
// ignoring tool_use / tool_result / image blocks — noise for a text search.
function lineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as Array<{ type?: string; text?: string }>) {
    if (b?.type === 'text' && b.text) parts.push(b.text);
  }
  return parts.join(' ');
}

// Synthetic USER lines the session view hides (mirrors isNoisyUserText in
// web/src/views/Session.tsx): slash-command wrappers (`<command-name>`…),
// tool acknowledgements, and failure notices. Search must agree with the
// view on what a message is, or a hit deep-links to a line that is never
// rendered. Only applied to user lines — the view shows assistant text as-is.
function isNoisyUserText(t: string): boolean {
  if (!t) return true;
  if (t.startsWith('<')) return true;
  if (/^The file .* (has been (updated|created) successfully|file state is current)/.test(t)) return true;
  if (/^Tool .* failed/.test(t)) return true;
  return false;
}

// Whitespace-collapsed window around the first match so the palette row
// shows context, not the whole message.
function snippetAround(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return flat.slice(0, 180);
  const start = Math.max(0, idx - 60);
  const end = Math.min(flat.length, idx + q.length + 120);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

// Grep the claude transcripts for a substring, newest-first, stopping once
// `limit` hits accumulate. Recency-biased on purpose: a palette wants the
// last thing you touched, and bounding the scan to ~limit sessions keeps the
// cost sane over a large ~/.claude/projects tree.
export async function searchMessages(query: string, limit = 30): Promise<MessageSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const ql = q.toLowerCase();
  const sessions = await listAllSessions(); // sorted mtime desc
  const hits: MessageSearchHit[] = [];
  for (const s of sessions) {
    if (hits.length >= limit) break;
    const filePath = path.join(CLAUDE_PROJECTS, s.project, `${s.sessionId}.jsonl`);
    let raw: string;
    try {
      const st = await fs.stat(filePath);
      if (st.size > SESSION_TAIL_BYTES) {
        const fh = await fs.open(filePath, 'r');
        try {
          const buf = Buffer.alloc(SESSION_TAIL_BYTES);
          await fh.read(buf, 0, SESSION_TAIL_BYTES, st.size - SESSION_TAIL_BYTES);
          raw = buf.toString('utf8');
          const nl = raw.indexOf('\n');
          if (nl !== -1) raw = raw.slice(nl + 1);
        } finally {
          await fh.close();
        }
      } else {
        raw = await fs.readFile(filePath, 'utf8');
      }
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta) continue;
        const text = lineText(o.message?.content);
        // Agree with the session view: it hides synthetic user lines
        // (isNoisyUserText). Without this, queries like `command` return
        // `<command-name>` hits that deep-link to a line the view never
        // renders — a dead link.
        if (o.type === 'user' && isNoisyUserText(text)) continue;
        // Match the DECODED text, not the escaped JSON bytes. A raw-byte grep
        // (the old pre-filter) silently dropped real matches: `C:\\Users`
        // (stored `C:\\\\Users`), any query containing a quote, and phrases
        // spanning two text blocks (joined by a space only after decode).
        if (!text || text.toLowerCase().indexOf(ql) < 0) continue;
        hits.push({
          project: s.project,
          sessionId: s.sessionId,
          uuid: typeof o.uuid === 'string' ? o.uuid : undefined,
          role: o.type,
          snippet: snippetAround(text, q),
          preview: s.preview,
          mtime: s.mtime,
        });
        // One hit per session: scroll-to-message is deferred, so `go()` drops
        // `uuid` and every hit from this file deep-links to the SAME place.
        // Extra rows would just crowd out other sessions. Revisit when the
        // message-level anchor lands and uuid is actually consumed.
        break;
      } catch {
        /* skip malformed */
      }
    }
  }
  return hits;
}

// Estimate the used-context split from transcript char tallies. `total` is the
// exact usage sum the Context bar shows; measured segments (~chars/4) are
// clamped to fit under it, and whatever's left is the un-itemizable system +
// tool-def + MCP + CLAUDE.md overhead. Returns undefined without a usage sample.
function buildContextBreakdown(
  usage: UsageSnapshot | undefined,
  chars: { msgChars: number; thinkChars: number; toolCallChars: number; toolResultChars: number },
): ContextBreakdown | undefined {
  if (!usage) return undefined;
  const total = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens + usage.outputTokens;
  if (total <= 0) return undefined;
  const tok = (c: number) => Math.ceil(c / 4);
  let messages = tok(chars.msgChars);
  let thinking = tok(chars.thinkChars);
  let toolCalls = tok(chars.toolCallChars);
  let toolResults = tok(chars.toolResultChars);
  const measured = messages + thinking + toolCalls + toolResults;
  // Overshoot (rare: tail-truncated head, char/4 drift) → scale segments to fit.
  if (measured > total && measured > 0) {
    const k = total / measured;
    messages = Math.floor(messages * k);
    thinking = Math.floor(thinking * k);
    toolCalls = Math.floor(toolCalls * k);
    toolResults = Math.floor(toolResults * k);
  }
  const system = Math.max(0, total - (messages + thinking + toolCalls + toolResults));
  return { system, messages, toolCalls, toolResults, thinking, total };
}

async function countClaudeMd(cwd: string): Promise<number> {
  const candidates = [
    cwd ? path.join(cwd, 'CLAUDE.md') : '',
    cwd ? path.join(cwd, '.claude', 'CLAUDE.md') : '',
    path.join(HOME, '.claude', 'CLAUDE.md'),
  ].filter(Boolean);
  let n = 0;
  await Promise.all(
    candidates.map(async (p) => {
      try {
        await fs.access(p);
        n++;
      } catch {
        /* not present */
      }
    }),
  );
  return n;
}

async function countMcpServers(): Promise<number> {
  const paths = [
    path.join(HOME, '.claude', 'settings.json'),
    path.join(HOME, '.claude.json'),
  ];
  for (const p of paths) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const j = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      if (j.mcpServers && typeof j.mcpServers === 'object') {
        return Object.keys(j.mcpServers).length;
      }
    } catch {
      /* file missing or malformed — try next */
    }
  }
  return 0;
}
