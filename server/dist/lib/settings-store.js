// Persisted plugin settings, held in ~/.claude/macaron-config.json.
//
// Data model: the user manages an arbitrary list of Anthropic-compatible
// providers (Macaron, OpenRouter, LiteLLM, self-hosted, …) and picks one
// as active. The special built-in "anthropic" provider always exists,
// uses the user's ambient Claude Code login, and can't be edited/deleted.
//
// Cache is warmed at startup so getActiveProviderEnv() is synchronous —
// hot-path request handlers can call it without awaiting disk I/O.
import { promises as fs, mkdirSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HOME, HOST, PORT, MACARON_API_BASE, MACARON_API_KEY } from '../config.js';
// The built-in pass-through provider. Never touches the SDK subprocess env —
// it inherits process.env unchanged. Whatever ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN the user has in their shell (Claude Code login,
// a GLM relay, LiteLLM, Bedrock, …) is exactly what runs.
export const SYSTEM_PROVIDER_ID = 'system';
// Legacy id kept for one-shot migration only.
const LEGACY_ANTHROPIC_ID = 'anthropic';
// b200 endpoint used to seed the built-in Macaron provider template on a
// first-run install. Users can edit/delete it like any other custom entry.
const DEFAULT_MACARON_BASE = 'https://b200-glm51-global-0615-exhrgwayh0b2hkac.z03.azurefd.net/v1';
const DEFAULT_MACARON_MODEL = 'macaron-0.6';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-7';
const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-config.json');
let cache = null;
function seedMacaronProvider() {
    return {
        id: randomUUID(),
        name: 'Macaron',
        endpoint: MACARON_API_BASE || DEFAULT_MACARON_BASE,
        model: DEFAULT_MACARON_MODEL,
        // Seed from env var so old .env-based setups keep working without a
        // WebUI save. Blank if no env var.
        apiKey: MACARON_API_KEY || '',
    };
}
function makeDefaults() {
    return {
        activeProviderId: SYSTEM_PROVIDER_ID,
        // Ship one seeded Macaron entry — users see it in the list, can add key,
        // switch to it, or delete it. Same UX as any other custom provider.
        customProviders: [seedMacaronProvider()],
        yoloMode: false,
    };
}
function normalizeActiveId(id) {
    // Old configs used 'anthropic' as the built-in id; unify on 'system'.
    return id === LEGACY_ANTHROPIC_ID ? SYSTEM_PROVIDER_ID : id;
}
// Old shape (0.x): { provider: 'anthropic'|'macaron', providers: { macaron: { apiKey } } }
// Detected by presence of `providers.macaron` at the top level; converted
// to the current shape by wrapping macaron as a custom provider.
function migrateIfLegacy(raw) {
    const legacy = raw;
    if (legacy && Array.isArray(legacy.customProviders)) {
        // Already current shape — just normalize the legacy 'anthropic' id.
        return {
            activeProviderId: normalizeActiveId(legacy.activeProviderId || SYSTEM_PROVIDER_ID),
            customProviders: legacy.customProviders.map(sanitizeProvider),
            yoloMode: Boolean(legacy.yoloMode),
        };
    }
    // Legacy: rebuild
    const macaron = {
        id: randomUUID(),
        name: 'Macaron',
        endpoint: MACARON_API_BASE || DEFAULT_MACARON_BASE,
        model: DEFAULT_MACARON_MODEL,
        apiKey: legacy?.providers?.macaron?.apiKey || MACARON_API_KEY || '',
    };
    const wasMacaronActive = legacy?.provider === 'macaron';
    return {
        activeProviderId: wasMacaronActive ? macaron.id : SYSTEM_PROVIDER_ID,
        customProviders: [macaron],
        yoloMode: Boolean(legacy?.yoloMode),
    };
}
function sanitizeProvider(p) {
    return {
        id: String(p.id || randomUUID()),
        name: String(p.name || '').trim() || 'Unnamed provider',
        endpoint: String(p.endpoint || '').trim(),
        model: String(p.model || '').trim(),
        apiKey: String(p.apiKey || ''),
    };
}
async function loadFromDisk() {
    try {
        const raw = await fs.readFile(CONFIG_PATH, 'utf8');
        return migrateIfLegacy(JSON.parse(raw));
    }
    catch {
        return makeDefaults();
    }
}
async function persist() {
    if (!cache)
        return;
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}
export async function readSettings() {
    if (!cache)
        cache = await loadFromDisk();
    return cache;
}
export async function warmSettingsCache() {
    await readSettings();
    // Persist any migration/defaults on first boot so the file exists.
    await persist();
}
export async function readPublicSettings() {
    const s = await readSettings();
    const envBase = process.env.ANTHROPIC_BASE_URL || '';
    const usingRelay = Boolean(envBase);
    return {
        activeProviderId: s.activeProviderId,
        builtins: [
            {
                id: SYSTEM_PROVIDER_ID,
                name: 'System default',
                description: usingRelay
                    ? "Passes through your shell's ANTHROPIC_BASE_URL — the SDK will hit your configured relay/gateway. We don't touch anything."
                    : "Uses your Claude Code login untouched. We don't override any env vars.",
                detectedEndpoint: usingRelay ? envBase : null,
            },
        ],
        customProviders: s.customProviders.map((p) => ({
            id: p.id,
            name: p.name,
            endpoint: p.endpoint,
            model: p.model,
            configured: Boolean(p.apiKey),
        })),
        yoloMode: s.yoloMode,
    };
}
// ---------- CRUD --------------------------------------------------------
export async function addProvider(input) {
    const s = await readSettings();
    const created = sanitizeProvider({ ...input, id: randomUUID() });
    s.customProviders.push(created);
    await persist();
    return created;
}
export async function updateProvider(id, patch) {
    const s = await readSettings();
    const idx = s.customProviders.findIndex((p) => p.id === id);
    if (idx < 0)
        return null;
    const cur = s.customProviders[idx];
    const next = sanitizeProvider({
        id: cur.id,
        name: patch.name ?? cur.name,
        endpoint: patch.endpoint ?? cur.endpoint,
        model: patch.model ?? cur.model,
        // Blank apiKey means "keep existing" — matches the UI's "leave blank to
        // preserve" pattern. Callers who want to CLEAR the key should pass a
        // sentinel; not needed for now.
        apiKey: patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : cur.apiKey,
    });
    s.customProviders[idx] = next;
    await persist();
    return next;
}
export async function deleteProvider(id) {
    const s = await readSettings();
    const before = s.customProviders.length;
    s.customProviders = s.customProviders.filter((p) => p.id !== id);
    if (s.customProviders.length === before)
        return false;
    // If we just deleted the active provider, fall back to anthropic default.
    if (s.activeProviderId === id)
        s.activeProviderId = SYSTEM_PROVIDER_ID;
    await persist();
    return true;
}
export async function setActiveProvider(id) {
    const s = await readSettings();
    if (id !== SYSTEM_PROVIDER_ID && !s.customProviders.some((p) => p.id === id)) {
        return false;
    }
    s.activeProviderId = id;
    await persist();
    return true;
}
// ---------- Active provider → SDK env override -------------------------
// Isolated CLAUDE_CONFIG_DIR for subprocesses run against a custom provider.
// Claude Code CLI reads its OAuth session from ~/.claude/settings.json on
// startup, which would otherwise beat any ANTHROPIC_AUTH_TOKEN we set in
// the subprocess env. We give it a fresh empty dir so the subprocess falls
// through to env-based auth against the custom provider.
//
// Caveat: the CLI ALSO stores session jsonls under <config_dir>/projects/.
// If we let those write to the isolated dir, our WebUI (which reads from
// ~/.claude/projects/) never sees the new session. Fix: symlink
// <isolated>/projects → ~/.claude/projects so sessions land in the same
// place terminal `claude` uses. Terminal `claude` sessions and our
// subprocess sessions coexist in one project tree; only auth is isolated.
const ISOLATED_CONFIG_DIR = path.join(os.tmpdir(), 'macaron-plugin-isolated-claude');
let isolatedDirReady = false;
function ensureIsolatedDir() {
    if (!isolatedDirReady) {
        if (!existsSync(ISOLATED_CONFIG_DIR))
            mkdirSync(ISOLATED_CONFIG_DIR, { recursive: true });
        // Symlink projects/ so jsonls land in ~/.claude/projects/ where the
        // WebUI can read them.
        const projectsLink = path.join(ISOLATED_CONFIG_DIR, 'projects');
        const realProjects = path.join(HOME, '.claude', 'projects');
        if (!existsSync(realProjects))
            mkdirSync(realProjects, { recursive: true });
        try {
            const st = lstatSync(projectsLink);
            // Repair if it's not a symlink or points elsewhere.
            if (!st.isSymbolicLink()) {
                // A stray dir was created here on an earlier run; replace it.
                fs.rm(projectsLink, { recursive: true, force: true }).catch(() => { });
                symlinkSync(realProjects, projectsLink);
            }
        }
        catch {
            // Doesn't exist — create the symlink.
            try {
                symlinkSync(realProjects, projectsLink);
            }
            catch { /* already there */ }
        }
        isolatedDirReady = true;
    }
    return ISOLATED_CONFIG_DIR;
}
// Consumed synchronously by request handlers. Requires the cache to be
// warmed (warmSettingsCache() at startup handles that).
// Direct-call variant for server-side operations that need to hit the
// active provider's endpoint themselves (e.g. /compact — where we don't
// want to spawn the whole SDK subprocess just to summarize). Returns null
// when the active provider is `system`, since that path relies on the
// user's ambient Claude auth we don't have server-side.
export function getActiveProviderRaw() {
    const s = cache ?? makeDefaults();
    if (s.activeProviderId === SYSTEM_PROVIDER_ID)
        return null;
    const p = s.customProviders.find((x) => x.id === s.activeProviderId);
    if (!p)
        return null;
    return { id: p.id, name: p.name, endpoint: p.endpoint, model: p.model, apiKey: p.apiKey };
}
// Sync getter for hot-path consumers (claude-runner reads this on every run
// to decide whether to force bypassPermissions). Cache is warmed at startup
// by warmSettingsCache(), so this never blocks on disk I/O.
export function getYoloMode() {
    return (cache ?? makeDefaults()).yoloMode ?? false;
}
export async function setYoloMode(enabled) {
    const s = await readSettings();
    s.yoloMode = Boolean(enabled);
    await persist();
}
export function getActiveProviderEnv() {
    const s = cache ?? makeDefaults();
    if (s.activeProviderId === SYSTEM_PROVIDER_ID) {
        return { model: DEFAULT_ANTHROPIC_MODEL, env: null };
    }
    const p = s.customProviders.find((x) => x.id === s.activeProviderId);
    if (!p)
        return { model: DEFAULT_ANTHROPIC_MODEL, env: null };
    const isolatedDir = ensureIsolatedDir();
    // Point the SDK subprocess at our local Anthropic-compatible relay rather
    // than at the provider directly. The relay stubs the /v1/ endpoints the
    // CLI probes at startup (models, org, telemetry) that Macaron doesn't
    // implement, and forwards /v1/messages verbatim after rewriting body.model
    // to the provider's canonical name. This way the CLI's startup checks
    // pass and requests actually reach the provider.
    const relayBase = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/relay/anthropic/${p.id}`;
    return {
        // Pass the provider's model name to SDK (best-effort — relay rewrites
        // anyway). Keeping a valid Anthropic name here also placates SDK
        // client-side model validation.
        model: p.model || DEFAULT_ANTHROPIC_MODEL,
        env: {
            ...process.env,
            // Isolate from user's OAuth session so env-based auth wins.
            CLAUDE_CONFIG_DIR: isolatedDir,
            // Clear any stale OAuth token that might be passed through.
            CLAUDE_CODE_OAUTH_TOKEN: '',
            // Point SDK subprocess at our local relay (see relay.ts).
            ANTHROPIC_BASE_URL: relayBase,
            // Relay uses the provider's key server-side; we still set the env
            // token so the SDK considers itself "authenticated" and skips OAuth.
            ANTHROPIC_AUTH_TOKEN: p.apiKey,
            ANTHROPIC_API_KEY: p.apiKey,
            ANTHROPIC_MODEL: p.model || DEFAULT_ANTHROPIC_MODEL,
        },
    };
}
//# sourceMappingURL=settings-store.js.map