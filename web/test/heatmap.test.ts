import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHeatmap, levelFor, navCells, navTarget, utcToDay, dayToUTC, DAY } from '../src/lib/heatmap';

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

test('long-history All fills every week with month track same-source aligned', () => {
  // ~135 weeks. Month labels must come from the same week iteration as cells,
  // so their column index never drifts from the grid columns.
  const daily = fill('2024-01-01', '2026-07-14');
  const grid = buildHeatmap(daily, '1970-01-01', '2026-07-14', 'all');
  // Every column has exactly 7 slots (some may be null at the head/tail edges).
  for (const week of grid.weeks) assert.equal(week.length, 7);
  // Month labels reference real columns within the grid, monotonically increasing.
  let prevCol = -1;
  for (const m of grid.months) {
    assert.ok(m.col >= 0 && m.col < grid.weeks.length, `month col ${m.col} in range`);
    assert.ok(m.col > prevCol, 'month columns strictly increase');
    prevCol = m.col;
  }
  // The first in-range day is the first active day (all → clamps to daily[0]).
  const firstCell = grid.weeks.flat().find((c) => c);
  assert.equal(firstCell?.key, '2024-01-01');
});

test('same-week cross-month shows both month labels', () => {
  // 2026-07-30 (Thu) .. 2026-08-06 straddle Jul/Aug within contiguous weeks.
  const daily = fill('2026-07-30', '2026-08-06');
  const grid = buildHeatmap(daily, '2026-07-30', '2026-08-06', '30d');
  const labels = grid.months.map((m) => m.label);
  assert.ok(labels.includes('Jul'), 'Jul present');
  assert.ok(labels.includes('Aug'), 'Aug not overwritten by Aug');
});

test('navTarget global/boundary uses date keys not DOM order', () => {
  // Partial first week: if Ctrl+Home used DOM order it could pick a later day.
  const daily = fill('2026-07-01', '2026-07-31');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-31', '30d');
  const cells = navCells(grid);
  assert.equal(navTarget(cells, cells[3]!.key, 'Home', true), '2026-07-01', 'Ctrl+Home → earliest date');
  assert.equal(navTarget(cells, cells[3]!.key, 'End', true), '2026-07-31', 'Ctrl+End → latest date');
});

test('navTarget arrows stay put at an edge', () => {
  const daily = fill('2026-07-01', '2026-07-31');
  const grid = buildHeatmap(daily, '2026-07-01', '2026-07-31', '30d');
  const cells = navCells(grid);
  const earliest = cells.reduce((a, b) => (a.key < b.key ? a : b));
  // Earliest day is at the left edge — ArrowLeft has no in-range neighbour.
  assert.equal(navTarget(cells, earliest.key, 'ArrowLeft', false), null);
});
