import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CompetitorDetail, CompetitorSignal, CompetitorView, CompetitorsData } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { AccountGroup, GroupsHead, useOpenGroups, type GroupLight } from '../groups';

/**
 * Growth > Competitors: the agencies we meet in deals, one collapsible block each. Who works there and who
 * joined or left (Apollo), what they are hiring for (their job boards), which brands they run (their own
 * client, case study and press pages, diffed weekly), the overlap with our pipeline, and the Monday digest.
 */
const KIND: Record<string, string> = { joined: 'Joined', left: 'Left', title_change: 'New title', hiring: 'Hiring', job_closed: 'Role closed', new_client: 'New client', client_gone: 'Client gone', overlap: 'In our pipeline', press: 'Press', event: 'Event', market: 'Market', website: 'Website', note: 'Note' };
const KIND_CLS: Record<string, string> = { overlap: 'crit', new_client: 'accent', joined: 'good', left: 'warn', title_change: 'muted', hiring: 'muted', market: 'accent', press: 'muted', event: 'muted', website: 'muted', note: 'muted', client_gone: 'warn', job_closed: 'muted' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function CompetitorsPage() {
  const [data, setData] = useState<CompetitorsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showOverlap, setShowOverlap] = useState(true);
  const [showDigest, setShowDigest] = useState(false);
  const [add, setAdd] = useState({ name: '', domain: '', markets: '', watch_urls: '', ats: '' });
  const isAdmin = useIsAdmin();
  const groups = useOpenGroups('competitors');
  const load = useCallback(() => api.competitors().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'competitors' || e.kind === 'bd' || e.kind === 'leads') load(); });
  const run = async <T extends CompetitorsData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const lightOf = (c: CompetitorView): GroupLight => (!c.enabled ? 'grey' : c.new_signals && c.overlap ? 'red' : c.new_signals ? 'amber' : c.last_checked_at ? 'green' : 'grey');
  const s = data.settings;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Competitors</h1>
          <p className="hint" style={{ margin: 0 }}>The agencies we meet in deals. Every {DAYS[s.day]} at {s.time} ({data.timezone}) the sweep reads who works there and who joined or left (Apollo), what they are hiring for (their job boards), which brands they run (their client, case study and press pages, diffed against last week) and the overlap with our pipeline; the digest goes to Slack at {s.digest_time}. Every line carries its source.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${data.apollo_configured ? 'good' : 'warn'}`} title="APOLLO_API_KEY">{data.apollo_configured ? 'Apollo' : 'Apollo not set'}</span>
          <span className={`badge ${data.llm_configured ? 'good' : 'muted'}`} title="ANTHROPIC_API_KEY reads the page changes">{data.llm_configured ? 'Claude' : 'Rules only'}</span>
          <span className={`badge ${data.slack_configured && s.channel ? 'good' : 'muted'}`} title="SLACK_BOT_TOKEN and a channel for the digest">{data.slack_configured && s.channel ? `Digest → ${s.channel}` : 'No digest channel'}</span>
          <span className={`badge ${data.last_error ? 'warn' : data.last_run_at ? 'good' : 'muted'}`} title={data.last_error ?? ''}>{data.running ? 'Sweeping…' : data.last_run_at ? `Swept ${fmtRelative(data.last_run_at)}` : 'Not swept yet'}</span>
          {isAdmin && <button className="small" disabled={busy === 'sweep' || data.running} onClick={() => run('sweep', () => api.competitorsSweep(), (r) => setNotice(`${r.swept} competitor(s) swept, ${r.signals} new signal(s)${r.errors.length ? `; ${r.errors.length} note(s): ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))}>{busy === 'sweep' ? 'Sweeping…' : 'Run sweep now'}</button>}
          {isAdmin && <button className="small" disabled={busy === 'digest'} onClick={() => run('digest', () => api.competitorsDigest({ force: true }), (r) => setNotice(r.sent ? 'Digest sent to Slack.' : `Digest not sent: ${r.reason}`))}>{busy === 'digest' ? 'Sending…' : 'Send digest now'}</button>}
          {isAdmin && <button className="small" onClick={() => setShowSettings((v) => !v)}>{showSettings ? 'Hide settings' : 'Settings'}</button>}
          <button className="small primary" onClick={() => setShowAdd((v) => !v)}>{showAdd ? 'Close' : '+ Competitor'}</button>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {showSettings && isAdmin && <SettingsCard data={data} busy={busy} run={run} />}
      {showAdd && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="inline-form" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ minWidth: 180 }}><span className="lbl">Name</span><input type="text" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="Agency" /></label>
            <label className="field" style={{ minWidth: 200 }}><span className="lbl">Domain</span><input type="text" value={add.domain} onChange={(e) => setAdd({ ...add, domain: e.target.value })} placeholder="agency.com" /></label>
            <label className="field" style={{ minWidth: 140 }}><span className="lbl">Markets</span><input type="text" value={add.markets} onChange={(e) => setAdd({ ...add, markets: e.target.value })} placeholder="UK, DE" /></label>
          </div>
          <div className="inline-form" style={{ alignItems: 'flex-end', marginTop: 8 }}>
            <label className="field" style={{ flex: 1, minWidth: 280 }}><span className="lbl">Pages to watch (one per line)</span><textarea rows={3} value={add.watch_urls} onChange={(e) => setAdd({ ...add, watch_urls: e.target.value })} placeholder={'https://agency.com/clients\nhttps://agency.com/case-studies\nhttps://agency.com/news'} /><span className="help">Client logos, case studies, team and press pages. The home page when empty.</span></label>
            <label className="field" style={{ flex: 1, minWidth: 240 }}><span className="lbl">Job boards (kind:slug, one per line)</span><textarea rows={3} value={add.ats} onChange={(e) => setAdd({ ...add, ats: e.target.value })} placeholder={'greenhouse:agency\nlever:agency\nworkable:agency\npersonio:agency'} /><span className="help">The slug is the part of the careers URL after the ATS host.</span></label>
            <button className="primary" disabled={!add.name.trim() || busy === 'add'} onClick={() => run('add', () => api.competitorCreate({ name: add.name, domain: add.domain, markets: add.markets, watch_urls: add.watch_urls, ats: add.ats }), (r) => { setAdd({ name: '', domain: '', markets: '', watch_urls: '', ats: '' }); setShowAdd(false); groups.toggle(r.competitor.id); })}>Add</button>
          </div>
        </div>
      )}
      {data.overlap.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="page-head" style={{ marginBottom: 6 }}><b>In our pipeline and theirs <span className="sub">{data.overlap.length}</span></b><button className="small" onClick={() => setShowOverlap((v) => !v)}>{showOverlap ? 'Hide' : 'Show'}</button></div>
          {showOverlap && (
            <table className="table">
              <thead><tr><th>Brand</th><th>Market</th><th>Competitor</th><th>Confidence</th><th>Our side</th><th>Last seen</th></tr></thead>
              <tbody>{data.overlap.map((o, i) => (
                <tr key={i}><td><b>{o.brand}</b></td><td>{o.market ?? ''}</td><td>{o.competitor}</td><td><span className={`badge ${o.confidence === 'high' ? 'good' : 'muted'}`}>{o.confidence}</span></td><td>{o.prospect_id !== null && <Link to="/bd" className="button small">BD pipeline{o.prospect_status ? ` · ${o.prospect_status}` : ''}</Link>} {o.lead_id !== null && <Link to="/leads" className="button small">Lead{o.lead_stage ? ` · ${o.lead_stage}` : ''}</Link>}</td><td className="sub">{fmtRelative(o.last_seen_at)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="page-head" style={{ marginBottom: 6 }}><b>This week's digest <span className="sub">{data.last_digest_at ? `last sent ${fmtRelative(data.last_digest_at)}` : 'not sent yet'}</span></b><div className="actions"><button className="small" onClick={() => { void navigator.clipboard?.writeText(data.digest_preview); setNotice('Digest copied.'); }}>Copy</button><button className="small" onClick={() => setShowDigest((v) => !v)}>{showDigest ? 'Hide' : 'Preview'}</button></div></div>
        {showDigest && <pre className="slack-preview" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{data.digest_preview}</pre>}
      </div>
      <GroupsHead noun="competitor" items={data.competitors.length} lights={data.competitors.map(lightOf)} open={groups.count > 0} onAll={(open) => groups.setAll(data.competitors.map((c) => c.id), open)}>
        {data.competitors.some((c) => c.new_signals) && <button className="small" onClick={() => run('seen', () => api.competitorsSeen(null))}>Mark all seen</button>}
      </GroupsHead>
      {data.competitors.length === 0 && <div className="empty">No competitors yet. Add the agencies you meet in deals.</div>}
      {data.competitors.map((c) => (
        <AccountGroup key={c.id} light={lightOf(c)} name={c.name} sub={c.markets.join(', ') || c.domain || undefined}
          summary={`${c.people_active} people · +${c.joined_30d} / −${c.left_30d} in 30 days · ${c.open_jobs} open role${c.open_jobs === 1 ? '' : 's'} · ${c.clients} client${c.clients === 1 ? '' : 's'}${c.overlap ? ` (${c.overlap} in our pipeline)` : ''}`}
          nums={c.new_signals ? <span className="badge accent">{c.new_signals} new</span> : null}
          right={<span className="sub" title={c.last_error ?? ''}>{c.last_error ? '⚠ ' : ''}{c.last_checked_at ? `checked ${fmtRelative(c.last_checked_at)}` : 'not checked'}</span>}
          open={groups.isOpen(c.id)} onToggle={() => groups.toggle(c.id)}>
          {groups.isOpen(c.id) && <CompetitorBody id={c.id} isAdmin={isAdmin} busy={busy} run={run} setNotice={setNotice} setError={setError} version={data.last_run_at ?? ''} />}
        </AccountGroup>
      ))}
    </>
  );
}

function SettingsCard({ data, busy, run }: { data: CompetitorsData; busy: string | null; run: <T extends CompetitorsData>(k: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void> }) {
  const [s, setS] = useState(data.settings);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="inline-form" style={{ alignItems: 'flex-end' }}>
        <label className="field"><span className="lbl">Sweep day</span><select value={s.day} onChange={(e) => setS({ ...s, day: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
        <label className="field"><span className="lbl">Sweep time ({data.timezone})</span><input type="time" value={s.time} onChange={(e) => setS({ ...s, time: e.target.value })} /></label>
        <label className="field"><span className="lbl">Digest time</span><input type="time" value={s.digest_time} onChange={(e) => setS({ ...s, digest_time: e.target.value })} /></label>
        <label className="field" style={{ minWidth: 200 }}><span className="lbl">Slack channel for the digest</span><input type="text" value={s.channel} onChange={(e) => setS({ ...s, channel: e.target.value })} placeholder="#bd" /></label>
        <label className="field check"><input type="checkbox" checked={s.apollo_jobs} onChange={(e) => setS({ ...s, apollo_jobs: e.target.checked })} /> <span>Apollo job postings (1 credit per competitor per sweep)</span></label>
        <button className="primary" disabled={busy === 'settings'} onClick={() => run('settings', () => api.competitorsSettings(s))}>Save</button>
      </div>
    </div>
  );
}

function CompetitorBody({ id, isAdmin, busy, run, setNotice, setError, version }: { id: number; isAdmin: boolean; busy: string | null; run: <T extends CompetitorsData>(k: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; setNotice: (s: string) => void; setError: (s: string | null) => void; version: string }) {
  const [d, setD] = useState<CompetitorDetail | null>(null);
  const [tab, setTab] = useState<'timeline' | 'people' | 'jobs' | 'clients' | 'watch'>('timeline');
  const [client, setClient] = useState({ brand: '', market: '', evidence: '', url: '' });
  const [note, setNote] = useState('');
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const load = useCallback(() => api.competitor(id).then(setD).catch((e) => setError((e as Error).message)), [id, setError]);
  useEffect(() => { load(); }, [load, version]);
  useLiveUpdates((e) => { if (e.kind === 'competitors') load(); });
  useEffect(() => { const t = setTimeout(() => void api.competitorsSeen(id).catch(() => undefined), 15000); return () => clearTimeout(t); }, [id]);
  const local = async (fn: () => Promise<CompetitorDetail>) => { setError(null); try { setD(await fn()); } catch (e) { setError((e as Error).message); } };
  if (!d) return <p className="sub">Loading…</p>;
  const c = d.competitor;
  const unseen = d.signals.filter((s) => !s.seen_at).length;
  const startEdit = () => setEdit({ name: c.name, domain: c.domain ?? '', linkedin_url: c.linkedin_url ?? '', tiktok_handle: c.tiktok_handle ?? '', markets: c.markets.join(', '), watch_urls: c.watch_urls.join('\n'), ats: c.ats.map((a) => `${a.kind}:${a.slug}`).join('\n'), notes: c.notes ?? '', enabled: c.enabled ? '1' : '' });
  return (
    <div>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div className="presets">
          <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Timeline{unseen ? ` (${unseen} new)` : ''}</button>
          <button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>People ({d.people.length})</button>
          <button className={tab === 'jobs' ? 'active' : ''} onClick={() => setTab('jobs')}>Hiring ({d.jobs.filter((j) => !j.closed_at).length})</button>
          <button className={tab === 'clients' ? 'active' : ''} onClick={() => setTab('clients')}>Clients ({d.clients.filter((x) => x.status === 'active').length})</button>
          <button className={tab === 'watch' ? 'active' : ''} onClick={() => setTab('watch')}>Sources</button>
        </div>
        <div className="actions">
          {c.linkedin_url && <a className="button small" href={c.linkedin_url} target="_blank" rel="noreferrer">LinkedIn</a>}
          {c.domain && <a className="button small" href={`https://${c.domain}`} target="_blank" rel="noreferrer">{c.domain}</a>}
          {isAdmin && <button className="small" disabled={busy === `sweep-${id}`} onClick={() => run(`sweep-${id}`, () => api.competitorsSweep({ competitor_id: id }), (r) => { setNotice(`${c.name}: ${r.signals} new signal(s)${r.errors.length ? `; ${r.errors.join(' · ')}` : ''}.`); load(); })}>{busy === `sweep-${id}` ? 'Sweeping…' : 'Sweep now'}</button>}
          {unseen > 0 && <button className="small" onClick={() => run('seen', () => api.competitorsSeen(id), () => load())}>Mark seen</button>}
        </div>
      </div>
      {c.last_error && <div className="banner warn">{c.last_error}</div>}
      {tab === 'timeline' && (
        <>
          <div className="inline-form" style={{ marginBottom: 8 }}>
            <input type="text" style={{ flex: 1, minWidth: 260 }} value={note} placeholder="Add a note: something you heard on a call, saw on a post, read in an email" onChange={(e) => setNote(e.target.value)} />
            <button className="small" disabled={!note.trim()} onClick={() => local(async () => { const r = await api.competitorNote(id, { text: note }); setNote(''); return r; })}>Add note</button>
          </div>
          {d.signals.length === 0 ? <p className="sub">Nothing on record yet. The first sweep takes a baseline (people, roles and clients) and later sweeps report what changed.</p> : (
            <ul className="signals">{d.signals.map((s) => <SignalRow key={s.id} s={s} />)}</ul>
          )}
        </>
      )}
      {tab === 'people' && (
        <>
          {d.people.length === 0 ? <p className="sub">No people yet{!c.domain ? ': add the domain so Apollo can find the company' : ''}.</p> : (
            <table className="table">
              <thead><tr><th>Name</th><th>Title</th><th>Department</th><th>Location</th><th>Started</th><th>Seen</th></tr></thead>
              <tbody>{d.people.map((p) => {
                const recent = p.started_at && p.started_at >= new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
                return <tr key={p.id}><td>{p.linkedin_url ? <a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}{recent && <span className="badge good" style={{ marginLeft: 6 }}>new</span>}</td><td>{p.title ?? ''}{p.prev_title && p.prev_title !== p.title ? <span className="sub"> (was {p.prev_title})</span> : null}</td><td>{p.department ?? ''}</td><td>{p.location ?? ''}</td><td>{p.started_at?.slice(0, 7) ?? ''}</td><td className="sub">{fmtRelative(p.last_seen_at)}</td></tr>;
              })}</tbody>
            </table>
          )}
          {d.leavers.length > 0 && (<><h4 style={{ marginTop: 12 }}>Left in the last 90 days</h4><ul>{d.leavers.map((p) => <li key={p.id}>{p.linkedin_url ? <a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}{p.title ? `, ${p.title}` : ''} <span className="sub">· {fmtRelative(p.left_at)}</span></li>)}</ul></>)}
        </>
      )}
      {tab === 'jobs' && (
        d.jobs.length === 0 ? <p className="sub">No roles on record. Add their job board under Sources (Greenhouse, Lever, Workable or Personio), or switch on Apollo job postings in settings.</p> : (
          <table className="table">
            <thead><tr><th>Role</th><th>Location</th><th>Source</th><th>Posted</th><th>Status</th></tr></thead>
            <tbody>{d.jobs.map((j) => <tr key={j.id} className={j.closed_at ? 'muted' : ''}><td>{j.url ? <a href={j.url} target="_blank" rel="noreferrer">{j.title}</a> : j.title}</td><td>{j.location ?? ''}</td><td className="sub">{j.source.split(':')[0]}</td><td className="sub">{j.posted_at ?? fmtRelative(j.first_seen_at)}</td><td>{j.closed_at ? <span className="badge muted">closed {fmtRelative(j.closed_at)}</span> : <span className="badge good">open</span>}</td></tr>)}</tbody>
          </table>
        )
      )}
      {tab === 'clients' && (
        <>
          <div className="inline-form" style={{ marginBottom: 8, alignItems: 'flex-end' }}>
            <label className="field"><span className="lbl">Brand</span><input type="text" value={client.brand} onChange={(e) => setClient({ ...client, brand: e.target.value })} /></label>
            <label className="field" style={{ width: 80 }}><span className="lbl">Market</span><input type="text" value={client.market} onChange={(e) => setClient({ ...client, market: e.target.value })} placeholder="DE" /></label>
            <label className="field" style={{ flex: 1, minWidth: 220 }}><span className="lbl">How we know</span><input type="text" value={client.evidence} onChange={(e) => setClient({ ...client, evidence: e.target.value })} placeholder="Said on the Neuro Gum call, 3 Oct" /></label>
            <label className="field" style={{ minWidth: 180 }}><span className="lbl">Link</span><input type="text" value={client.url} onChange={(e) => setClient({ ...client, url: e.target.value })} placeholder="https://" /></label>
            <button className="small primary" disabled={!client.brand.trim()} onClick={() => local(async () => { const r = await api.competitorClientAdd(id, { brand: client.brand, market: client.market || null, evidence: client.evidence || null, url: client.url || null }); setClient({ brand: '', market: '', evidence: '', url: '' }); return r; })}>Add client</button>
          </div>
          {d.clients.filter((x) => x.status === 'active').length === 0 ? <p className="sub">No clients attributed yet. The sweep reads their client, case study and press pages; you can also add what you hear.</p> : (
            <table className="table">
              <thead><tr><th>Brand</th><th>Market</th><th>Confidence</th><th>Sources</th><th>Our side</th><th></th></tr></thead>
              <tbody>{d.clients.filter((x) => x.status === 'active').map((x) => (
                <tr key={x.id}><td><b>{x.brand}</b></td><td>{x.market ?? ''}</td><td><span className={`badge ${x.confidence === 'high' ? 'good' : 'muted'}`}>{x.confidence}</span></td><td className="sub">{x.sources.slice(-2).map((s, i) => <div key={i} title={s.evidence}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https?:\/\//, '').slice(0, 40)}</a> : 'by hand'} · {s.evidence.slice(0, 90)}</div>)}</td><td>{x.prospect_id !== null && <Link to="/bd" className="button small">BD pipeline</Link>} {x.lead_id !== null && <Link to="/leads" className="button small">Lead</Link>}</td><td>{isAdmin && <button className="small danger" onClick={() => local(() => api.competitorClientRemove(id, x.id))}>Remove</button>}</td></tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
      {tab === 'watch' && (
        <>
          {edit ? (
            <div className="card" style={{ marginBottom: 8 }}>
              <div className="inline-form" style={{ alignItems: 'flex-end' }}>
                <label className="field"><span className="lbl">Name</span><input type="text" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
                <label className="field"><span className="lbl">Domain</span><input type="text" value={edit.domain} onChange={(e) => setEdit({ ...edit, domain: e.target.value })} /></label>
                <label className="field"><span className="lbl">Markets</span><input type="text" value={edit.markets} onChange={(e) => setEdit({ ...edit, markets: e.target.value })} /></label>
                <label className="field"><span className="lbl">LinkedIn page</span><input type="text" value={edit.linkedin_url} onChange={(e) => setEdit({ ...edit, linkedin_url: e.target.value })} /></label>
                <label className="field"><span className="lbl">TikTok handle</span><input type="text" value={edit.tiktok_handle} onChange={(e) => setEdit({ ...edit, tiktok_handle: e.target.value })} /></label>
                <label className="field check"><input type="checkbox" checked={edit.enabled === '1'} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked ? '1' : '' })} /> <span>Tracked</span></label>
              </div>
              <div className="inline-form" style={{ alignItems: 'flex-end', marginTop: 8 }}>
                <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Pages to watch (one per line)</span><textarea rows={4} value={edit.watch_urls} onChange={(e) => setEdit({ ...edit, watch_urls: e.target.value })} /></label>
                <label className="field" style={{ flex: 1, minWidth: 220 }}><span className="lbl">Job boards (kind:slug)</span><textarea rows={4} value={edit.ats} onChange={(e) => setEdit({ ...edit, ats: e.target.value })} /></label>
                <label className="field" style={{ flex: 1, minWidth: 220 }}><span className="lbl">Notes</span><textarea rows={4} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
              </div>
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="primary" disabled={busy === 'edit'} onClick={() => run('edit', () => api.competitorUpdate(id, { ...edit, enabled: edit.enabled === '1' }), () => { setEdit(null); load(); })}>Save</button>
                <button onClick={() => setEdit(null)}>Cancel</button>
                {isAdmin && <button className="danger" onClick={() => window.confirm(`Delete ${c.name} and everything on record about them?`) && run('del', () => api.competitorDelete(id))}>Delete</button>}
              </div>
            </div>
          ) : (
            <div className="page-head" style={{ marginBottom: 8 }}><span className="sub">{c.notes ?? ''}</span><button className="small" onClick={startEdit}>Edit</button></div>
          )}
          <h4>Pages watched</h4>
          {d.snapshots.length === 0 ? <p className="sub">Nothing fetched yet.</p> : <ul>{d.snapshots.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.url}</a> <span className="sub">· {s.error ? `failed: ${s.error}` : `${s.chars.toLocaleString()} characters`} · {fmtRelative(s.fetched_at)}</span></li>)}</ul>}
          <h4>Job boards</h4>
          {c.ats.length === 0 ? <p className="sub">None. Add the Greenhouse, Lever, Workable or Personio slug from their careers page.</p> : <ul>{c.ats.map((a) => <li key={`${a.kind}:${a.slug}`}>{a.kind}: {a.slug}</li>)}</ul>}
          <p className="sub">Apollo organisation: {c.apollo_org_id ?? 'not resolved yet (needs the domain and an Apollo key)'}.</p>
        </>
      )}
    </div>
  );
}

function SignalRow({ s }: { s: CompetitorSignal }) {
  return (
    <li className={`signal ${s.seen_at ? '' : 'unseen'}`}>
      <span className={`badge ${KIND_CLS[s.kind] ?? 'muted'}`}>{KIND[s.kind] ?? s.kind}</span>
      <span className="text"><b>{s.summary}</b>{s.evidence ? <span className="sub"> · {s.evidence.slice(0, 200)}</span> : null}</span>
      <span className="sub when">{s.url ? <a href={s.url} target="_blank" rel="noreferrer">source</a> : null} {fmtRelative(s.observed_at)}</span>
    </li>
  );
}
