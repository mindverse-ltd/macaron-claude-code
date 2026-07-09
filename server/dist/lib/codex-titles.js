// Macaron-side sidecar mapping a Codex threadId → a generated sidebar title.
//
// The rollout `.jsonl` under ~/.codex/sessions is Codex-owned, so we never
// write titles into it. Instead we keep our own tiny JSON map in the macaron
// config dir, exactly like codex-config.ts persists provider settings.
//
// Cache is warmed at startup so getCodexTitle() is synchronous on the
// listCodexSessions() hot path (one lookup per rendered row).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';
const TITLES_PATH = path.join(HOME, '.claude', 'macaron-codex-titles.json');
let cache = null;
async function loadFromDisk() {
    try {
        const raw = await fs.readFile(TITLES_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
async function persist() {
    if (!cache)
        return;
    await fs.mkdir(path.dirname(TITLES_PATH), { recursive: true });
    await fs.writeFile(TITLES_PATH, JSON.stringify(cache, null, 2), 'utf8');
}
export async function warmCodexTitlesCache() {
    cache = await loadFromDisk();
}
export function getCodexTitle(sid) {
    return (cache ?? {})[sid];
}
export async function setCodexTitle(sid, title) {
    if (!cache)
        cache = await loadFromDisk();
    cache[sid] = title;
    await persist();
}
export async function deleteCodexTitle(sid) {
    if (!cache)
        cache = await loadFromDisk();
    if (!(sid in cache))
        return;
    delete cache[sid];
    await persist();
}
//# sourceMappingURL=codex-titles.js.map