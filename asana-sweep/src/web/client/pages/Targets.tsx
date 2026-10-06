import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TargetRow, TargetsData } from '../../../sweep/types';
import { api, currentMonth, fmtMoney, fmtRelative, monthLabel, shiftMonth, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { AccountGroup, GroupsHead, useOpenGroups, type GroupLight } from '../groups';
import { Confetti } from '../celebrate';

/**
 * Onboarding > Targets: every lead on the list ranked by how far along the deal is, with the context, the
 * next steps and the blockers behind it, the AM who handles it, and the tick that moves a won deal into
 * Onboarding steps. Pick a month to see what closed or did not.
 */
const KIND: Record<string, string> = { call: 'Call', email: 'Email', slack: 'Slack', sop: 'Note', report: 'Report' };

export default function TargetsPage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<TargetsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [amFilter, setAmFilter] = useState('');
  const [celebrate, setCelebrate] = useState(0);
  const isAdmin = useIsAdmin();
  const groups = useOpenGroups('targets');
  const load = useCallback(() => api.targets(month).then(setData).catch((e) => setError((e as Error).message)), [month]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => void api.targetsSeen(month).catch(() => undefined), 20000); return () => clearTimeout(t); }, [month]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'leads' || e.kind === 'copilot') load(); });
  const run = async <T extends TargetsData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const isCurrent = month === data.today.slice(0, 7);
  const ams = [...new Set(data.rows.map((r) => r.am_name ?? 'Unassigned'))].sort();
  const rows = data.rows.filter((r) => !amFilter || (r.am_name ?? 'Unassigned') === amFilter);
  const lightOf = (r: TargetRow): GroupLight => (r.closed_in_month === 'won' || r.status === 'ready' ? 'green' : r.closed_in_month === 'lost' || r.status === 'lost' ? 'grey' : r.analysis?.light ?? 'grey');
  const cur = data.currency;
  return (
    <>
      <Confetti run={celebrate} />
      <div className="page-head">
        <div>
          <h1>Targets</h1>
          <p className="hint" style={{ margin: 0 }}>Every lead on the list, read daily: how far along the deal is, what it hinges on, what is left to do and who handles it. Context comes from the calls, emails and Slack that name the lead (internal calls stay out). Tick <b>Ready to sign</b> and the deal moves to Onboarding steps.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${data.last_refresh_error ? 'warn' : data.last_refresh_at ? 'good' : 'muted'}`} title={data.last_refresh_error ?? ''}>{data.refreshing ? 'Reading…' : data.last_refresh_at ? `Read ${fmtRelative(data.last_refresh_at)}` : 'Not read yet'}</span>
          {!data.llm_configured && <span className="badge muted" title="Set ANTHROPIC_API_KEY for the written read">Rules only</span>}
          {isAdmin && <button className="small" disabled={busy === 'refresh' || data.refreshing} onClick={() => run('refresh', () => api.targetsRefresh({ month }), (r) => setNotice(`${r.analysed} lead(s) re-read${r.errors.length ? `; ${r.errors.length} error(s)` : ''}.`))}>{busy === 'refresh' ? 'Reading…' : 'Re-read all now'}</button>}
          <Link to="/leads" className="button small">Lead list ▸</Link>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      <div className="toolbar">
        <button className="small" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
        <b>{monthLabel(month)}</b>
        <button className="small" onClick={() => setMonth(shiftMonth(month, 1))} disabled={isCurrent}>›</button>
        {!isCurrent && <button className="small" onClick={() => setMonth(currentMonth())}>This month</button>}
        <select value={amFilter} onChange={(e) => setAmFilter(e.target.value)}><option value="">All AMs</option>{ams.map((a) => <option key={a} value={a}>{a}</option>)}</select>
        <span className="sub">{isCurrent ? 'Open deals plus what closed this month' : 'What was added, active, won or lost that month'}</span>
      </div>
      <div className="kpis">
        <div className="kpi"><div className="k">Open deals</div><div className="v">{data.totals.open}</div><div className="t">{fmtMoney(data.totals.pipeline_value, cur)} a month in pipeline</div></div>
        <div className="kpi"><div className="k">Ready to sign</div><div className="v">{data.totals.ready}</div><div className="t">in Onboarding steps</div></div>
        <div className="kpi"><div className="k">Won {isCurrent ? 'this month' : monthLabel(month).split(' ')[0]}</div><div className="v">{data.totals.won}</div><div className="t">{fmtMoney(data.totals.won_value, cur)} a month</div></div>
        <div className="kpi"><div className="k">Lost</div><div className="v">{data.totals.lost}</div><div className="t">{data.totals.won + data.totals.lost ? `${Math.round((data.totals.won / (data.totals.won + data.totals.lost)) * 100)}% close rate` : 'nothing closed yet'}</div></div>
        <div className="kpi"><div className="k">New</div><div className="v">{data.totals.new}</div><div className="t">since the team last looked</div></div>
      </div>
      {rows.length === 0 ? <div className="empty">No leads for {monthLabel(month)}{amFilter ? ` for ${amFilter}` : ''}. Leads come from the lead list (Growth › Leads).</div> : (
        <>
          <GroupsHead items={rows.length} lights={rows.map(lightOf)} open={rows.every((r) => groups.isOpen(r.lead.id))} onAll={(o) => groups.setAll(rows.map((r) => r.lead.id), o)} />
          <div className="areas">
            {rows.map((r) => {
              const a = r.analysis;
              const pct = r.status === 'ready' || r.lead.signed ? 100 : a?.progress_pct ?? 0;
              return (
                <AccountGroup key={r.lead.id} light={lightOf(r)} name={r.lead.name} sub={`${r.lead.country ?? ''}${r.lead.poc ? ` · ${r.lead.poc}` : ''}`} open={groups.isOpen(r.lead.id)} onToggle={() => groups.toggle(r.lead.id)}
                  summary={<span>{r.is_new && <span className="bell" title="New or changed since the team last looked">🔔 new</span>} {r.closed_in_month === 'won' ? <span className="win-badge">✓ Won</span> : r.closed_in_month === 'lost' ? <span className="badge muted">Lost</span> : r.status === 'ready' ? <span className="win-badge">✓ Ready to sign</span> : null} {a ? `${a.stage_label} · ${a.summary}` : r.lead.stage ?? 'Not read yet'}</span>}
                  nums={<><span className="num" style={{ minWidth: 120 }}><span className="k">Progress</span><span className="v"><div className={`progress ${lightOf(r) === 'green' ? 'good' : lightOf(r) === 'amber' ? 'warn' : lightOf(r) === 'red' ? 'crit' : ''}`} style={{ width: 110 }}><i style={{ width: `${pct}%` }} /></div></span></span><span className="num"><span className="k">Value</span><span className="v">{r.lead.est_value !== null ? fmtMoney(r.lead.est_value, cur) : '–'}</span></span></>}
                  right={<>{r.am_name ? <span className="badge muted">{r.am_name}</span> : <span className="badge warn" title="No AM assigned">no AM</span>}{a?.blockers.length ? <span className="badge crit" title={a.blockers.join('\n')}>{a.blockers.length}</span> : null}</>}>
                  {groups.isOpen(r.lead.id) && <TargetDetail row={r} data={data} month={month} busy={busy} run={run} isAdmin={isAdmin} onWon={() => setCelebrate((n) => n + 1)} setNotice={setNotice} />}
                </AccountGroup>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function TargetDetail({ row: r, data, month, busy, run, isAdmin, onWon, setNotice }: { row: TargetRow; data: TargetsData; month: string; busy: string | null; run: <T extends TargetsData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; isAdmin: boolean; onWon: () => void; setNotice: (s: string) => void }) {
  const a = r.analysis;
  const [ticked, setTicked] = useState(r.status === 'ready');
  useEffect(() => { setTicked(r.status === 'ready'); }, [r.status]);
  const ready = () => {
    if (!window.confirm(`Mark ${r.lead.name} as ready to sign? It moves to Onboarding steps.`)) return;
    setTicked(true);
    void run(`ready${r.lead.id}`, () => api.targetReady(r.lead.id, month), (res) => { onWon(); setNotice(`${r.lead.name} is in Onboarding steps.`); void res; });
  };
  return (
    <div>
      <div className="page-head" style={{ marginBottom: 8, alignItems: 'center' }}>
        <div className="inline-form" style={{ alignItems: 'center' }}>
          <label className="field" style={{ minWidth: 180 }}><span className="lbl">Handled by</span><select value={r.am_person_id ?? ''} disabled={!isAdmin && Boolean(r.am_person_id)} onChange={(e) => run(`am${r.lead.id}`, () => api.targetUpdate(r.lead.id, { am_person_id: e.target.value ? Number(e.target.value) : null, month }))}><option value="">Unassigned</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role === 'aa' ? ' (AA)' : ''}</option>)}</select></label>
          <span className="sub">Stage on the list: <b>{r.lead.stage ?? 'none'}</b>{r.lead.last_contact ? ` · last contact ${r.lead.last_contact}` : ''}{r.lead.priority ? ` · priority ${r.lead.priority}` : ''}{r.lead.sourced_by_name ? ` · sourced by ${r.lead.sourced_by_name}` : ''}</span>
        </div>
        <div className="actions">
          {r.status === 'ready' || r.lead.signed ? (
            <>
              <span className="big-tick on" title={r.ready_by ? `Ticked by ${r.ready_by} ${fmtRelative(r.ready_at)}` : 'Signed on the lead list'}><span className="box" /> Ready to sign</span>
              {r.onboarding_id && <Link to="/onboarding" className="button small primary">Onboarding steps ▸</Link>}
              {isAdmin && !r.lead.signed && <button className="small" onClick={() => run(`reopen${r.lead.id}`, () => api.targetReopen(r.lead.id, month))}>Reopen</button>}
            </>
          ) : r.status === 'lost' || r.closed_in_month === 'lost' ? (
            <>{isAdmin && r.status === 'lost' && <button className="small" onClick={() => run(`reopen${r.lead.id}`, () => api.targetReopen(r.lead.id, month))}>Reopen</button>}</>
          ) : (
            <>
              <span className={`big-tick ${ticked ? 'on' : ''}`} role="button" onClick={ready} title="Tick when the client has agreed to sign: it moves to Onboarding steps"><span className="box" /> Ready to sign</span>
              <button className="small" disabled={busy === `an${r.lead.id}`} onClick={() => run(`an${r.lead.id}`, () => api.targetAnalyse(r.lead.id, month))}>{busy === `an${r.lead.id}` ? 'Reading…' : 'Re-read'}</button>
              {isAdmin && <button className="small" onClick={() => window.confirm(`Mark ${r.lead.name} as lost?`) && run(`lost${r.lead.id}`, () => api.targetUpdate(r.lead.id, { status: 'lost', month }))}>Lost</button>}
            </>
          )}
        </div>
      </div>
      {!a ? <p className="sub">Not read yet. <button className="small" onClick={() => run(`an${r.lead.id}`, () => api.targetAnalyse(r.lead.id, month))}>Read now</button></p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          <div className="card"><h4 style={{ marginTop: 0 }}>Where it is <span className="sub">{a.stage_label} · {a.progress_pct}% · {a.generator === 'claude' ? 'Claude' : 'rules'} {fmtRelative(a.analysed_at)}</span></h4><p style={{ marginBottom: 6 }}>{a.summary}</p>{a.signals.length > 0 && <ul className="sub" style={{ margin: 0, paddingLeft: 18 }}>{a.signals.map((s, i) => <li key={i}>{s}</li>)}</ul>}</div>
          <div className="card"><h4 style={{ marginTop: 0 }}>Outstanding steps</h4>{a.next_steps.length ? <ol className="target-steps" style={{ margin: 0, paddingLeft: 18 }}>{a.next_steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : <p className="sub">Nothing outstanding.</p>}</div>
          <div className="card"><h4 style={{ marginTop: 0 }}>Blockers</h4>{a.blockers.length ? <ul className="target-blockers" style={{ margin: 0, paddingLeft: 18 }}>{a.blockers.map((b, i) => <li key={i} style={{ color: 'var(--crit-ink)' }}>{b}</li>)}</ul> : <p className="sub">None spotted.</p>}</div>
          <div className="card" style={{ gridColumn: '1 / -1' }}><h4 style={{ marginTop: 0 }}>Context <span className="sub">{a.sources.length} source{a.sources.length === 1 ? '' : 's'} that name {r.lead.name}; internal calls are never read here</span></h4>
            {a.sources.length === 0 ? <p className="sub">Nothing on record names this lead yet. Calls, emails and Slack that mention it will show here after the next evidence index.</p> : (
              <ol className="sources">{a.sources.map((s, i) => <li key={i}><span className="badge muted">{KIND[s.kind] ?? s.kind}</span> <b>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</b>{s.occurred_at ? <span className="sub"> · {s.occurred_at.slice(0, 10)}</span> : null}<div className="sub">{s.snippet}</div></li>)}</ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
