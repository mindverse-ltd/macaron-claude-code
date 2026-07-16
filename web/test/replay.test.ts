import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@macaron/shared';
import { compressReplayGap, createReplayTimeline, replayFrame } from '../src/lib/replay';

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

test('finishes intermediate and final streaming text at their recorded event times', () => {
  const messages = [user('go', '2026-01-01T00:00:00.000Z'), assistant('intermediate text', '2026-01-01T00:00:00.100Z'), assistant('final response', '2026-01-01T00:00:01.000Z')];
  const timeline = createReplayTimeline(messages, 'exact');
  assert.equal(timeline[1]!.revealStart, 0);
  assert.equal(timeline[1]!.end, 100);
  assert.equal(timeline[2]!.end, 1_000);
  assert.equal(replayFrame(timeline, 99).length, 2);
  assert.deepEqual(replayFrame(timeline, 100).slice(0, 2), messages.slice(0, 2));
  assert.deepEqual(replayFrame(timeline, 1_000), messages);
});

test('offers exact, logarithmic, and compact replay timing', () => {
  assert.equal(compressReplayGap(60_000, 'exact'), 60_000);
  assert.equal(compressReplayGap(60_000, 'compact'), 2_000);
  assert.equal(Math.round(compressReplayGap(60_000, 'natural')), 8_802);
  assert.equal(compressReplayGap(1_000, 'natural'), 1_000);
});

test('compact timing caps long event gaps while preserving non-text event boundaries', () => {
  const messages: Message[] = [user('go', '2026-01-01T00:00:00.000Z'), { role: 'assistant', timestamp: '2026-01-01T00:01:00.000Z', blocks: [{ kind: 'tool_use', id: '1', name: 'Read', input: {} }] }];
  const timeline = createReplayTimeline(messages, 'compact');
  assert.equal(timeline[1]!.end, 2_000);
  assert.equal(replayFrame(timeline, 1_999).length, 1);
  assert.deepEqual(replayFrame(timeline, 2_000), messages);
});
