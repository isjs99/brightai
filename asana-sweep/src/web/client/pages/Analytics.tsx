import { useEffect, useState } from 'react';
import type { Analytics, GradeRow, GradesData } from '../../../sweep/types';
import { api, currentMonth, fmtMoney, fmtPct, monthLabel, shiftMonth } from '../api';

const pct = (v: number | null) => (v === null ? '–' : `${v}%`);

function GradeBadge({ grade }: { grade: GradeRow['grade'] }) {
  return grade ? <span className={`grade ${grade}`}>{grade}</span> : <span className="sub">–</span>;
}

function GradeTable({ rows, showAm }: { rows: GradeRow[]; showAm: boolean }) {
  return (
    <table>
      <thead>
        <tr>
          <th>{showAm ? 'Account' : 'AM'}</th>
          {showAm && <th>AM</th>}
          <th>Grade</th>
          <th className="num">Score</th>
          <th className="num">Checklist</th>
          <th className="num hide-sm">Missed</th>
          <th className="num">GMV</th>
          <th className="num hide-sm">Target</th>
          <th className="num">GMV %</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.account_id ?? 'am'}-${r.name}`}>
            <td><b>{r.name}</b></td>
            {showAm && <td className="sub">{r.am_name ?? ''}</td>}
            <td><GradeBadge grade={r.grade} /></td>
            <td className="num">{r.score ?? '–'}</td>
            <td className="num"><span className={`frac ${r.compliance === null ? '' : r.compliance >= 100 ? 'ok' : r.compliance >= 80 ? 'warn-ink' : 'bad'}`}>{fmtPct(r.compliance)}</span><div className="sub">{r.checked_days} day{r.checked_days === 1 ? '' : 's'}</div></td>
            <td className="num hide-sm">{r.missed || <span className="sub">0</span>}</td>
            <td className="num">{fmtMoney(r.gmv)}</td>
            <td className="num hide-sm">{fmtMoney(r.target)}</td>
            <td className="num"><span className={`frac ${r.attainment === null ? '' : r.attainment >= 100 ? 'ok' : r.attainment >= 80 ? 'warn-ink' : 'bad'}`}>{fmtPct(r.attainment)}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GradesSection() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<GradesData | null>(null);
  const [weight, setWeight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api.grades(month).then((d) => { setData(d); setWeight(d.weight_checklist); }).catch((e) => setError((e as Error).message));
  }, [month]);

  const saveWeight = async () => {
    if (weight === null) return;
    try {
      await api.saveGradeWeight(weight);
      setData(await api.grades(month));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section style={{ marginBottom: 28 }}>
      <div className="page-head">
        <div>
          <h2 style={{ margin: 0 }}>Grades</h2>
          <p className="hint" style={{ margin: 0 }}>Checklist compliance (target 100%) blended with GMV against the monthly target. GMV uses the projected month-end figure while the month is running.</p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="small" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <b>{monthLabel(month)}</b>
          <button className="small" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= currentMonth()}>›</button>
          {weight !== null && (
            <label className="sub" style={{ marginLeft: 12 }}>
              checklist weight <input type="number" min={0} max={100} value={weight} onChange={(e) => setWeight(Number(e.target.value))} onBlur={saveWeight} style={{ width: 64 }} /> %
            </label>
          )}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {data === null ? <p>Loading…</p> : (
        <>
          <div className="legend"><span className="grade A">A</span> 90+ <span className="grade B">B</span> 80+ <span className="grade C">C</span> 70+ <span className="grade D">D</span> 60+ <span className="grade F">F</span> below 60 · score = {data.weight_checklist}% checklist + {100 - data.weight_checklist}% GMV attainment (capped at 100)</div>
          <h2>Account managers</h2>
          <GradeTable rows={data.ams} showAm={false} />
          <h2>Accounts</h2>
          <GradeTable rows={data.accounts.filter((r) => r.checked_days > 0 || r.gmv > 0 || r.target !== null)} showAm={true} />
        </>
      )}
    </section>
  );
}

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
      <GradesSection />
      <h2>Checklist completion</h2>
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
