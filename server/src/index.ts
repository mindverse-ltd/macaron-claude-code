import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { HOST, PORT, WEB_DIST } from './config.js';
import { warmSettingsCache } from './lib/settings-store.js';
import { warmCodexConfigCache } from './lib/codex-config.js';
import { checkGenUI } from './lib/genui-check.js';

// Claude Agent SDK kills MCP tool calls after 60s by default. Macaron renders
// for complex UIs can take 30-120s, so raise the ceiling to 5 min.
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT || '300000';
import { registerHealthRoutes } from './routes/health.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerRelayRoutes } from './routes/relay.js';
import { registerCodexRoutes } from './routes/codex.js';
import { registerGitRoutes } from './routes/git.js';

const app = Fastify({
  logger: { level: process.env.MACARON_LOG_LEVEL || 'info' },
  // Disable strict trailing-slash for friendlier URLs.
  ignoreTrailingSlash: true,
  // Allow large request bodies (genui prompts can grow).
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(async (instance) => {
  await registerHealthRoutes(instance);
  await registerSettingsRoutes(instance);
  await registerRelayRoutes(instance);
  await registerWorkspaceRoutes(instance);
  await registerSessionRoutes(instance);
  await registerCodexRoutes(instance);
  await registerGitRoutes(instance);
});

// Static assets + SPA fallback. In dev (vite dev server on :5173 with proxy),
// WEB_DIST may not exist — just register a 404 handler in that case.
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: '/',
    // Don't auto-serve index.html at `/` — we route it ourselves so
    // MACARON_ENGINE=codex can steer `/` to codex.html instead.
    index: false,
  });
  // Two SPA entries live side-by-side in web/dist: index.html (claude) and
  // codex.html. The env decides which one is the SPA fallback for `/` and
  // any deep-link URL, so `mcc` boots the claude UI and `mcx` boots codex
  // from the same server binary. Static assets (JS/CSS/wasm chunks) come
  // from the shared /assets/ folder and are shared between entries.
  const spaEntry = process.env.MACARON_ENGINE === 'codex' ? 'codex.html' : 'index.html';
  // Explicit root — fastify-static's `index: false` refuses `/`, so own it here.
  app.get('/', (_req, reply) => reply.sendFile(spaEntry));
  app.setNotFoundHandler((req, reply) => {
    // Don't serve the SPA for /api paths — let them surface as 404 JSON.
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not found', path: req.url });
    }
    return reply.sendFile(spaEntry);
  });
} else {
  app.log.warn(`web dist not found at ${WEB_DIST} — running in API-only mode (use vite dev for the UI)`);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: 'not found', path: req.url }),
  );
}

try {
  await warmSettingsCache();
  await warmCodexConfigCache();
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`macaron server listening on http://${HOST}:${PORT}`);
  // Pre-warm the render_ui TS check: the first diagnose pays full program construction. Do it now,
  // at boot, instead of mid-turn while an SSE stream is live. The `import "$macaron/ui"` is what
  // makes this warm the expensive half — it pulls source.tsx and its whole vendored tree into the
  // snapshot cache; without an import TS lazily skips them and the first real render_ui still pays
  // ~300ms. checkGenUI never throws (it degrades to an ack on failure), so this can't crash boot.
  setImmediate(() => checkGenUI('import "$macaron/ui";\nexport default function App() { return null }'));
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
