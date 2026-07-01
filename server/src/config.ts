import os from 'node:os';
import path from 'node:path';

export const PORT = parseInt(process.env.MACARON_PORT || '7878', 10);
export const HOST = process.env.MACARON_HOST || '127.0.0.1';

// Macaron API is optional — the Claude Code path (default experience) works
// without it. GenUI Builder and the Macaron-0.6 chat model need these set;
// each endpoint checks at call time and returns a helpful 503 if missing.
export const MACARON_API_BASE = process.env.MACARON_API_BASE || '';
export const MACARON_API_KEY = process.env.MACARON_API_KEY || '';
export const MACARON_MODEL = process.env.MACARON_MODEL || 'macaron-0.6';
export const isMacaronConfigured = (): boolean =>
  Boolean(MACARON_API_BASE) && Boolean(MACARON_API_KEY);
export const MACARON_CONFIG_HINT =
  'Set MACARON_API_BASE and MACARON_API_KEY (see .env.example). WebUI settings panel coming soon.';

export const GENUI_SYSTEM_PROMPT_URL = 'https://genui.macaron.im/api/system-prompt';

export const HOME = os.homedir();
export const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

// Web assets (Vite build output). When running in dev (vite dev server on :5173
// with proxy), this directory may not exist — @fastify/static handles that.
// src/config.ts → ../../web/dist  (and after build: dist/config.js → ../../web/dist)
export const WEB_DIST = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'web',
  'dist',
);
