import { useEffect, useState } from 'react';
import type { Analytics } from '../../../sweep/types';
import { api } from '../api';

const pct = (v: number | null) => (v === null ? '–' : `${v}%`);

function Bar({ value }: { value: number | null }) {
  return (
    <div className="bar" title={pct(value)}>
      <span style={{ width: `${value ?? 0}%` }} />
    </div>
  );
}

const CELL: Record<string, string> = { complete: '✓', partial: '◐', none: '○', empty: '·', error: '!', unlinked: '·' };

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterAm, setFilterAm] = useState('');

  useEffect(() => {
    api.analytics(days).then(setData).catch((e) => setError((e as Error).message));
  }, [days]);

  const accounts = (data?.accounts ?? []).filter((a) => a.account.enabled && (!filterAm || (a.account.am_name ?? 'Unassigned') === filterAm));
  const scored = accounts.filter((a) => a.checks > 0);
  const totalChecks = scored.reduce((n, a) => n + a.checks, 0);
  const wavg = (key: 'rate_am' | 'rate_aa' | 'rate_combined') =>
    totalChecks ? Math.round(scored.reduce((n, a) => n + (a[key] ?? 0) * a.checks, 0) / totalChecks) : null;
  const last = data?.days.length ? data.days[data.days.length - 1] : null;
  const shortDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="hint" style={{ margin: 0 }}>Share of daily checks where the checklist was complete by the check time. {data ? `${data.from} to ${data.to}.` : ''}</p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <select value={filterAm} onChange={(e) => setFilterAm(e.target.value)}>
            <option value="">All AMs</option>
            {(data?.ams ?? []).map((a) => <option key={a.am_name} value={a.am_name}>{a.am_name}</option>)}
          </select>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {data === null ? <p>Loading…</p> : data.dates.length === 0 ? (
        <div className="empty">No checks recorded yet. Use "Check all now" on the Checklists page, or wait for the 16:00 run.</div>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="v">{pct(wavg('rate_combined'))}</div><div className="k">complete (AM + AA)</div><div className="d">{totalChecks} account-days</div></div>
            <div className="kpi"><div className="v">{pct(wavg('rate_am'))}</div><div className="k">AM checklist complete</div></div>
            <div className="kpi"><div className="v">{pct(wavg('rate_aa'))}</div><div className="k">AA actions complete</div></div>
            <div className="kpi"><div className="v">{last ? `${last.combined_complete}/${last.accounts_checked}` : '–'}</div><div className="k">complete on {last ? shortDate(last.date) : ''}</div></div>
          </div>

          <h2>By account manager</h2>
          <div className="card">
            <table>
              <thead><tr><th>AM</th><th className="num">Accounts</th><th className="num">Checks</th><th>Complete</th><th className="num">AM</th><th className="num">AA</th></tr></thead>
              <tbody>
                {data.ams.filter((a) => !filterAm || a.am_name === filterAm).map((a) => (
                  <tr key={a.am_name}>
                    <td><b>{a.am_name}</b></td>
                    <td className="num">{a.accounts}</td>
                    <td className="num">{a.checks}</td>
                    <td><div className="bar-row" style={{ border: 0, padding: 0, gridTemplateColumns: '160px 48px' }}><Bar value={a.rate_combined} /><span className="n">{pct(a.rate_combined)}</span></div></td>
                    <td className="num">{pct(a.rate_am)}</td>
                    <td className="num">{pct(a.rate_aa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>By account, per day</h2>
          <div className="legend">
            <span className="cell"><span className="s-complete">✓</span> complete</span>
            <span className="cell"><span className="s-partial">◐</span> partial</span>
            <span className="cell"><span className="s-none">○</span> nothing done</span>
            <span className="cell"><span className="s-empty">·</span> no tasks due / not linked</span>
            <span className="cell"><span className="s-error">!</span> error</span>
            <span className="cell"><span className="s-null"> </span> not checked</span>
          </div>
          <div className="grid-wrap">
            <table className="heat">
              <thead>
                <tr>
                  <th>Account</th><th className="hide-sm">AM</th>
                  {data.dates.map((d) => <th key={d} className="day">{shortDate(d)}</th>)}
                  <th className="num">Complete</th><th className="num hide-sm">AM</th><th className="num hide-sm">AA</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.account.id}>
                    <td><b>{a.account.name}</b></td>
                    <td className="hide-sm sub">{a.account.am_name ?? ''}</td>
                    {a.days.map((d) => (
                      <td key={d.date} className="cell" title={d.status ? `${d.date}: ${d.status}. AM ${d.am_done}/${d.am_total}, AA ${d.aa_done}/${d.aa_total}` : `${d.date}: not checked`}>
                        <span className={`s-${d.status ?? 'null'}`}>{d.status ? CELL[d.status] : ''}</span>
                      </td>
                    ))}
                    <td className="num">{pct(a.rate_combined)}</td>
                    <td className="num hide-sm">{pct(a.rate_am)}</td>
                    <td className="num hide-sm">{pct(a.rate_aa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
