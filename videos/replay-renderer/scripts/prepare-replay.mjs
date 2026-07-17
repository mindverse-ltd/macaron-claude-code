import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT_TYPES = new Set(['user', 'assistant', 'tool', 'render_ui']);
const INTRO_DURATION = 0.8;
const OUTRO_DURATION = 1.2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value) => Math.round(value * 1000) / 1000;

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid replay: ${message}`);
}

function eventWeight(event) {
  if (event.type === 'render_ui') return 3.8 + event.stream.length * 0.22;
  if (event.type === 'tool') return clamp(1.35 + (event.input.length + event.result.length) * 0.004, 1.55, 2.15);
  const chars = event.text.length;
  return event.type === 'user'
    ? clamp(1.45 + chars * 0.009, 1.7, 2.35)
    : clamp(1.2 + chars * 0.008, 1.45, 2.05);
}

export function validateReplay(replay) {
  assert(replay && typeof replay === 'object', 'input must be an object');
  assert(replay.version === 1, 'version must be 1');
  assert(typeof replay.id === 'string' && replay.id.trim(), 'id is required');
  assert(typeof replay.title === 'string' && replay.title.trim(), 'title is required');
  assert(typeof replay.agent === 'string' && replay.agent.trim(), 'agent is required');
  assert(Number.isFinite(replay.targetDuration) && replay.targetDuration >= 8 && replay.targetDuration <= 180, 'targetDuration must be between 8 and 180 seconds');
  assert(Array.isArray(replay.events) && replay.events.length > 0, 'events must be a non-empty array');

  const ids = new Set();
  replay.events.forEach((event, index) => {
    assert(event && typeof event === 'object', `events[${index}] must be an object`);
    assert(typeof event.id === 'string' && event.id.trim(), `events[${index}].id is required`);
    assert(!ids.has(event.id), `duplicate event id: ${event.id}`);
    ids.add(event.id);
    assert(EVENT_TYPES.has(event.type), `unsupported event type: ${event.type}`);

    if (event.type === 'user' || event.type === 'assistant') {
      assert(typeof event.text === 'string' && event.text.trim(), `${event.id}.text is required`);
    } else if (event.type === 'tool') {
      assert(typeof event.name === 'string' && event.name.trim(), `${event.id}.name is required`);
      assert(typeof event.input === 'string', `${event.id}.input must be a string`);
      assert(typeof event.result === 'string', `${event.id}.result must be a string`);
    } else {
      assert(typeof event.code === 'string' && event.code.length >= 20, `${event.id}.code must contain the render_ui module`);
      assert(Array.isArray(event.stream) && event.stream.length >= 2, `${event.id}.stream needs at least two frames`);
      event.stream.forEach((frame, frameIndex) => {
        assert(typeof frame.label === 'string' && frame.label.trim(), `${event.id}.stream[${frameIndex}].label is required`);
        assert(frame.preview && typeof frame.preview === 'object', `${event.id}.stream[${frameIndex}].preview is required`);
        if (frameIndex > 0) {
          const previous = event.stream[frameIndex - 1].preview;
          for (const key of ['stats', 'bars', 'rows']) {
            const previousCount = Array.isArray(previous[key]) ? previous[key].length : 0;
            const currentCount = Array.isArray(frame.preview[key]) ? frame.preview[key].length : 0;
            assert(currentCount >= previousCount, `${event.id}.stream[${frameIndex}].preview.${key} must be cumulative`);
          }
        }
      });
    }
  });
}

export function prepareReplay(replay) {
  validateReplay(replay);
  const available = replay.targetDuration - INTRO_DURATION - OUTRO_DURATION;
  const weights = replay.events.map(eventWeight);
  const scale = available / weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = INTRO_DURATION;

  const events = replay.events.map((event, index) => {
    const start = round(cursor);
    const isLast = index === replay.events.length - 1;
    const duration = isLast
      ? round(replay.targetDuration - OUTRO_DURATION - start)
      : round(weights[index] * scale);
    cursor += duration;

    if (event.type !== 'render_ui') return { ...event, start, duration };

    const streamStart = start + Math.min(0.42, duration * 0.12);
    const streamSpan = Math.max(0.4, duration - 0.82);
    const stream = event.stream.map((frame, frameIndex) => ({
      ...frame,
      at: round(streamStart + (streamSpan * frameIndex) / (event.stream.length - 1)),
      progress: round((frameIndex + 1) / event.stream.length),
    }));
    return { ...event, start, duration, stream };
  });

  return {
    ...replay,
    duration: replay.targetDuration,
    introDuration: INTRO_DURATION,
    outroDuration: OUTRO_DURATION,
    events,
  };
}

export function renderTemplate(template, replay) {
  const serialized = JSON.stringify(replay).replaceAll('<', '\\u003c');
  assert(template.includes('__REPLAY_DURATION__'), 'template is missing __REPLAY_DURATION__');
  assert(template.includes('/*__REPLAY_DATA__*/'), 'template is missing replay data marker');
  return template
    .replaceAll('__REPLAY_DURATION__', String(replay.duration))
    .replace('/*__REPLAY_DATA__*/', serialized);
}

export function prepareFile(inputPath, outputPath = 'index.html') {
  const replay = prepareReplay(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const template = fs.readFileSync(path.join(projectRoot, 'index.template'), 'utf8');
  const rendered = renderTemplate(template, replay);
  fs.writeFileSync(path.resolve(outputPath), rendered);
  fs.mkdirSync(path.join(projectRoot, 'out'), { recursive: true });
  return replay;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const inputPath = path.resolve(process.argv[2] || path.join(projectRoot, 'fixtures/sample-replay.json'));
  const outputPath = path.resolve(process.argv[3] || path.join(projectRoot, 'index.html'));
  const replay = prepareFile(inputPath, outputPath);
  process.stdout.write(`Prepared ${replay.events.length} events / ${replay.duration}s -> ${outputPath}\n`);
}
