import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableWeeks, buildHeatmap, isDay, levelFor, navCells, navTarget, quantileThresholds, utcToDay, dayToUTC, DAY } from '../src/lib/heatmap';

// Helper: synthesize a `daily` payload spanning [since, until] with 1 msg/day.
function fill(since: string, until: string) {
  const out: Array<{ date: string; messageCount: number }> = [];
  for (let ms = dayToUTC(since); ms <= dayToUTC(until); ms += DAY) out.push({ date: utcToDay(ms), messageCount: 1 });
  return out;
}

test('levelFor maps a count against quantile cut-points (0 → L0, strictly-greater climbs)', () => {
  const th: [number, number, number] = [10, 20, 30];
  assert.equal(levelFor(0, th), 0); // no activity → L0 regardless of cuts
  assert.equal(levelFor(5, th), 1); // below first cut
  assert.equal(levelFor(10, th), 1); // equal to a cut stays in the lower band
  assert.equal(levelFor(11, th), 2);
  assert.equal(levelFor(25, th), 3);
  assert.equal(levelFor(999, th), 4); // capped at L4
});

test('quantileThresholds splits active days into 4 near-equal bands, immune to an outlier', () => {
  // 29 modest days + 1 huge spike: a linear-by-max scale would crush all 29 into
  // L1, but quantile cuts keep every band populated.
  const active = [...Array(29)].map((_, i) => (i + 1) * 10).concat([100000]);
  const th = quantileThresholds(active);
  const buckets = [0, 0, 0, 0, 0];
  for (const c of active) buckets[levelFor(c, th)]!++;
  assert.equal(buckets[0], 0, 'no zero-count days here');
  for (let L = 1; L <= 4; L++) assert.ok(buckets[L]! >= 6, `L${L} has ${buckets[L]} days — every band populated`);
});

test('quantileThresholds handles degenerate distributions without throwing', () => {
  assert.deepEqual(quantileThresholds([]), [0, 0, 0]); // empty → all-zero cuts
  assert.deepEqual(quantileThresholds([7]), [7, 7, 7]); // single day
  const allEqual = quantileThresholds([5, 5, 5, 5, 5]);
  // Every day identical → all land in one band, none crash; ramp just isn't used.
  assert.ok(new Set([5, 5, 5, 5, 5].map((c) => levelFor(c, allEqual))).size === 1);
});

test('the busiest day always reaches L4 at small sample sizes (4 and 8 distinct values)', () => {
  // With a top cut EQUAL to the max, levelFor's strict `>` would strand the
  // busiest day in L3. The cut must sit strictly below the max so the peak is L4.
  for (const active of [[1, 2, 3, 4], [1, 2, 3, 4, 5, 6, 7, 8]]) {
    const th = quantileThresholds(active);
    const max = active[active.length - 1]!;
    assert.equal(levelFor(max, th), 4, `n=${active.length}: max ${max} must be L4, cuts=${th}`);
    assert.equal(levelFor(active[0]!, th), 1, `n=${active.length}: min stays L1`);
    // Every band populated across the distinct values → visible light→dark ramp.
    const bands = new Set(active.map((c) => levelFor(c, th)));
    for (let L = 1; L <= 4; L++) assert.ok(bands.has(L), `n=${active.length}: L${L} present`);
  }
});

test('thresholds are a property of the whole window — cropping columns never re-shades', () => {
  // Same daily payload, same window, different rendered width. buildHeatmap must
  // return identical thresholds regardless of how many columns fit, so a resize
  // only crops the grid — it never recolors the days that stay visible.
  const daily = fill('2026-01-01', '2026-07-14').map((d, i) => ({ ...d, messageCount: (i % 40) + 1 }));
  const wide = buildHeatmap(daily, '2026-01-01', '2026-07-14', 40);
  const narrow = buildHeatmap(daily, '2026-01-01', '2026-07-14', 6);
  assert.deepEqual(narrow.thresholds, wide.thresholds, 'thresholds identical across widths');
  // And a day visible in BOTH widths keeps the same shade level.
  const sharedKey = narrow.weeks.flat().filter(isDay).at(-1)!.key;
  const inWide = wide.weeks.flat().filter(isDay).find((c) => c.key === sharedKey)!;
  const inNarrow = narrow.weeks.flat().filter(isDay).find((c) => c.key === sharedKey)!;
  assert.equal(levelFor(inWide.count, wide.thresholds), levelFor(inNarrow.count, narrow.thresholds), 'shared day keeps its level');
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
  const firstRealKey = grid.weeks.flat().filter(isDay).map((c) => c.key).sort()[0];
  // 4 columns back from the week of 2026-07-14 (Tue) → grid starts 2026-06-21 (Sun).
  assert.equal(firstRealKey, '2026-06-21');
});

test('buildHeatmap keeps real day keys inside the window; pads before, hides after', () => {
  // untilDate is a Tuesday; the last column's Wed–Sat are AFTER the window → null
  // hidden slots. The first column's days before sinceDate are BEFORE it → visible
  // inert pad squares (fill the column, no date key), never real day cells.
  const daily = fill('2026-07-01', '2026-07-14');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-14', 4);
  const keys = grid.weeks.flat().filter(isDay).map((c) => c.key).sort();
  assert.equal(keys[0], '2026-07-01', 'no real day before sinceDate');
  assert.equal(keys.at(-1), '2026-07-14', 'no real day after untilDate');
  // First column (week 2026-06-21..27) is entirely before the window → all pads.
  const firstCol = grid.weeks[0]!;
  assert.deepEqual(firstCol.map((c) => (isDay(c) ? c.key : c && 'pad' in c ? 'pad' : null)), ['pad', 'pad', 'pad', 'pad', 'pad', 'pad', 'pad']);
  // The window opens mid-column: Wed 2026-07-01 is the first real day, preceded
  // by pads for Sun–Tue in that same column.
  const openCol = grid.weeks.find((w) => w.some((c) => isDay(c) && c.key === '2026-07-01'))!;
  assert.deepEqual(openCol.map((c) => (isDay(c) ? c.key : c && 'pad' in c ? 'pad' : null)), ['pad', 'pad', 'pad', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
  // Last column (week of untilDate, Sun 2026-07-12) keeps Sun/Mon/Tue, hides Wed+.
  const lastCol = grid.weeks.at(-1)!;
  assert.deepEqual(lastCol.map((c) => (isDay(c) ? c.key : null)), ['2026-07-12', '2026-07-13', '2026-07-14', null, null, null, null]);
});

test('buildHeatmap fills the full requested width with inert pads when history is short', () => {
  // A 2-week window rendered into a 12-column container: every column exists (no
  // half-empty grid), the earlier columns are inert pad squares, and the real
  // days still match the server window exactly — pads never become date cells.
  const daily = fill('2026-07-01', '2026-07-14');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-14', 12);
  assert.equal(grid.weeks.length, 12, 'renders all 12 requested columns');
  const realKeys = grid.weeks.flat().filter(isDay).map((c) => c.key).sort();
  assert.equal(realKeys[0], '2026-07-01', 'earliest real day is still sinceDate');
  assert.equal(realKeys.at(-1), '2026-07-14', 'latest real day is still untilDate');
  // The leading columns are entirely pad squares (no real day leaks earlier).
  const pads = grid.weeks.flat().filter((c) => c && !isDay(c)).length;
  assert.ok(pads > 0, 'pre-window columns are filled with inert pad squares');
  // navCells (the ARIA/keyboard model) sees only real days, never pads.
  assert.equal(navCells(grid).length, realKeys.length, 'pads never enter the nav/ARIA set');
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
