import { useCallback, useEffect, useState } from 'react';
import type { SampleAccount, SampleRequest, SampleRules, SampleShop, SamplesData } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { useInScope } from '../hubs';
import { AccountGroup, GroupsHead, useOpenGroups } from '../groups';

const n = (x: number) => Math.round(x).toLocaleString();

/**
 * Accounts > Samples: one traffic light per account over its pending sample requests. The rules live in the
 * account's box (the weekly cap comes from Targets unless overridden), the shortlist is what clears them,
 * Accept selected approves in Cruva (ships product), auto-accept lets the scan do it up to a weekly number.
 */
export default function SamplesPage() {
  const [data, setData] = useState<SamplesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const inScope = useInScope();
  const groups = useOpenGroups('samples');
  const load = useCallback(() => api.samples().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'samples') load(); });
  const run = async (key: string, fn: () => Promise<SamplesData>, ok?: (r: SamplesData) => string | null) => { setBusy(key); setError(null); setNotice(null); try { const r = await fn(); setData(r); const msg = ok?.(r); if (msg) setNotice(msg); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const accounts = data.accounts.filter((a) => inScope(a.account_id));
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Samples</h2><p className="hint" style={{ margin: 0 }}>Pending sample requests per account, scanned at 08:30 and 14:30 on working days. Set the numbers in the box; the weekly cap is the account's "samples a week" target unless overridden here. Accepting ships product.</p></div>
        <div className="actions">{isAdmin && <button className="small" disabled={busy !== null || !data.configured} onClick={() => run('all', () => api.samplesScanAll(), (r) => { const x = r as SamplesData & { shops: number; errors: string[] }; return `${x.shops} shop${x.shops === 1 ? '' : 's'} scanned${x.errors.length ? ` · ${x.errors.join(' | ')}` : ''}`; })}>{busy === 'all' || data.scanning ? 'Scanning…' : 'Scan all now'}</button>}</div>
      </div>
      {!data.configured && <div className="banner warn">CRUVA_API_KEY is not set: the queue cannot be read.</div>}
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      <GroupsHead items={accounts.length} lights={accounts.map((a) => a.light)} open={accounts.every((a) => groups.isOpen(a.account_id))} onAll={(o) => groups.setAll(accounts.map((a) => a.account_id), o)} />
      <div className="areas">
        {accounts.map((a) => {
          const pending = a.shops.reduce((x, s) => x + s.pending, 0); const short = a.shops.reduce((x, s) => x + s.shortlist.length, 0); const acc = a.shops.reduce((x, s) => x + s.accepted_week, 0); const cap = a.shops.some((s) => s.cap !== null) ? a.shops.reduce((x, s) => x + (s.cap ?? 0), 0) : null;
          return (
            <AccountGroup key={a.account_id} light={a.light} name={a.name} sub={a.shops.map((s) => s.market ?? '?').join(' ')} summary={a.summary} open={groups.isOpen(a.account_id)} onToggle={() => groups.toggle(a.account_id)}
              nums={<><span className="num"><span className="k">To review</span><span className="v">{pending}</span></span><span className={`num ${short ? 'warn' : ''}`}><span className="k">Shortlist</span><span className="v">{short}</span></span><span className="num"><span className="k">This week</span><span className="v">{acc}{cap !== null ? ` / ${cap}` : ''}</span></span></>}
              right={<>{a.rules.auto_accept && <span className="badge accent" title={`Up to ${a.rules.auto_per_week} a week`}>auto</span>}{short ? <span className="badge warn">{short}</span> : null}</>}>
              <Rules account={a} isAdmin={isAdmin} busy={busy} run={run} />
              {a.shops.map((s) => <ShopBlock key={s.shop_id} shop={s} rules={a.rules} isAdmin={isAdmin} busy={busy} run={run} />)}
            </AccountGroup>
          );
        })}
        {accounts.length === 0 && <p className="sub">No account with a linked Cruva shop in scope.</p>}
      </div>
    </div>
  );
}

