import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { prepareReplay, renderTemplate, validateReplay } from './prepare-replay.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/sample-replay.json', import.meta.url), 'utf8'));

test('prepares a contiguous replay ending at the requested duration', () => {
  const replay = prepareReplay(fixture);
  assert.equal(replay.duration, 24);
  assert.equal(replay.events[0].start, replay.introDuration);
  for (let index = 1; index < replay.events.length; index += 1) {
    const previous = replay.events[index - 1];
    assert.ok(Math.abs(replay.events[index].start - (previous.start + previous.duration)) < 0.002);
  }
  const last = replay.events.at(-1);
  assert.ok(Math.abs(last.start + last.duration + replay.outroDuration - replay.duration) < 0.002);
});

test('assigns monotonic streaming frames inside render_ui event windows', () => {
  const replay = prepareReplay(fixture);
  for (const event of replay.events.filter((item) => item.type === 'render_ui')) {
    assert.equal(event.stream.at(-1).progress, 1);
    for (let index = 1; index < event.stream.length; index += 1) {
      assert.ok(event.stream[index].at > event.stream[index - 1].at);
    }
    assert.ok(event.stream[0].at >= event.start);
    assert.ok(event.stream.at(-1).at <= event.start + event.duration);
  }
});

test('rejects duplicate ids and unsupported event types', () => {
  assert.throws(
    () => validateReplay({ ...fixture, events: [fixture.events[0], fixture.events[0]] }),
    /duplicate event id/,
  );
  assert.throws(
    () => validateReplay({ ...fixture, events: [{ id: 'bad', type: 'network' }] }),
    /unsupported event type/,
  );
});

test('rejects render_ui streams that remove previously rendered nodes', () => {
  const renderEvent = structuredClone(fixture.events.find((event) => event.type === 'render_ui'));
  renderEvent.stream[2].preview.stats = [];
  assert.throws(
    () => validateReplay({ ...fixture, events: [renderEvent] }),
    /preview.stats must be cumulative/,
  );
});

test('template uses one persistent GenUI root without snapshot swapping', () => {
  const template = fs.readFileSync(new URL('../index.template', import.meta.url), 'utf8');
  assert.equal(template.match(/id="genui-root"/g)?.length, 1);
  assert.doesNotMatch(template, /ui-snapshot|renderSnapshot|previousSnapshot/);
  assert.match(template, /updateStats\(preview\.stats \|\| \[\], at\)/);
  assert.match(template, /updateBars\(preview\.bars \|\| \[\], at\)/);
  assert.match(template, /updateRows\(preview\.rows \|\| \[\], at\)/);
});

test('template rendering escapes script-closing markup', () => {
  const replay = prepareReplay({
    ...fixture,
    title: '</script><script>alert(1)</script>',
  });
  const html = renderTemplate(
    '<div data-duration="__REPLAY_DURATION__"></div><script>window.REPLAY=/*__REPLAY_DATA__*/</script>',
    replay,
  );
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /\\u003c\/script>/);
});
