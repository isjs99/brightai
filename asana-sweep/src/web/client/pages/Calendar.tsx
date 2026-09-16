import { useEffect, useState, type ReactElement } from 'react';
import type { CalendarAccountRow, CalendarCell, CalendarData } from '../../../sweep/types';
import { api, currentMonth, fmtPct, monthLabel, shiftMonth } from '../api';

const CELL: Record<string, string> = { complete: '✓', partial: '◐', none: '○', empty: '·', error: '!', unlinked: '·' };

function Cell({ c, today }: { c: CalendarCell; today: string }) {
  const future = c.date > today;
  const cls = c.status ? `s-${c.status}` : future ? 's-future' : 's-null';
  const title = c.status
    ? `${c.date}: ${c.status}. AM ${c.am_done}/${c.am_total}, AA ${c.aa_done}/${c.aa_total}`
    : future
      ? `${c.date}: upcoming`
      : `${c.date}: not checked`;
  return (
    <td className="cell" title={title}>
      <span className={cls}>{c.status ? CELL[c.status] : ''}</span>
    </td>
  );
}

function Compliance({ value, target }: { value: number | null; target: number }) {
  if (value === null) return <span className="sub">–</span>;
  const cls = value >= target ? 'ok' : value >= 80 ? 'warn-ink' : 'bad';
  return <span className={`frac ${cls}`}>{fmtPct(value)}</span>;
}

export default function CalendarPage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAccounts, setShowAccounts] = useState(true);

  useEffect(() => {
    setData(null);
    api.calendar(month).then(setData).catch((e) => setError((e as Error).message));
  }, [month]);

  const dayHead = (d: string) => {
    const dt = new Date(d + 'T12:00:00Z');
    return `${dt.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2)} ${d.slice(8, 10)}`;
  };

  const AccountRows = ({ rows, today }: { rows: CalendarAccountRow[]; today: string }) => (
    <>
      {rows.map((r) => (
        <tr key={r.account.id} className="sub-row">
          <td className="sub" style={{ paddingLeft: 24 }}>{r.account.name}{!r.account.asana_project_gid && <span className="badge muted" style={{ marginLeft: 6 }}>not linked</span>}</td>
          {r.cells.map((c) => <Cell key={c.date} c={c} today={today} />)}
          <td className="num">{r.complete_days}/{r.checked_days}</td>
          <td className="num">{r.missed ? <span className="frac bad">{r.missed}</span> : <span className="sub">0</span>}</td>
          <td className="num"><Compliance value={r.compliance} target={100} /></td>
        </tr>
      ))}
    </>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="hint" style={{ margin: 0 }}>Who checked off their checklist on each working day. Target is 100%. "Missed" counts every account-day that was not fully complete at the check time.</p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="small" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <b>{monthLabel(month)}</b>
          <button className="small" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= currentMonth()}>›</button>
          <label className="toggle" style={{ marginLeft: 12 }}><input type="checkbox" checked={showAccounts} onChange={(e) => setShowAccounts(e.target.checked)} /> show accounts</label>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {data === null ? <p>Loading…</p> : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="v"><Compliance value={data.totals.compliance} target={data.target} /></div><div className="k">compliance vs {data.target}% target</div></div>
            <div className="kpi"><div className="v">{data.totals.missed}</div><div className="k">missed instances</div><div className="d">account-days not complete</div></div>
            <div className="kpi"><div className="v">{data.totals.complete_days}/{data.totals.checked_days}</div><div className="k">complete / checked</div></div>
            <div className="kpi"><div className="v">{data.workdays.filter((d) => d <= data.today).length}/{data.workdays.length}</div><div className="k">working days so far</div></div>
          </div>
          <div className="legend">
            <span className="cell"><span className="s-complete">✓</span> complete</span>
            <span className="cell"><span className="s-partial">◐</span> partial</span>
            <span className="cell"><span className="s-none">○</span> nothing done</span>
            <span className="cell"><span className="s-empty">·</span> no tasks / not linked</span>
            <span className="cell"><span className="s-error">!</span> error</span>
            <span className="cell"><span className="s-null"> </span> not checked</span>
            <span className="cell"><span className="s-future"> </span> upcoming</span>
          </div>
          <div className="grid-wrap">
            <table className="heat">
              <thead>
                <tr>
                  <th>AM / account</th>
                  {data.workdays.map((d) => <th key={d} className="day">{dayHead(d)}</th>)}
                  <th className="num">Done</th>
                  <th className="num">Missed</th>
                  <th className="num">Compliance</th>
                </tr>
              </thead>
              <tbody>
                {data.ams.map((am) => (
                  <AmBlock key={am.am_name} am={am} today={data.today} workdays={data.workdays} showAccounts={showAccounts} AccountRows={AccountRows} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function AmBlock({ am, today, workdays, showAccounts, AccountRows }: { am: CalendarData['ams'][number]; today: string; workdays: string[]; showAccounts: boolean; AccountRows: (p: { rows: CalendarAccountRow[]; today: string }) => ReactElement }) {
  // AM summary cell per day: complete if all their linked accounts were complete that day.
  const summary = workdays.map((date) => {
    const cells = am.accounts.map((a) => a.cells.find((c) => c.date === date)!).filter((c) => c.status && c.status !== 'unlinked' && c.status !== 'empty');
    const checked = cells.length;
    const done = cells.filter((c) => c.combined_complete).length;
    const status = checked === 0 ? null : done === checked ? 'complete' : done === 0 ? 'none' : 'partial';
    return { date, status, done, checked };
  });
  return (
    <>
      <tr className="am-row">
        <td><b>{am.am_name}</b> <span className="sub">· {am.accounts.length} account{am.accounts.length === 1 ? '' : 's'}</span></td>
        {summary.map((s) => (
          <td key={s.date} className="cell" title={s.status ? `${s.date}: ${s.done}/${s.checked} accounts complete` : s.date > today ? `${s.date}: upcoming` : `${s.date}: not checked`}>
            <span className={s.status ? `s-${s.status}` : s.date > today ? 's-future' : 's-null'}>{s.status ? CELL[s.status] : ''}</span>
          </td>
        ))}
        <td className="num"><b>{am.complete_days}/{am.checked_days}</b></td>
        <td className="num">{am.missed ? <b className="frac bad">{am.missed}</b> : <span className="sub">0</span>}</td>
        <td className="num"><b><Compliance value={am.compliance} target={100} /></b></td>
      </tr>
      {showAccounts && <AccountRows rows={am.accounts} today={today} />}
    </>
  );
}