function Rules({ account, isAdmin, busy, run }: { account: SampleAccount; isAdmin: boolean; busy: string | null; run: (key: string, fn: () => Promise<SamplesData>, ok?: (r: SamplesData) => string | null) => Promise<void> }) {
  const r = account.rules;
  const save = (patch: Partial<SampleRules>) => run(`rules-${account.account_id}`, () => api.samplesRules(account.account_id, patch));
  const field = (key: keyof SampleRules, label: string, help: string, max?: number) => <label className="field" style={{ width: 130 }}><span className="lbl">{label}</span><input type="number" min={0} max={max} step="any" defaultValue={String(r[key] ?? '')} disabled={!isAdmin} onBlur={(e) => Number(e.target.value) !== r[key] && save({ [key]: Number(e.target.value) })} /><span className="help">{help}</span></label>;
  const capShop = account.shops[0];
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="actions" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {field('min_gmv', 'Min GMV 30d', 'Creator, all brands')}
        {field('min_engagement', 'Min engagement %', 'Blank data = needs a look', 100)}
        {field('min_post_rate', 'Min post rate %', 'Samples they posted for', 100)}
        {field('min_followers', 'Min followers', '')}
        <label className="field" style={{ width: 170 }}><span className="lbl">Relevance</span><select value={r.relevance} disabled={!isAdmin} onChange={(e) => save({ relevance: e.target.value as SampleRules['relevance'] })}><option value="require">Required for the shortlist</option><option value="prefer">Ranks only</option><option value="ignore">Numbers only</option></select><span className="help">Competitor, category, brand risk</span></label>
        <label className="field" style={{ width: 150 }}><span className="lbl">Cap a week</span><input type="number" min={0} placeholder={capShop?.cap_source === 'target' ? `${capShop.cap} from Targets` : 'no target'} defaultValue={r.cap_override ?? ''} disabled={!isAdmin} onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== r.cap_override) save({ cap_override: v }); }} /><span className="help">{r.cap_override !== null ? 'Overrides Targets' : capShop?.cap_source === 'target' ? 'From Targets (source of truth)' : 'Set it in Targets, or here'}</span></label>
        <label className="field check" style={{ alignSelf: 'center' }} title="The scan approves the top of the shortlist itself, up to the number a week, never past the cap"><input type="checkbox" checked={r.auto_accept} disabled={!isAdmin} onChange={(e) => save({ auto_accept: e.target.checked })} /> Auto-accept</label>
        {r.auto_accept && field('auto_per_week', 'Auto a week', 'Top of the shortlist', 500)}
        <span style={{ flex: 1 }} />
        <span className="sub">{busy === `rules-${account.account_id}` ? 'Saving…' : 'Saves as you leave a field · the next scan applies it'}</span>
      </div>
    </div>
  );
}

