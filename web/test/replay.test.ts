import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@macaron/shared';
import { createReplayTimeline, replayFrame } from '../src/lib/replay';

const user = (text: string, timestamp: string): Message => ({ role: 'user', timestamp, blocks: [{ kind: 'text', text }] });
const assistant = (text: string, timestamp: string): Message => ({ role: 'assistant', timestamp, blocks: [{ kind: 'text', text }] });

test('smoothly reveals assistant text inside its replay interval', () => {
  const timeline = createReplayTimeline([user('go', '2026-01-01T00:00:00.000Z'), assistant('abcdefghij', '2026-01-01T00:00:01.000Z')]);
  assert.deepEqual(replayFrame(timeline, 0), [timeline[0]!.message]);
  const halfway = replayFrame(timeline, 850);
  assert.equal(halfway.length, 2);
  assert.equal(halfway[1]!.blocks[0]!.kind, 'text');
  assert.equal((halfway[1]!.blocks[0] as { kind: 'text'; text: string }).text, 'abcde');
  assert.deepEqual(replayFrame(timeline, 1_000), timeline.map((entry) => entry.message));
});

test('caps long event gaps while preserving non-text event boundaries', () => {
  const messages: Message[] = [user('go', '2026-01-01T00:00:00.000Z'), { role: 'assistant', timestamp: '2026-01-01T00:01:00.000Z', blocks: [{ kind: 'tool_use', id: '1', name: 'Read', input: {} }] }];
  const timeline = createReplayTimeline(messages);
  assert.equal(timeline[1]!.end, 2_000);
  assert.equal(replayFrame(timeline, 1_999).length, 1);
  assert.deepEqual(replayFrame(timeline, 2_000), messages);
});
