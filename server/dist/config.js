import os from 'node:os';
import path from 'node:path';
export const PORT = parseInt(process.env.MACARON_PORT || '7878', 10);
export const HOST = process.env.MACARON_HOST || '127.0.0.1';
// Optional shared token that gates the API when the server is reachable from
// the network. Empty = auth off (the default for loopback-only binds).
export const AUTH_TOKEN = process.env.MACARON_AUTH_TOKEN || '';
// Optional env overrides. Users normally set the Macaron API key via the
// Settings page (persisted to ~/.claude/macaron-config.json); env vars still
// win for ops-driven / one-shot invocations.
export const MACARON_API_BASE = process.env.MACARON_API_BASE || '';
export const MACARON_API_KEY = process.env.MACARON_API_KEY || '';
export const MACARON_MODEL = process.env.MACARON_MODEL || 'macaron-0.6';
// Speech-to-text backend. Any OpenAI-compatible `/audio/transcriptions`
// endpoint (OpenAI, Groq, LocalAI, Speaches, a Macaron audio host…). The
// feature is off until STT_API_KEY is set — the mic button stays hidden.
export const STT_BASE_URL = (process.env.MACARON_STT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
export const STT_API_KEY = process.env.MACARON_STT_API_KEY || '';
export const STT_MODEL = process.env.MACARON_STT_MODEL || 'whisper-1';
export const STT_LANGUAGE = process.env.MACARON_STT_LANGUAGE || '';
export const HOME = os.homedir();
export const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
// Web root (repo's web/ dir). Same hop from compiled location in both dev (tsx src/) and prod (node dist/).
// src/config.ts → ../../web  (and after build: dist/config.js → ../../web)
export const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..', 'web');
// Web assets (Vite build output). When running in dev (vite dev server on :5173 with proxy), this directory may not exist — @fastify/static handles that.
export const WEB_DIST = path.join(WEB_ROOT, 'dist');
//# sourceMappingURL=config.js.map