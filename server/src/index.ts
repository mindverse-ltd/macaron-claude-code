import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { HOST, PORT, WEB_DIST } from './config.js';
import { warmSettingsCache } from './lib/settings-store.js';
import { checkGenUI } from './lib/genui-check.js';

// Claude Agent SDK kills MCP tool calls after 60s by default. Macaron renders
// for complex UIs can take 30-120s, so raise the ceiling to 5 min.
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT || '300000';
import { registerHealthRoutes } from './routes/health.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerRelayRoutes } from './routes/relay.js';

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
});

// Static assets + SPA fallback. In dev (vite dev server on :5173 with proxy),
// WEB_DIST may not exist — just register a 404 handler in that case.
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: '/',
  });
  app.setNotFoundHandler((req, reply) => {
    // Don't serve index.html for /api paths — let them surface as 404 JSON.
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not found', path: req.url });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`web dist not found at ${WEB_DIST} — running in API-only mode (use vite dev for the UI)`);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: 'not found', path: req.url }),
  );
}

try {
  await warmSettingsCache();
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
