// Persisted plugin settings, held in ~/.claude/macaron-config.json.
//
// Data model: the user manages an arbitrary list of Anthropic-compatible
// providers (Macaron, OpenRouter, LiteLLM, self-hosted, …) and picks one
// as active. The special built-in "anthropic" provider always exists,
// uses the user's ambient Claude Code login, and can't be edited/deleted.
//
// Cache is warmed at startup so getActiveProviderEnv() is synchronous —
// hot-path request handlers can call it without awaiting disk I/O.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HOME, MACARON_API_BASE, MACARON_API_KEY } from '../config.js';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

// b200 endpoint used to seed the built-in Macaron provider template on a
// first-run install. Users can edit/delete it like any other custom entry.
const DEFAULT_MACARON_BASE =
  'https://b200-glm51-global-0615-exhrgwayh0b2hkac.z03.azurefd.net/v1';
const DEFAULT_MACARON_MODEL = 'macaron-0.6';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-7';

export type CustomProvider = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
};

export type Settings = {
  activeProviderId: string; // 'anthropic' or a CustomProvider.id
  customProviders: CustomProvider[];
};

// Public projection sent to the client. Never surfaces raw apiKey — only a
// `configured` boolean so the UI can toggle placeholder text.
export type PublicCustomProvider = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  configured: boolean;
};

export type PublicBuiltinProvider = {
  id: 'anthropic';
  name: string;
  description: string;
};

export type PublicSettings = {
  activeProviderId: string;
  builtins: PublicBuiltinProvider[];
  customProviders: PublicCustomProvider[];
};

const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-config.json');

let cache: Settings | null = null;

function seedMacaronProvider(): CustomProvider {
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

function makeDefaults(): Settings {
  return {
    activeProviderId: ANTHROPIC_PROVIDER_ID,
    // Ship one seeded Macaron entry — users see it in the list, can add key,
    // switch to it, or delete it. Same UX as any other custom provider.
    customProviders: [seedMacaronProvider()],
  };
}

// Old shape (0.x): { provider: 'anthropic'|'macaron', providers: { macaron: { apiKey } } }
// Detected by presence of `providers.macaron` at the top level; converted
// to the current shape by wrapping macaron as a custom provider.
function migrateIfLegacy(raw: unknown): Settings {
  const legacy = raw as {
    provider?: string;
    providers?: { macaron?: { apiKey?: string } };
    activeProviderId?: string;
    customProviders?: CustomProvider[];
  };
  if (legacy && Array.isArray(legacy.customProviders)) {
    // Already current shape.
    return {
      activeProviderId: legacy.activeProviderId || ANTHROPIC_PROVIDER_ID,
      customProviders: legacy.customProviders.map(sanitizeProvider),
    };
  }
  // Legacy: rebuild
  const macaron: CustomProvider = {
    id: randomUUID(),
    name: 'Macaron',
    endpoint: MACARON_API_BASE || DEFAULT_MACARON_BASE,
    model: DEFAULT_MACARON_MODEL,
    apiKey: legacy?.providers?.macaron?.apiKey || MACARON_API_KEY || '',
  };
  const wasMacaronActive = legacy?.provider === 'macaron';
  return {
    activeProviderId: wasMacaronActive ? macaron.id : ANTHROPIC_PROVIDER_ID,
    customProviders: [macaron],
  };
}

function sanitizeProvider(p: CustomProvider): CustomProvider {
  return {
    id: String(p.id || randomUUID()),
    name: String(p.name || '').trim() || 'Unnamed provider',
    endpoint: String(p.endpoint || '').trim(),
    model: String(p.model || '').trim(),
    apiKey: String(p.apiKey || ''),
  };
}

async function loadFromDisk(): Promise<Settings> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return migrateIfLegacy(JSON.parse(raw));
  } catch {
    return makeDefaults();
  }
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function readSettings(): Promise<Settings> {
  if (!cache) cache = await loadFromDisk();
  return cache;
}

export async function warmSettingsCache(): Promise<void> {
  await readSettings();
  // Persist any migration/defaults on first boot so the file exists.
  await persist();
}

export async function readPublicSettings(): Promise<PublicSettings> {
  const s = await readSettings();
  return {
    activeProviderId: s.activeProviderId,
    builtins: [
      {
        id: ANTHROPIC_PROVIDER_ID,
        name: 'Anthropic (default)',
        description:
          "Uses your Claude Code login — Opus 4.7 by default. Nothing to configure.",
      },
    ],
    customProviders: s.customProviders.map((p) => ({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      model: p.model,
      configured: Boolean(p.apiKey),
    })),
  };
}

// ---------- CRUD --------------------------------------------------------

export async function addProvider(
  input: Omit<CustomProvider, 'id'>,
): Promise<CustomProvider> {
  const s = await readSettings();
  const created = sanitizeProvider({ ...input, id: randomUUID() });
  s.customProviders.push(created);
  await persist();
  return created;
}

export async function updateProvider(
  id: string,
  patch: Partial<Omit<CustomProvider, 'id'>>,
): Promise<CustomProvider | null> {
  const s = await readSettings();
  const idx = s.customProviders.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const cur = s.customProviders[idx]!;
  const next: CustomProvider = sanitizeProvider({
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

export async function deleteProvider(id: string): Promise<boolean> {
  const s = await readSettings();
  const before = s.customProviders.length;
  s.customProviders = s.customProviders.filter((p) => p.id !== id);
  if (s.customProviders.length === before) return false;
  // If we just deleted the active provider, fall back to anthropic default.
  if (s.activeProviderId === id) s.activeProviderId = ANTHROPIC_PROVIDER_ID;
  await persist();
  return true;
}

export async function setActiveProvider(id: string): Promise<boolean> {
  const s = await readSettings();
  if (id !== ANTHROPIC_PROVIDER_ID && !s.customProviders.some((p) => p.id === id)) {
    return false;
  }
  s.activeProviderId = id;
  await persist();
  return true;
}

// ---------- Active provider → SDK env override -------------------------

// Consumed synchronously by request handlers. Requires the cache to be
// warmed (warmSettingsCache() at startup handles that).
export function getActiveProviderEnv(): {
  model: string | undefined;
  env: Record<string, string> | null;
} {
  const s = cache ?? makeDefaults();
  if (s.activeProviderId === ANTHROPIC_PROVIDER_ID) {
    return { model: DEFAULT_ANTHROPIC_MODEL, env: null };
  }
  const p = s.customProviders.find((x) => x.id === s.activeProviderId);
  if (!p) return { model: DEFAULT_ANTHROPIC_MODEL, env: null };
  return {
    model: p.model || DEFAULT_ANTHROPIC_MODEL,
    env: {
      ...process.env as Record<string, string>,
      ANTHROPIC_BASE_URL: p.endpoint,
      ANTHROPIC_AUTH_TOKEN: p.apiKey,
      ANTHROPIC_API_KEY: p.apiKey,
    },
  };
}
