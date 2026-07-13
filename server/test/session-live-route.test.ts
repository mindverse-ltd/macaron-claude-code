import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { RunOptions, RunnerEvent } from '../src/lib/claude-runner.js';

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-live-route-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const [{ CLAUDE_PROJECTS }, { registerSessionRoutes }] = await Promise.all([
  import('../src/config.js'),
  import('../src/routes/sessions.js'),
]);

after(() => fs.rm(tmpHome, { recursive: true, force: true }));

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  initial = '',
): Promise<string> {
  const decoder = new TextDecoder();
  let text = initial;
  while (!text.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('resumed bypass turn survives original SSE disconnect and replays through /live', { timeout: 10_000 }, async (t) => {
  const project = 'existing-project';
  const sid = 'existing-session';
  const cwd = path.join(tmpHome, 'repo');
  await fs.mkdir(path.join(CLAUDE_PROJECTS, project), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'earlier turn' } })}\n`,
    'utf8',
  );

  let continueRun!: () => void;
  let finishRun!: () => void;
  const continueGate = new Promise<void>((resolve) => { continueRun = resolve; });
  const finishGate = new Promise<void>((resolve) => { finishRun = resolve; });
  let observedOptions: RunOptions | undefined;

  async function* fakeRunClaude(opts: RunOptions): AsyncGenerator<RunnerEvent> {
    observedOptions = opts;
    yield { kind: 'delta', text: 'before refresh' };
    await continueGate;
    yield { kind: 'delta', text: ' after refresh' };
    await finishGate;
    yield { kind: 'done', exitCode: 0 };
  }

  const app = Fastify({ logger: false });
  await registerSessionRoutes(app, { runClaude: fakeRunClaude });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
  });

  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const sessionPath = `/api/sessions/claude/${project}/${sid}`;

  const original = await fetch(`${base}${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'keep working', permissionMode: 'bypassPermissions' }),
  });
  assert.equal(original.status, 200);
  assert.ok(original.body);
  const originalReader = original.body.getReader();
  const originalText = await readUntil(originalReader, 'before refresh');
  assert.match(originalText, /"type":"meta"/);
  assert.match(originalText, /before refresh/);
  await originalReader.cancel();

  assert.equal(observedOptions?.resume, sid);
  assert.equal(observedOptions?.permissionMode, 'bypassPermissions');
  assert.equal(observedOptions?.abortController?.signal.aborted, false);

  const duplicate = await fetch(`${base}${sessionPath}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'competing turn', permissionMode: 'default' }),
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'session already running' });

  const reattached = await fetch(`${base}${sessionPath}/live`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(reattached.status, 200);
  assert.ok(reattached.body);
  const liveReader = reattached.body.getReader();
  let liveText = await readUntil(liveReader, 'before refresh');
  assert.match(liveText, /"type":"meta"/);
  assert.match(liveText, /"type":"user-text","text":"keep working"/);

  continueRun();
  liveText = await readUntil(liveReader, 'after refresh', liveText);
  assert.match(liveText, /after refresh/);

  finishRun();
  liveText = await readUntil(liveReader, '"type":"done"', liveText);
  assert.match(liveText, /"type":"done","exitCode":0/);
  await liveReader.cancel().catch(() => {});
});
