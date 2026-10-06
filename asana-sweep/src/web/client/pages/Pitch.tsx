import { useCallback, useEffect, useState } from 'react';
import type { Pitch, PitchBrief, PitchSlide, PitchesData } from '../../../sweep/types';
import { api, fmtMoney, fmtRelative } from '../api';
import { useIsAdmin } from '../session';

/**
 * Pitch designer: pick the lead, fill the brief (markets, products and PDP images, colours, options,
 * pricing, forecast inputs), run the research (site, TikTok Shop via FastMoss and Cruva, creators,
 * Amazon, the pitch context on record), build the deck in the Brightform template with the client's
 * palette, edit every slide here, present it, print it to PDF, or export it for Claude Design.
 */
const MARKETS = ['DE', 'UK', 'FR', 'IT', 'ES', 'NL', 'BE', 'IE', 'PL', 'AT', 'US'];
const OPTIONS: { key: keyof PitchBrief['options']; label: string }[] = [
  { key: 'pdp_imagery', label: 'PDP imagery' }, { key: 'market', label: 'Market analysis (FastMoss)' }, { key: 'resellers', label: 'Resellers and marketplaces' }, { key: 'amazon', label: 'Amazon check' },
  { key: 'creators', label: 'Creator strategy' }, { key: 'forecasts', label: 'Forecast' }, { key: 'livestream', label: 'Live selling' }, { key: 'case_studies', label: 'Case studies' },
];

export default function PitchPage() {
  const [data, setData] = useState<PitchesData | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [create, setCreate] = useState({ lead_id: '', client: '', website: '' });
  const isAdmin = useIsAdmin();
  const load = useCallback(() => api.pitches().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const run = async <T extends PitchesData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const pitch = data.pitches.find((p) => p.id === selected) ?? null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pitch designer</h1>
          <p className="hint" style={{ margin: 0 }}>Build the client deck from the lead: the brief, the research (their site and PDPs, TikTok Shop through FastMoss and Cruva, resellers, Amazon, the creators to build the strategy on, what they said on the pitch call), then the deck in the Brightform template with their colours. Edit every slide here, present it, print it to PDF, or take it into Claude Design.</p>
        </div>
        <div className="actions">
          <span className={`badge ${data.llm_configured ? 'good' : 'muted'}`}>{data.llm_configured ? 'Claude writing' : 'Template copy'}</span>
          <span className={`badge ${data.fastmoss_configured ? 'good' : 'muted'}`}>{data.fastmoss_configured ? 'FastMoss' : 'FastMoss not set'}</span>
          <span className={`badge ${data.cruva_configured ? 'good' : 'muted'}`}>{data.cruva_configured ? 'Cruva' : 'Cruva not set'}</span>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {isAdmin && (
        <div className="card inline-form" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 220 }}><span className="lbl">From a lead</span><select value={create.lead_id} onChange={(e) => { const l = data.leads.find((x) => String(x.id) === e.target.value); setCreate({ ...create, lead_id: e.target.value, client: l?.name ?? create.client }); }}><option value="">Pick a lead (optional)</option>{data.leads.map((l) => <option key={l.id} value={l.id}>{l.name}{l.country ? ` · ${l.country}` : ''}</option>)}</select></label>
          <label className="field" style={{ minWidth: 200 }}><span className="lbl">Client</span><input type="text" value={create.client} onChange={(e) => setCreate({ ...create, client: e.target.value })} placeholder="Brand name" /></label>
          <label className="field" style={{ minWidth: 220 }}><span className="lbl">Website</span><input type="text" value={create.website} onChange={(e) => setCreate({ ...create, website: e.target.value })} placeholder="https://brand.com" /></label>
          <button className="primary" disabled={!create.client.trim() || busy === 'create'} onClick={() => run('create', () => api.pitchCreate({ lead_id: create.lead_id ? Number(create.lead_id) : null, client: create.client.trim(), website: create.website.trim() }), (r) => { setSelected(r.pitch.id); setCreate({ lead_id: '', client: '', website: '' }); })}>New pitch</button>
        </div>
      )}
      <div className="inbox-split">
        <div className="inbox-list">
          {data.pitches.length === 0 ? <div className="empty">No pitches yet.</div> : data.pitches.map((p) => (
            <button key={p.id} className={`conv ${selected === p.id ? 'active' : ''}`} onClick={() => setSelected(p.id)}>
              <div className="page-head" style={{ marginBottom: 2 }}><b>{p.client}</b><span className={`badge ${p.deck ? 'good' : p.research ? 'accent' : 'muted'}`}>{p.deck ? `${p.deck.slides.filter((s) => s.enabled).length} slides` : p.research ? 'researched' : 'brief'}</span></div>
              <div style={{ fontSize: 13.5 }}>{p.name}</div>
              <div className="sub">{p.brief.markets.join(', ')}{p.lead_name ? ` · lead ${p.lead_name}` : ''} · {fmtRelative(p.updated_at)}</div>
            </button>
          ))}
        </div>
        <div className="detail card">
          {pitch ? <PitchEditor key={pitch.id} pitch={pitch} data={data} busy={busy} run={run} isAdmin={isAdmin} setNotice={setNotice} onDeleted={() => setSelected(null)} /> : <p className="sub">Pick a pitch on the left or start a new one.</p>}
        </div>
      </div>
    </>
  );
}

