// Persistent Codex-runner config, held in ~/.claude/macaron-codex-config.json.
//
// The Codex CLI reads its provider/model/reasoning knobs from ~/.codex/config.toml,
// but our plugin needs the same knobs in a form we can pass via CodexOptions +
// ThreadOptions when spawning threads programmatically. This module gives us
// that: one JSON file the WebUI can edit, one loader the runner consumes.
//
// The apiKey lives in this file (not in git). Users paste it once via Settings.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';
import type {
  ApprovalMode,
  ModelReasoningEffort,
  SandboxMode,
} from '@openai/codex-sdk';

export type CodexProviderConfig = {
  /** Human-facing name for the WebUI's ProviderPicker. */
  name: string;
  /** Anthropic-style OpenAI-compatible endpoint (`.../v1` or root). */
  baseUrl: string;
  /** Bearer token for the endpoint. */
  apiKey: string;
  /** Model id sent to the endpoint. */
  model: string;
  /** `wire_api` — `responses` for GPT-5-family / `chat` for legacy. */
  wireApi: 'responses' | 'chat';
  /** Provider display name recorded in ~/.codex/sessions rollouts. */
  modelProvider: string;
  /** Reasoning effort — passed to ThreadOptions and mirrored as config. */
  reasoningEffort: ModelReasoningEffort;
  /** Sandbox mode for Codex agent tool calls. */
  sandboxMode: SandboxMode;
  /** Approval policy — MVP uses `never` since SDK has no callback yet. */
  approvalPolicy: ApprovalMode;
  /** Enable Codex's web_search tool. */
  webSearchEnabled: boolean;
  /** Model context window — passed through to codex CLI config. */
  contextWindow: number;
  /** Auto-compact trigger — passed through to codex CLI config. */
  autoCompactTokenLimit: number;
  /** Disable OpenAI-style response storage. */
  disableResponseStorage: boolean;
};

export type CodexSettings = {
  provider: CodexProviderConfig;
};

const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-codex-config.json');

function defaults(): CodexSettings {
  return {
    provider: {
      name: 'Macaron GLM',
      baseUrl: 'https://pi-api-cn.macaron.xin',
      apiKey: process.env.MACARON_CODEX_API_KEY || '',
      model: 'gpt-5.5',
      wireApi: 'responses',
      modelProvider: 'OpenAI',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      webSearchEnabled: false,
      contextWindow: 200_000,
      autoCompactTokenLimit: 180_000,
      disableResponseStorage: true,
    },
  };
}

let cache: CodexSettings | null = null;

async function loadFromDisk(): Promise<CodexSettings> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CodexSettings>;
    const d = defaults();
    return {
      provider: { ...d.provider, ...(parsed.provider || {}) },
    };
  } catch {
    return defaults();
  }
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function warmCodexConfigCache(): Promise<void> {
  cache = await loadFromDisk();
  await persist();
}

export function getCodexConfig(): CodexSettings {
  return cache ?? defaults();
}

export async function updateCodexProvider(
  patch: Partial<CodexProviderConfig>,
): Promise<CodexSettings> {
  if (!cache) cache = await loadFromDisk();
  cache.provider = { ...cache.provider, ...patch };
  await persist();
  return cache;
}

// Public projection for the WebUI. Never surfaces raw apiKey.
export type PublicCodexSettings = {
  provider: Omit<CodexProviderConfig, 'apiKey'> & { configured: boolean };
};

export function readPublicCodexSettings(): PublicCodexSettings {
  const p = (cache ?? defaults()).provider;
  const { apiKey, ...rest } = p;
  return { provider: { ...rest, configured: Boolean(apiKey) } };
}
