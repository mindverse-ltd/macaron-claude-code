import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { HOST, PORT, WEB_DIST, isMacaronConfigured } from './config.js';

// Claude Agent SDK kills MCP tool calls after 60s by default. Macaron renders
// for complex UIs can take 30-120s, so raise the ceiling to 5 min.
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT || '300000';
import { registerHealthRoutes } from './routes/health.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerGenuiRoutes } from './routes/genui.js';

const app = Fastify({
  logger: { level: process.env.MACARON_LOG_LEVEL || 'info' },
  // Disable strict trailing-slash for friendlier URLs.
  ignoreTrailingSlash: true,
  // Allow large request bodies (genui prompts can grow).
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(async (instance) => {
  await registerHealthRoutes(instance);
  await registerWorkspaceRoutes(instance);
  await registerSessionRoutes(instance);
  await registerGenuiRoutes(instance);
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
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`macaron server listening on http://${HOST}:${PORT}`);
  if (!isMacaronConfigured()) {
    app.log.warn(
      'MACARON_API_BASE / MACARON_API_KEY not set — Claude features work; GenUI Builder and Macaron-0.6 model will return 503 until configured.',
    );
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
