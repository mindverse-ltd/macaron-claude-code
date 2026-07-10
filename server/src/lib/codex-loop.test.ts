import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLoopRunnerEvent } from './codex-loop.js';
import { resolveCodexTransport } from './codex-transport.js';

test('manual and loop turns default to the app-server transport', () => {
  assert.equal(resolveCodexTransport(undefined), 'app-server');
  assert.equal(resolveCodexTransport('app-server'), 'app-server');
  assert.equal(resolveCodexTransport('sdk'), 'sdk');
});

test('loop stream preserves native reasoning, plan, and approval events', () => {
  assert.deepEqual(
    mapLoopRunnerEvent({ kind: 'reasoning', text: 'checking' }),
    { type: 'reasoning', text: 'checking' },
  );
  assert.deepEqual(
    mapLoopRunnerEvent({
      kind: 'codex_plan',
      steps: [{ step: 'Run checks', status: 'inProgress' }],
      explanation: 'Verifying',
    }),
    {
      type: 'codex_plan',
      steps: [{ step: 'Run checks', status: 'inProgress' }],
      explanation: 'Verifying',
    },
  );
  assert.deepEqual(
    mapLoopRunnerEvent({
      kind: 'codex_approval_request',
      id: 'thread:1',
      approval: 'command',
      command: 'pnpm test',
      available: ['accept', 'decline'],
    }),
    {
      type: 'codex_approval_request',
      id: 'thread:1',
      kind: 'command',
      command: 'pnpm test',
      cwd: undefined,
      reason: undefined,
      fileChanges: undefined,
      grantRoot: undefined,
      network: undefined,
      available: ['accept', 'decline'],
    },
  );
  assert.deepEqual(
    mapLoopRunnerEvent({ kind: 'codex_approval_resolved', id: 'thread:1', decision: 'accept' }),
    { type: 'codex_approval_resolved', id: 'thread:1', decision: 'accept' },
  );
});
