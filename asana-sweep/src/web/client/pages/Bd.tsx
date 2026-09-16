import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { BdContact, BdData, BdOutreachEvent, BdProspect, BdProspectPatch, BdStatus } from '../../../sweep/types';
import { api, fmtMoney, fmtPct, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { useNavigate } from 'react-router-dom';

const STATUSES: { v: BdStatus; label: string; cls: string }[] = [
  { v: 'new', label: 'New', cls: 'muted' },
  { v: 'researching', label: 'Researching', cls: 'muted' },
  { v: 'contacted', label: 'Contacted', cls: 'warn' },
  { v: 'replied', label: 'Replied', cls: 'accent' },
  { v: 'meeting', label: 'Meeting', cls: 'accent' },
  { v: 'won', label: 'Won', cls: 'good' },
  { v: 'lost', label: 'Lost', cls: 'crit' },
];
const CHANNELS: { k: 'outreach_tts_am' | 'outreach_gmail' | 'outreach_linkedin'; label: string; at: 'outreach_tts_am_at' | 'outreach_gmail_at' | 'outreach_linkedin_at' }[] = [
  { k: 'outreach_tts_am', label: 'TTS AM', at: 'outreach_tts_am_at' },
  { k: 'outreach_gmail', label: 'Gmail', at: 'outreach_gmail_at' },
  { k: 'outreach_linkedin', label: 'LinkedIn', at: 'outreach_linkedin_at' },
];
const MARKET_NAMES: Record<string, string> = { DE: 'Germany', UK: 'United Kingdom', FR: 'France', IT: 'Italy', ES: 'Spain', IE: 'Ireland', NL: 'Netherlands', BE: 'Belgium', PL: 'Poland', AT: 'Austria', SE: 'Sweden' };

const launchBadge = (p: BdProspect) => {
  if (p.new_shop_30d) return <span className="badge good" title={`Shop created ${p.launched_at}`}>New shop</span>;
  if (p.gmv_started_30d) return <span className="badge accent" title={p.gmv_started_at ? `First sales ${p.gmv_started_at}` : `Estimated from the 7-day share: about ${p.age_estimate_days ?? '?'} days of selling`}>{p.gmv_started_at ? 'Started selling' : 'Took off (est.)'}</span>;
  return null;
};

const band = (s: number | null) => (s === null ? { label: 'No data', cls: 'muted' } : s >= 0.15 ? { label: 'Surging', cls: 'good' } : s >= 0.05 ? { label: 'Rising', cls: 'accent' } : { label: 'Steady', cls: 'muted' });

export default function BdPage() {
  const [data, setData] = useState<BdData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [f, setF] = useState({ market: '', status: '', category: '', owner: '', rise: '', type: '', launch: '', contact: '', q: '', sort: 'rise' as 'rise' | 'gmv' | 'name' | 'updated' | 'launched', hideDone: false, hideClients: true });
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [add, setAdd] = useState({ shop_name: '', market: 'DE', brand: '', category: '', website: '', tiktok_handle: '', notes: '' });
  const [importText, setImportText] = useState('');
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();

  const load = useCallback(() => api.bd().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'bd') load(); });

  const run = async (key: string, fn: () => Promise<BdData | (BdData & Record<string, unknown>)>, ok?: string) => {
    setBusy(key);
    setError(null);
    try {
      const d = await fn();
      setData(d);
      if (ok) setNotice(ok);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const patch = (p: BdProspect, body: BdProspectPatch) => run(`p${p.id}`, () => api.patchProspect(p.id, body));
  const tick = (p: BdProspect, key: 'outreach_tts_am' | 'outreach_gmail' | 'outreach_linkedin', value: boolean) => {
    const label = CHANNELS.find((c) => c.k === key)!.label;
    const note = value ? window.prompt(`${label} → ${p.shop_name}. Who did you contact and about what? (optional, saved to the history)`, '') : null;
    if (value && note === null) return; // cancelled
    patch(p, { [key]: value, outreach_note: note || null });
  };
  const addNote = (p: BdProspect) => {
    const note = window.prompt(`Note for ${p.shop_name} (e.g. "Replied on LinkedIn, call booked Thursday")`, '');
    if (!note) return;
    run(`n${p.id}`, () => api.logOutreach(p.id, { note }), 'Note saved to the outreach history.');
  };

  const createProspect = () => run('add', async () => {
    const d = await api.createProspect({ shop_name: add.shop_name, market: add.market, brand: add.brand || null, category: add.category || null, website: add.website || null, tiktok_handle: add.tiktok_handle || null, notes: add.notes || null, source: 'manual' });
    setAdd({ shop_name: '', market: add.market, brand: '', category: '', website: '', tiktok_handle: '', notes: '' });
    setShowAdd(false);
    setOpen(d.prospect.id);
    return d;
  }, 'Prospect added.');

  const importJson = () => run('import', async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(importText); } catch { throw new Error('That is not valid JSON.'); }
    const rows = Array.isArray(parsed) ? parsed : (parsed as { shops?: unknown[]; prospects?: unknown[] }).shops ?? (parsed as { prospects?: unknown[] }).prospects ?? [];
    if (!Array.isArray(rows) || !rows.length) throw new Error('Paste an array of shops, or an object with a "shops" array (FastMoss shop_search output works).');
    const r = await api.importProspects(rows as Record<string, unknown>[]);
    setImportText('');
    setShowImport(false);
    setNotice(`Imported: ${r.result.added} new, ${r.result.updated} refreshed.`);
    return api.bd();
  });

  const findContacts = (p: BdProspect) => {
    const domain = window.prompt(`Company website or domain for ${p.brand ?? p.shop_name} (leave blank to search by name):`, p.domain ?? '') ?? undefined;
    if (domain === undefined) return;
    run(`find${p.id}`, async () => {
      const d = await api.findContacts(p.id, { domain: domain || undefined });
      setNotice(d.found ? `${d.found} people found at ${p.brand ?? p.shop_name}, ${d.revealed} revealed with email / LinkedIn.` : `Apollo found nobody for ${p.brand ?? p.shop_name}. Try a website domain.`);
      return d;
    });
  };

  const reveal = (c: BdContact) => run(`c${c.id}`, () => api.revealContact(c.id), `${c.name} revealed.`);
  const draftEmail = async (c: BdContact, style: 'short' | 'intro') => {
    setBusy(`d${c.id}`);
    setError(null);
    try {
      const r = await api.draftEmail(c.id, { style });
      navigate(`/inbox?tab=outreach&draft=${r.draft.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  if (!data) return <p>{error ?? 'Loading…'}</p>;

  const q = f.q.trim().toLowerCase();
  const rows = data.prospects
    .filter((p) =>
      (!f.market || p.market === f.market) &&
      (!f.status || p.status === f.status) &&
      (!f.category || p.category === f.category) &&
      (!f.owner || String(p.owner_id ?? '') === f.owner) &&
      (!f.rise || band(p.rise_score).label.toLowerCase() === f.rise) &&
      (!f.type || (p.shop_type ?? '') === f.type) &&
      (!f.launch || (f.launch === 'new_shop' ? p.new_shop_30d : f.launch === 'gmv_started' ? p.gmv_started_30d : p.new_shop_30d || p.gmv_started_30d)) &&
      (!f.contact || (f.contact === 'email' ? p.contacts.some((c) => c.email) : f.contact === 'linkedin' ? p.contacts.some((c) => c.linkedin_url) : f.contact === 'any' ? p.contacts.length > 0 : p.contacts.length === 0)) &&
      (!f.hideClients || !p.is_client) &&
      (!f.hideDone || (!p.outreach_complete && p.status !== 'won' && p.status !== 'lost')) &&
      (!q || [p.shop_name, p.brand, p.category, p.notes, p.tiktok_handle, ...p.contacts.map((c) => c.name)].some((v) => (v ?? '').toLowerCase().includes(q))))
    .sort((a, b) =>
      f.sort === 'gmv' ? (b.gmv_7d ?? 0) - (a.gmv_7d ?? 0)
        : f.sort === 'name' ? a.shop_name.localeCompare(b.shop_name)
          : f.sort === 'updated' ? b.updated_at.localeCompare(a.updated_at)
          : f.sort === 'launched' ? (b.launched_at ?? '').localeCompare(a.launched_at ?? '')
            : (b.rise_score ?? -1) - (a.rise_score ?? -1) || (b.gmv_7d ?? 0) - (a.gmv_7d ?? 0));

  const statusBadge = (s: BdStatus) => { const st = STATUSES.find((x) => x.v === s)!; return <span className={`badge ${st.cls}`}>{st.label}</span>; };

  const contactRow = (c: BdContact): ReactElement => (
    <tr key={c.id}>
      <td><b>{c.name}</b>{c.notes && <div className="sub">{c.notes}</div>}</td>
      <td>{c.title ?? <span className="sub">–</span>}</td>
      <td>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="sub">{c.enriched ? 'no email' : 'hidden'}</span>}</td>
      <td>{c.linkedin_url ? <a href={c.linkedin_url} target="_blank" rel="noreferrer">LinkedIn</a> : <span className="sub">–</span>}</td>
      <td className="sub">{c.phone ?? ''}</td>
      <td>
        <div className="actions">
          {isAdmin && c.email && <button className="small primary" onClick={() => draftEmail(c, 'short')} disabled={busy === `d${c.id}`} title="Draft a short note in Isaac's voice, tailored to this shop, then review it in the inbox and send from Gmail">{busy === `d${c.id}` ? 'Drafting…' : 'Draft email'}</button>}
          {isAdmin && c.email && <button className="small" onClick={() => draftEmail(c, 'intro')} disabled={busy === `d${c.id}`} title="Full introduction with the Who we are / Credentials / What we do blocks">Draft intro</button>}
          {isAdmin && !c.enriched && data.apollo_configured && <button className="small" onClick={() => reveal(c)} disabled={busy === `c${c.id}`}>Reveal</button>}
          {isAdmin && <button className="small danger" onClick={() => window.confirm(`Remove ${c.name}?`) && run(`c${c.id}`, () => api.deleteContact(c.id))}>×</button>}
        </div>
      </td>
    </tr>
  );

  const details = (p: BdProspect): ReactElement => (
    <tr className="detail-row" key={`${p.id}-d`}>
      <td colSpan={9}>
        <div className="card" style={{ margin: '4px 0 10px' }}>
          <div className="stats">
            <div className="stat"><span className="v">{fmtMoney(p.gmv_7d, p.currency)}</span><span className="k">GMV last 7 days</span></div>
            <div className="stat"><span className="v">{fmtMoney(p.gmv_total, p.currency)}</span><span className="k">GMV lifetime</span></div>
            <div className="stat"><span className="v">{p.rise_score === null ? '–' : fmtPct(p.rise_score * 100)}</span><span className="k">of lifetime GMV this week</span></div>
            <div className="stat"><span className="v">{p.units_7d ?? '–'}</span><span className="k">units / 7d</span></div>
            <div className="stat"><span className="v">{p.rating ?? '–'}</span><span className="k">shop rating</span></div>
            <div className="stat"><span className="v">{p.products ?? '–'}</span><span className="k">active products</span></div>
            <div className="stat"><span className="v">{p.shop_type === 'cross_border' ? 'Cross-border' : p.shop_type === 'local' ? 'Local' : '–'}</span><span className="k">shop type</span></div>
            <div className="stat"><span className="v">{p.launched_at ?? '–'}</span><span className="k">shop created</span></div>
            <div className="stat"><span className="v">{p.gmv_started_at ?? (p.age_estimate_days !== null ? `~${p.age_estimate_days}d` : '–')}</span><span className="k">{p.gmv_started_at ? 'first sales' : 'selling age (est.)'}</span></div>
          </div>
          {isAdmin && (
            <div className="inline-form" style={{ marginBottom: 12 }}>
              <label className="field"><span className="lbl">Shop created</span><input type="date" defaultValue={p.launched_at ?? ''} onChange={(e) => patch(p, { launched_at: e.target.value || null })} /></label>
              <label className="field"><span className="lbl">First sales</span><input type="date" defaultValue={p.gmv_started_at ?? ''} onChange={(e) => patch(p, { gmv_started_at: e.target.value || null })} /></label>
              <span className="sub" style={{ alignSelf: 'flex-end' }}>Dates come from FastMoss when known; set them by hand otherwise.</span>
            </div>
          )}
          <div className="inline-form" style={{ marginBottom: 12 }}>
            <label className="field" style={{ minWidth: 260 }}><span className="lbl">Website</span><input type="text" defaultValue={p.website ?? p.domain ?? ''} placeholder="brand.com" disabled={!isAdmin} onBlur={(e) => e.target.value !== (p.website ?? p.domain ?? '') && patch(p, { website: e.target.value || null })} /></label>
            <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Notes</span><input type="text" defaultValue={p.notes ?? ''} placeholder="What they sell, why they fit, who said what" disabled={!isAdmin} onBlur={(e) => e.target.value !== (p.notes ?? '') && patch(p, { notes: e.target.value || null })} /></label>
            {p.tiktok_handle && <a className="button" href={`https://www.tiktok.com/@${p.tiktok_handle}`} target="_blank" rel="noreferrer">TikTok @{p.tiktok_handle}</a>}
            {p.fastmoss_url && <a className="button" href={p.fastmoss_url} target="_blank" rel="noreferrer">FastMoss shop page</a>}
          </div>

          <h3 style={{ margin: '6px 0' }}>Decision makers</h3>
          {p.contacts.length === 0 ? <p className="sub">No contacts yet.</p> : (
            <table><thead><tr><th>Name</th><th>Title</th><th>Email</th><th>LinkedIn</th><th>Phone</th><th></th></tr></thead><tbody>{p.contacts.map(contactRow)}</tbody></table>
          )}
          {isAdmin && (
            <div className="actions" style={{ marginTop: 8 }}>
              <button onClick={() => findContacts(p)} disabled={!data.apollo_configured || busy === `find${p.id}`} title={data.apollo_configured ? 'Search Apollo for founders, ecommerce and marketing leads (free)' : 'Set APOLLO_API_KEY in .env to search from here'}>
                {busy === `find${p.id}` ? 'Searching Apollo…' : 'Find decision makers (Apollo)'}
              </button>
              <AddContact onAdd={(c) => run(`add${p.id}`, () => api.addContact(p.id, c), 'Contact added.')} />
              <button className="danger" onClick={() => window.confirm(`Archive ${p.shop_name}? It disappears from the pipeline but stays in the database.`) && patch(p, { archived: true })}>Archive</button>
            </div>
          )}
          {!data.apollo_configured && isAdmin && <p className="sub" style={{ marginTop: 8 }}>Apollo is not connected: add APOLLO_API_KEY to .env to search and reveal decision makers from here. Contacts can still be added by hand.</p>}

          <h3 style={{ margin: '14px 0 6px' }}>Outreach history</h3>
          {p.outreach_log.length === 0 ? <p className="sub">Nothing logged yet. Ticking a channel above records it here; add notes for replies and calls.</p> : (
            <ul className="history">
              {p.outreach_log.map((e: BdOutreachEvent) => (
                <li key={e.id}>
                  <span className={`badge ${e.action === 'contacted' ? 'good' : e.action === 'uncontacted' ? 'crit' : e.action === 'replied' ? 'accent' : 'muted'}`}>{e.channel ? CHANNELS.find((c) => c.k === `outreach_${e.channel}`)?.label ?? e.channel : e.action === 'note' ? 'note' : 'status'}</span>{' '}
                  <span>{e.action === 'contacted' ? 'Reached out' : e.action === 'uncontacted' ? 'Unticked' : ''}{e.contact_name ? ` to ${e.contact_name}` : ''}{e.note ? `${e.action === 'contacted' || e.action === 'uncontacted' ? ': ' : ''}${e.note}` : ''}</span>
                  <span className="sub"> · {fmtRelative(e.created_at)}{e.actor ? ` · ${e.actor}` : ''}</span>
                  {isAdmin && <button className="small danger" style={{ marginLeft: 6 }} onClick={() => run(`e${e.id}`, () => api.deleteOutreachEvent(e.id))}>×</button>}
                </li>
              ))}
            </ul>
          )}
          {isAdmin && <div className="actions" style={{ marginTop: 6 }}><button className="small" onClick={() => addNote(p)}>+ Note</button></div>}
        </div>
      </td>
    </tr>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>BD pipeline</h1>
          <p className="hint" style={{ margin: 0 }}>Fast-rising TikTok Shops per EU market from FastMoss, the decision makers behind them, and where we have reached out. Outreach counts as complete only when TTS AM, Gmail and LinkedIn are all ticked.</p>
        </div>
        <div className="actions">
          <span className="badge muted" title="Most recent FastMoss pull">{data.last_pull_at ? `Pulled ${fmtRelative(data.last_pull_at)}` : 'No pull yet'}</span>
          <span className={`badge ${data.apollo_configured ? 'good' : 'muted'}`}>{data.apollo_configured ? 'Apollo connected' : 'Apollo not connected'}</span>
          {connected && <span className="badge muted">Live</span>}
          {isAdmin && <button onClick={() => { setShowAdd((s) => !s); setShowImport(false); }}>{showAdd ? 'Close' : '+ Prospect'}</button>}
          {isAdmin && <button onClick={() => { setShowImport((s) => !s); setShowAdd(false); }}>{showImport ? 'Close' : 'Import pull'}</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}

      {isAdmin && showAdd && (
        <div className="card inline-form" style={{ marginBottom: 16 }}>
          <label className="field" style={{ minWidth: 200 }}><span className="lbl">Shop / brand</span><input type="text" value={add.shop_name} onChange={(e) => setAdd({ ...add, shop_name: e.target.value })} /></label>
          <label className="field" style={{ minWidth: 90 }}><span className="lbl">Market</span><select value={add.market} onChange={(e) => setAdd({ ...add, market: e.target.value })}>{Object.keys(MARKET_NAMES).map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <label className="field"><span className="lbl">Brand</span><input type="text" value={add.brand} onChange={(e) => setAdd({ ...add, brand: e.target.value })} /></label>
          <label className="field"><span className="lbl">Category</span><input type="text" value={add.category} onChange={(e) => setAdd({ ...add, category: e.target.value })} /></label>
          <label className="field"><span className="lbl">Website</span><input type="text" value={add.website} onChange={(e) => setAdd({ ...add, website: e.target.value })} placeholder="brand.com" /></label>
          <label className="field"><span className="lbl">TikTok handle</span><input type="text" value={add.tiktok_handle} onChange={(e) => setAdd({ ...add, tiktok_handle: e.target.value.replace(/^@/, '') })} /></label>
          <button className="primary" onClick={createProspect} disabled={!add.shop_name.trim() || busy === 'add'}>Add</button>
        </div>
      )}
      {isAdmin && showImport && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="sub" style={{ marginTop: 0 }}>
            Paste a FastMoss <code>shop_search</code> result (JSON) to add or refresh shops. Existing prospects keep their status, owner, contacts and outreach ticks.
            {data.ingest_configured ? ' A scheduled job can also POST the same JSON to /api/bd/import with the INGEST_TOKEN bearer token.' : ' Set INGEST_TOKEN in .env to let a scheduled job POST pulls to /api/bd/import.'}
          </p>
          <textarea rows={5} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"shops":[{"seller_id":"…","shop_name":"…","region":"DE","gmv_last_7d":1234,"total_gmv":56789, …}]}' style={{ width: '100%' }} />
          <div className="actions" style={{ marginTop: 8 }}><button className="primary" onClick={importJson} disabled={!importText.trim() || busy === 'import'}>Import</button></div>
        </div>
      )}

      <div className="kpis">
        <div className="kpi"><div className="v">{data.totals.prospects}</div><div className="k">Prospects in pipeline</div></div>
        <div className="kpi"><div className="v">{data.totals.with_contacts}</div><div className="k">With decision makers</div></div>
        <div className="kpi"><div className="v">{data.totals.complete}</div><div className="k">Outreach complete</div><div className="d">all three channels</div></div>
        <div className="kpi"><div className="v">{data.totals.new_30d}</div><div className="k">Launched last 30 days</div><div className="d">shop created date</div></div>
        <div className="kpi"><div className="v">{data.totals.gmv_started_30d}</div><div className="k">Started selling last 30 days</div><div className="d">first sales, or took off</div></div>
        <div className="kpi"><div className="v">{data.totals.won}</div><div className="k">Won</div></div>
      </div>

      <h2>CRM overview by country</h2>
      <table style={{ marginBottom: 24 }}>
        <thead><tr><th>Country</th><th className="num">Prospects</th><th className="num">New</th><th className="num">In progress</th><th className="num">Any outreach</th><th className="num">Complete</th><th className="num">Won</th><th className="num">Lost</th><th className="num hide-sm">7d GMV tracked</th></tr></thead>
        <tbody>
          {data.countries.map((c) => (
            <tr key={c.market} style={{ cursor: 'pointer' }} onClick={() => setF({ ...f, market: f.market === c.market ? '' : c.market })}>
              <td><b>{MARKET_NAMES[c.market] ?? c.market}</b> <span className="sub">{c.market}</span></td>
              <td className="num">{c.prospects}</td><td className="num">{c.new}</td><td className="num">{c.in_progress}</td><td className="num">{c.contacted_any}</td>
              <td className="num"><b>{c.complete}</b> <span className="sub">{c.prospects ? fmtPct((c.complete / c.prospects) * 100) : ''}</span></td>
              <td className="num">{c.won}</td><td className="num">{c.lost}</td>
              <td className="num hide-sm">{fmtMoney(c.gmv_7d, c.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Prospects</h2>
      <div className="toolbar">
        <input type="text" placeholder="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.market} onChange={(e) => setF({ ...f, market: e.target.value })}><option value="">All countries</option>{data.markets.map((m) => <option key={m} value={m}>{MARKET_NAMES[m] ?? m}</option>)}</select>
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All statuses</option>{STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}</select>
        <select value={f.rise} onChange={(e) => setF({ ...f, rise: e.target.value })}><option value="">All momentum</option><option value="surging">Surging</option><option value="rising">Rising</option><option value="steady">Steady</option></select>
        <select value={f.launch} onChange={(e) => setF({ ...f, launch: e.target.value })}><option value="">Any age</option><option value="new_shop">Launched in last 30 days</option><option value="gmv_started">GMV started in last 30 days</option><option value="either">Either</option></select>
        <select value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })}><option value="">Any contacts</option><option value="email">With email contact</option><option value="linkedin">With LinkedIn contact</option><option value="any">With any contact</option><option value="none">No contacts yet</option></select>
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">Local + cross-border</option><option value="local">Local shops</option><option value="cross_border">Cross-border</option></select>
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All categories</option>{data.categories.map((c) => <option key={c}>{c}</option>)}</select>
        <select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}><option value="">Any owner</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value as typeof f.sort })}><option value="rise">Fastest rising</option><option value="gmv">Biggest 7d GMV</option><option value="updated">Recently updated</option><option value="launched">Newest shops</option><option value="name">Name</option></select>
        <label className="field check"><input type="checkbox" checked={f.hideDone} onChange={(e) => setF({ ...f, hideDone: e.target.checked })} /> Hide complete / closed</label>
        <label className="field check"><input type="checkbox" checked={f.hideClients} onChange={(e) => setF({ ...f, hideClients: e.target.checked })} /> Hide existing clients</label>
        <span className="sub">{rows.length} of {data.prospects.length}</span>
      </div>

      {rows.length === 0 ? <div className="empty">No prospects match.</div> : (
        <table>
          <thead><tr><th></th><th>Shop</th><th>Country</th><th className="hide-sm">Category</th><th className="num">7d GMV</th><th>Momentum</th><th>Status</th><th>Owner</th><th>Outreach</th></tr></thead>
          <tbody>
            {rows.flatMap((p) => {
              const b = band(p.rise_score);
              const main = (
                <tr key={p.id} className={open === p.id ? 'open' : ''}>
                  <td><button className="small" onClick={() => setOpen(open === p.id ? null : p.id)} aria-label="Details">{open === p.id ? '−' : '+'}</button></td>
                  <td>
                    <b>{p.shop_name}</b>{p.brand && p.brand !== p.shop_name && <span className="sub"> · {p.brand}</span>}
                    {p.fastmoss_url && <> <a href={p.fastmoss_url} target="_blank" rel="noreferrer" className="sub" title="Open on FastMoss">FastMoss ↗</a></>}
                    {p.is_client && <> <span className="badge muted">client</span></>}
                    <div className="sub">{p.contacts.length ? `${p.contacts.length} contact${p.contacts.length === 1 ? '' : 's'}` : 'no contacts'}{p.contacts.some((c) => c.email) ? ' · email' : ''}{p.outreach_log.length ? ` · ${p.outreach_log.length} in history` : ''}</div>
                  </td>
                  <td>{p.market}</td>
                  <td className="hide-sm sub">{p.category ?? ''}</td>
                  <td className="num">{fmtMoney(p.gmv_7d, p.currency)}<div className="sub">{p.rise_score === null ? '' : `${fmtPct(p.rise_score * 100)} of lifetime`}</div></td>
                  <td><span className={`badge ${b.cls}`}>{b.label}</span> {launchBadge(p)}</td>
                  <td>{isAdmin ? <select value={p.status} onChange={(e) => patch(p, { status: e.target.value as BdStatus })} style={{ width: 'auto' }}>{STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}</select> : statusBadge(p.status)}</td>
                  <td>{isAdmin ? <select value={p.owner_id ?? ''} onChange={(e) => patch(p, { owner_id: e.target.value ? Number(e.target.value) : null })} style={{ width: 'auto' }}><option value="">–</option>{data.people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select> : p.owner_name ?? <span className="sub">–</span>}</td>
                  <td>
                    <div className="checks">
                      {CHANNELS.map((ch) => (
                        <label key={ch.k} className={`chk ${p[ch.k] ? 'on' : ''}`} title={p[ch.at] ? `Ticked ${fmtRelative(p[ch.at])}` : 'Not yet'}>
                          <input type="checkbox" checked={p[ch.k]} disabled={!isAdmin} onChange={(e) => tick(p, ch.k, e.target.checked)} /> {ch.label}
                        </label>
                      ))}
                      {p.outreach_complete && <span className="badge good">Complete</span>}
                    </div>
                  </td>
                </tr>
              );
              return open === p.id ? [main, details(p)] : [main];
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function AddContact({ onAdd }: { onAdd: (c: { name: string; title?: string; email?: string; linkedin_url?: string }) => void }) {
  const [openForm, setOpenForm] = useState(false);
  const [c, setC] = useState({ name: '', title: '', email: '', linkedin_url: '' });
  if (!openForm) return <button onClick={() => setOpenForm(true)}>+ Contact by hand</button>;
  return (
    <span className="inline-form">
      <input type="text" placeholder="Name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} style={{ width: 150 }} />
      <input type="text" placeholder="Title" value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} style={{ width: 150 }} />
      <input type="email" placeholder="Email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} style={{ width: 200 }} />
      <input type="text" placeholder="LinkedIn URL" value={c.linkedin_url} onChange={(e) => setC({ ...c, linkedin_url: e.target.value })} style={{ width: 200 }} />
      <button className="primary" disabled={!c.name.trim()} onClick={() => { onAdd({ name: c.name.trim(), title: c.title || undefined, email: c.email || undefined, linkedin_url: c.linkedin_url || undefined }); setC({ name: '', title: '', email: '', linkedin_url: '' }); setOpenForm(false); }}>Save</button>
      <button onClick={() => setOpenForm(false)}>Cancel</button>
    </span>
  );
}
