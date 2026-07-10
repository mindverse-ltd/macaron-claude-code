import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { AUTH_TOKEN, HOST, PORT, WEB_DIST } from './config.js';
import { makeAuthHook, redactTokenInUrl, resolveToken } from './lib/auth.js';
import { warmSettingsCache } from './lib/settings-store.js';
import { warmWorktreeCache } from './lib/worktree-store.js';
import { warmPermissionRulesCache } from './lib/permission-rules.js';
import { warmShareCache } from './lib/share-store.js';
import { warmCodexConfigCache } from './lib/codex-config.js';
import { warmLabelsCache } from './lib/label-store.js';
import { warmSchedulesCache } from './lib/schedule-store.js';
import { startScheduler } from './lib/scheduler.js';
import { warmCodexTitlesCache } from './lib/codex-titles.js';
import { checkGenUI } from './lib/genui-check.js';
import { startSessionWatcher } from './lib/session-watcher.js';

// Claude Agent SDK kills MCP tool calls after 60s by default. Macaron renders
// for complex UIs can take 30-120s, so raise the ceiling to 5 min.
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT || '300000';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerWorktreeRoutes } from './routes/worktrees.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerConfigFileRoutes } from './routes/config-files.js';
import { registerRelayRoutes } from './routes/relay.js';
import { registerCodexRoutes } from './routes/codex.js';
import { registerShareRoutes } from './routes/share.js';
import { registerPushRoutes } from './routes/push.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerGitRoutes } from './routes/git.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerTerminalRoutes } from './routes/terminal.js';
import { registerFileRoutes } from './routes/files.js';

const app = Fastify({
  logger: {
    level: process.env.MACARON_LOG_LEVEL || 'info',
    // pino's default req serializer logs req.url verbatim, so a `?token=` share
    // link would land in every request line. Strip the token before it's logged.
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: redactTokenInUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  },
  // Disable strict trailing-slash for friendlier URLs.
  ignoreTrailingSlash: true,
  // Allow large request bodies (genui prompts can grow).
  bodyLimit: 2 * 1024 * 1024,
  // Worktree cwds can be long (deep repo paths encoded as path params), and
  // Fastify caps a single param at 100 chars by default — a worktree under
  // .../macaron-genui-demo/.claude/worktrees/<name> blows past it and 414s every
  // /api/.../:project route. Raise it well above any plausible cwd.
  maxParamLength: 4000,
});

// Gate the API/relay behind a shared token when the server is reachable from
// the network. resolveToken auto-generates one when bound to a non-loopback
// host with no token set, so an exposed server is never wide open.
const { token: authToken, generated: authGenerated } = resolveToken(HOST, AUTH_TOKEN);
app.addHook('onRequest', makeAuthHook(authToken));

await app.register(async (instance) => {
  await registerHealthRoutes(instance);
  await registerAuthRoutes(instance, authToken);
  await registerSettingsRoutes(instance);
  await registerCommandRoutes(instance);
  await registerPushRoutes(instance);
  await registerUsageRoutes(instance);
  await registerMcpRoutes(instance);
  await registerConfigFileRoutes(instance);
  await registerRelayRoutes(instance);
  await registerWorkspaceRoutes(instance);
  await registerFsRoutes(instance);
  await registerSessionRoutes(instance);
  await registerWorktreeRoutes(instance);
  await registerCodexRoutes(instance);
  await registerShareRoutes(instance);
  await registerGitRoutes(instance);
  await registerScheduleRoutes(instance);
  await registerTerminalRoutes(instance);
  await registerFileRoutes(instance);
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
  await warmWorktreeCache();
  await warmPermissionRulesCache();
  await warmCodexConfigCache();
  await warmLabelsCache();
  await warmSchedulesCache();
  await warmCodexTitlesCache();
  await warmShareCache();
  await startSessionWatcher();
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`macaron server listening on http://${HOST}:${PORT}`);
  if (authGenerated) {
    app.log.warn(`bound to non-loopback host ${HOST} with no MACARON_AUTH_TOKEN — generated one for this run.`);
    // The token is a live credential — keep it out of the structured log (which may be
    // shipped off-box) and print the connection string straight to stdout so the operator
    // can still grab it from their own terminal on first launch.
    console.log(`connect from another device with: http://${HOST}:${PORT}/?token=${authToken}`);
  } else if (authToken) {
    app.log.info('server auth enabled (MACARON_AUTH_TOKEN) — remote requests require the token.');
  }
  startScheduler();
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
