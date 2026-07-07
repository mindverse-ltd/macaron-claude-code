// Saved prompts / custom slash commands, stored as one `.md` file per command
// under ~/.claude/commands/ — the exact layout Claude Code's CLI reads for
// user-scoped `/name` commands. A saved prompt IS a command file, so the
// WebUI's library and the CLI's `/` palette stay the same source of truth.
//
// File shape (optional YAML frontmatter + Markdown body):
//   ---
//   description: Review a PR for correctness and risk
//   argument-hint: <PR number>
//   ---
//   Review pull request $ARGUMENTS with the following structure: …

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLAUDE_COMMANDS } from '../config.js';
import type { SavedCommand } from '@macaron/shared';

// `/name` invocation → filename stem. Keep it filesystem- and CLI-safe:
// lowercase, digits, dash, underscore. Reject path separators so a crafted
// name can't escape the commands dir.
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && name.length <= 64;
}

function fileFor(name: string): string {
  return path.join(CLAUDE_COMMANDS, `${name}.md`);
}

// Split a `.md` file into (frontmatter fields, body). Only the two fields a
// saved-prompt library needs are surfaced — `description` and `argument-hint`.
// Anything else in the frontmatter (model, allowed-tools, …) is preserved
// on disk but ignored here; editing a command round-trips through
// serialize(), which only re-emits the two known fields, so unknown fields
// are dropped on save — acceptable for the first slice.
function parse(raw: string): { description: string; argumentHint: string; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { description: '', argumentHint: '', body: raw.trim() };
  const [, fm, body] = m;
  let description = '';
  let argumentHint = '';
  for (const line of fm!.split('\n')) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const val = kv[2]!.trim().replace(/^["']|["']$/g, '');
    if (key === 'description') description = val;
    else if (key === 'argument-hint') argumentHint = val;
  }
  return { description, argumentHint, body: (body || '').trim() };
}

function serialize(input: { description: string; argumentHint: string; body: string }): string {
  const fm: string[] = [];
  if (input.description) fm.push(`description: ${input.description}`);
  if (input.argumentHint) fm.push(`argument-hint: ${input.argumentHint}`);
  const head = fm.length ? `---\n${fm.join('\n')}\n---\n\n` : '';
  return `${head}${input.body.trim()}\n`;
}

export async function listCommands(): Promise<SavedCommand[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(CLAUDE_COMMANDS);
  } catch {
    return []; // dir doesn't exist yet — no commands
  }
  const out: SavedCommand[] = [];
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3);
    if (!isValidName(name)) continue; // skip namespaced/subdir shapes for now
    try {
      const full = path.join(CLAUDE_COMMANDS, f);
      const [raw, st] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      const parsed = parse(raw);
      out.push({ name, ...parsed, mtime: st.mtimeMs });
    } catch {
      /* unreadable file — skip */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getCommand(name: string): Promise<SavedCommand | null> {
  if (!isValidName(name)) return null;
  try {
    const full = fileFor(name);
    const [raw, st] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
    return { name, ...parse(raw), mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

export type CommandInput = { description?: string; argumentHint?: string; body: string };

// Create fails if the name is taken; callers rename or edit instead of
// silently clobbering someone's existing command.
export async function createCommand(name: string, input: CommandInput): Promise<SavedCommand> {
  if (!isValidName(name)) throw new Error('invalid name');
  await fs.mkdir(CLAUDE_COMMANDS, { recursive: true });
  const full = fileFor(name);
  try {
    await fs.access(full);
    throw new Error('command already exists');
  } catch (e) {
    if ((e as Error).message === 'command already exists') throw e;
    /* ENOENT — good, free to create */
  }
  const doc = serialize({ description: input.description || '', argumentHint: input.argumentHint || '', body: input.body });
  await fs.writeFile(full, doc, 'utf8');
  return (await getCommand(name))!;
}

export async function updateCommand(name: string, input: CommandInput): Promise<SavedCommand | null> {
  if (!isValidName(name)) return null;
  const full = fileFor(name);
  try {
    await fs.access(full);
  } catch {
    return null;
  }
  const doc = serialize({ description: input.description || '', argumentHint: input.argumentHint || '', body: input.body });
  await fs.writeFile(full, doc, 'utf8');
  return await getCommand(name);
}

export async function deleteCommand(name: string): Promise<boolean> {
  if (!isValidName(name)) return false;
  try {
    await fs.unlink(fileFor(name));
    return true;
  } catch {
    return false;
  }
}