function ShopBlock({ shop, rules, isAdmin, busy, run }: { shop: SampleShop; rules: SampleRules; isAdmin: boolean; busy: string | null; run: (key: string, fn: () => Promise<SamplesData>, ok?: (r: SamplesData) => string | null) => Promise<void> }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [showSkipped, setShowSkipped] = useState(false);
  const [showAccepted, setShowAccepted] = useState(false);
  const room = shop.cap === null ? null : Math.max(0, shop.cap - shop.accepted_week);
  const all = () => setSel(new Set(shop.shortlist.map((r) => r.apply_id)));
  const toggle = (id: string) => setSel((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const accept = () => { const ids = [...sel].filter((id) => shop.shortlist.some((r) => r.apply_id === id)); if (!ids.length) return; if (!window.confirm(`Approve ${ids.length} sample request${ids.length === 1 ? '' : 's'} on ${shop.shop_name}? Cruva ships the product; there is no undo.`)) return; run(`acc-${shop.shop_id}`, () => api.samplesAccept(shop.shop_id, ids), (r) => { setSel(new Set()); const x = r as SamplesData & { accepted: number }; return `${x.accepted} approved on ${shop.shop_name}`; }); };
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="actions" style={{ flexWrap: 'wrap' }}>
        <b>{shop.shop_name}</b>
        <span className="sub">{shop.scanned_at ? `scanned ${fmtRelative(shop.scanned_at)}` : 'not scanned'} · {shop.pending} to review{shop.oldest_days !== null ? ` · oldest ${shop.oldest_days}d` : ''} · {shop.accepted_week} accepted this week{shop.cap !== null ? ` of ${shop.cap}` : ''}{shop.auto_week ? ` (${shop.auto_week} auto)` : ''}{shop.min_target !== null ? ` · minimum ${shop.min_target}` : ''}</span>
        {shop.error && <span className="badge crit" title={shop.error}>scan failed</span>}
        <span style={{ flex: 1 }} />
        {isAdmin && <button className="small" disabled={busy !== null} onClick={() => run(`scan-${shop.shop_id}`, () => api.samplesScan(shop.shop_id))}>{busy === `scan-${shop.shop_id}` ? 'Scanning…' : 'Scan now'}</button>}
        {isAdmin && shop.shortlist.length > 0 && <><button className="small" onClick={all}>Select all {shop.shortlist.length}</button><button className="primary small" disabled={busy !== null || sel.size === 0} onClick={accept}>{busy === `acc-${shop.shop_id}` ? 'Approving…' : `Accept selected (${sel.size})`}</button></>}
      </div>
      {room !== null && shop.shortlist.length > room && <p className="sub" style={{ margin: '4px 0' }}>{room} more fit under this week's cap; the rest of the shortlist waits for next week unless you raise the cap.</p>}
      {shop.shortlist.length > 0 ? <Table rows={shop.shortlist} sel={sel} onToggle={isAdmin ? toggle : undefined} /> : <p className="sub" style={{ margin: '4px 0' }}>{shop.pending ? 'Nothing clears the rules right now.' : 'Queue empty.'}</p>}
      {shop.review.length > 0 && <details style={{ marginTop: 6 }}><summary style={{ cursor: 'pointer' }}>Needs a look ({shop.review.length})</summary><Table rows={shop.review} sel={sel} onToggle={isAdmin ? toggle : undefined} /></details>}
      {shop.skipped.length > 0 && <details style={{ marginTop: 6 }} open={showSkipped} onToggle={(e) => setShowSkipped((e.target as HTMLDetailsElement).open)}><summary style={{ cursor: 'pointer' }}>Skipped ({shop.skipped.length})</summary>{showSkipped && <Table rows={shop.skipped} sel={sel} />}</details>}
      {shop.accepted.length > 0 && <details style={{ marginTop: 6 }} open={showAccepted} onToggle={(e) => setShowAccepted((e.target as HTMLDetailsElement).open)}><summary style={{ cursor: 'pointer' }}>Accepted here ({shop.accepted.length})</summary>{showAccepted && <Table rows={shop.accepted} sel={sel} decided />}</details>}
      {rules.relevance === 'require' && shop.review.some((r) => r.reasons.includes('not researched yet')) && <p className="sub">Some creators were not researched yet (25 a scan): scan again.</p>}
    </div>
  );
}

function Table({ rows, sel, onToggle, decided }: { rows: SampleRequest[]; sel: Set<string>; onToggle?: (id: string) => void; decided?: boolean }) {
  return (
    <div className="grid-wrap"><table><thead><tr>{onToggle && <th />}<th>Creator</th><th className="num">Followers</th><th className="num">GMV 30d</th><th className="num">Engagement</th><th className="num">Post rate</th><th>Product</th><th>Research</th><th className="num">Score</th><th>{decided ? 'Accepted' : 'Submitted'}</th></tr></thead><tbody>
      {rows.map((r) => (
        <tr key={r.apply_id} className={onToggle ? 'clickable' : ''} onClick={() => onToggle?.(r.apply_id)}>
          {onToggle && <td><input type="checkbox" checked={sel.has(r.apply_id)} onChange={() => onToggle(r.apply_id)} onClick={(e) => e.stopPropagation()} /></td>}
          <td><a href={`https://www.tiktok.com/@${r.handle}`} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>@{r.handle}</a>{r.name ? <span className="sub"> {r.name}</span> : null}{r.videos.length ? <span className="sub"> · {r.videos.length} video{r.videos.length === 1 ? '' : 's'} for us</span> : null}</td>
          <td className="num">{n(r.followers)}</td><td className="num">{n(r.gmv_30d)}</td><td className="num">{r.engagement !== null ? `${r.engagement}%` : '–'}</td><td className="num">{r.post_rate !== null ? `${r.post_rate}%` : '–'}</td>
          <td className="sub" style={{ maxWidth: 220 }} title={r.product ?? ''}>{r.product?.slice(0, 60) ?? ''}{r.variant ? ` · ${r.variant}` : ''}</td>
          <td style={{ maxWidth: 320 }}>
            {r.research?.competitor && <span className="badge accent" title="Sold for a direct competitor in the last 90 days">{r.research.competitor}</span>}
            {r.research?.category_match && !r.research.competitor && <span className="badge muted">{r.research.category_match}</span>}
            {r.research?.risk === 'high' && <span className="badge crit">brand risk</span>}
            {r.research?.risk === 'some' && <span className="badge warn">check</span>}
            <span className="sub"> {r.reasons.join(' · ')}</span>
          </td>
          <td className="num">{r.score}</td>
          <td className="sub">{decided ? `${fmtRelative(r.decided_at)}${r.decided_by ? ` · ${r.decided_by}` : ''}` : r.submitted ?? ''}</td>
        </tr>
      ))}
    </tbody></table></div>
  );
}
