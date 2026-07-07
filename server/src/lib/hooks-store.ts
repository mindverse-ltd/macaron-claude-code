// Read-only reader for the `hooks` block of Claude Code settings.json files.
//
// Claude Code lets settings define hooks — shell commands / HTTP endpoints /
// prompts that fire at lifecycle events (PreToolUse, PostToolUse, Stop, …).
// They silently mutate agent behaviour, so the WebUI surfaces them for
// debugging. We only READ; editing stays in the user's editor of choice.
//
// Precedence mirrors Claude Code's own layering (see hooks docs):
//   user     ~/.claude/settings.json          (all projects)
//   project  <cwd>/.claude/settings.json       (committed, shared)
//   local    <cwd>/.claude/settings.local.json (per-machine, git-ignored)
//
// The on-disk schema is three levels deep:
//   { hooks: { <Event>: [ { matcher, hooks: [ { type, command, if, url } ] } ] } }
// We flatten it to one HookHandlerView per leaf handler so the client renders
// a flat table without re-implementing the nesting.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';
import type { HookHandlerView, HookScope, HooksResponse } from '@macaron/shared';

type RawHandler = {
  type?: string;
  command?: string;
  url?: string;
  if?: string;
  prompt?: string;
  agent?: string;
};
type RawMatcherGroup = { matcher?: string; hooks?: RawHandler[] };
type RawSettings = { hooks?: Record<string, RawMatcherGroup[]> };

// Best identifier of what a handler actually runs, per kind. Command hooks
// carry a `command`; HTTP hooks a `url`; prompt/agent hooks a short label.
function describeRun(h: RawHandler): string {
  if (h.command) return h.command;
  if (h.url) return h.url;
  if (h.prompt) return h.prompt;
  if (h.agent) return h.agent;
  return '';
}

function flattenSettings(raw: RawSettings, scope: HookScope, source: string): HookHandlerView[] {
  const out: HookHandlerView[] = [];
  const hooks = raw.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = String(group?.matcher ?? '');
      const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const h of handlers) {
        out.push({
          event,
          matcher,
          scope,
          source,
          type: String(h?.type || 'command'),
          run: describeRun(h),
          ...(h?.if ? { condition: String(h.if) } : {}),
        });
      }
    }
  }
  return out;
}

async function readSettingsFile(p: string): Promise<RawSettings | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw) as RawSettings;
  } catch {
    // Missing file or malformed JSON — treat as "no hooks here".
    return null;
  }
}

// Resolve the three settings.json locations. `cwd` is optional: without it,
// only user-scope hooks are returned (the /hooks page before a workspace is
// picked).
function sourcePaths(cwd?: string): Array<{ scope: HookScope; path: string }> {
  const paths: Array<{ scope: HookScope; path: string }> = [
    { scope: 'user', path: path.join(HOME, '.claude', 'settings.json') },
  ];
  if (cwd) {
    paths.push({ scope: 'project', path: path.join(cwd, '.claude', 'settings.json') });
    paths.push({ scope: 'local', path: path.join(cwd, '.claude', 'settings.local.json') });
  }
  return paths;
}

export async function readHooks(cwd?: string): Promise<HooksResponse> {
  const wanted = sourcePaths(cwd);
  const results = await Promise.all(
    wanted.map(async ({ scope, path: p }) => {
      const raw = await readSettingsFile(p);
      return {
        scope,
        path: p,
        present: raw !== null,
        handlers: raw ? flattenSettings(raw, scope, p) : [],
      };
    }),
  );
  return {
    handlers: results.flatMap((r) => r.handlers),
    sources: results.map(({ scope, path, present }) => ({ scope, path, present })),
  };
}
