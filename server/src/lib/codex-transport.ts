import { runCodex, type CodexRunOptions } from './codex-runner.js';
import { runCodexAppServer } from './codex-app-server.js';

export type CodexTransport = 'app-server' | 'sdk';

export function resolveCodexTransport(value: string | undefined): CodexTransport {
  return value === 'sdk' ? 'sdk' : 'app-server';
}

// Keep manual and autonomous turns on the same transport. The app-server is
// the default because it is the only path with native plans and approvals.
export function runCodexTurn(opts: CodexRunOptions): ReturnType<typeof runCodex> {
  return resolveCodexTransport(process.env.MACARON_CODEX_TRANSPORT) === 'sdk'
    ? runCodex(opts)
    : runCodexAppServer(opts);
}