function PitchEditor({ pitch, data, busy, run, isAdmin, setNotice, onDeleted }: { pitch: Pitch; data: PitchesData; busy: string | null; run: <T extends PitchesData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; isAdmin: boolean; setNotice: (s: string) => void; onDeleted: () => void }) {
  const [tab, setTab] = useState<'brief' | 'research' | 'deck' | 'export'>(pitch.deck ? 'deck' : 'brief');
  const [brief, setBrief] = useState<PitchBrief>(pitch.brief);
  const [slides, setSlides] = useState<PitchSlide[]>(pitch.deck?.slides ?? []);
  const [palette, setPalette] = useState(pitch.deck?.palette ?? null);
  const [cur, setCur] = useState(0);
  const [previewKey, setPreviewKey] = useState(0);
  useEffect(() => { setBrief(pitch.brief); setSlides(pitch.deck?.slides ?? []); setPalette(pitch.deck?.palette ?? null); setPreviewKey((k) => k + 1); }, [pitch.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const briefDirty = JSON.stringify(brief) !== JSON.stringify(pitch.brief);
  const deckDirty = JSON.stringify({ slides, palette }) !== JSON.stringify({ slides: pitch.deck?.slides ?? [], palette: pitch.deck?.palette ?? null });
  const saveBrief = () => run('brief', () => api.pitchUpdate(pitch.id, { brief }));
  const saveDeck = () => run('deck', () => api.pitchDeck(pitch.id, { slides, palette: palette ?? undefined }));
  const r = pitch.research;
  const s = slides[cur] ?? null;
  const setSlide = (patch: Partial<PitchSlide>) => setSlides(slides.map((x, i) => (i === cur ? { ...x, ...patch } : x)));
  const move = (d: number) => { const j = cur + d; if (j < 0 || j >= slides.length) return; const n = [...slides]; [n[cur], n[j]] = [n[j], n[cur]]; setSlides(n); setCur(j); };
  const upd = <K extends keyof PitchBrief>(k: K, v: PitchBrief[K]) => setBrief({ ...brief, [k]: v });
  return (
    <>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div><b>{pitch.client}</b> <span className="sub">{pitch.name}{pitch.lead_name ? ` · from lead ${pitch.lead_name}` : ''}</span></div>
        <div className="actions">
          <div className="presets">
            <button className={tab === 'brief' ? 'active' : ''} onClick={() => setTab('brief')}>1 Brief</button>
            <button className={tab === 'research' ? 'active' : ''} onClick={() => setTab('research')}>2 Research{r ? ' ✓' : ''}</button>
            <button className={tab === 'deck' ? 'active' : ''} onClick={() => setTab('deck')}>3 Deck{pitch.deck ? ' ✓' : ''}</button>
            <button className={tab === 'export' ? 'active' : ''} onClick={() => setTab('export')}>4 Present / export</button>
          </div>
          {isAdmin && <button className="small danger" onClick={() => window.confirm('Delete this pitch?') && run('del', () => api.pitchDelete(pitch.id), onDeleted)}>Delete</button>}
        </div>
      </div>

      {tab === 'brief' && (
        <div>
          <div className="inline-form" style={{ marginBottom: 10 }}>
            <label className="field" style={{ minWidth: 200 }}><span className="lbl">Client</span><input type="text" value={brief.client} onChange={(e) => upd('client', e.target.value)} /></label>
            <label className="field" style={{ minWidth: 240 }}><span className="lbl">Website</span><input type="text" value={brief.website} onChange={(e) => upd('website', e.target.value)} placeholder="https://" /></label>
            <label className="field" style={{ minWidth: 200 }}><span className="lbl">Category</span><input type="text" value={brief.category} onChange={(e) => upd('category', e.target.value)} placeholder="e.g. collagen supplements" /></label>
            <label className="field" style={{ minWidth: 260 }}><span className="lbl">Markets</span><div className="shop-switches" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{MARKETS.map((m) => <button key={m} className={`small ${brief.markets.includes(m) ? 'primary' : ''}`} onClick={() => upd('markets', brief.markets.includes(m) ? brief.markets.filter((x) => x !== m) : [...brief.markets, m])}>{m}</button>)}</div></label>
          </div>
          <div className="inline-form" style={{ marginBottom: 10 }}>
            <label className="field" style={{ flex: 1, minWidth: 300 }}><span className="lbl">What the creators' videos should look like</span><input type="text" value={brief.creator_query} onChange={(e) => upd('creator_query', e.target.value)} placeholder="e.g. woman talking about gut health supplements at home" /><span className="help">Drives the Cruva creator search</span></label>
            <label className="field" style={{ minWidth: 220 }}><span className="lbl">Logo URL</span><input type="text" value={brief.logo_url} onChange={(e) => upd('logo_url', e.target.value)} /></label>
          </div>
          <h4>Products and PDPs <span className="sub">name, price, PDP URL (images and prices are pulled from the page), image URL</span></h4>
          {brief.products.map((p, i) => (
            <div key={i} className="inline-form" style={{ marginBottom: 6 }}>
              <input type="text" style={{ minWidth: 200 }} value={p.name} placeholder="Product" onChange={(e) => upd('products', brief.products.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
              <input type="number" style={{ width: 100 }} value={p.price ?? ''} placeholder="Price" onChange={(e) => upd('products', brief.products.map((x, k) => (k === i ? { ...x, price: e.target.value === '' ? null : Number(e.target.value) } : x)))} />
              <input type="text" style={{ minWidth: 260 }} value={p.url ?? ''} placeholder="PDP URL" onChange={(e) => upd('products', brief.products.map((x, k) => (k === i ? { ...x, url: e.target.value || null } : x)))} />
              <input type="text" style={{ minWidth: 220 }} value={p.image ?? ''} placeholder="Image URL (optional)" onChange={(e) => upd('products', brief.products.map((x, k) => (k === i ? { ...x, image: e.target.value || null } : x)))} />
              <button className="small" onClick={() => upd('products', brief.products.filter((_, k) => k !== i))}>×</button>
            </div>
          ))}
          <button className="small" onClick={() => upd('products', [...brief.products, { name: '', price: null, url: null, image: null }])}>+ Product</button>
          <h4>Images <span className="sub">PDP and lifestyle image URLs for the cover and product slides (the research fills these from the PDPs)</span></h4>
          <textarea rows={3} style={{ width: '100%' }} value={brief.pdp_images.join('\n')} onChange={(e) => upd('pdp_images', e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} placeholder="one URL per line" />
          {brief.pdp_images.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>{brief.pdp_images.slice(0, 12).map((u) => <img key={u} src={u} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />)}</div>}
          <h4>Colours <span className="sub">the client's palette; the site's theme colour is picked up by the research</span></h4>
          <div className="inline-form" style={{ marginBottom: 10 }}>
            {(['primary', 'secondary', 'accent'] as const).map((k) => <label key={k} className="field" style={{ minWidth: 150 }}><span className="lbl">{k}</span><div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="color" value={brief.colours[k]} onChange={(e) => upd('colours', { ...brief.colours, [k]: e.target.value })} /><input type="text" style={{ width: 90 }} value={brief.colours[k]} onChange={(e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) upd('colours', { ...brief.colours, [k]: e.target.value.toLowerCase() }); }} /></div></label>)}
            <div className="field"><span className="lbl">Preview</span><div style={{ display: 'flex', gap: 4 }}>{[brief.colours.primary, brief.colours.secondary, brief.colours.accent].map((c) => <span key={c} style={{ width: 36, height: 36, borderRadius: 8, background: c, border: '1px solid var(--border)' }} />)}</div></div>
          </div>
          <h4>What goes in</h4>
          <div className="inline-form" style={{ marginBottom: 10 }}>{OPTIONS.map((o) => <label key={o.key} className="field check"><input type="checkbox" checked={brief.options[o.key]} onChange={(e) => upd('options', { ...brief.options, [o.key]: e.target.checked })} /> {o.label}</label>)}</div>
          <h4>Pricing</h4>
          <div className="inline-form" style={{ marginBottom: 10 }}>
            <label className="field" style={{ minWidth: 130 }}><span className="lbl">Retainer / month</span><input type="number" min={0} value={brief.pricing.retainer ?? ''} onChange={(e) => upd('pricing', { ...brief.pricing, retainer: e.target.value === '' ? null : Number(e.target.value) })} /></label>
            <label className="field" style={{ minWidth: 90 }}><span className="lbl">Currency</span><select value={brief.pricing.currency} onChange={(e) => upd('pricing', { ...brief.pricing, currency: e.target.value })}>{['EUR', 'GBP', 'USD'].map((c) => <option key={c}>{c}</option>)}</select></label>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Commission %</span><input type="number" min={0} step={0.5} value={brief.pricing.commission_pct ?? ''} onChange={(e) => upd('pricing', { ...brief.pricing, commission_pct: e.target.value === '' ? null : Number(e.target.value) })} /></label>
            <label className="field" style={{ minWidth: 170 }}><span className="lbl">On</span><select value={brief.pricing.commission_basis} onChange={(e) => upd('pricing', { ...brief.pricing, commission_basis: e.target.value as 'gmv' | 'mor' })}><option value="gmv">GMV</option><option value="mor">Net settlement (MoR)</option></select></label>
            <label className="field" style={{ minWidth: 100 }}><span className="lbl">Term (months)</span><input type="number" min={1} value={brief.pricing.term_months} onChange={(e) => upd('pricing', { ...brief.pricing, term_months: Number(e.target.value) })} /></label>
            <label className="field" style={{ minWidth: 120 }}><span className="lbl">Creator video fee</span><input type="number" min={0} value={brief.pricing.creator_video_fee ?? ''} onChange={(e) => upd('pricing', { ...brief.pricing, creator_video_fee: e.target.value === '' ? null : Number(e.target.value) })} /></label>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Live rate / hour</span><input type="number" min={0} value={brief.pricing.live_rate ?? ''} onChange={(e) => upd('pricing', { ...brief.pricing, live_rate: e.target.value === '' ? null : Number(e.target.value) })} /></label>
          </div>
          <h4>Forecast inputs</h4>
          <div className="inline-form" style={{ marginBottom: 10 }}>
            {([['start_gmv', 'Month 1 GMV'], ['aov', 'AOV'], ['cogs_pct', 'COGS %'], ['discount_pct', 'Discount %'], ['growth_pct', 'Growth % / month'], ['ad_spend', 'Ad spend / month'], ['ad_roi', 'Ad ROI'], ['samples_per_month', 'Samples / month'], ['sample_gmv_each', 'GMV per sample'], ['months', 'Months']] as [keyof PitchBrief['forecast'], string][]).map(([k, label]) => <label key={k} className="field" style={{ minWidth: 110 }}><span className="lbl">{label}</span><input type="number" step={k === 'ad_roi' ? 0.1 : 1} value={brief.forecast[k]} onChange={(e) => upd('forecast', { ...brief.forecast, [k]: Number(e.target.value) })} /></label>)}
          </div>
          <h4>Case studies <span className="sub">our accounts with GMV on record; blank = the top three</span></h4>
          <div className="inline-form" style={{ marginBottom: 10 }}>{data.accounts.map((a) => <label key={a.id} className="field check"><input type="checkbox" checked={brief.case_studies.includes(a.name)} onChange={(e) => upd('case_studies', e.target.checked ? [...brief.case_studies, a.name] : brief.case_studies.filter((x) => x !== a.name))} /> {a.name}</label>)}</div>
          <div className="inline-form" style={{ marginBottom: 10 }}>
            <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Notes for the deck</span><textarea rows={2} value={brief.notes} onChange={(e) => upd('notes', e.target.value)} placeholder="what they said on the pitch call, what matters to them" /></label>
            <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Instructions for Claude</span><textarea rows={2} value={brief.instructions} onChange={(e) => upd('instructions', e.target.value)} placeholder="tone, what to stress, what to leave out" /></label>
          </div>
          <div className="actions">
            <button className="primary" disabled={!briefDirty || busy === 'brief'} onClick={saveBrief}>{busy === 'brief' ? 'Saving…' : briefDirty ? 'Save brief' : 'Saved'}</button>
            <button disabled={busy === 'research'} onClick={() => run('research', async () => { if (briefDirty) await api.pitchUpdate(pitch.id, { brief }); return api.pitchResearch(pitch.id); }, () => { setTab('research'); setNotice('Research done.'); })}>{busy === 'research' ? 'Researching…' : 'Save and run research ▸'}</button>
          </div>
        </div>
      )}

      {tab === 'research' && (
        <div>
          <div className="actions" style={{ marginBottom: 10 }}>
            <button className="primary" disabled={busy === 'research'} onClick={() => run('research', () => api.pitchResearch(pitch.id), () => setNotice('Research refreshed.'))}>{busy === 'research' ? 'Researching…' : r ? 'Run research again' : 'Run research'}</button>
            {r && <button disabled={busy === 'build'} onClick={() => run('build', () => api.pitchBuild(pitch.id), () => { setTab('deck'); setNotice('Deck built.'); })}>{busy === 'build' ? 'Building…' : 'Build the deck ▸'}</button>}
            {r && <span className="sub">Researched {fmtRelative(r.fetched_at)}{r.errors.length ? ` · ${r.errors.length} note(s)` : ''}</span>}
          </div>
          {!r ? <div className="empty">Not researched yet. It reads the site and PDPs, TikTok Shop through FastMoss and Cruva, resellers, Amazon and the pitch context on record.</div> : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
              <div className="card"><h4 style={{ marginTop: 0 }}>Site</h4>{r.site ? <><b>{r.site.title}</b><p className="sub">{r.site.description}</p>{r.site.theme_colour && <p className="sub">Theme colour <span style={{ display: 'inline-block', width: 14, height: 14, background: r.site.theme_colour, verticalAlign: 'middle', borderRadius: 3 }} /> {r.site.theme_colour}</p>}<div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{r.site.images.slice(0, 10).map((u) => <img key={u} src={u} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6 }} />)}</div></> : <p className="sub">No website in the brief or not reachable.</p>}</div>
              <div className="card"><h4 style={{ marginTop: 0 }}>Products</h4>{r.products.length ? <ul className="sub" style={{ paddingLeft: 18 }}>{r.products.map((p) => <li key={p.url}>{p.name}{p.price !== null ? ` · ${fmtMoney(p.price, pitch.brief.pricing.currency)}` : ''}{p.image ? ' · image' : ''}</li>)}</ul> : <p className="sub">Add PDP URLs in the brief.</p>}</div>
              <div className="card"><h4 style={{ marginTop: 0 }}>TikTok Shop today</h4>{r.tiktok.brand ? <p><b>{r.tiktok.brand.name}</b>: ${Math.round(r.tiktok.brand.gmv ?? 0).toLocaleString('en-GB')} GMV in 30 days · {r.tiktok.brand.creators} creators · {r.tiktok.brand.videos} videos ({r.tiktok.brand.region})</p> : <p className="sub">No brand found on TikTok Shop under this name.</p>}{r.tiktok.shops.length > 0 && <ul className="sub" style={{ paddingLeft: 18 }}>{r.tiktok.shops.slice(0, 8).map((sh, i) => <li key={i}>{sh.shop_name} ({sh.region}){sh.gmv_7d !== null ? ` · ${fmtMoney(sh.gmv_7d, 'USD')} last 7 days` : ''}</li>)}</ul>}{r.tiktok.market.map((m) => <p key={m.market} className="sub">{m.market}: {m.prospects} shops tracked, {m.surging} surging · leaders {m.leaders.slice(0, 3).join(', ')}</p>)}</div>
              <div className="card"><h4 style={{ marginTop: 0 }}>Resellers and Amazon</h4>{r.resellers.length ? <ul className="sub" style={{ paddingLeft: 18 }}>{r.resellers.slice(0, 8).map((x, i) => <li key={i}>{x.name} ({x.region}) · {x.note}</li>)}</ul> : <p className="sub">No resellers found on TikTok Shop.</p>}<p className="sub">Amazon: {r.amazon.reachable ? `${r.amazon.items.length} listing(s)` : 'not reachable from the server (Amazon blocks bots); add listings by hand on the slide'}</p>{r.amazon.items.slice(0, 5).map((i) => <div key={i.url} className="sub"><a href={i.url} target="_blank" rel="noreferrer">{i.title.slice(0, 80)}</a>{i.price ? ` · ${i.price}` : ''}</div>)}</div>
              <div className="card" style={{ gridColumn: '1 / -1' }}><h4 style={{ marginTop: 0 }}>Creators <span className="sub">{r.creators.length} found · Cruva (by what their videos show) and FastMoss (by GMV)</span></h4>{r.creators.length ? <div className="grid-wrap"><table><thead><tr><th>Handle</th><th className="num">Followers</th><th className="num">30d GMV</th><th className="num">Engagement</th><th>Categories</th><th>Source</th></tr></thead><tbody>{r.creators.map((c) => <tr key={c.handle}><td><b>@{c.handle}</b>{c.name ? <span className="sub"> {c.name}</span> : null}{c.video_url ? <> · <a href={c.video_url} target="_blank" rel="noreferrer">video</a></> : null}</td><td className="num">{c.followers?.toLocaleString('en-GB') ?? '–'}</td><td className="num">{c.gmv_30d !== null ? `$${Math.round(c.gmv_30d).toLocaleString('en-GB')}` : '–'}</td><td className="num">{c.engagement !== null ? `${c.engagement}%` : '–'}</td><td className="sub">{c.categories ?? ''}</td><td><span className="badge muted">{c.source}</span></td></tr>)}</tbody></table></div> : <p className="sub">No creators yet: set the category and the creator query in the brief, and make sure Cruva or FastMoss is configured.</p>}</div>
              <div className="card" style={{ gridColumn: '1 / -1' }}><h4 style={{ marginTop: 0 }}>What they said <span className="sub">pitch call, emails and Slack that name the client; internal calls are never read</span></h4>{r.context.length ? <ol className="sources">{r.context.map((c, i) => <li key={i}><span className="badge muted">{c.kind}</span> <b>{c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a> : c.title}</b>{c.occurred_at ? <span className="sub"> · {c.occurred_at.slice(0, 10)}</span> : null}<div className="sub">{c.snippet}</div></li>)}</ol> : <p className="sub">Nothing on record names this client yet.</p>}</div>
              {r.errors.length > 0 && <div className="card" style={{ gridColumn: '1 / -1' }}><h4 style={{ marginTop: 0 }}>Notes</h4><ul className="sub" style={{ paddingLeft: 18 }}>{r.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
            </div>
          )}
        </div>
      )}

      {tab === 'deck' && (
        <div>
          <div className="actions" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            <button className="primary" disabled={busy === 'build'} onClick={() => run('build', () => api.pitchBuild(pitch.id), () => setNotice('Deck built from the brief and the research.'))}>{busy === 'build' ? 'Building…' : pitch.deck ? 'Rebuild deck' : 'Build deck'}</button>
            {pitch.deck && <button disabled={!deckDirty || busy === 'deck'} onClick={saveDeck}>{busy === 'deck' ? 'Saving…' : deckDirty ? 'Save slides' : 'Saved'}</button>}
            {pitch.deck && <span className="sub">Built {fmtRelative(pitch.deck.built_at)} · {pitch.deck.generator === 'claude' ? 'Claude copy' : 'template copy'}</span>}
            {palette && <span className="inline-form" style={{ marginLeft: 'auto', alignItems: 'center' }}><span className="sub">Palette</span>{(['primary', 'secondary', 'accent', 'ink', 'paper'] as const).map((k) => <input key={k} type="color" value={palette[k]} title={k} onChange={(e) => setPalette({ ...palette, [k]: e.target.value })} />)}</span>}
          </div>
          {!pitch.deck ? <div className="empty">No deck yet. Build it from the brief and the research.</div> : (
            <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 12 }}>
              <div className="inbox-list" style={{ maxHeight: 640, overflow: 'auto' }}>
                {slides.map((x, i) => <button key={x.key} className={`conv ${i === cur ? 'active' : ''} ${x.enabled ? '' : 'dim'}`} onClick={() => setCur(i)}><div style={{ fontSize: 13 }}><span className="sub">{i + 1}.</span> {x.title}</div><div className="sub">{x.kind}{x.enabled ? '' : ' · hidden'}</div></button>)}
                <button className="small" style={{ margin: 8 }} onClick={() => { setSlides([...slides, { key: `custom_${Date.now().toString(36)}`, kind: 'custom', enabled: true, title: 'New slide', subtitle: null, bullets: [], stats: [], images: [], body: null, notes: null }]); setCur(slides.length); }}>+ Slide</button>
              </div>
              {s && (
                <div>
                  <div className="inline-form" style={{ marginBottom: 8, alignItems: 'center' }}>
                    <label className="field check"><input type="checkbox" checked={s.enabled} onChange={(e) => setSlide({ enabled: e.target.checked })} /> Show</label>
                    <button className="small" onClick={() => move(-1)} disabled={cur === 0}>↑</button><button className="small" onClick={() => move(1)} disabled={cur === slides.length - 1}>↓</button>
                    {s.kind === 'custom' && <button className="small danger" onClick={() => { setSlides(slides.filter((_, i) => i !== cur)); setCur(Math.max(0, cur - 1)); }}>Remove</button>}
                    <span className="sub">{s.kind}</span>
                  </div>
                  <label className="field"><span className="lbl">Title</span><input type="text" value={s.title} onChange={(e) => setSlide({ title: e.target.value })} /></label>
                  <label className="field"><span className="lbl">Subtitle</span><input type="text" value={s.subtitle ?? ''} onChange={(e) => setSlide({ subtitle: e.target.value || null })} /></label>
                  <label className="field"><span className="lbl">Bullets (one per line)</span><textarea rows={6} value={s.bullets.join('\n')} onChange={(e) => setSlide({ bullets: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} /></label>
                  <label className="field"><span className="lbl">Stats (label | value | note, one per line)</span><textarea rows={3} value={s.stats.map((st) => `${st.label} | ${st.value}${st.note ? ` | ${st.note}` : ''}`).join('\n')} onChange={(e) => setSlide({ stats: e.target.value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0] && p[1]).map((p) => ({ label: p[0], value: p[1], note: p[2] || null })) })} /></label>
                  <label className="field"><span className="lbl">Images (URLs, one per line)</span><textarea rows={2} value={s.images.join('\n')} onChange={(e) => setSlide({ images: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} /></label>
                  <label className="field"><span className="lbl">Body</span><textarea rows={2} value={s.body ?? ''} onChange={(e) => setSlide({ body: e.target.value || null })} /></label>
                  <label className="field"><span className="lbl">Speaker notes</span><textarea rows={2} value={s.notes ?? ''} onChange={(e) => setSlide({ notes: e.target.value || null })} /></label>
                </div>
              )}
            </div>
          )}
          {pitch.deck && <div style={{ marginTop: 12 }}><div className="sub" style={{ marginBottom: 4 }}>Preview (saved version){deckDirty ? ' · save to refresh' : ''}</div><iframe key={previewKey} title="deck" src={api.pitchDeckUrl(pitch.id)} style={{ width: '100%', height: 480, border: '1px solid var(--border)', borderRadius: 12, background: '#111' }} /></div>}
        </div>
      )}

      {tab === 'export' && (
        <div>
          {!pitch.deck ? <div className="empty">Build the deck first.</div> : (
            <div className="card">
              <h4 style={{ marginTop: 0 }}>Present and export</h4>
              <div className="actions" style={{ flexWrap: 'wrap' }}>
                <a className="button primary" href={api.pitchDeckUrl(pitch.id)} target="_blank" rel="noreferrer">Open the deck (present, arrow keys)</a>
                <a className="button" href={api.pitchDeckUrl(pitch.id, true)} download>Download HTML</a>
                <a className="button" href={api.pitchExportUrl(pitch.id)} download>Download JSON (brief, research, slides)</a>
              </div>
              <p className="sub">PDF: open the deck and print it (each slide is a landscape page). Claude Design: download the HTML and the JSON, open <a href="https://claude.ai/design" target="_blank" rel="noreferrer">claude.ai/design</a>, start from the Brightform design system and drop the HTML in; every slide, colour and image comes across, and the JSON carries the research and the numbers. Edits made there can be pasted back into the slide editor here.</p>
              <p className="sub">Deck status: <span className={`badge ${pitch.status === 'ready' ? 'good' : 'muted'}`}>{pitch.status}</span> {isAdmin && <button className="small" onClick={() => run('st', () => api.pitchUpdate(pitch.id, { status: pitch.status === 'ready' ? 'draft' : 'ready' }))}>{pitch.status === 'ready' ? 'Back to draft' : 'Mark ready'}</button>}</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
