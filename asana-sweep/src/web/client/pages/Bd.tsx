import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { BdContact, BdData, BdOutreachEvent, BdProspect, BdProspectPatch, BdStatus, TtsContact } from '../../../sweep/types';
import { api, fmtMoney, fmtPct, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { Link, useNavigate } from 'react-router-dom';

const LANGS: Record<string, string> = { en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' };

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
  const [liMsg, setLiMsg] = useState<{ contact: BdContact; text: string; generator: string } | null>(null);
  const [ttsPoc, setTtsPoc] = useState<Record<number, { contact: TtsContact | null; fallback: TtsContact | null; reason: string }>>({});
  useEffect(() => { if (open !== null && !ttsPoc[open]) api.ttsContactFor(open).then((r) => setTtsPoc((m) => ({ ...m, [open]: r }))).catch(() => undefined); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState({ market: '', status: '', category: '', owner: '', rise: '', type: '', launch: '', contact: '', q: '', sort: 'rise' as 'rise' | 'gmv' | 'name' | 'updated' | 'launched', hideDone: false, hideClients: true });
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [bulk, setBulk] = useState({ style: 'short' as 'short' | 'intro', language: 'en', limit: 25, to_gmail: true, include_drafted: false, instructions: '' });
  const [bulkPreview, setBulkPreview] = useState<{ count: number; items: { prospect_id: number; shop_name: string; brand: string | null; market: string; contact_name: string; contact_title: string | null; contact_email: string | null }[] } | null>(null);
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
      setNotice(d.found ? `${d.company ?? p.brand ?? p.shop_name}${d.domain ? ` (${d.domain})` : ''}: ${d.found} people found, ${d.kept} kept, ${d.revealed} revealed with email / LinkedIn.` : `Apollo found nobody for ${p.brand ?? p.shop_name}${d.matched ? '' : ' and could not match the company'}. Try a website domain.`);
      return d;
    });
  };

  const reveal = (c: BdContact) => run(`c${c.id}`, () => api.revealContact(c.id), `${c.name} revealed.`);
  const linkedin = async (c: BdContact, step: 'requested' | 'connected' | 'messaged') => {
    if (step === 'requested' && c.linkedin_url) window.open(c.linkedin_url, '_blank', 'noopener');
    setBusy(`l${c.id}`);
    setError(null);
    try {
      const r = await api.linkedinStep(c.id, step, step === 'messaged' && liMsg?.contact.id === c.id ? liMsg.text : undefined);
      await load();
      if (step === 'requested') setNotice(`Logged the LinkedIn request to ${c.name}. Reminder to check back in ${r.followup ? fmtRelative(r.followup.due_at) : 'a few days'}.`);
      if (step === 'connected' && r.message) { setLiMsg({ contact: r.contact, text: r.message.text, generator: r.message.generator }); setNotice('Connected. Copy the message below, send it on LinkedIn, then click "Message sent".'); }
      if (step === 'messaged') { setLiMsg(null); setNotice(`Logged the LinkedIn message to ${c.name}. A chase reminder is set for 5 days.`); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const draftEmail = async (c: BdContact, style: 'short' | 'intro') => {
    setBusy(`d${c.id}`);
    setError(null);
    try {
      const r = await api.draftEmail(c.id, { style });
      navigate(`/outreach?draft=${r.draft.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  useEffect(() => { if (showBulk) api.bulkPreview({ market: f.market, include_drafted: bulk.include_drafted }).then(setBulkPreview).catch((e) => setError((e as Error).message)); }, [showBulk, f.market, bulk.include_drafted, data?.bulk_draft.finished_at]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <td className="sub">{c.phone ?? ''}{c.linkedin_status !== 'none' && <div><span className={`badge ${c.linkedin_status === 'messaged' ? 'good' : c.linkedin_status === 'connected' ? 'accent' : 'muted'}`}>{c.linkedin_status === 'requested' ? `LinkedIn requested ${c.linkedin_requested_at ? fmtRelative(c.linkedin_requested_at) : ''}` : c.linkedin_status === 'connected' ? 'LinkedIn connected' : 'LinkedIn messaged'}</span></div>}</td>
      <td>
        <div className="actions">
          {isAdmin && c.linkedin_url && c.linkedin_status === 'none' && <button className="small" onClick={() => linkedin(c, 'requested')} disabled={busy === `l${c.id}`} title="Opens their profile so you can send the request, logs it, and reminds you to check back">Connect on LinkedIn</button>}
          {isAdmin && c.linkedin_status === 'requested' && <button className="small primary" onClick={() => linkedin(c, 'connected')} disabled={busy === `l${c.id}`} title="They accepted: get the short follow-up message">They accepted</button>}
          {isAdmin && c.linkedin_status === 'connected' && <button className="small primary" onClick={() => (liMsg?.contact.id === c.id ? linkedin(c, 'messaged') : linkedin(c, 'connected'))} disabled={busy === `l${c.id}`}>{liMsg?.contact.id === c.id ? 'Message sent' : 'Show message'}</button>}
          {isAdmin && c.email && <button className="small primary" onClick={() => draftEmail(c, 'short')} disabled={busy === `d${c.id}`} title="Draft a short note in Isaac's voice, tailored to this shop, then review it under Growth > Outreach emails and send from Gmail">{busy === `d${c.id}` ? 'Drafting…' : 'Draft email'}</button>}
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

          {ttsPoc[p.id] && (
            <p className="sub" style={{ margin: '0 0 8px' }}>
              <b>TikTok Shop POC:</b>{' '}
              {ttsPoc[p.id].contact
                ? <>{ttsPoc[p.id].contact!.name}{ttsPoc[p.id].contact!.role ? ` (${ttsPoc[p.id].contact!.role})` : ''}{ttsPoc[p.id].contact!.lark ? ` · Lark: ${ttsPoc[p.id].contact!.lark}` : ''}{ttsPoc[p.id].contact!.email ? ` · ${ttsPoc[p.id].contact!.email}` : ''} <span className="sub">({ttsPoc[p.id].reason})</span></>
                : ttsPoc[p.id].fallback
                  ? <>{ttsPoc[p.id].reason}: <b>{ttsPoc[p.id].fallback!.name}</b>{ttsPoc[p.id].fallback!.lark ? ` (Lark: ${ttsPoc[p.id].fallback!.lark})` : ''}</>
                  : <>{ttsPoc[p.id].reason}. Add the org chart under Outreach emails › Voice, Gmail &amp; contacts.</>}
            </p>
          )}
          {liMsg && p.contacts.some((c) => c.id === liMsg.contact.id) && (
            <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 10 }}>
              <div className="page-head" style={{ marginBottom: 6 }}><b>LinkedIn message for {liMsg.contact.name}</b> <span className="sub">{liMsg.generator === 'claude' ? 'Claude, in Isaac\'s voice' : 'template'} · {liMsg.text.length} chars</span></div>
              <textarea rows={4} style={{ width: '100%', fontFamily: 'inherit' }} value={liMsg.text} onChange={(e) => setLiMsg({ ...liMsg, text: e.target.value })} />
              <div className="actions" style={{ marginTop: 6 }}>
                <button className="primary" onClick={async () => { try { await navigator.clipboard.writeText(liMsg.text); setNotice('Message copied. Paste it into LinkedIn.'); } catch { setNotice('Copy failed; select the text by hand.'); } if (liMsg.contact.linkedin_url) window.open(liMsg.contact.linkedin_url, '_blank', 'noopener'); }}>Copy &amp; open LinkedIn</button>
                <button onClick={() => linkedin(liMsg.contact, 'messaged')} disabled={busy === `l${liMsg.contact.id}`}>Message sent</button>
                <button onClick={() => setLiMsg(null)}>Close</button>
              </div>
            </div>
          )}
          <h3 style={{ margin: '6px 0' }}>Decision makers</h3>
          {p.contacts.length === 0 ? <p className="sub">No contacts yet.</p> : (
            <table><thead><tr><th>Name</th><th>Title</th><th>Email</th><th>LinkedIn</th><th>Phone</th><th></th></tr></thead><tbody>{p.contacts.map(contactRow)}</tbody></table>
          )}
          {isAdmin && (
            <div className="actions" style={{ marginTop: 8 }}>
              <button onClick={() => findContacts(p)} disabled={!data.apollo_configured || data.apollo.exhausted || busy === `find${p.id}`} title={data.apollo.exhausted ? 'Apollo is out of credits' : data.apollo_configured ? `Resolve the company in Apollo, pull founders, e-commerce, TikTok and marketing leads, reveal the top ${data.apollo.reveal_per_prospect} (one credit each)` : 'Set APOLLO_API_KEY in .env to search from here'}>
                {busy === `find${p.id}` ? 'Searching Apollo…' : 'Find decision makers (Apollo)'}
              </button>
              <AddContact onAdd={(c) => run(`add${p.id}`, () => api.addContact(p.id, c), 'Contact added.')} />
              <button className="danger" onClick={() => window.confirm(`Archive ${p.shop_name}? It disappears from the pipeline but stays in the database.`) && patch(p, { archived: true })}>Archive</button>
            </div>
          )}
          {(p.company_industry || p.company_employees || p.company_linkedin || p.company_location || p.enrich_note) && (
            <p className="sub" style={{ marginTop: 8 }}>
              {[p.company_industry, p.company_employees ? `${p.company_employees.toLocaleString('en-GB')} employees` : null, p.company_location].filter(Boolean).join(' · ')}
              {p.company_linkedin && <> · <a href={p.company_linkedin} target="_blank" rel="noreferrer">Company LinkedIn</a></>}
              {p.enrich_note && <> · Apollo: {p.enrich_note}{p.enriched_at ? ` (${fmtRelative(p.enriched_at)})` : ''}</>}
            </p>
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
          <span className="badge muted" title="Most recent FastMoss pull. The Claude routine commits a pull file every morning at 05:30 UTC; the server pulls the repo and imports it at 06:00 and 11:00, then enriches the new shops with Apollo.">{data.last_pull_at ? `Pulled ${fmtRelative(data.last_pull_at)}` : 'No pull yet'}</span>
          {!data.fastmoss.configured
            ? <span className="badge muted" title="Set FASTMOSS_CLIENT_ID / FASTMOSS_CLIENT_SECRET in .env for the server to pull FastMoss itself">FastMoss API not set</span>
            : data.fastmoss.quota_hit_at && (!data.fastmoss.last_pull_at || data.fastmoss.quota_hit_at > data.fastmoss.last_pull_at)
              ? <span className="badge crit" title={data.fastmoss.last_error ?? ''}>FastMoss: out of credits</span>
              : data.fastmoss.last_error
                ? <span className="badge warn" title={data.fastmoss.last_error}>FastMoss: error</span>
                : <span className="badge good" title={`${data.fastmoss.last_test ?? 'Not tested yet'}${data.fastmoss.credits ? `. ${data.fastmoss.credits.available.toLocaleString('en-GB')} credits left` : ''}`}>FastMoss API{data.fastmoss.credits ? `: ${data.fastmoss.credits.available.toLocaleString('en-GB')} credits` : ' connected'}</span>}
          {isAdmin && data.fastmoss.configured && <button className="small" disabled={busy === 'fmtest'} onClick={() => run('fmtest', async () => { const r = await api.fastmossTest(); setNotice(r.error ? `FastMoss test failed: ${r.error}` : `FastMoss works: token at ${r.token_path}, shops at ${r.shop_search_path} (${r.rows} row returned).`); return r; })} title="Find the token and shop endpoints and run a one-row search (costs at most one credit)">{busy === 'fmtest' ? 'Testing…' : 'Test FastMoss'}</button>}
          {isAdmin && data.fastmoss.configured && <button className="small primary" disabled={busy === 'fmpull'} onClick={() => run('fmpull', async () => { const r = await api.fastmossPull(); const fm = r.fastmoss.last_pull; setNotice(r.fastmoss_error ? `FastMoss pull failed: ${r.fastmoss_error}` : `Pulled ${fm?.markets.map((m) => `${m.market} ${m.kept}`).join(', ')}: ${fm?.added ?? 0} new prospects, ${fm?.updated ?? 0} refreshed${fm?.quota_hit ? ' (stopped: out of credits)' : ''}. Enrichment queued.`); return r; })} title={`Pull the top ${data.fastmoss.pages} pages per market (${data.fastmoss.markets}) now, about ${data.fastmoss.pages * data.fastmoss.markets.split(',').length} FastMoss calls`}>{busy === 'fmpull' ? 'Pulling…' : 'Pull FastMoss now'}</button>}
          {isAdmin && <button className="small" disabled={busy === 'sweep'} onClick={() => run('sweep', async () => { const r = await api.bdSweep(); setNotice(`Sweep done: ${r.pulled ? 'repo pulled, ' : ''}${r.imported.files.length} new pull file(s), ${r.imported.added} prospects added, ${r.imported.updated} refreshed${data.apollo.configured ? ', enrichment queued' : ''}.`); return r; })} title="Run the daily sweep now: git pull, import new pull files, enrich with Apollo, scan alerts">{busy === 'sweep' ? 'Sweeping…' : 'Sweep now'}</button>}
          {!data.apollo.configured
            ? <span className="badge muted" title="Add APOLLO_API_KEY to .env and restart">Apollo not connected</span>
            : data.apollo.exhausted
              ? <span className="badge crit" title={data.apollo.error ?? 'Apollo refused a call for lack of credits'}>Apollo: out of credits</span>
              : data.apollo.ok
                ? <span className="badge good" title={`${data.apollo.used ?? 0} of ${data.apollo.limit ?? 0} used${data.apollo.cycle_end ? `, cycle resets ${data.apollo.cycle_end.slice(0, 10)}` : ''}. Checked ${fmtRelative(data.apollo.checked_at)}.`}>Apollo: {(data.apollo.remaining ?? 0).toLocaleString('en-GB')} credits left</span>
                : <span className="badge warn" title={data.apollo.error ?? ''}>Apollo: {data.apollo.checked_at ? 'check failed' : 'checking…'}</span>}
          {isAdmin && data.apollo.configured && <button className="small" disabled={busy === 'apollo'} onClick={() => run('apollo', async () => { const r = await api.apolloTest(); setNotice(r.healthy ? `Apollo key works. ${r.apollo.remaining?.toLocaleString('en-GB') ?? '?'} credits left${r.apollo.cycle_end ? `, cycle resets ${r.apollo.cycle_end.slice(0, 10)}` : ''}.` : `Apollo key rejected: ${r.health_error ?? r.apollo.error ?? 'unknown error'}`); return r; })} title="Check the key and refresh the credit balance (free)">{busy === 'apollo' ? 'Testing…' : 'Test Apollo'}</button>}
          {data.enrich.running && <span className="badge accent" title={data.enrich.current ?? ''}>Enriching {data.enrich.done}/{data.enrich.total}{data.enrich.current ? ` · ${data.enrich.current}` : ''}</span>}
          {!data.enrich.running && data.enrich.finished_at && <span className="badge muted" title={data.enrich.errors.join('\n')}>Last run: {data.enrich.matched}/{data.enrich.done} matched, {data.enrich.contacts} contacts, {data.enrich.revealed} revealed{data.enrich.errors.length ? `, ${data.enrich.errors.length} errors` : ''}</span>}
          {isAdmin && data.apollo_configured && <label className="field check" title="After every FastMoss pull or import, look up decision makers for the new prospects and reveal the top four, with nobody clicking"><input type="checkbox" checked={data.auto_enrich} onChange={(e) => run('auto', () => api.saveBdSettings({ auto_enrich: e.target.checked }), e.target.checked ? 'Auto-enrich on: new prospects get decision makers after each pull.' : 'Auto-enrich off.')} /> Auto-enrich new prospects</label>}
          {isAdmin && data.apollo_configured && (data.enrich.running
            ? <button onClick={() => run('enrich', api.stopEnrich, 'Stopping after the current prospect.')}>Stop</button>
            : <>
              <button onClick={() => { const n = data.prospects.filter((p) => !p.is_client && p.status !== 'won' && p.status !== 'lost' && p.contacts.length === 0).length; if (!n) { setNotice('Every open prospect already has contacts. Use "Enrich deeper" for the ones without an email.'); return; } run('enrich', () => api.enrichAll({ mode: 'new' }), `Enrichment started for ${n} prospects (up to ${data.apollo.reveal_per_prospect} reveals each).`); }} disabled={busy === 'enrich' || data.apollo.exhausted} title={`Resolve each company in Apollo, pull its decision makers and reveal the top ${data.apollo.reveal_per_prospect}. No confirmation, credits are spent as needed.`}>Find decision makers for all</button>
              <button onClick={() => { const n = data.prospects.filter((p) => !p.is_client && p.status !== 'won' && p.status !== 'lost' && p.contacts.length > 0 && !p.contacts.some((c) => c.email)).length; if (!n) { setNotice('No prospects with contacts but no email.'); return; } run('enrich', () => api.enrichAll({ mode: 'no_email' }), `Deeper pass started for ${n} prospects with no email yet.`); }} disabled={busy === 'enrich' || data.apollo.exhausted} title="Second pass on prospects that have contacts but no email yet: broader title search, local people first, more reveals">Enrich deeper</button>
            </>)}
          {connected && <span className="badge muted">Live</span>}
          {data.bulk_draft.running && <span className="badge accent" title={data.bulk_draft.current ?? ''}>Drafting {data.bulk_draft.done}/{data.bulk_draft.total}{data.bulk_draft.current ? ` · ${data.bulk_draft.current}` : ''}</span>}
          {isAdmin && <button className={showBulk ? '' : 'primary'} onClick={() => { setShowBulk((s) => !s); setShowAdd(false); setShowImport(false); }} title="Draft one email per prospect to its most senior relevant decision maker and save them all into Gmail drafts">{showBulk ? 'Close' : 'Bulk emails to Gmail'}</button>}
          {isAdmin && <button onClick={() => { setShowAdd((s) => !s); setShowImport(false); setShowBulk(false); }}>{showAdd ? 'Close' : '+ Prospect'}</button>}
          {isAdmin && <button onClick={() => { setShowImport((s) => !s); setShowAdd(false); }}>{showImport ? 'Close' : 'Import pull'}</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data.apollo.configured && data.apollo.exhausted && <div className="banner crit"><b>Apollo has run out of credits.</b> Enrichment and reveals are paused{data.apollo.exhausted_at ? ` since ${fmtRelative(data.apollo.exhausted_at)}` : ''}{data.apollo.cycle_end ? `; the cycle resets on ${data.apollo.cycle_end.slice(0, 10)}` : ''}. Top up in Apollo (Settings &gt; Plans) or wait for the reset; the balance is re-checked every 10 minutes and enrichment resumes on its own.{data.apollo.error ? ` Last error: ${data.apollo.error}` : ''}</div>}
      {data.apollo.configured && !data.apollo.exhausted && data.apollo.ok && (data.apollo.remaining ?? 0) < 200 && <div className="banner info">Apollo credits are running low: {data.apollo.remaining?.toLocaleString('en-GB')} left{data.apollo.cycle_end ? `, cycle resets ${data.apollo.cycle_end.slice(0, 10)}` : ''}.</div>}
      {data.enrich.stopped_reason === 'credits' && !data.enrich.running && <div className="banner crit">The last enrichment run stopped because Apollo ran out of credits ({data.enrich.done} of {data.enrich.total} done).</div>}
      {data.fastmoss.configured && data.fastmoss.quota_hit_at && (!data.fastmoss.last_pull_at || data.fastmoss.quota_hit_at > data.fastmoss.last_pull_at) && <div className="banner crit"><b>FastMoss has run out of credits.</b> The last pull stopped {fmtRelative(data.fastmoss.quota_hit_at)}. Top up at developers.fastmoss.com; the next scheduled pull tries again on its own.</div>}
      {isAdmin && data.fastmoss.configured && (
        <details style={{ marginBottom: 10 }}>
          <summary className="sub" style={{ cursor: 'pointer' }}>FastMoss pull settings: {data.fastmoss.markets} · {data.fastmoss.pages} pages per market · cron {data.fastmoss.pull_hour}{data.fastmoss.last_pull_at ? ` · last pull ${fmtRelative(data.fastmoss.last_pull_at)}` : ''}</summary>
          <div className="inline-form" style={{ marginTop: 6 }}>
            <label className="field" style={{ minWidth: 160 }}><span className="lbl">Markets</span><input type="text" defaultValue={data.fastmoss.markets} onBlur={(e) => e.target.value !== data.fastmoss.markets && run('fms', () => api.fastmossSettings({ markets: e.target.value }))} /></label>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Pages (×10 shops)</span><input type="number" min={1} max={30} defaultValue={data.fastmoss.pages} onBlur={(e) => Number(e.target.value) !== data.fastmoss.pages && run('fms', () => api.fastmossSettings({ pages: Number(e.target.value) }))} /></label>
            <label className="field" style={{ minWidth: 140 }}><span className="lbl">Daily pull (cron, {'Madrid time'})</span><input type="text" defaultValue={data.fastmoss.pull_hour} onBlur={(e) => e.target.value !== data.fastmoss.pull_hour && run('fms', () => api.fastmossSettings({ cron: e.target.value }))} /></label>
            <label className="field" style={{ flex: 1, minWidth: 320 }}><span className="lbl">Endpoint paths (from developers.fastmoss.com, only if the test cannot find them)</span><input type="text" defaultValue={JSON.stringify(data.fastmoss.paths)} onBlur={(e) => e.target.value !== JSON.stringify(data.fastmoss.paths) && run('fms', () => api.fastmossSettings({ paths: e.target.value }))} /></label>
          </div>
          {data.fastmoss.last_pull && <p className="sub" style={{ marginBottom: 0 }}>Last pull {data.fastmoss.last_pull.date}: {data.fastmoss.last_pull.markets.map((m) => `${m.market} ${m.pages}p/${m.kept} kept${m.error ? ` (${m.error.slice(0, 60)})` : ''}`).join(' · ')} → {data.fastmoss.last_pull.added} new, {data.fastmoss.last_pull.updated} refreshed.</p>}
        </details>
      )}
      {isAdmin && data.apollo.configured && (
        <div className="inline-form" style={{ marginBottom: 10 }}>
          <label className="field" style={{ minWidth: 150 }}><span className="lbl">Reveal per prospect</span><input type="number" min={0} max={20} defaultValue={data.apollo.reveal_per_prospect} onBlur={(e) => Number(e.target.value) !== data.apollo.reveal_per_prospect && run('s', () => api.saveBdSettings({ reveal_per_prospect: Number(e.target.value) }))} /><span className="help">Emails revealed per company (1 credit each)</span></label>
          <label className="field" style={{ minWidth: 150 }}><span className="lbl">Keep per prospect</span><input type="number" min={1} max={30} defaultValue={data.apollo.keep_per_prospect} onBlur={(e) => Number(e.target.value) !== data.apollo.keep_per_prospect && run('s', () => api.saveBdSettings({ keep_per_prospect: Number(e.target.value) }))} /><span className="help">People stored as contacts (free)</span></label>
          <span className="sub" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>Auto-enrich runs after every FastMoss pull: new prospects first, then a deeper pass on prospects with no email. Credits are spent without asking; it pauses by itself when Apollo runs out.</span>
        </div>
      )}

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
      {isAdmin && showBulk && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="page-head" style={{ marginBottom: 6 }}>
            <div>
              <h3 style={{ margin: 0 }}>Bulk emails</h3>
              <p className="hint" style={{ margin: 0 }}>One email per prospect to the most senior, most relevant contact with an email address (founder or ecommerce lead first, interns and support inboxes last). Prospects already drafted or emailed are skipped. Drafts land in {data.gmail_connected ? 'your Gmail drafts folder, ready to send in a batch' : 'Growth > Outreach emails (connect Gmail in Settings to save them straight into Gmail)'}.</p>
            </div>
            <div className="actions">
              {data.bulk_draft.running
                ? <button onClick={() => run('bulk', api.stopBulkDraft, 'Stopping after the current prospect.')}>Stop</button>
                : <button className="primary" disabled={busy === 'bulk' || !bulkPreview || bulkPreview.count === 0} onClick={() => run('bulk', () => api.bulkDraft({ market: f.market || undefined, limit: bulk.limit, language: bulk.language, style: bulk.style, instructions: bulk.instructions || undefined, to_gmail: bulk.to_gmail, include_drafted: bulk.include_drafted }), `Drafting ${Math.min(bulk.limit, bulkPreview?.count ?? 0)} emails in the background${bulk.to_gmail && data.gmail_connected ? ', saving each one to Gmail' : ''}.`)}>{busy === 'bulk' ? 'Starting…' : `Draft ${Math.min(bulk.limit, bulkPreview?.count ?? 0)} emails`}</button>}
            </div>
          </div>
          <div className="inline-form" style={{ marginBottom: 8 }}>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Shape</span><select value={bulk.style} onChange={(e) => setBulk({ ...bulk, style: e.target.value as 'short' | 'intro' })}><option value="short">Short note</option><option value="intro">Introduction</option></select></label>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Language</span><select value={bulk.language} onChange={(e) => setBulk({ ...bulk, language: e.target.value })}>{Object.entries(LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field" style={{ minWidth: 90 }}><span className="lbl">Max this run</span><input type="number" min={1} max={200} value={bulk.limit} onChange={(e) => setBulk({ ...bulk, limit: Math.max(1, Number(e.target.value) || 1) })} /></label>
            <label className="field" style={{ flex: 1, minWidth: 220 }}><span className="lbl">Extra instructions (optional)</span><input type="text" value={bulk.instructions} onChange={(e) => setBulk({ ...bulk, instructions: e.target.value })} placeholder="e.g. mention our Milan studio" /></label>
            <label className="field check" title="Save each draft into the connected Gmail account"><input type="checkbox" checked={bulk.to_gmail} disabled={!data.gmail_connected} onChange={(e) => setBulk({ ...bulk, to_gmail: e.target.checked })} /> Save to Gmail drafts</label>
            <label className="field check" title="Also draft for prospects that already have an open draft or a sent email"><input type="checkbox" checked={bulk.include_drafted} onChange={(e) => setBulk({ ...bulk, include_drafted: e.target.checked })} /> Include already drafted</label>
          </div>
          {data.bulk_draft.finished_at && !data.bulk_draft.running && <div className="banner info" style={{ marginBottom: 8 }}>Last run: {data.bulk_draft.drafted} drafted, {data.bulk_draft.gmail} saved to Gmail{data.bulk_draft.errors.length ? `, ${data.bulk_draft.errors.length} error(s): ${data.bulk_draft.errors.slice(0, 3).join(' · ')}` : ''}. <Link to="/outreach">Review drafts</Link>.</div>}
          {!bulkPreview ? <p className="sub">Loading candidates…</p> : bulkPreview.count === 0 ? <p className="sub">Nothing to draft{f.market ? ` in ${f.market}` : ''}: every prospect with an email contact already has a draft or an email out. Tick "Include already drafted" to redo them.</p> : (
            <>
              <p className="sub">{bulkPreview.count} prospect(s){f.market ? ` in ${f.market}` : ' across all markets'} ready, sorted by momentum. Who gets the email:</p>
              <div style={{ maxHeight: 220, overflow: 'auto' }}>
                <table className="table compact">
                  <thead><tr><th>Brand</th><th>Market</th><th>Contact</th><th>Title</th><th>Email</th></tr></thead>
                  <tbody>{bulkPreview.items.slice(0, bulk.limit).map((i) => <tr key={i.prospect_id}><td>{i.brand ?? i.shop_name}</td><td>{i.market}</td><td>{i.contact_name}</td><td className="sub">{i.contact_title ?? ''}</td><td className="sub">{i.contact_email}</td></tr>)}</tbody>
                </table>
              </div>
            </>
          )}
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
