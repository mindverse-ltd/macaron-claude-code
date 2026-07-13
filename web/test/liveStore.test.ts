import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { attachLive, clearLive, getLive, startNewSession, subscribeLive } from '../src/lib/liveStore';

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function sseResponse(events: unknown[]): Response {
  return new Response(events.map(frame).join('') + frame('[DONE]'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function streamedText(sid: string): string {
  return getLive(sid)?.timeline
    .filter((item) => item.kind === 'text')
    .map((item) => item.text)
    .join('') ?? '';
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not met');
}

test('concurrent reattach probes share one SSE reader and apply each delta once', async () => {
  const sid = 'single-flight-session';
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return sseResponse([
      { type: 'meta', cwd: '/repo', sessionId: sid },
      { type: 'user-text', text: 'question' },
      { type: 'delta', text: 'The ' },
      { type: 'delta', text: 'user' },
      { type: 'done', exitCode: 0 },
    ]);
  };

  const results = await Promise.all([
    attachLive('project', sid),
    attachLive('project', sid),
  ]);
  await waitFor(() => getLive(sid)?.done === true);

  assert.deepEqual(results, ['attached', 'attached']);
  assert.equal(fetches, 1);
  assert.equal(getLive(sid)?.cwd, '/repo');
  assert.equal(getLive(sid)?.userText, 'question');
  assert.equal(streamedText(sid), 'The user');
  clearLive(sid);
});

test('an existing new-session POST owner prevents a second live attachment', async () => {
  const sid = 'post-owned-session';
  let fetches = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
        next.enqueue(encoder.encode(
          frame({ type: 'meta', cwd: '/repo', sessionId: sid }) +
          frame({ type: 'delta', text: 'only once' }),
        ));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  assert.equal(await startNewSession('project', { text: 'question' }), sid);
  assert.equal(await attachLive('project', sid), 'attached');
  assert.equal(fetches, 1);
  assert.equal(streamedText(sid), 'only once');

  controller.enqueue(encoder.encode(frame({ type: 'done', exitCode: 0 }) + frame('[DONE]')));
  controller.close();
  await waitFor(() => getLive(sid)?.done === true);
  clearLive(sid);
});

test('an ended replay can be consumed before the attach promise callback runs', async () => {
  const sid = 'ended-replay-session';
  globalThis.fetch = async () => sseResponse([
    { type: 'meta', cwd: '/repo', sessionId: sid },
    { type: 'user-text', text: 'question' },
    { type: 'delta', text: 'answer' },
    { type: 'done', exitCode: 0 },
  ]);

  let rendered = '';
  const unsubscribe = subscribeLive(sid, (state) => {
    rendered = state.timeline
      .filter((item) => item.kind === 'text')
      .map((item) => item.text)
      .join('');
    if (state.done) clearLive(sid);
  });

  assert.equal(await attachLive('project', sid), 'attached');
  assert.equal(rendered, 'answer');
  assert.equal(getLive(sid), undefined);
  unsubscribe();
});
