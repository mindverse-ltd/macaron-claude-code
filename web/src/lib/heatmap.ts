// Pure heatmap geometry — extracted from the Analytics view so the calendar
// bucketing, month-label placement, and keyboard-target math can be unit-tested
// without a DOM. The React component consumes `buildHeatmap` and the two nav
// resolvers below; everything here is deterministic and side-effect free.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A calendar day is a plain YYYY-MM-DD string. We iterate days via UTC-noon
// millis so DST shifts never skip or double a day, and never convert to the
// browser's local timezone — the server already keyed `daily` and the window
// bounds (sinceDate/untilDate) in its own timezone, so days line up regardless
// of where the browser runs.
export const dayToUTC = (key: string) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y!, m! - 1, d!, 12); };
export const utcToDay = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };
export const DAY = 86400000;

export type HeatCell = { key: string; count: number; inRange: boolean } | null;
export type MonthLabel = { col: number; label: string };
export type HeatGrid = { weeks: HeatCell[][]; months: MonthLabel[]; max: number };

// Build the weeks × weekday grid for the active window. `daily` is the analytics
// payload (date → messageCount); `sinceDate`/`untilDate` are the server-local
// calendar-day bounds; `window` selects the sizing rule.
export function buildHeatmap(
  daily: Array<{ date: string; messageCount: number }>,
  sinceDate: string,
  untilDate: string,
  window: string,
): HeatGrid {
  const byDay = new Map(daily.map((d) => [d.date, d.messageCount]));
  const endMs = dayToUTC(untilDate);
  // Fixed windows (7d/30d/90d) start at sinceDate so leading zero-days still
  // render; 'all' (sinceDate = epoch) would span back to 1970, so clamp to
  // the first active day instead.
  const startMs = window === 'all' ? dayToUTC(daily.length ? daily[0]!.date : untilDate) : dayToUTC(sinceDate);

  // Back up to the Sunday of the start week (getUTCDay: 0 = Sunday).
  const gridStartMs = startMs - new Date(startMs).getUTCDay() * DAY;

  const weeks: HeatCell[][] = [];
  const months: MonthLabel[] = [];
  let max = 0;
  let prevLabelMonth = -1;
  for (let ms = gridStartMs, col = 0; ms <= endMs; col++) {
    const week: HeatCell[] = [];
    let weekFirstMonth = -1;
    for (let row = 0; row < 7; row++, ms += DAY) {
      const inRange = ms >= startMs && ms <= endMs;
      const key = utcToDay(ms);
      if (!inRange) { week.push(null); continue; }
      const count = byDay.get(key) ?? 0;
      if (count > max) max = count;
      if (weekFirstMonth < 0) weekFirstMonth = new Date(ms).getUTCMonth();
      week.push({ key, count, inRange });
    }
    // Label a column by the month of its first in-range day, whenever that month
    // differs from the last one labelled. A week straddling a month boundary shows
    // its earlier month here and the new month lands on the next column, so neither
    // the leading partial month nor the incoming month is ever overwritten/lost.
    if (weekFirstMonth >= 0 && weekFirstMonth !== prevLabelMonth) {
      months.push({ col, label: MONTHS[weekFirstMonth]! });
      prevLabelMonth = weekFirstMonth;
    }
    weeks.push(week);
  }
  return { weeks, months, max };
}

// The 5-level shade bucket for a day's count, given the window's busiest day.
export function levelFor(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((count / max) * 4));
}

// Flattened, date-sorted list of the in-range cells with their (row, col)
// coordinates — the model the keyboard resolver navigates.
export type NavCell = { key: string; row: number; col: number };
export function navCells(grid: HeatGrid): NavCell[] {
  const out: NavCell[] = [];
  grid.weeks.forEach((week, col) => week.forEach((cell, row) => { if (cell) out.push({ key: cell.key, row, col }); }));
  return out;
}

// Resolve the target cell for a key press from the currently-focused cell.
// Returns null when the move lands outside the in-range set (arrow at an edge,
// or a gap) so the caller keeps focus put — never snapping to a DOM-first cell.
// Home/End walk the focused weekday row; ctrl selects the global first/last day
// by DATE KEY, not DOM order, so a partial first/last week can't misplace them.
export function navTarget(cells: NavCell[], fromKey: string, key: string, ctrl: boolean): string | null {
  if (!cells.length) return null;
  const cur = cells.find((c) => c.key === fromKey);
  const at = (r: number, c: number) => cells.find((x) => x.row === r && x.col === c) ?? null;
  const extreme = (pick: (a: NavCell, b: NavCell) => NavCell) => cells.reduce(pick);
  if ((key === 'Home' || key === 'End') && ctrl) {
    const later = key === 'End';
    return extreme((a, b) => ((later ? a.key > b.key : a.key < b.key) ? a : b)).key;
  }
  if (!cur) return null;
  if (key === 'ArrowRight') return at(cur.row, cur.col + 1)?.key ?? null;
  if (key === 'ArrowLeft') return at(cur.row, cur.col - 1)?.key ?? null;
  if (key === 'ArrowDown') return at(cur.row + 1, cur.col)?.key ?? null;
  if (key === 'ArrowUp') return at(cur.row - 1, cur.col)?.key ?? null;
  if (key === 'Home' || key === 'End') {
    const later = key === 'End';
    const inRow = cells.filter((x) => x.row === cur.row);
    return inRow.reduce((a, b) => ((later ? a.col > b.col : a.col < b.col) ? a : b)).key;
  }
  return null;
}
