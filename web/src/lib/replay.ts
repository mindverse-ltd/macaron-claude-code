import type { Message } from '@macaron/shared';

const MAX_GAP_MS = 2_000;
const MIN_STREAM_MS = 300;
const MAX_STREAM_MS = 2_000;
const MS_PER_CHARACTER = 12;

export type ReplayTimelineEntry = { message: Message; end: number; revealStart: number; textLength: number };

function timestamp(message: Message): number | undefined {
  const value = message.timestamp ? new Date(message.timestamp).getTime() : NaN;
  return Number.isFinite(value) ? value : undefined;
}

function streamLength(message: Message): number {
  if (message.role !== 'assistant') return 0;
  return message.blocks.reduce((length, block) => length + (block.kind === 'text' || block.kind === 'thinking' ? block.text.length : 0), 0);
}

export function createReplayTimeline(messages: Message[]): ReplayTimelineEntry[] {
  let elapsed = 0;
  return messages.map((message, index) => {
    const textLength = streamLength(message);
    if (index > 0) {
      const current = timestamp(message);
      const previous = timestamp(messages[index - 1]!);
      const gap = current === undefined || previous === undefined ? 250 : Math.min(MAX_GAP_MS, Math.max(0, current - previous));
      const streamDuration = textLength ? Math.min(MAX_STREAM_MS, Math.max(MIN_STREAM_MS, textLength * MS_PER_CHARACTER)) : 0;
      elapsed += Math.max(gap, streamDuration);
      return { message, end: elapsed, revealStart: elapsed - streamDuration, textLength };
    }
    return { message, end: 0, revealStart: 0, textLength };
  });
}

function revealMessage(message: Message, visibleCharacters: number): Message {
  let remaining = visibleCharacters;
  const blocks = [];
  for (const block of message.blocks) {
    if (block.kind !== 'text' && block.kind !== 'thinking') {
      if (remaining > 0) blocks.push(block);
      continue;
    }
    if (remaining <= 0) break;
    const text = block.text.slice(0, remaining);
    if (text) blocks.push({ ...block, text });
    remaining -= block.text.length;
    if (remaining <= 0) break;
  }
  return { ...message, blocks };
}

export function replayFrame(timeline: ReplayTimelineEntry[], position: number): Message[] {
  const visible: Message[] = [];
  for (const entry of timeline) {
    if (position >= entry.end) {
      visible.push(entry.message);
      continue;
    }
    if (entry.textLength && position >= entry.revealStart) {
      const progress = (position - entry.revealStart) / (entry.end - entry.revealStart);
      visible.push(revealMessage(entry.message, Math.max(1, Math.ceil(entry.textLength * progress))));
    }
    break;
  }
  return visible;
}
