// Persisted user settings for the Macaron plugin, held in
// ~/.claude/macaron-config.json. Loaded lazily on first read and written
// synchronously on every PUT so a subsequent GET on a different request
// sees the fresh value. Env vars (MACARON_API_BASE / MACARON_API_KEY)
// still take precedence over the on-disk config for ops overrides.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME, MACARON_API_BASE, MACARON_API_KEY } from '../config.js';

export type Provider = 'anthropic' | 'macaron';

export type Settings = {
  provider: Provider;
  providers: {
    macaron: {
      apiKey: string;
    };
  };
};

// Default Macaron endpoint — this is the b200 Anthropic-compatible URL,
// baked in so users only ever need to supply their key.
const DEFAULT_MACARON_BASE =
  'https://b200-glm51-global-0615-exhrgwayh0b2hkac.z03.azurefd.net/v1';
const DEFAULT_MACARON_MODEL = 'macaron-0.6';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-7';

const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-config.json');

let cache: Settings | null = null;

function makeDefaults(): Settings {
  return {
    provider: 'anthropic',
    providers: {
      macaron: {
        // Env var wins over on-disk during initial hydration so old .env-based
        // setups keep working without a WebUI save.
        apiKey: MACARON_API_KEY || '',
      },
    },
  };
}

async function loadFromDisk(): Promise<Settings> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const defaults = makeDefaults();
    return {
      provider: parsed.provider === 'macaron' ? 'macaron' : 'anthropic',
      providers: {
        macaron: {
          apiKey:
            (parsed.providers?.macaron?.apiKey ?? defaults.providers.macaron.apiKey) || '',
        },
      },
    };
  } catch {
    return makeDefaults();
  }
}

export async function readSettings(): Promise<Settings> {
  if (!cache) cache = await loadFromDisk();
  return cache;
}

export async function writeSettings(next: Partial<Settings>): Promise<Settings> {
  const current = await readSettings();
  const merged: Settings = {
    provider: next.provider ?? current.provider,
    providers: {
      macaron: {
        apiKey:
          next.providers?.macaron?.apiKey ?? current.providers.macaron.apiKey,
      },
    },
  };
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  cache = merged;
  return merged;
}

// Non-secret view for the client (never surface the raw key — send a
// `configured` boolean instead so the UI can toggle placeholder text).
export type PublicSettings = {
  provider: Provider;
  providers: {
    macaron: {
      base: string;
      model: string;
      configured: boolean;
    };
  };
};

export async function readPublicSettings(): Promise<PublicSettings> {
  const s = await readSettings();
  return {
    provider: s.provider,
    providers: {
      macaron: {
        base: MACARON_API_BASE || DEFAULT_MACARON_BASE,
        model: DEFAULT_MACARON_MODEL,
        configured: Boolean(s.providers.macaron.apiKey),
      },
    },
  };
}

// Compute env-var overrides for the Claude Code SDK subprocess so it talks
// to the configured provider's endpoint. Returns:
//   { model, env }
// where `env` is null for the default Anthropic path (SDK uses ambient
// credentials — the user's own claude auth) and populated for Macaron.
export function getProviderEnv(): {
  model: string | undefined;
  env: Record<string, string> | null;
} {
  // Read synchronously via cache — this runs on the request hot path so we
  // can't await. Callers should ensure readSettings() has been triggered at
  // startup or on first request (it will be by the /api/settings GET the
  // WebUI issues on load).
  const s = cache ?? makeDefaults();
  if (s.provider === 'macaron') {
    const key = s.providers.macaron.apiKey;
    return {
      model: DEFAULT_MACARON_MODEL,
      env: {
        // Spread inherited env so PATH, HOME, keychain access etc. work.
        ...process.env as Record<string, string>,
        ANTHROPIC_BASE_URL: MACARON_API_BASE || DEFAULT_MACARON_BASE,
        ANTHROPIC_AUTH_TOKEN: key,
        // Some SDK versions also read API_KEY; set both.
        ANTHROPIC_API_KEY: key,
      },
    };
  }
  return { model: DEFAULT_ANTHROPIC_MODEL, env: null };
}

// Warm the cache at server startup so the first request already has settings
// in memory (avoids racing the first getProviderEnv() call with an unresolved
// loadFromDisk promise).
export async function warmSettingsCache(): Promise<void> {
  await readSettings();
}
