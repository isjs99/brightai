import { useCallback, useEffect, useState } from 'react';
import type { PlaybookCompetitor, PlaybookContentVideo, PlaybookMarketProfile, PlaybookProfile, PlaybookShop } from '../../../sweep/types';
import { api, fmtRelative, type PlaybookCompetitorsData } from '../api';

/**
 * One shop's learning: the top videos and what they have in common, the voice learnt from the messages the
 * shop already runs in Cruva (shown in full), and the two settings (top slice, automatic weekly updates).
 */
type Loaded = Awaited<ReturnType<typeof api.playbookProfile>>;
const n = (x: number) => Math.round(x).toLocaleString();

export default function CruvaProfile({ shopId, isAdmin, onChanged }: { shopId: string; isAdmin: boolean; onChanged: () => void }) {
  const [d, setD] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<'content' | 'voice' | 'competitors' | 'history'>('content');
  const load = useCallback(() => api.playbookProfile(shopId).then(setD).catch((e) => setError((e as Error).message)), [shopId]);
  useEffect(() => { load(); }, [load]);
  const run = async <T,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => { setBusy(key); setError(null); try { after?.(await fn()); await load(); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  if (!d) return <p className="sub">{error ?? 'Loading…'}</p>;
  const shop: PlaybookShop = d.shop; const p: PlaybookProfile | null = d.profiles[0] ?? null;
  const top: PlaybookContentVideo[] = d.videos.filter((v) => v.top);
  return (
    <>
      {error && <div className="banner crit">{error}</div>}
      <div className="actions" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <span className="sub">{d.learned_at ? `Learnt ${fmtRelative(d.learned_at)}` : 'Not learnt yet'}{p ? ` · ${p.window_from} to ${p.window_to} · ${p.videos} videos, top ${p.top_count} = ${n(p.top_gmv)} of ${n(p.total_gmv)} GMV` : ''}</span>
        <span style={{ flex: 1 }} />
        {isAdmin && <label className="field" style={{ width: 120 }}><span className="lbl">Top slice %</span><input type="number" min={1} max={20} defaultValue={shop.top_pct} onBlur={(e) => Number(e.target.value) !== shop.top_pct && run('pct', () => api.playbookShop(shopId, { top_pct: Number(e.target.value) }))} /></label>}
        {isAdmin && <label className="field check" title="Monday: when the profile moves, the live lifecycle bots are rewritten and applied without waiting for approval (outreach pushes always wait)"><input type="checkbox" checked={shop.auto_update} onChange={(e) => run('auto', () => api.playbookShop(shopId, { auto_update: e.target.checked }))} /> Update bots automatically</label>}
        {isAdmin && <button className="primary small" disabled={busy !== null} onClick={() => run('learn', () => api.playbookLearn(shopId), (r) => { if (r.errors.length) setError(r.errors.join(' | ')); })}>{busy === 'learn' ? 'Learning…' : 'Learn now'}</button>}
      </div>
      <div className="presets" style={{ marginBottom: 10 }}>
        <button className={tab === 'content' ? 'active' : ''} onClick={() => setTab('content')}>What sells</button>
        <button className={tab === 'voice' ? 'active' : ''} onClick={() => setTab('voice')}>Voice and existing messages ({d.existing.length})</button>
        <button className={tab === 'competitors' ? 'active' : ''} onClick={() => setTab('competitors')}>Competitors{shop.competitors ? ` (${shop.competitors})` : ''}</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History ({d.profiles.length})</button>
      </div>

      {tab === 'content' && (!p ? <p className="sub">No profile yet. Learn now reads the last 28 days of the shop's affiliate videos from Cruva, ranks them, and writes what the top slice has in common.</p> : (
        <>
          <p style={{ marginTop: 0 }}>{p.summary}</p>
          <div className="two-col">
            <div>
              <h4>Hooks that work</h4>
              <ul>{p.hooks.map((h, i) => <li key={i}><b>{h.group}</b>: "{h.example}" <span className="sub">· {h.video_ids.length} video{h.video_ids.length === 1 ? '' : 's'}</span></li>)}</ul>
              {p.formats.length > 0 && <><h4>Formats</h4><p className="sub">{p.formats.map((f) => `${f.name} (${f.video_ids.length})`).join(' · ')}</p></>}
              {p.products_carry.length > 0 && <><h4>Products that carry</h4><ul>{p.products_carry.slice(0, 6).map((x) => <li key={x.product_id}>{x.product_id} <span className="sub">· {n(x.gmv)} GMV over {x.videos} video{x.videos === 1 ? '' : 's'}</span></li>)}</ul></>}
              {p.products_no_gmv.length > 0 && <p className="sub">Videos but no sales: {p.products_no_gmv.slice(0, 6).join(', ')}</p>}
            </div>
            <div>
              <h4>Timing and offer</h4>
              <p className="sub">{p.timing.best_days.length ? `Best days: ${p.timing.best_days.join(', ')}` : 'No clear day'}{p.timing.best_hours.length ? ` · ${p.timing.best_hours.join(', ')}` : ''}{p.offer ? ` · Offer: ${p.offer}` : ''}</p>
              <h4>Creators</h4>
              <p className="sub">{p.creator_shape.follower_band ?? 'Any size'}{p.creator_shape.niches.length ? ` · ${p.creator_shape.niches.join(', ')}` : ''}{p.creator_shape.first_video_share !== null ? ` · ${Math.round(p.creator_shape.first_video_share * 100)}% on their first video for us` : ''}</p>
              <ul>{p.top_creators.slice(0, 6).map((c) => <li key={c.handle}>@{c.handle} <span className="sub">· {n(c.gmv)} GMV, {c.videos} video{c.videos === 1 ? '' : 's'} in the top slice</span></li>)}</ul>
              {p.content_ideas.length > 0 && <><h4>Ideas for the brief</h4><ul>{p.content_ideas.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
            </div>
          </div>
          {p.example_scripts.length > 0 && <><h4>Example scripts</h4>{p.example_scripts.map((e) => <div key={e.video_id} className="bubble" style={{ marginBottom: 6 }}><b>@{e.handle}</b> {e.link && <a href={e.link} target="_blank" rel="noopener" className="sub">open ↗</a>}<div style={{ whiteSpace: 'pre-wrap' }}>{e.lines}</div></div>)}</>}
          <h4>The top {top.length} videos</h4>
          <div className="grid-wrap"><table><thead><tr><th>Creator</th><th className="num">GMV</th><th className="num">Units</th><th className="num">Views</th><th className="num">Per view</th><th>Hook</th><th>Posted</th><th /></tr></thead><tbody>
            {top.map((v) => <tr key={v.video_id}><td>@{v.handle}</td><td className="num">{n(v.gmv)}</td><td className="num">{v.units}</td><td className="num">{n(v.views)}</td><td className="num">{v.gmv_per_view !== null ? v.gmv_per_view.toFixed(3) : '–'}{v.rank_eff && v.rank_eff <= 5 ? ' ★' : ''}</td><td className="sub" style={{ maxWidth: 360 }}>{v.hooks[0]?.hook ?? v.overview?.slice(0, 120) ?? v.title?.slice(0, 100) ?? ''}</td><td className="sub">{v.post_time ?? ''}</td><td>{v.link && <a href={v.link} target="_blank" rel="noopener" className="small">↗</a>}</td></tr>)}
          </tbody></table></div>
        </>
      ))}

      {tab === 'voice' && (
        <>
          {shop.voice ? (
            <div className="card" style={{ marginBottom: 10 }}>
              <b>The voice, learnt from the shop's own messages</b>
              <p style={{ margin: '6px 0' }}>{shop.voice.summary}</p>
              <p className="sub">{[shop.voice.greeting && `Opens: ${shop.voice.greeting}`, shop.voice.signoff && `Closes: ${shop.voice.signoff}`, shop.voice.register && `Register: ${shop.voice.register}`, shop.voice.emoji && `Emoji: ${shop.voice.emoji}`, shop.voice.length && `Length: ${shop.voice.length}`].filter(Boolean).join(' · ')}</p>
              {shop.voice.phrases.length > 0 && <p className="sub">Phrases: {shop.voice.phrases.map((x) => `"${x}"`).join(' · ')}</p>}
              {shop.voice.avoid.length > 0 && <p className="sub">Never: {shop.voice.avoid.join(' · ')}</p>}
            </div>
          ) : <p className="sub">No voice learnt yet. Learn now reads the messages the shop already runs in Cruva and describes how they are written; every draft for this shop is then rewritten in that voice.</p>}
          <b>Messages already running in Cruva</b>
          {d.existing.length === 0 ? <p className="sub">None read yet. Press Check now on the account, then Learn now.</p> : d.existing.sort((a, b) => Number(b.gmv ?? 0) - Number(a.gmv ?? 0) || Number(b.sent ?? 0) - Number(a.sent ?? 0)).map((e) => (
            <details key={e.remote_id} style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer' }}><b>{e.name}</b> <span className="sub">{e.enabled ? 'running' : 'stopped'}{e.sent ? ` · sent ${n(Number(e.sent))}` : ''}{e.replies ? ` · ${e.replies} replies` : ''}{e.gmv ? ` · ${n(Number(e.gmv))} GMV` : ''}</span></summary>
              <div className="bubble" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{e.copy}</div>
            </details>
          ))}
        </>
      )}

      {tab === 'competitors' && <Competitors shopId={shopId} isAdmin={isAdmin} onChanged={() => { load(); onChanged(); }} />}

      {tab === 'history' && (
        <table><thead><tr><th>Learnt</th><th>Window</th><th className="num">Videos</th><th className="num">Top</th><th className="num">Top GMV</th><th>Best hook</th><th>Top creator</th><th>Offer</th></tr></thead><tbody>
          {d.profiles.map((h) => <tr key={h.learned_at}><td>{fmtRelative(h.learned_at)}</td><td className="sub">{h.window_from} → {h.window_to}</td><td className="num">{h.videos}</td><td className="num">{h.top_count}</td><td className="num">{n(h.top_gmv)}</td><td className="sub">{h.hooks[0] ? `${h.hooks[0].group}: "${h.hooks[0].example.slice(0, 60)}"` : '–'}</td><td className="sub">{h.top_creators[0] ? `@${h.top_creators[0].handle}` : '–'}</td><td className="sub">{h.offer ?? '–'}</td></tr>)}
        </tbody></table>
      )}
    </>
  );
}

/**
 * The shop's direct competitors (Claude proposes, the marketplace index verifies, the team confirms) and the
 * weekly market read: trends, hooks, formats, winning products, gaps, ideas, the creators selling for
 * competitors but not for us, and the top competitor videos with links.
 */
function Competitors({ shopId, isAdmin, onChanged }: { shopId: string; isAdmin: boolean; onChanged: () => void }) {
  const [d, setD] = useState<PlaybookCompetitorsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const load = useCallback(() => api.playbookCompetitors(shopId).then(setD).catch((e) => setError((e as Error).message)), [shopId]);
  useEffect(() => { load(); }, [load]);
  const run = async <T extends PlaybookCompetitorsData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => { setBusy(key); setError(null); setNotice(null); try { const r = await fn(); setD(r); after?.(r); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  if (!d) return <p className="sub">{error ?? 'Loading…'}</p>;
  const m: PlaybookMarketProfile | null = d.market;
  const live = d.competitors.filter((c) => c.status !== 'rejected');
  const confirmed = live.filter((c) => c.status === 'confirmed');
  const chip = (c: PlaybookCompetitor) => <span className={`chip ${c.status === 'confirmed' ? 'good' : c.status === 'rejected' ? 'muted' : 'warn'}`}>{c.status === 'confirmed' ? 'confirmed' : c.status === 'rejected' ? 'not a competitor' : 'suggested'}</span>;
  return (
    <>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      <div className="actions" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <span className="sub">{m ? `Market read ${fmtRelative(m.learned_at)} · ${m.window_from} to ${m.window_to} · ${m.competitors.map((c) => `${c.name} (${c.videos_read} videos, ${c.creators_read} creators)`).join(', ')}` : 'No market read yet'}</span>
        <span style={{ flex: 1 }} />
        {isAdmin && <button className="small" disabled={busy !== null} onClick={() => run('suggest', () => api.playbookSuggestCompetitors(shopId), (r) => setNotice(`${r.added.length} brand${r.added.length === 1 ? '' : 's'} added${r.unmatched.length ? ` · not in the marketplace index: ${r.unmatched.join(', ')}` : ''}`))}>{busy === 'suggest' ? 'Asking…' : 'Suggest competitors'}</button>}
        {isAdmin && <button className="primary small" disabled={busy !== null || !live.length} onClick={() => run('scan', () => api.playbookScanMarket(shopId))}>{busy === 'scan' ? 'Scanning…' : 'Scan now'}</button>}
      </div>
      <p className="sub" style={{ marginTop: 0 }}>Direct competitors only: the same product sold to the same buyer in this market, or a very similar brand. Claude proposes, the marketplace index verifies, you confirm. The scan reads the confirmed ones{confirmed.length ? '' : ' (until one is confirmed, the suggested ones)'} every Monday with the learning: their top videos by GMV, the creators selling for them, the best scripts.</p>
      <table><thead><tr><th>Brand</th><th className="num">GMV 30d</th><th className="num">Creators</th><th className="num">Videos</th><th>Why</th><th>Status</th>{isAdmin && <th />}</tr></thead><tbody>
        {d.competitors.map((c) => <tr key={c.id} style={c.status === 'rejected' ? { opacity: 0.55 } : undefined}>
          <td><b>{c.name}</b>{c.category ? <span className="sub"> · {c.category}</span> : null}{c.scanned_at ? <div className="sub">scanned {fmtRelative(c.scanned_at)}</div> : null}</td>
          <td className="num">{c.gmv !== null ? n(c.gmv) : '–'}</td><td className="num">{c.creators ?? '–'}</td><td className="num">{c.videos ?? '–'}</td>
          <td className="sub" style={{ maxWidth: 360 }}>{c.reason ?? ''}</td>
          <td>{chip(c)}</td>
          {isAdmin && <td style={{ whiteSpace: 'nowrap' }}>
            {c.status !== 'confirmed' && <button className="small" disabled={busy !== null} onClick={() => run('st', () => api.playbookCompetitorStatus(shopId, c.id, 'confirmed'))}>Confirm</button>}
            {c.status !== 'rejected' && <button className="small" disabled={busy !== null} onClick={() => run('st', () => api.playbookCompetitorStatus(shopId, c.id, 'rejected'))}>Not a competitor</button>}
            <button className="small" disabled={busy !== null} onClick={() => run('rm', () => api.playbookRemoveCompetitor(shopId, c.id))}>Remove</button>
          </td>}
        </tr>)}
        {d.competitors.length === 0 && <tr><td colSpan={7} className="sub">None yet. Press Suggest competitors, or add one by name.</td></tr>}
      </tbody></table>
      {isAdmin && <form className="actions" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (name.trim()) run('add', () => api.playbookAddCompetitor(shopId, name.trim()), () => setName('')); }}>
        <input placeholder="Add a brand by its TikTok Shop name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 320 }} />
        <button className="small" disabled={busy !== null || !name.trim()}>{busy === 'add' ? 'Looking up…' : 'Add'}</button>
      </form>}

      {m && (
        <>
          <h4>What is selling for them</h4>
          <p style={{ marginTop: 0 }}>{m.summary}</p>
          <div className="two-col">
            <div>
              {m.trends.length > 0 && <><h4>Trends</h4><ul>{m.trends.map((t, i) => <li key={i}><b>{t.name}</b>: {t.detail} <span className="sub">· {t.brands.join(', ')} · {t.video_ids.length} video{t.video_ids.length === 1 ? '' : 's'}</span></li>)}</ul></>}
              {m.hooks.length > 0 && <><h4>Hooks that work for them</h4><ul>{m.hooks.map((h, i) => <li key={i}><b>{h.group}</b>: "{h.example}" <span className="sub">{h.brand ? `· ${h.brand} ` : ''}· {h.video_ids.length} video{h.video_ids.length === 1 ? '' : 's'}</span></li>)}</ul></>}
              {m.formats.length > 0 && <><h4>Formats</h4><p className="sub">{m.formats.map((f) => `${f.name} (${f.video_ids.length})`).join(' · ')}</p></>}
            </div>
            <div>
              {m.products.length > 0 && <><h4>Products that carry for them</h4><ul>{m.products.map((p, i) => <li key={i}><b>{p.name}</b>{p.brand ? <span className="sub"> · {p.brand}</span> : null} <span className="sub">· {n(p.gmv)} GMV in the videos read</span><div className="sub">{p.angle}</div></li>)}</ul></>}
              {m.gaps.length > 0 && <><h4>What they do that we do not</h4><ul>{m.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul></>}
              {m.ideas.length > 0 && <><h4>Ideas for the brief</h4><ul>{m.ideas.map((g, i) => <li key={i}>{g}</li>)}</ul></>}
            </div>
          </div>
          {m.creators_to_approach.length > 0 && <><h4>Creators selling for them, not for us</h4>
            <div className="grid-wrap"><table><thead><tr><th>Creator</th><th>Sells for</th><th className="num">GMV with them</th><th className="num">Platform GMV 30d</th><th className="num">Followers</th><th>Why</th></tr></thead><tbody>
              {m.creators_to_approach.map((c) => <tr key={c.handle}><td><a href={`https://www.tiktok.com/@${c.handle}`} target="_blank" rel="noopener">@{c.handle}</a></td><td>{c.brand}</td><td className="num">{n(c.brand_gmv)}</td><td className="num">{n(c.platform_gmv_30d)}</td><td className="num">{n(c.followers)}</td><td className="sub">{c.why}</td></tr>)}
            </tbody></table></div></>}
          <h4>Their top {m.videos.length} videos</h4>
          <div className="grid-wrap"><table><thead><tr><th>Brand</th><th>Creator</th><th className="num">GMV</th><th className="num">Views</th><th>Product</th><th>Script</th><th>Posted</th><th /></tr></thead><tbody>
            {m.videos.map((v) => <tr key={v.video_id}><td>{v.brand_name}</td><td>@{v.handle}</td><td className="num">{n(v.gmv)}</td><td className="num">{n(v.views)}</td><td className="sub" style={{ maxWidth: 260 }}>{v.product?.slice(0, 90) ?? ''}</td><td className="sub" style={{ maxWidth: 320 }} title={v.script ?? undefined}>{(v.hook ?? v.script ?? v.overview ?? '').slice(0, 140)}</td><td className="sub">{v.posted ?? ''}</td><td>{v.link && <a href={v.link} target="_blank" rel="noopener" className="small">↗</a>}</td></tr>)}
          </tbody></table></div>
        </>
      )}
    </>
  );
}
