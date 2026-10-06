import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Onboarding, OnboardingsData, OnboardingTerms } from '../../../sweep/types';
import { api, fmtMoney, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { AccountGroup, GroupsHead, useOpenGroups, type GroupLight } from '../groups';
import { Confetti } from '../celebrate';

/**
 * Onboarding > Onboarding steps: one collapsible block per client being onboarded, every step ticked in
 * order (contract, forms and access, shop and tools, compliance, commercial, launch, handover), the
 * context from the deal, and the retainer and commission terms at the end that become the account's deal.
 */
export default function OnboardingPage() {
  const [data, setData] = useState<OnboardingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  const [showDone, setShowDone] = useState(false);
  const [add, setAdd] = useState({ name: '', am: '' });
  const isAdmin = useIsAdmin();
  const groups = useOpenGroups('onboarding');
  const load = useCallback(() => api.onboardings().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'leads') load(); });
  const run = async <T extends OnboardingsData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const rows = data.onboardings.filter((o) => showDone || o.status === 'active');
  const lightOf = (o: Onboarding): GroupLight => (o.status === 'done' ? 'green' : o.total && o.done === o.total ? 'green' : Date.now() - Date.parse(o.updated_at) > 7 * 86400000 ? 'red' : o.done ? 'amber' : 'grey');
  return (
    <>
      <Confetti run={celebrate} />
      <div className="page-head">
        <div>
          <h1>Onboarding steps</h1>
          <p className="hint" style={{ margin: 0 }}>From signed to live. Every step gets ticked by the AM, in order: contract, forms and access, shop and tools, compliance, commercial, launch, handover. The retainer and commission terms at the end become the deal on the account. Deals arrive here from Targets; you can also start one by hand.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <label className="field check"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show completed</label>
          <Link to="/targets" className="button small">Targets ▸</Link>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      <div className="kpis">
        <div className="kpi"><div className="k">Onboarding now</div><div className="v">{data.onboardings.filter((o) => o.status === 'active').length}</div></div>
        <div className="kpi"><div className="k">Steps ticked</div><div className="v">{data.onboardings.filter((o) => o.status === 'active').reduce((n, o) => n + o.done, 0)}/{data.onboardings.filter((o) => o.status === 'active').reduce((n, o) => n + o.total, 0)}</div></div>
        <div className="kpi"><div className="k">Completed</div><div className="v">{data.onboardings.filter((o) => o.status === 'done').length}</div></div>
      </div>
      {isAdmin && (
        <div className="card inline-form" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 220 }}><span className="lbl">Start an onboarding by hand</span><input type="text" value={add.name} placeholder="Client name" onChange={(e) => setAdd({ ...add, name: e.target.value })} /></label>
          <label className="field" style={{ minWidth: 160 }}><span className="lbl">AM</span><select value={add.am} onChange={(e) => setAdd({ ...add, am: e.target.value })}><option value="">Unassigned</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <button className="small primary" disabled={!add.name.trim() || busy === 'start'} onClick={() => run('start', () => api.onboardingStart({ name: add.name.trim(), am_person_id: add.am ? Number(add.am) : null }), (r) => { setAdd({ name: '', am: '' }); groups.toggle(r.onboarding.id); })}>Start</button>
          <span className="sub">Templates: {data.templates.map((t) => <a key={t.key} href={t.url} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>{t.label}</a>)}</span>
        </div>
      )}
      {rows.length === 0 ? <div className="empty">Nothing onboarding right now. Tick "Ready to sign" on a target, or start one by hand.</div> : (
        <>
          <GroupsHead items={rows.length} lights={rows.map(lightOf)} open={rows.every((o) => groups.isOpen(o.id))} onAll={(v) => groups.setAll(rows.map((o) => o.id), v)} />
          <div className="areas">
            {rows.map((o) => (
              <AccountGroup key={o.id} light={lightOf(o)} name={o.name} sub={`${o.markets ?? ''}${o.am_name ? ` · ${o.am_name}` : ''}`} open={groups.isOpen(o.id)} onToggle={() => groups.toggle(o.id)}
                summary={o.status === 'done' ? <span className="win-badge">✓ Live {fmtRelative(o.completed_at)}</span> : `${o.done}/${o.total} steps · next: ${o.steps.find((s) => !s.done_at)?.title ?? 'all done, complete it'}`}
                nums={<span className="num"><span className="k">Progress</span><span className="v"><span className="ring" style={{ ['--p' as string]: o.total ? Math.round((o.done / o.total) * 100) : 0 }} data-label={`${o.total ? Math.round((o.done / o.total) * 100) : 0}%`} /></span></span>}
                right={<>{o.account_id ? <span className="badge good">account linked</span> : null}{o.terms.retainer !== null ? <span className="badge muted">{fmtMoney(o.terms.retainer, o.terms.currency)} + {o.terms.commission_pct ?? 0}%</span> : <span className="badge warn" title="Terms not entered yet">no terms</span>}</>}>
                {groups.isOpen(o.id) && <OnboardingDetail o={o} data={data} busy={busy} run={run} isAdmin={isAdmin} onComplete={() => { setCelebrate((n) => n + 1); setNotice(`${o.name} is live. The account is set up with the deal terms.`); }} />}
              </AccountGroup>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function OnboardingDetail({ o, data, busy, run, isAdmin, onComplete }: { o: Onboarding; data: OnboardingsData; busy: string | null; run: <T extends OnboardingsData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; isAdmin: boolean; onComplete: () => void }) {
  const [terms, setTerms] = useState<OnboardingTerms>(o.terms);
  const [addStep, setAddStep] = useState<{ group: string; title: string } | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  useEffect(() => { setTerms(o.terms); }, [o.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const groupsOf = [...new Set(o.steps.map((s) => s.group))];
  const allDone = o.total > 0 && o.done === o.total;
  const dirty = JSON.stringify(terms) !== JSON.stringify(o.terms);
  const tick = (key: string, done: boolean) => run(`t${o.id}${key}`, () => api.onboardingTick(o.id, key, done));
  return (
    <div>
      <div className="inline-form" style={{ marginBottom: 10, alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 170 }}><span className="lbl">AM</span><select value={o.am_person_id ?? ''} disabled={!isAdmin} onChange={(e) => run(`am${o.id}`, () => api.onboardingUpdate(o.id, { am_person_id: e.target.value ? Number(e.target.value) : null }))}><option value="">Unassigned</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field" style={{ minWidth: 200 }}><span className="lbl">Account in the dashboard</span><select value={o.account_id ?? ''} disabled={!isAdmin} onChange={(e) => run(`acc${o.id}`, () => api.onboardingUpdate(o.id, { account_id: e.target.value ? Number(e.target.value) : null }))}><option value="">Create on completion</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="field" style={{ minWidth: 120 }}><span className="lbl">Markets</span><input type="text" defaultValue={o.markets ?? ''} placeholder="DE, UK" onBlur={(e) => { if ((e.target.value || null) !== o.markets) void run(`mk${o.id}`, () => api.onboardingUpdate(o.id, { markets: e.target.value || null })); }} /></label>
        <span className="sub">{o.lead_name ? `From lead ${o.lead_name}` : 'Started by hand'}{o.created_by ? ` by ${o.created_by}` : ''} {fmtRelative(o.created_at)}</span>
      </div>
      {(o.context.summary || o.context.sources.length > 0) && (
        <details style={{ marginBottom: 10 }} open>
          <summary className="sub" style={{ cursor: 'pointer' }}>Context from the deal{o.context.poc ? ` · POC ${o.context.poc}` : ''}{o.context.est_value !== null ? ` · ${fmtMoney(o.context.est_value, 'EUR')} a month` : ''}</summary>
          {o.context.summary && <p style={{ margin: '6px 0' }}>{o.context.summary}</p>}
          {o.context.sources.length > 0 && <ol className="sources">{o.context.sources.slice(0, 6).map((s, i) => <li key={i}><span className="badge muted">{s.kind}</span> <b>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</b>{s.occurred_at ? <span className="sub"> · {s.occurred_at.slice(0, 10)}</span> : null}<div className="sub">{s.snippet}</div></li>)}</ol>}
        </details>
      )}
      {groupsOf.map((g) => {
        const steps = o.steps.filter((s) => s.group === g);
        const done = steps.filter((s) => s.done_at).length;
        return (
          <div key={g}>
            <div className="step-group"><span>{g}</span><span className={`frac ${done === steps.length ? 'ok' : ''}`}>{done}/{steps.length}</span>{isAdmin && <button className="small" style={{ marginLeft: 'auto' }} onClick={() => setAddStep({ group: g, title: '' })}>+ step</button>}</div>
            {steps.map((s) => (
              <div key={s.key} className={`step-row ${s.done_at ? 'done' : ''}`}>
                <span className={`big-tick ${s.done_at ? 'on' : ''}`} role="button" title={s.done_at ? `Ticked by ${s.done_by ?? 'someone'} ${fmtRelative(s.done_at)}` : 'Tick when done'} onClick={() => tick(s.key, !s.done_at)}><span className="box" /></span>
                <div style={{ flex: 1 }}>
                  <div className="title">{s.title}{s.link ? <> <a href={s.link} target="_blank" rel="noreferrer" className="sub">template ↗</a></> : null}{s.custom && isAdmin && <button className="small" style={{ marginLeft: 6 }} onClick={() => run(`rm${s.key}`, () => api.onboardingRemoveStep(o.id, s.key))}>remove</button>}</div>
                  {s.help && <div className="meta">{s.help}</div>}
                  {s.done_at && <div className="meta">Done by {s.done_by ?? 'someone'} {fmtRelative(s.done_at)}{s.note ? ` · ${s.note}` : ''}</div>}
                  {noteFor === s.key ? <input type="text" autoFocus defaultValue={s.note ?? ''} placeholder="Note (link, who, when)" onBlur={(e) => { setNoteFor(null); if ((e.target.value || null) !== s.note) void run(`n${s.key}`, () => api.onboardingTick(o.id, s.key, Boolean(s.done_at), e.target.value || null)); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} style={{ marginTop: 4 }} /> : <button className="small" style={{ marginTop: 4 }} onClick={() => setNoteFor(s.key)}>{s.note ? 'Edit note' : 'Add note'}</button>}
                </div>
              </div>
            ))}
            {addStep?.group === g && (
              <div className="inline-form" style={{ margin: '6px 0 0 36px', alignItems: 'flex-end' }}>
                <input type="text" autoFocus value={addStep.title} placeholder="Custom step" onChange={(e) => setAddStep({ ...addStep, title: e.target.value })} style={{ minWidth: 260 }} />
                <button className="small primary" disabled={!addStep.title.trim() || busy === 'addstep'} onClick={() => run('addstep', () => api.onboardingAddStep(o.id, { group: g, title: addStep.title.trim() }), () => setAddStep(null))}>Add</button>
                <button className="small" onClick={() => setAddStep(null)}>Cancel</button>
              </div>
            )}
          </div>
        );
      })}
      <div className="card" style={{ marginTop: 14 }}>
        <h4 style={{ marginTop: 0 }}>Retainer and commission terms <span className="sub">applied to the account's deal and P&L inputs</span></h4>
        <div className="inline-form" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 130 }}><span className="lbl">Retainer / month</span><input type="number" min={0} value={terms.retainer ?? ''} disabled={!isAdmin} onChange={(e) => setTerms({ ...terms, retainer: e.target.value === '' ? null : Number(e.target.value) })} /></label>
          <label className="field" style={{ minWidth: 90 }}><span className="lbl">Currency</span><select value={terms.currency} disabled={!isAdmin} onChange={(e) => setTerms({ ...terms, currency: e.target.value })}>{['EUR', 'GBP', 'USD'].map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="field" style={{ minWidth: 120 }}><span className="lbl">Commission %</span><input type="number" min={0} step={0.5} value={terms.commission_pct ?? ''} disabled={!isAdmin} onChange={(e) => setTerms({ ...terms, commission_pct: e.target.value === '' ? null : Number(e.target.value) })} /></label>
          <label className="field" style={{ minWidth: 170 }}><span className="lbl">Commission on</span><select value={terms.commission_basis} disabled={!isAdmin} onChange={(e) => setTerms({ ...terms, commission_basis: e.target.value as 'gmv' | 'mor' })}><option value="gmv">GMV</option><option value="mor">Net settlement (MoR)</option></select></label>
          {terms.commission_basis === 'mor' && <label className="field" style={{ minWidth: 120 }}><span className="lbl">Settlement % est.</span><input type="number" min={0} max={100} value={terms.settlement_pct} disabled={!isAdmin} onChange={(e) => setTerms({ ...terms, settlement_pct: Number(e.target.value) })} /></label>}
          <label className="field" style={{ minWidth: 110 }}><span className="lbl">Initial term (months)</span><input type="number" min={0} value={terms.term_months ?? ''} disabled={!isAdmin} onChange={(e) => setTerms({ ...terms, term_months: e.target.value === '' ? null : Number(e.target.value) })} /></label>
          <label className="field" style={{ minWidth: 110 }}><span className="lbl">Notice (months)</span><input type="number" min={0} value={terms.notice_months ?? ''} disabled={!isAdmin} onChange={(e) => setTerms({ ...terms, notice_months: e.target.value === '' ? null : Number(e.target.value) })} /></label>
          <label className="field" style={{ minWidth: 150 }}><span className="lbl">Start date</span><input type="date" value={terms.start_date ?? ''} disabled={!isAdmin} onChange={(e) => setTerms({ ...terms, start_date: e.target.value || null })} /></label>
          <label className="field" style={{ minWidth: 120 }}><span className="lbl">Markets</span><input type="text" value={terms.markets} disabled={!isAdmin} placeholder="DE, UK" onChange={(e) => setTerms({ ...terms, markets: e.target.value })} /></label>
          <label className="field" style={{ minWidth: 240 }}><span className="lbl">Brightform entity</span><input type="text" value={terms.billing_entity} disabled={!isAdmin} onChange={(e) => setTerms({ ...terms, billing_entity: e.target.value })} /></label>
          <label className="field" style={{ flex: 1, minWidth: 220 }}><span className="lbl">Notes</span><input type="text" value={terms.notes} disabled={!isAdmin} placeholder="e.g. per store per country; creator videos ad hoc" onChange={(e) => setTerms({ ...terms, notes: e.target.value })} /></label>
          {isAdmin && <button className="primary" disabled={!dirty || busy === `terms${o.id}`} onClick={() => run(`terms${o.id}`, () => api.onboardingTerms(o.id, terms))}>{busy === `terms${o.id}` ? 'Saving…' : dirty ? 'Save terms' : 'Saved'}</button>}
        </div>
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        {o.status === 'done' ? <span className="win-badge">✓ Live {fmtRelative(o.completed_at)}{o.account_name ? ` · account ${o.account_name}` : ''}</span> : (
          <button className="primary" disabled={!allDone || busy === `done${o.id}`} title={allDone ? 'Every step is ticked: create the account with these terms' : `${o.total - o.done} step(s) still to tick`} onClick={() => run(`done${o.id}`, () => api.onboardingComplete(o.id), onComplete)}>{busy === `done${o.id}` ? 'Completing…' : allDone ? 'Complete onboarding' : `${o.total - o.done} step${o.total - o.done === 1 ? '' : 's'} to go`}</button>
        )}
        {isAdmin && <button className="small danger" onClick={() => window.confirm('Delete this onboarding?') && run(`del${o.id}`, () => api.onboardingDelete(o.id))}>Delete</button>}
      </div>
    </div>
  );
}
