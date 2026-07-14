import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableWeeks, buildHeatmap, levelFor, navCells, navTarget, utcToDay, dayToUTC, DAY } from '../src/lib/heatmap';

// Helper: synthesize a `daily` payload spanning [since, until] with 1 msg/day.
function fill(since: string, until: string) {
  const out: Array<{ date: string; messageCount: number }> = [];
  for (let ms = dayToUTC(since); ms <= dayToUTC(until); ms += DAY) out.push({ date: utcToDay(ms), messageCount: 1 });
  return out;
}

test('levelFor buckets by busiest day', () => {
  assert.equal(levelFor(0, 10), 0);
  assert.equal(levelFor(1, 10), 1);
  assert.equal(levelFor(10, 10), 4);
  assert.equal(levelFor(5, 0), 0); // no activity → level 0 even if count > 0
});

test('buildHeatmap renders exactly the requested whole columns, no stretch', () => {
  const daily = fill('2024-01-01', '2026-07-14');
  const grid = buildHeatmap(daily, '2024-01-01', '2026-07-14', 20);
  assert.equal(grid.weeks.length, 20, 'exactly 20 columns');
  for (const week of grid.weeks) assert.equal(week.length, 7, 'every column has 7 weekday rows');
});

test('buildHeatmap shows the MOST-RECENT days when fewer columns than history fit', () => {
  const daily = fill('2024-01-01', '2026-07-14');
  const grid = buildHeatmap(daily, '2024-01-01', '2026-07-14', 4); // only 4 weeks fit
  const firstRealKey = grid.weeks.flat().filter(Boolean).map((c) => c!.key).sort()[0];
  // 4 columns back from the week of 2026-07-14 (Tue) → grid starts 2026-06-21 (Sun).
  assert.equal(firstRealKey, '2026-06-21');
});

test('buildHeatmap strictly clips to the server since..until window (no padding days)', () => {
  // untilDate is a Tuesday; the last column's Wed–Sat are AFTER the window and
  // the first column's days before sinceDate are BEFORE it — both must be null,
  // never zero-count cells the server didn't account for.
  const daily = fill('2026-07-01', '2026-07-14');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-14', 4);
  const keys = grid.weeks.flat().filter(Boolean).map((c) => c!.key).sort();
  assert.equal(keys[0], '2026-07-01', 'no day before sinceDate');
  assert.equal(keys.at(-1), '2026-07-14', 'no day after untilDate');
  // The last column (week of untilDate, Sun 2026-07-12) keeps Sun/Mon/Tue, drops Wed+.
  const lastCol = grid.weeks.at(-1)!;
  assert.deepEqual(lastCol.map((c) => c?.key ?? null), ['2026-07-12', '2026-07-13', '2026-07-14', null, null, null, null]);
});

test('first-frame long history clamps to fitted columns (no full-width overflow)', () => {
  // Whatever column count the layout fits, buildHeatmap returns exactly that many
  // — a 135-week history asked for 52 columns yields 52, not 135, so the very
  // first paint is already the fitted width.
  const daily = fill('2024-01-01', '2026-07-14');
  assert.equal(buildHeatmap(daily, '2024-01-01', '2026-07-14', 52).weeks.length, 52);
});

test('availableWeeks caps the column count to the window span', () => {
  const daily = fill('2026-06-15', '2026-07-14');
  assert.equal(availableWeeks(daily, '2026-06-15', '2026-07-14', '30d'), 5);
  const long = fill('2026-01-01', '2026-07-14');
  assert.ok(availableWeeks(long, '1970-01-01', '2026-07-14', 'all') >= 27);
});

test('navTarget global/boundary uses date keys not DOM order', () => {
  const daily = fill('2026-07-01', '2026-07-31');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-31', 6);
  const cells = navCells(grid);
  assert.equal(navTarget(cells, cells[3]!.key, 'Home', true), cells.map((c) => c.key).sort()[0], 'Ctrl+Home → earliest date');
  assert.equal(navTarget(cells, cells[3]!.key, 'End', true), '2026-07-31', 'Ctrl+End → latest date');
});

test('navTarget arrows stay put at an edge', () => {
  const daily = fill('2026-07-01', '2026-07-31');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-31', 6);
  const cells = navCells(grid);
  const earliest = cells.reduce((a, b) => (a.key < b.key ? a : b));
  assert.equal(navTarget(cells, earliest.key, 'ArrowLeft', false), null);
});

test('narrow resize drops leftmost columns — earlier keys leave the visible set', () => {
  // Simulates a wide→narrow resize: same data, fewer fitted columns. The keys
  // visible when narrow must be a strict suffix (most-recent) of the wide set,
  // so the component knows which roving/focus keys fell off the left edge.
  const daily = fill('2024-01-01', '2026-07-14');
  const wide = new Set(navCells(buildHeatmap(daily, '2024-01-01', '2026-07-14', 40)).map((c) => c.key));
  const narrow = navCells(buildHeatmap(daily, '2024-01-01', '2026-07-14', 8)).map((c) => c.key);
  assert.ok(narrow.every((k) => wide.has(k)), 'narrow keys are a subset of wide');
  assert.ok(wide.size > narrow.length, 'wide shows strictly more days than narrow');
});

// --- Contrast: mirrors the .heatmap-cell ramp in styles.css so a token or
// percentage change that drops an active level below WCAG 3:1 fails here. ---
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const mix = (a: RGB, b: RGB, pa: number): RGB => a.map((v, i) => Math.round(v * pa + b[i]! * (1 - pa))) as RGB;
const relLum = ([r, g, b]: RGB) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a: RGB, b: RGB) => { const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
// color-mix(in srgb, text D%, color-mix(in srgb, accent P%, surface2))
const rampLevel = (t: { accent: string; surface2: string; text: string; darken: number }, accentPct: number) =>
  mix(hex(t.text), mix(hex(t.accent), hex(t.surface2), accentPct), t.darken);

test('active levels L1–L4 clear WCAG 3:1 against the panel in both themes', () => {
  const themes = {
    light: { accent: '#C96442', surface2: '#F5F4ED', text: '#3D3929', panel: '#FFFFFF', darken: 0.18 },
    dark: { accent: '#E08159', surface2: '#2C2B26', text: '#EDEAE0', panel: '#262521', darken: 0.0 },
  };
  for (const [name, t] of Object.entries(themes)) {
    const panel = hex(t.panel);
    for (const [lv, pct] of [[1, 0.66], [2, 0.76], [3, 0.88], [4, 1.0]] as const) {
      const fill = pct === 1.0 ? mix(hex(t.text), hex(t.accent), t.darken) : rampLevel(t, pct);
      assert.ok(ratio(fill, panel) >= 3, `${name} L${lv} = ${ratio(fill, panel).toFixed(2)} must be >= 3`);
    }
  }
});

