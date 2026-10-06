import { useEffect, useState, type ReactElement } from 'react';
import type { AlertCalendar, AlertDay, CalendarAccountRow, CalendarCell, CalendarData } from '../../../sweep/types';
import { Link, useSearchParams } from 'react-router-dom';
import { useAccountScope, useAllowedAccounts, useInScope } from '../hubs';
import { api, currentMonth, fmtPct, fmtRelative, monthLabel, shiftMonth, useLiveUpdates } from '../api';

const CELL: Record<string, string> = { complete: '✓', partial: '◐', none: '○', empty: '–', error: '!', unlinked: '–' };

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
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'alerts' ? 'alerts' : 'checklist';
  const setView = (v: 'checklist' | 'alerts') => { const n = new URLSearchParams(params); if (v === 'alerts') n.set('view', 'alerts'); else n.delete('view'); setParams(n); };
  if (view === 'alerts') return <AlertsCalendar onView={setView} />;
  return <ChecklistCalendar onView={setView} />;
}

function ViewTabs({ view, onView }: { view: 'checklist' | 'alerts'; onView: (v: 'checklist' | 'alerts') => void }) {
  return <div className="tabs" style={{ marginBottom: 0 }}><button className={`tab ${view === 'checklist' ? 'active' : ''}`} onClick={() => onView('checklist')}>Checklist</button><button className={`tab ${view === 'alerts' ? 'active' : ''}`} onClick={() => onView('alerts')}>Alerts</button></div>;
}

