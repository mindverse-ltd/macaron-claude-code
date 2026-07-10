import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, fmtAgo, type AnalyticsResponse, type UsageBySession } from '../lib/api';

const WINDOWS: Array<{ id: string; label: string }> = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'all', label: 'All' },
];

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compact = (n: number) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const int = (n: number) => n.toLocaleString('en-US');
const shortModel = (m: string) => m.replace(/^claude-/, '') || 'unknown';

type SortKey = keyof Pick<
  UsageBySession,
  'preview' | 'model' | 'messageCount' | 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens' | 'costUsd' | 'lastActivity'
>;

const SESSION_CAP = 100;

export function Analytics() {
  const [window, setWindow] = useState('30d');
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'costUsd', dir: 'desc' });

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    setData(null);
    api
      .analytics(window)
      .then((d) => { if (live) { setData(d); setLoading(false); } })
      .catch((e) => { if (live) { setError((e as Error).message); setLoading(false); } });
    return () => { live = false; };
  }, [window]);

  const totals = data?.totals;
  const cacheHit = totals
    ? totals.cacheReadTokens / Math.max(1, totals.inputTokens + totals.cacheWriteTokens + totals.cacheReadTokens)
    : 0;

  const dailyChart = useMemo(
    () => (data?.daily ?? []).map((d) => ({ ...d, label: d.date.slice(5) })),
    [data],
  );
  const modelChart = useMemo(
    () => (data?.byModel ?? []).map((m) => ({ ...m, label: shortModel(m.model) })),
    [data],
  );

  const sortedSessions = useMemo(() => {
    const rows = [...(data?.bySession ?? [])];
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * mul;
      return ((av as number) - (bv as number)) * mul;
    });
    return rows;
  }, [data, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <section className="view">
      <header>
        <h1>Usage & Cost</h1>
        <p>Token usage, spend, and burn rate across your Claude Code sessions. Cost is estimated from public model rates — transcripts don't record a price.</p>
      </header>

      <div className="usage-pills">
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            className={'usage-pill' + (window === w.id ? ' active' : '')}
            onClick={() => setWindow(w.id)}
          >
            {w.label}
          </button>
        ))}
      </div>

      {error && <div className="placeholder">Error: {error}</div>}
      {loading && !data && <div className="muted">Loading…</div>}

      {totals && (
        <>
          <div className="usage-tiles">
            <div className="stat-tile">
              <div className="stat-label">Total cost</div>
              <div className="stat-value">{usd(totals.costUsd)}</div>
              <div className="stat-sub">{int(totals.messageCount)} messages</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Total tokens</div>
              <div className="stat-value">{compact(totals.inputTokens + totals.outputTokens + totals.cacheWriteTokens + totals.cacheReadTokens)}</div>
              <div className="stat-sub">{compact(totals.inputTokens)} in · {compact(totals.outputTokens)} out</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Cache hit</div>
              <div className="stat-value">{(cacheHit * 100).toFixed(1)}%</div>
              <div className="stat-sub">{compact(totals.cacheReadTokens)} read · {compact(totals.cacheWriteTokens)} write</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Sessions</div>
              <div className="stat-value">{int(totals.sessionCount)}</div>
              <div className="stat-sub">{dailyChart.length} active day{dailyChart.length === 1 ? '' : 's'}</div>
            </div>
          </div>

          <div className="usage-panel">
            <h2 className="sec-title">Daily spend</h2>
            {dailyChart.length === 0 ? (
              <p className="muted">No activity in this window.</p>
            ) : (
              <div className="usage-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={dailyChart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={24} />
                    <YAxis tickFormatter={(v) => usd0(Number(v))} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} width={54} />
                    <Tooltip
                      formatter={(v) => [usd(Number(v)), 'Cost']}
                      labelFormatter={(l) => `Date ${l}`}
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 12 }}
                    />
                    <Area type="monotone" dataKey="costUsd" stroke="var(--accent)" strokeWidth={2} fill="url(#costFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="usage-panel">
            <h2 className="sec-title">Cost by model</h2>
            {modelChart.length === 0 ? (
              <p className="muted">No activity in this window.</p>
            ) : (
              <div className="usage-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={modelChart} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke="var(--border)" horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => usd0(Number(v))} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
                    <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-2)' }} tickLine={false} axisLine={false} width={130} />
                    <Tooltip
                      formatter={(v) => [usd(Number(v)), 'Cost']}
                      cursor={{ fill: 'var(--accent-soft)' }}
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 12 }}
                    />
                    <Bar dataKey="costUsd" fill="var(--accent)" radius={[0, 4, 4, 0]} maxBarSize={26} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {modelChart.some((m) => !m.known) && (
              <p className="usage-note">Models marked <span className="usage-est">~est</span> didn't match the rate table and use a default Sonnet-class estimate.</p>
            )}
          </div>

          <div className="usage-panel">
            <h2 className="sec-title">Sessions</h2>
            {sortedSessions.length === 0 ? (
              <p className="muted">No sessions in this window.</p>
            ) : (
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th className="ut-left" onClick={() => toggleSort('preview')}>Session{arrow('preview')}</th>
                      <th className="ut-left" onClick={() => toggleSort('model')}>Model{arrow('model')}</th>
                      <th onClick={() => toggleSort('messageCount')}>Msgs{arrow('messageCount')}</th>
                      <th onClick={() => toggleSort('inputTokens')}>Input{arrow('inputTokens')}</th>
                      <th onClick={() => toggleSort('outputTokens')}>Output{arrow('outputTokens')}</th>
                      <th onClick={() => toggleSort('cacheReadTokens')}>Cache R{arrow('cacheReadTokens')}</th>
                      <th onClick={() => toggleSort('cacheWriteTokens')}>Cache W{arrow('cacheWriteTokens')}</th>
                      <th onClick={() => toggleSort('costUsd')}>Cost{arrow('costUsd')}</th>
                      <th onClick={() => toggleSort('lastActivity')}>Last{arrow('lastActivity')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSessions.slice(0, SESSION_CAP).map((s) => (
                      <tr key={`${s.project}/${s.sessionId}`}>
                        <td className="ut-left ut-preview" title={s.preview || s.sessionId}>{s.preview || s.sessionId.slice(0, 8)}</td>
                        <td className="ut-left ut-mono">{shortModel(s.model)}</td>
                        <td>{int(s.messageCount)}</td>
                        <td>{compact(s.inputTokens)}</td>
                        <td>{compact(s.outputTokens)}</td>
                        <td>{compact(s.cacheReadTokens)}</td>
                        <td>{compact(s.cacheWriteTokens)}</td>
                        <td className="ut-cost">{usd(s.costUsd)}</td>
                        <td className="ut-ago">{fmtAgo(s.lastActivity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sortedSessions.length > SESSION_CAP && (
                  <p className="usage-note">Showing top {SESSION_CAP} of {int(sortedSessions.length)} sessions.</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
