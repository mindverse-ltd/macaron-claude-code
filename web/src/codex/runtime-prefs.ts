// Last-used per-turn runtime override for the Codex composer, persisted per
// workspace (like lib/history.ts). The new-thread route ('/') has no project,
// so it shares the '_' bucket; workspace tiles key on their project id.

import type { CodexRuntimeOverride } from './api';

const STORAGE_PREFIX = 'macaron.codex.runtime.';

function storageKey(project: string): string {
  return STORAGE_PREFIX + (project || '_');
}

export function loadRuntimePref(project: string): CodexRuntimeOverride {
  try {
    const raw = localStorage.getItem(storageKey(project));
    return raw ? (JSON.parse(raw) as CodexRuntimeOverride) : {};
  } catch {
    return {};
  }
}

export function saveRuntimePref(project: string, pref: CodexRuntimeOverride): void {
  try {
    localStorage.setItem(storageKey(project), JSON.stringify(pref));
  } catch {
    /* quota / private mode — ignore */
  }
}