/** Alerts view: a month of traffic lights. Red = a critical incident or flag was open that day, amber = a warning, green = nothing open and the checklist done. */
function AlertsCalendar({ onView }: { onView: (v: 'checklist' | 'alerts') => void }) {
  const scope = useAccountScope();
  const inScope = useInScope();
  const allowed = useAllowedAccounts();
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<AlertCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const load = () => api.alertCalendar(month).then((d) => { setData(d); setSel((cur) => cur && cur.startsWith(month) ? cur : d.today.startsWith(month) ? d.today : d.days[d.days.length - 1]?.date ?? null); }).catch((e) => setError((e as Error).message));
  useEffect(() => { setData(null); load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps
  useLiveUpdates((e) => { if (e.kind === 'incidents' || e.kind === 'monitor' || e.kind === 'check') load(); });
  const scoped = (d: AlertDay) => d.accounts.filter((a) => inScope(a.account_id));
  const lightOf = (d: AlertDay) => { if (scope === null && allowed === null) return d.light; const mine = scoped(d); return d.date > (data?.today ?? '') ? 'none' : mine.some((a) => a.light === 'crit') ? 'crit' : mine.some((a) => a.light === 'warn') ? 'warn' : mine.some((a) => a.light === 'good') ? 'good' : 'none'; };
  const day = data?.days.find((d) => d.date === sel) ?? null;
  const first = data ? new Date(data.days[0].date + 'T12:00:00Z').getUTCDay() : 0; // 0 = Sunday
  const lead = (first + 6) % 7; // Monday first
  const LIGHT_LABEL = { crit: 'Critical', warn: 'Warning', good: 'All clear', none: 'Nothing recorded' } as const;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="hint" style={{ margin: 0 }}>Every day graded by what was open on it: red for a critical incident or flag, amber for a warning, green when nothing was open and the checklist was done. Click a day for the alerts, flags and checklist behind it.</p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <ViewTabs view="alerts" onView={onView} />
          <button className="small" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <b>{monthLabel(month)}</b>
          <button className="small" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= currentMonth()}>›</button>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {!data ? <p>Loading…</p> : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="v">{data.totals.days_red}</div><div className="k">red days</div><div className="d">{data.totals.days_amber} amber · {data.totals.days_green} green</div></div>
            <div className="kpi"><div className="v">{data.totals.crit}</div><div className="k">critical alerts opened</div><div className="d">{data.totals.warn} warnings · {data.totals.info} info</div></div>
            <div className="kpi"><div className="v">{data.totals.resolved}</div><div className="k">resolved this month</div></div>
            <div className="kpi"><div className="v">{data.default_channel || '–'}</div><div className="k">default Slack channel</div><div className="d"><Link to="/monitor?tab=incidents">Channel pickers ▸</Link></div></div>
          </div>
          <div className="alert-split">
            <div className="alert-cal">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="dow">{d}</div>)}
              {Array.from({ length: lead }).map((_, i) => <div key={`e${i}`} className="alert-day empty" />)}
              {data.days.map((d) => {
                const l = lightOf(d);
                const mine = scoped(d);
                const crit = mine.reduce((n, a) => n + a.incidents.filter((i) => i.severity === 'crit' && i.opened_today).length + a.flags.filter((f) => f.severity === 'crit' && f.opened_today).length, 0);
                const warn = mine.reduce((n, a) => n + a.incidents.filter((i) => i.severity === 'warn' && i.opened_today).length + a.flags.filter((f) => f.severity === 'warn' && f.opened_today).length, 0);
                const checked = mine.filter((a) => a.checklist).length; const done = mine.filter((a) => a.checklist?.combined_complete).length;
                return (
                  <button key={d.date} className={`alert-day ${l} ${sel === d.date ? 'sel' : ''} ${d.date === data.today ? 'today' : ''}`} onClick={() => setSel(d.date)} title={`${d.date}: ${LIGHT_LABEL[l]}`}>
                    <span className="d">{Number(d.date.slice(8, 10))}<span className={`light ${l}`} /></span>
                    {d.date <= data.today && <span className="n">{crit ? `${crit} critical · ` : ''}{warn ? `${warn} warning${warn === 1 ? '' : 's'}` : crit ? '' : l === 'good' ? 'clear' : ''}</span>}
                    {d.date <= data.today && checked > 0 && <span className="n">checklist {done}/{checked}</span>}
                  </button>
                );
              })}
            </div>
            <div className="card">
              {!day ? <p className="sub">Pick a day.</p> : (
                <>
                  <div className="page-head" style={{ marginBottom: 8 }}><h3 style={{ margin: 0 }}>{new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</h3><span className={`badge ${lightOf(day) === 'crit' ? 'crit' : lightOf(day) === 'warn' ? 'warn' : lightOf(day) === 'good' ? 'good' : 'muted'}`}>{LIGHT_LABEL[lightOf(day)]}</span></div>
                  {scoped(day).length === 0 ? <p className="sub">Nothing recorded for this day.</p> : scoped(day).filter((a) => a.light !== 'none' || a.checklist).sort((a, b) => ['crit', 'warn', 'good', 'none'].indexOf(a.light) - ['crit', 'warn', 'good', 'none'].indexOf(b.light)).map((a) => (
                    <div key={a.account_id} className={`alert-acc ${a.light}`}>
                      <div className="page-head" style={{ marginBottom: 4 }}><b>{a.account_name}</b><span className="sub">{a.am_name ?? ''}{a.checklist ? ` · checklist ${a.checklist.combined_complete ? 'done' : `${a.checklist.am_done + a.checklist.aa_done}/${a.checklist.am_total + a.checklist.aa_total}`}` : ' · no checklist record'}</span></div>
                      {a.incidents.map((i) => <div key={i.id} className="sub" style={{ marginBottom: 3 }}><span className={`badge ${i.severity === 'crit' ? 'crit' : i.severity === 'warn' ? 'warn' : 'muted'}`}>{i.severity}</span> <b>{i.title}</b> {i.message}{i.slack_channel ? <span className="sub"> · {i.posted_at ? `posted to ${i.slack_channel}` : `not posted (${i.slack_channel})`}</span> : null}{i.resolved_at ? <span className="sub"> · resolved {fmtRelative(i.resolved_at)}</span> : i.opened_today ? <span className="sub"> · opened</span> : <span className="sub"> · still open</span>}</div>)}
                      {a.flags.filter((f) => !a.incidents.some((i) => i.message.startsWith(f.message.slice(0, 40)))).map((f, idx) => <div key={idx} className="sub" style={{ marginBottom: 3 }}><span className={`badge ${f.severity === 'crit' ? 'crit' : f.severity === 'warn' ? 'warn' : 'muted'}`}>{f.severity}</span> {f.message}{f.resolved_at ? ` · resolved ${fmtRelative(f.resolved_at)}` : ''}</div>)}
                      {a.incidents.length === 0 && a.flags.length === 0 && <div className="sub">No alerts.</div>}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function ChecklistCalendar({ onView }: { onView: (v: 'checklist' | 'alerts') => void }) {
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
          <td className="sub" style={{ paddingLeft: 24 }}>{r.account.name}</td>
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
          <ViewTabs view="checklist" onView={onView} />
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
            <span className="cell"><span className="s-empty">–</span> no tasks / not linked</span>
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
