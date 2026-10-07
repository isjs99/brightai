import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { PlaybookCellStatus, PlaybookData, PlaybookDraft, PlaybookDraftStatus, PlaybookItem, PlaybookKind, PlaybookRollout, PlaybookSetupCell, PlaybookShop } from '../../../sweep/types';
import { api, fmtRelative, useActor, useLiveUpdates } from '../api';
import CruvaWalk from './CruvaWalk';
import CruvaProfile from './CruvaProfile';
import { useIsAdmin } from '../session';
import { useAccountScope, useAllowedAccounts, useInScope } from '../hubs';
import { GroupsHead, useOpenGroups, type GroupLight } from '../groups';

/** The matrix reads left to right the way the rollout happens: groups, the bots on them, outreach, content, email, flows, hygiene. */
const CATEGORIES = ['Groups', 'CRM bots', 'Outreach', 'Content', 'Email', 'Flows', 'Hygiene'] as const;
type Category = (typeof CATEGORIES)[number];
const COLUMN_META: Record<string, { cat: Category; short: string; order: number }> = {
  'group:sample_sent': { cat: 'Groups', short: 'Ship’d', order: 1 }, 'group:content_pending': { cat: 'Groups', short: 'Pend.', order: 2 }, 'group:first_sale': { cat: 'Groups', short: '1st sale', order: 3 }, 'group:content_not_posted': { cat: 'Groups', short: 'Unful. 7d', order: 4 }, 'group:no_post_10d': { cat: 'Groups', short: 'No post 10d', order: 5 }, 'group:rejected': { cat: 'Groups', short: 'Reject.', order: 6 }, 'group:posted_no_gmv': { cat: 'Groups', short: 'No GMV', order: 7 }, 'group:top_creators': { cat: 'Groups', short: 'Top', order: 8 }, 'group:inactive_creators': { cat: 'Groups', short: 'Inact.', order: 9 }, 'group:existing_creators': { cat: 'Groups', short: 'Exist.', order: 10 },
  'automation:sample_sent': { cat: 'CRM bots', short: 'Ship’d', order: 1 }, 'automation:delivered': { cat: 'CRM bots', short: 'Deliv.', order: 2 }, 'automation:first_sale': { cat: 'CRM bots', short: '1st sale', order: 3 }, 'automation:content_not_posted': { cat: 'CRM bots', short: 'Unful. 7d', order: 4 }, 'automation:no_post_10d': { cat: 'CRM bots', short: 'No post 10d', order: 5 }, 'automation:rejected': { cat: 'CRM bots', short: 'Reject.', order: 6 }, 'automation:push_more_videos': { cat: 'CRM bots', short: 'More vid.', order: 7 }, 'automation:retarget_bonus': { cat: 'CRM bots', short: 'Bonus', order: 8 }, 'automation:deals_info_existing': { cat: 'CRM bots', short: 'Deals', order: 9 },
  'automation:first_outreach': { cat: 'Outreach', short: 'First', order: 1 }, 'automation:monthly_deals_outreach': { cat: 'Outreach', short: 'Deals', order: 2 }, 'automation:new_product_outreach': { cat: 'Outreach', short: 'New prod.', order: 3 }, 'automation:top_creators_collab': { cat: 'Outreach', short: 'Collab', order: 4 },
  'brief:creator_brief': { cat: 'Content', short: 'Brief', order: 1 }, 'list:ai_search_list': { cat: 'Content', short: 'AI list', order: 2 },
  'sender:sender_email': { cat: 'Email', short: 'Sender', order: 1 }, 'email_campaign:creator_newsletter': { cat: 'Email', short: 'News', order: 2 },
  'workflow:sample_chase': { cat: 'Flows', short: 'Chase', order: 1 }, 'workflow:welcome_new': { cat: 'Flows', short: 'Welc.', order: 2 },
  'manual:auto_review': { cat: 'Hygiene', short: 'Review', order: 1 }, 'manual:blacklist': { cat: 'Hygiene', short: 'Blackl.', order: 2 }, 'automation:ai_auto_replies': { cat: 'Hygiene', short: 'AI reply', order: 3 }, 'tag:do_not_contact': { cat: 'Hygiene', short: 'DNC', order: 4 }, 'tag:vip': { cat: 'Hygiene', short: 'VIP', order: 5 },
};
const KIND_CAT: Record<PlaybookKind, Category> = { group: 'Groups', automation: 'Outreach', workflow: 'Flows', email_campaign: 'Email', list: 'Content', brief: 'Content', sender: 'Email', tag: 'Hygiene', manual: 'Hygiene' };
const metaOf = (c: { kind: PlaybookKind; key: string; name: string }) => COLUMN_META[`${c.kind}:${c.key}`] ?? { cat: KIND_CAT[c.kind], short: shortName(c.name), order: 99 };
const shortName = (name: string) => name.replace(/\s*\(.*\)$/, '').replace(/^Target collab: /, 'Collab: ').replace(/ creators?/i, '').slice(0, 12);
const LANG: Record<string, string> = { '*': 'Any', en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' };
const STATE: Record<PlaybookCellStatus, { glyph: string; label: string }> = { set: { glyph: '✓', label: 'set' }, paused: { glyph: '⏸', label: 'exists, paused' }, drift: { glyph: '≠', label: 'differs from the library' }, missing: { glyph: '✕', label: 'missing' }, manual: { glyph: '–', label: 'Cruva UI only' }, unknown: { glyph: '?', label: 'not checked' }, queued: { glyph: '…', label: 'in a rollout' }, error: { glyph: '!', label: 'error' } };
const DRAFT_BADGE: Record<PlaybookDraftStatus, { cls: string; label: string }> = { ready: { cls: 'good', label: 'ready' }, needs_input: { cls: 'warn', label: 'needs input' }, blocked: { cls: 'crit', label: 'blocked' }, approved: { cls: 'good', label: 'approved' }, skipped: { cls: 'muted', label: 'skipped' }, done: { cls: 'good', label: 'done' }, error: { cls: 'crit', label: 'error' }, undone: { cls: 'muted', label: 'undone' } };
const ACTION_LABEL: Record<PlaybookDraft['action'], string> = { create: 'create', update: 'update copy', start: 'start' };
const KIND_ORDER: PlaybookKind[] = ['group', 'automation', 'list', 'brief', 'email_campaign', 'workflow', 'sender', 'tag', 'manual'];
const KIND_ONE: Record<PlaybookKind, string> = { group: 'Group', automation: 'Bot', workflow: 'Workflow', email_campaign: 'Email', list: 'List', brief: 'Brief', sender: 'Sender', tag: 'Tag', manual: 'Hygiene' };

function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><button className="small" onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>
  );
}

type Column = { kind: PlaybookKind; key: string; name: string; description: string | null; core: boolean; manual: boolean };

/** Accounts › Cruva: what the best-practice Cruva setup looks like on every shop, and the rollout of what is missing. */
export default function CruvaPage() {
  const [params, setParams] = useSearchParams();
  const scope = useAccountScope();
  const inScope = useInScope();
  const allowed = useAllowedAccounts();
  const [data, setData] = useState<PlaybookData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'library' | 'rollouts' | 'link' | null>(null);
  const [profileOf, setProfileOf] = useState<PlaybookShop | null>(null);
  const [cellOpen, setCellOpen] = useState<{ shop: PlaybookShop; col: Column; cell: PlaybookSetupCell | null } | null>(null);
  const [view, setView] = useState<'cards' | 'grid'>(() => { try { return localStorage.getItem('cruva_view') === 'grid' ? 'grid' : 'cards'; } catch { return 'cards'; } });
  useEffect(() => { try { localStorage.setItem('cruva_view', view); } catch { /* private window */ } }, [view]);
  const [filter, setFilter] = useState<'all' | 'mine' | 'missing' | 'paused' | 'unchecked'>('all');
  const [search, setSearch] = useState('');
  const actor = useActor();
  const isAdmin = useIsAdmin();
  const groups = useOpenGroups('cruva');
  const rolloutId = params.get('rollout') ? Number(params.get('rollout')) : null;
  const load = useCallback(() => api.playbook().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'playbook') load(); });
  const run = async <T,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { const r = await fn(); if (r && typeof r === 'object' && 'items' in (r as object)) setData(r as unknown as PlaybookData); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const columns = useMemo<Column[]>(() => {
    if (!data) return [];
    const seen = new Map<string, Column>();
    for (const i of data.items.filter((x) => x.enabled && !x.language.startsWith('shop:'))) {
      const k = `${i.kind}:${i.key}`;
      if (!seen.has(k)) seen.set(k, { kind: i.kind, key: i.key, name: i.name.replace(/\[month\]\s*/g, ''), description: i.description, core: Boolean(i.config.core), manual: Boolean(i.config.manual) || i.kind === 'manual' });
    }
    return [...seen.values()].sort((a, b) => { const ma = metaOf(a); const mb = metaOf(b); return CATEGORIES.indexOf(ma.cat) - CATEGORIES.indexOf(mb.cat) || ma.order - mb.order || a.name.localeCompare(b.name); });
  }, [data]);
  if (!data) return <p>{error ?? 'Loading…'}</p>;

  const shops = data.shops.filter((s) => inScope(s.account_id)).sort((a, b) => a.account_name.localeCompare(b.account_name) || a.shop_name.localeCompare(b.shop_name));
  const cell = (shopId: string, c: Column) => data.cells.find((x) => x.shop_id === shopId && x.kind === c.kind && x.playbook_key === c.key) ?? null;
  const coverage = (shopId: string) => { const cells = columns.map((c) => cell(shopId, c)); const known = cells.filter((c) => c && c.status !== 'unknown' && c.status !== 'manual'); return { set: known.filter((c) => c!.status === 'set' || c!.status === 'drift').length, total: known.length, missing: cells.filter((c) => c?.status === 'missing' || c?.status === 'error').length, paused: cells.filter((c) => c?.status === 'paused').length, drift: cells.filter((c) => c?.status === 'drift').length, checked: known.length > 0 }; };
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const ticked = shops.filter((s) => sel.has(s.shop_id));
  const totals = ticked.reduce((t, s) => { const c = coverage(s.shop_id); return { missing: t.missing + c.missing, paused: t.paused + c.paused, drift: t.drift + c.drift }; }, { missing: 0, paused: 0, drift: 0 });
  const colGroups = CATEGORIES.map((cat) => ({ cat, cols: columns.filter((c) => metaOf(c).cat === cat) })).filter((g) => g.cols.length);
  const firstCols = new Set(colGroups.map((g) => `${g.cols[0].kind}:${g.cols[0].key}`));
  const accountBlocks = (() => {
    const by = new Map<number, typeof shops>();
    for (const s of shops) by.set(s.account_id, [...(by.get(s.account_id) ?? []), s]);
    const order = ['red', 'amber', 'green', 'grey'];
    return [...by.entries()].map(([account_id, list]) => {
      const covs = list.map((s) => coverage(s.shop_id));
      const checked = covs.some((c) => c.checked);
      const set = covs.reduce((n, c) => n + c.set, 0); const total = covs.reduce((n, c) => n + c.total, 0);
      const missing = covs.reduce((n, c) => n + c.missing, 0); const paused = covs.reduce((n, c) => n + c.paused, 0); const drift = covs.reduce((n, c) => n + c.drift, 0);
      const errors = list.filter((s) => s.error).length;
      const light: GroupLight = !checked ? 'grey' : total && set / total >= 1 && !errors ? 'green' : total && set / total >= 0.5 ? 'amber' : 'red';
      return { account_id, account_name: list[0].account_name, am_name: list[0].am_name, shops: list, checked, set, total, missing, paused, drift, errors, light };
    }).sort((a, b) => order.indexOf(a.light) - order.indexOf(b.light) || a.account_name.localeCompare(b.account_name));
  })();
  const openRollout = (id: number | null, opts: { shop?: string; table?: boolean } = {}) => { const n = new URLSearchParams(params); n.delete('shop'); n.delete('table'); if (id === null) n.delete('rollout'); else { n.set('rollout', String(id)); if (opts.shop) n.set('shop', opts.shop); if (opts.table) n.set('table', '1'); } setParams(n); };

  if (rolloutId !== null) return params.get('table') ? <RolloutView id={rolloutId} data={data} isAdmin={isAdmin} onBack={() => openRollout(null)} onError={setError} /> : <CruvaWalk id={rolloutId} shopId={params.get('shop')} data={data} isAdmin={isAdmin} onBack={() => openRollout(null)} onTable={() => openRollout(rolloutId, { table: true })} onError={setError} />;

  // Cards: core coverage per account (the nine pieces the monitor cares about), what is missing, paused and drifted in words.
  const coreCols = columns.filter((c) => c.core && !c.manual);
  const cards = accountBlocks.map((blk) => {
    const per = (st: PlaybookCellStatus[], cols: Column[]) => { const out = new Map<string, { col: Column; shops: PlaybookShop[] }>(); for (const sh of blk.shops) for (const c of cols) { const st2 = cell(sh.shop_id, c)?.status ?? 'unknown'; if (st.includes(st2)) { const k = `${c.kind}:${c.key}`; const e = out.get(k) ?? { col: c, shops: [] }; e.shops.push(sh); out.set(k, e); } } return [...out.values()]; };
    const coreTotal = coreCols.length * blk.shops.length;
    const coreSet = blk.shops.reduce((n, sh) => n + coreCols.filter((c) => ['set', 'drift'].includes(cell(sh.shop_id, c)?.status ?? '')).length, 0);
    const missingCore = per(['missing', 'error'], coreCols);
    const missingExtra = per(['missing', 'error'], columns.filter((c) => !c.core && !c.manual));
    const paused = per(['paused'], columns);
    const drift = per(['drift'], columns);
    const light: GroupLight = !blk.checked ? 'grey' : coreTotal && coreSet === coreTotal && !blk.errors ? 'green' : coreTotal && coreSet / coreTotal >= 0.6 ? 'amber' : 'red';
    const markets = [...new Set(blk.shops.map((sh) => sh.market).filter((m): m is string => Boolean(m)))];
    const learned = blk.shops.map((sh) => sh.learned).filter((l): l is NonNullable<typeof l> => Boolean(l));
    const drafting = data.rollouts.find((r) => r.status === 'draft' && r.shop_ids.some((sid) => blk.shops.some((sh) => sh.shop_id === sid)));
    return { ...blk, coreSet, coreTotal, missingCore, missingExtra, paused, drift, light, markets, learned, drafting };
  }).filter((c) => {
    if (search && !c.account_name.toLowerCase().includes(search.toLowerCase()) && !(c.am_name ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'mine') return Boolean(actor) && (c.am_name ?? '').toLowerCase().startsWith(actor.toLowerCase().split(' ')[0]);
    if (filter === 'missing') return c.missingCore.length > 0;
    if (filter === 'paused') return c.paused.length > 0;
    if (filter === 'unchecked') return !c.checked;
    return true;
  }).sort((a, b) => (a.checked === b.checked ? 0 : a.checked ? -1 : 1) || (a.coreTotal ? a.coreSet / a.coreTotal : 0) - (b.coreTotal ? b.coreSet / b.coreTotal : 0) || a.account_name.localeCompare(b.account_name));
  const allCore = cards.filter((c) => c.checked && c.coreTotal && c.coreSet === c.coreTotal).length;
  const withPausedCore = cards.filter((c) => c.paused.some((p) => p.col.core)).length;
  const draftsWaiting = data.rollouts.filter((r) => r.status === 'draft').reduce((n, r) => n + (r.counts.ready ?? 0) + (r.counts.needs_input ?? 0) + (r.counts.approved ?? 0), 0);
  const names = (list: { col: Column; shops: PlaybookShop[] }[], blkShops: number) => list.map((e) => `${e.col.name.replace(/^Target collab: /, '')}${blkShops > 1 && e.shops.length < blkShops ? ` (${e.shops.map((sh) => sh.market ?? sh.shop_name).join(', ')})` : ''}`);
  const checkAccount = (blk: (typeof cards)[number]) => run(`chk${blk.account_id}`, async () => { let last: PlaybookData | null = null; const errors: string[] = []; for (const sh of blk.shops) { const r = await api.playbookCheck(sh.shop_id, true); last = r; errors.push(...r.errors); } if (errors.length) setNotice(`Checked ${blk.account_name}: ${errors.join(' | ')}`); return last; });
  const prepareAccount = (blk: (typeof cards)[number]) => run(`prep${blk.account_id}`, () => api.playbookPrepare({ shop_ids: blk.shops.map((sh) => sh.shop_id) }), (r) => openRollout(r.rollout.id, { shop: blk.shops[0].shop_id }));

  return (
    <>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <h1>Cruva</h1>
          <p className="hint" style={{ margin: 0 }}>Best-practice Cruva setup on every shop, checked through the Cruva MCP.</p>
        </div>
        <div className="actions">
          <span className={`badge ${data.mcp_configured ? (data.last_error ? 'warn' : 'good') : 'muted'}`} title={data.last_error ?? ''}>{data.mcp_configured ? `Cruva MCP · ${data.shops.length} shop${data.shops.length === 1 ? '' : 's'}` : 'Cruva MCP not configured'}</span>
          {data.checking ? <span className="badge warn">Checking{data.progress ? ` ${data.progress.done}/${data.progress.total}` : ''}…</span> : data.last_check_at ? <span className="badge muted">Checked {fmtRelative(data.last_check_at)}</span> : null}
          {isAdmin && <button className="small" disabled={busy !== null} onClick={() => run('sync', api.playbookSyncShops, (r) => setNotice(`${r.linked} shop(s) linked to accounts, ${r.unlinked} waiting to be linked.`))}>{busy === 'sync' ? 'Syncing…' : 'Sync shops'}</button>}
          {isAdmin && <button className="primary" disabled={busy !== null || data.checking} onClick={() => run('check', async () => { if (scope === null) return api.playbookCheck(undefined, true); let last: Awaited<ReturnType<typeof api.playbookCheck>> | null = null; const errors: string[] = []; let checked = 0; for (const s of shops) { last = await api.playbookCheck(s.shop_id, true); checked += last.checked; errors.push(...last.errors); } return { ...(last ?? (await api.playbook())), checked, errors, started: false }; }, (r) => setNotice(r.started ? `Checking ${r.checked} shop(s) in the background; rows fill in as each shop comes back.` : `Checked ${r.checked} shop(s)${r.errors.length ? `; ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))}>{busy === 'check' ? 'Checking…' : scope === null ? 'Check all now' : 'Check now'}</button>}
          <div className="menu">
            <button onClick={() => setMenu(!menu)}>More ▾</button>
            {menu && (
              <div className="menu-list" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => { setMenu(false); setDialog('rollouts'); }}>Rollouts ({data.rollouts.length})</button>
                <button onClick={() => { setMenu(false); setDialog('library'); }}>Library ({columns.length} items)</button>
                <button onClick={() => { setMenu(false); setDialog('link'); }}>Link shops{data.unlinked.length ? ` (${data.unlinked.length} waiting)` : ''}</button>
              </div>
            )}
          </div>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data.last_error && !data.checking && <div className="banner warn"><b>Last check:</b> {data.last_error}</div>}
      {!data.mcp_configured && <div className="banner warn"><b>Cruva MCP not configured.</b> Generate an API key under Cruva › Dashboard › API, set it as <code>CRUVA_API_KEY</code> on the server and restart. Until then you can paste a shop's listing by hand from a cell.</div>}
      {data.mcp_configured && data.shops.length === 0 && <div className="banner info">No Cruva shops linked yet. Press <b>Sync shops</b>: every shop whose name matches an account links itself, the rest wait under More › Link shops.</div>}
      {data.unlinked.length > 0 && <div className="banner info">{data.unlinked.length} Cruva shop{data.unlinked.length === 1 ? '' : 's'} not linked to an account yet. <a href="#link" onClick={(e) => { e.preventDefault(); setDialog('link'); }}>Link them</a>.</div>}

      {view === 'cards' && shops.length > 0 && (
        <>
          <div className="kpis" style={{ marginBottom: 10 }}>
            <div className="kpi"><div className="v">{allCore}/{cards.filter((c) => c.checked).length}</div><div className="k">accounts with every core piece live</div></div>
            <div className="kpi"><div className="v">{withPausedCore}</div><div className="k">accounts with a core bot paused</div></div>
            <div className="kpi"><div className="v">{draftsWaiting}</div><div className="k">drafts waiting in rollouts</div></div>
            <div className="kpi"><div className="v">{data.last_check_at ? fmtRelative(data.last_check_at) : '–'}</div><div className="k">last check{data.checking && data.progress ? ` · running ${data.progress.done}/${data.progress.total}` : ''}</div></div>
          </div>
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <div className="presets">
              {([['all', 'All'], ['mine', 'Mine'], ['missing', 'Missing core'], ['paused', 'Paused'], ['unchecked', 'Not checked']] as const).map(([k, l]) => <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{l}</button>)}
            </div>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Account or AM" style={{ width: 180 }} />
            <span className="sub">Worst setup first. Core = the six lifecycle bots, the brief, first outreach and AI replies; the rest counts as extras.</span>
            <span style={{ flex: 1 }} />
            <button className="small" onClick={() => setView('grid')}>Open grid</button>
          </div>
          <div className="cruva-cards">
            {cards.map((c) => (
              <div key={c.account_id} className={`card cruva-card ${c.light}`}>
                <div className="cc-head">
                  <span className={`light ${c.light === 'red' ? 'crit' : c.light === 'amber' ? 'warn' : c.light === 'green' ? 'good' : 'muted'}`} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{c.account_name}</b> <span className="sub">{c.am_name ?? 'no AM'} · {c.shops.length} shop{c.shops.length === 1 ? '' : 's'}{c.markets.length ? ` · ${c.markets.join(' ')}` : ''}</span>
                    {c.checked ? <div className="cc-bar"><div className="pace"><span className={c.light === 'green' ? 'good' : c.light === 'amber' ? 'warn' : 'crit'} style={{ width: `${c.coreTotal ? (c.coreSet / c.coreTotal) * 100 : 0}%` }} /></div><span className="sub">{c.coreSet}/{c.coreTotal} core{c.missingExtra.length ? ` · ${c.missingExtra.length} extra${c.missingExtra.length === 1 ? '' : 's'} missing` : ''}</span></div> : <div className="sub">Not checked yet</div>}
                  </div>
                </div>
                <div className="cc-lines">
                  {c.missingCore.length > 0 && <div><span className="badge crit">missing</span> {c.missingCore.map((e, i) => <a key={e.col.key} href="#cell" onClick={(ev) => { ev.preventDefault(); setCellOpen({ shop: e.shops[0], col: e.col, cell: cell(e.shops[0].shop_id, e.col) }); }}>{names([e], c.shops.length)[0]}{i < c.missingCore.length - 1 ? ', ' : ''}</a>)}</div>}
                  {c.paused.length > 0 && <div><span className="badge warn">paused</span> {c.paused.map((e, i) => <a key={e.col.key} href="#cell" onClick={(ev) => { ev.preventDefault(); setCellOpen({ shop: e.shops[0], col: e.col, cell: cell(e.shops[0].shop_id, e.col) }); }}>{names([e], c.shops.length)[0]}{i < c.paused.length - 1 ? ', ' : ''}</a>)}</div>}
                  {c.drift.length > 0 && <div><span className="badge muted">differs</span> {names(c.drift, c.shops.length).join(', ')}</div>}
                  {c.errors > 0 && <div className="check-err sub">{c.errors} shop{c.errors === 1 ? '' : 's'} failed the last check</div>}
                  {c.checked && !c.missingCore.length && !c.paused.length && !c.drift.length && <div className="sub">Every core piece is live.</div>}
                  {(() => { const sh = c.shops.find((x) => x.profile); const pr = sh?.profile; return pr ? <div className="cc-learned"><span className="badge accent" title={`Learnt ${fmtRelative(pr.learned_at)} from ${pr.videos} videos`}>top {pr.top_count}</span> {pr.hooks[0] ? <>best hook <b>{pr.hooks[0].group}</b>: "{pr.hooks[0].example.slice(0, 70)}"</> : pr.summary.slice(0, 120)}{pr.top_creators[0] ? <span className="sub"> · @{pr.top_creators[0].handle}</span> : null}{pr.products_carry.length ? <span className="sub"> · {pr.products_carry.length} product{pr.products_carry.length === 1 ? '' : 's'} carry</span> : null}{sh?.voice ? <span className="badge muted" style={{ marginLeft: 6 }} title={sh.voice.summary}>voice learnt</span> : null}</div> : null; })()}
                  {c.learned.length > 0 && <div className="sub cc-learned">Known from the shop: {c.learned.some((l) => l.brief_link) ? 'brief link' : 'no brief link'} · {[...new Set(c.learned.flatMap((l) => l.categories))].length} categories · {[...new Set(c.learned.flatMap((l) => l.products))].length} products{c.learned.some((l) => l.sender_emails.length) ? ' · sender email' : ' · no sender email'}</div>}
                </div>
                <div className="actions cc-actions">
                  {isAdmin && (c.drafting ? <button className="small primary" onClick={() => openRollout(c.drafting!.id, { shop: c.shops[0].shop_id })}>Continue rollout #{c.drafting.id}</button> : <button className="small primary" disabled={busy !== null || !c.checked || (!c.missingCore.length && !c.missingExtra.length && !c.paused.length && !c.drift.length)} onClick={() => prepareAccount(c)}>{busy === `prep${c.account_id}` ? 'Preparing…' : 'Prepare rollout'}</button>)}
                  {isAdmin && <button className="small" disabled={busy !== null || data.checking} onClick={() => checkAccount(c)}>{busy === `chk${c.account_id}` ? 'Checking…' : 'Check now'}</button>}
                  <button className="small" onClick={() => setProfileOf(c.shops[0])} title="Top videos, what sells, the shop's voice and its existing messages">{c.shops.some((x) => x.profile || x.voice) ? 'Profile' : 'Learn'}</button>
                  <button className="small" onClick={() => { groups.setAll([c.account_id], true); setView('grid'); }}>Grid</button>
                </div>
              </div>
            ))}
            {cards.length === 0 && <div className="empty">No accounts match.</div>}
          </div>
        </>
      )}

      {view === 'grid' && (<>
      <div className="toolbar" style={{ marginBottom: 6 }}><button className="small" onClick={() => setView('cards')}>◂ Cards</button><span className="sub">The full matrix, every item per shop.</span></div>
      {shops.length > 0 && <GroupsHead items={accountBlocks.length} lights={accountBlocks.map((b) => b.light)} open={accountBlocks.every((b) => groups.isOpen(b.account_id))} onAll={(o) => groups.setAll(accountBlocks.map((b) => b.account_id), o)} />}
      <div className="cruva-legend" style={{ marginBottom: 8 }}>
        <span>Click an account to open its shops, a cell for the detail. Tick shops and press Prepare to draft what is missing.</span>
        <span style={{ flex: 1 }} />
        {(['set', 'paused', 'drift', 'missing', 'manual', 'unknown'] as PlaybookCellStatus[]).map((s) => <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className={`cstate ${s}`}>{STATE[s].glyph}</span>{STATE[s].label}</span>)}
      </div>

      {shops.length === 0 ? <div className="empty">{scope === null ? 'No Cruva shops linked to accounts.' : 'This account has no Cruva shop linked. More › Link shops.'}</div> : (
        <div className="grid-wrap card" style={{ padding: '4px 10px 8px' }}>
          <table className="cruva" aria-label="Cruva setup per shop">
            <thead>
              <tr><th colSpan={5} /> {colGroups.map((g) => <th key={g.cat} className="grp" colSpan={g.cols.length}>{g.cat}</th>)}</tr>
              <tr>
                <th><input type="checkbox" aria-label="All shops" checked={shops.length > 0 && shops.every((s) => sel.has(s.shop_id))} onChange={() => setSel(shops.every((s) => sel.has(s.shop_id)) ? new Set() : new Set(shops.map((s) => s.shop_id)))} /></th>
                <th>Shop</th><th>Lang</th><th>Plan</th><th>Coverage</th>
                {columns.map((c) => <th key={`${c.kind}:${c.key}`} className={`col ${firstCols.has(`${c.kind}:${c.key}`) ? 'first' : ''}`} title={`${KIND_ONE[c.kind]} · ${c.name}${c.core ? ' · core' : ''}\n${c.description ?? ''}`}>{metaOf(c).short}{c.core ? <span title="core" style={{ color: 'var(--accent)' }}>·</span> : null}</th>)}
              </tr>
            </thead>
            <tbody>
              {accountBlocks.map((blk) => [
                <tr key={`acc-${blk.account_id}`} className={`acc-row ${blk.light}`} onClick={() => groups.toggle(blk.account_id)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`All ${blk.account_name} shops`} checked={blk.shops.every((s) => sel.has(s.shop_id))} onChange={() => { const n = new Set(sel); const all = blk.shops.every((s) => n.has(s.shop_id)); for (const s of blk.shops) { if (all) n.delete(s.shop_id); else n.add(s.shop_id); } setSel(n); }} /></td>
                  <td className="shop" colSpan={2}><span className={`light ${blk.light === 'red' ? 'crit' : blk.light === 'amber' ? 'warn' : blk.light === 'green' ? 'good' : 'muted'}`} style={{ marginRight: 8 }} /><b>{blk.account_name}</b> <span className="sub">{blk.am_name ? `${blk.am_name} · ` : ''}{blk.shops.length} shop{blk.shops.length === 1 ? '' : 's'} · {blk.shops.map((s) => s.market ?? '?').join(' ')}</span></td>
                  <td className="sub">{blk.checked ? `${blk.set}/${blk.total}` : 'not checked'}</td>
                  <td>{blk.checked ? <div className="pace" style={{ width: 80 }}><span className={blk.light === 'green' ? 'good' : blk.light === 'amber' ? 'warn' : 'crit'} style={{ width: `${blk.total ? (blk.set / blk.total) * 100 : 0}%` }} /></div> : null}</td>
                  <td colSpan={columns.length} className="sub">{blk.missing ? `${blk.missing} missing` : ''}{blk.paused ? ` · ${blk.paused} paused` : ''}{blk.drift ? ` · ${blk.drift} differ` : ''}{blk.errors ? ` · ${blk.errors} check failed` : ''} <span style={{ float: 'right' }}>{groups.isOpen(blk.account_id) ? '▾' : '▸'}</span></td>
                </tr>,
                ...(groups.isOpen(blk.account_id) ? blk.shops : []).map((s) => {
                const cov = coverage(s.shop_id);
                return (
                  <tr key={s.shop_id}>
                    <td><input type="checkbox" aria-label={s.shop_name} checked={sel.has(s.shop_id)} onChange={() => toggle(s.shop_id)} /></td>
                    <td className="shop"><b>{s.shop_name}</b><div className="sub">{s.account_name}{s.am_name ? ` · ${s.am_name}` : ''}{s.checked_at ? ` · ${fmtRelative(s.checked_at)}` : ''}</div>{s.error && <div className="sub check-err" title={s.error}>Check failed: {s.error.replace(/^Streamable HTTP error: Error POSTing to endpoint: /, '').replace(/^Cruva MCP refused every connection\. /, '')}</div>}</td>
                    <td>{isAdmin ? <select value={s.language} onChange={(e) => run(`l${s.shop_id}`, () => api.playbookShop(s.shop_id, { language: e.target.value }))} style={{ width: 'auto' }}>{['en', 'de', 'fr', 'it', 'es'].map((l) => <option key={l} value={l}>{l}</option>)}</select> : s.language}</td>
                    <td className="sub">{s.plan ? s.plan.charAt(0).toUpperCase() + s.plan.slice(1) : '–'}</td>
                    <td>{cov.checked ? <><b>{cov.set}/{cov.total}</b><div className="pace" style={{ width: 80 }}><span className={cov.set === cov.total ? 'good' : cov.set >= cov.total / 2 ? 'warn' : 'crit'} style={{ width: `${cov.total ? (cov.set / cov.total) * 100 : 0}%` }} /></div></> : <span className="badge muted">not checked</span>}</td>
                    {columns.map((c) => {
                      const st = cell(s.shop_id, c);
                      const k: PlaybookCellStatus = st?.status ?? 'unknown';
                      return <td key={`${c.kind}:${c.key}`} className={`c ${firstCols.has(`${c.kind}:${c.key}`) ? 'first' : ''}`}><button className={`cstate ${k}`} title={`${c.name}: ${STATE[k].label}${st?.remote_name ? ` (${st.remote_name})` : ''}${st?.note ? ` · ${st.note}` : ''}`} onClick={() => setCellOpen({ shop: s, col: c, cell: st })}>{STATE[k].glyph}</button></td>;
                    })}
                  </tr>
                );
              })])}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && (
        <div className="rollout-bar">
          <b>{ticked.length} shop{ticked.length === 1 ? '' : 's'} ticked</b>
          <span className="sub">· {totals.missing} missing · {totals.paused} paused · {totals.drift} differ</span>
          <span style={{ flex: 1 }} />
          <span className="sub">Nothing is sent to Cruva until you review the drafts.</span>
          <button className="primary" disabled={!ticked.length || busy !== null} onClick={() => run('prep', () => api.playbookPrepare({ shop_ids: ticked.map((s) => s.shop_id) }), (r) => { setSel(new Set()); openRollout(r.rollout.id); })}>{busy === 'prep' ? 'Preparing…' : `Prepare rollout${totals.missing + totals.paused + totals.drift ? ` · ${totals.missing + totals.paused + totals.drift} drafts` : ''}`}</button>
        </div>
      )}

      </>)}

      {profileOf && <Modal title={`${profileOf.shop_name}: what sells and how the shop writes`} wide onClose={() => setProfileOf(null)}>
        {(() => { const siblings = data.shops.filter((x) => x.account_id === profileOf.account_id); return siblings.length > 1 ? <div className="presets" style={{ marginBottom: 8 }}>{siblings.map((x) => <button key={x.shop_id} className={x.shop_id === profileOf.shop_id ? 'active' : ''} onClick={() => setProfileOf(x)}>{x.shop_name}</button>)}</div> : null; })()}
        <CruvaProfile key={profileOf.shop_id} shopId={profileOf.shop_id} isAdmin={isAdmin} onChanged={load} />
      </Modal>}
      {cellOpen && <Modal title={`${cellOpen.col.name} · ${cellOpen.shop.shop_name}`} onClose={() => setCellOpen(null)}><CellDetail {...cellOpen} data={data} isAdmin={isAdmin} run={run} onClose={() => setCellOpen(null)} /></Modal>}
      {dialog === 'rollouts' && <Modal title="Rollouts" wide onClose={() => setDialog(null)}>
        {data.rollouts.length === 0 ? <p className="sub">No rollouts yet.</p> : (
          <div className="grid-wrap"><table><thead><tr><th>#</th><th>When</th><th>By</th><th>Shops</th><th>Status</th><th>Drafts</th><th></th></tr></thead><tbody>
            {data.rollouts.map((r) => <tr key={r.id}><td>{r.id}</td><td>{fmtRelative(r.created_at)}</td><td>{r.created_by ?? '–'}</td><td>{r.shop_ids.length}</td><td><span className={`badge ${r.status === 'done' ? 'good' : r.status === 'running' ? 'warn' : 'muted'}`}>{r.status}</span></td><td className="sub">{Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${DRAFT_BADGE[k as PlaybookDraftStatus].label}`).join(' · ')}</td><td><span className="actions"><button className="small" onClick={() => { setDialog(null); openRollout(r.id); }}>Open</button>{isAdmin && r.status !== 'running' && <button className="small danger" onClick={() => { if (window.confirm(`Delete rollout #${r.id}? Nothing in Cruva is touched.`)) run('del', () => api.playbookRolloutDelete(r.id)); }}>Delete</button>}</span></td></tr>)}
          </tbody></table></div>
        )}
      </Modal>}
      {dialog === 'library' && <Modal title="Library" wide onClose={() => setDialog(null)}><Library data={data} isAdmin={isAdmin} run={run} /></Modal>}
      {dialog === 'link' && <Modal title="Link Cruva shops to accounts" onClose={() => setDialog(null)}><LinkShops data={data} isAdmin={isAdmin} run={run} /></Modal>}
    </>
  );
}


function CellDetail({ shop, col, cell, isAdmin, run, onClose }: { shop: PlaybookShop; col: Column; cell: PlaybookSetupCell | null; data: PlaybookData; isAdmin: boolean; run: <T>(k: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; onClose: () => void }) {
  const [paste, setPaste] = useState('');
  const k: PlaybookCellStatus = cell?.status ?? 'unknown';
  return (
    <>
      <p><span className={`cstate ${k}`} style={{ marginRight: 8 }}>{STATE[k].glyph}</span><b>{STATE[k].label}</b>{cell?.remote_name ? <span className="sub"> · in Cruva as "{cell.remote_name}"</span> : null}{cell?.note ? <div className="sub">{cell.note}</div> : null}{cell?.checked_at ? <div className="sub">Checked {fmtRelative(cell.checked_at)}{cell.applied_at ? ` · applied ${fmtRelative(cell.applied_at)}` : ''}</div> : null}</p>
      <p className="sub">{col.description}</p>
      {col.manual && <p className="sub">This lives in the Cruva UI. Once it is done on {shop.shop_name}, tick it here so the matrix reads true.</p>}
      {isAdmin && (
        <div className="actions" style={{ flexWrap: 'wrap' }}>
          <button className="small" onClick={() => run('c', () => api.playbookCheck(shop.shop_id, true), onClose)}>Re-check this shop</button>
          {k !== 'set' && <button className="small" onClick={() => run('m', () => api.playbookCell({ shop_id: shop.shop_id, kind: col.kind, key: col.key, status: 'set' }), onClose)}>Mark set up by hand</button>}
          {k === 'set' && !cell?.remote_id && <button className="small" onClick={() => run('m', () => api.playbookCell({ shop_id: shop.shop_id, kind: col.kind, key: col.key, status: col.manual ? 'manual' : 'missing' }), onClose)}>Unmark</button>}
          {(k === 'missing' || k === 'paused' || k === 'drift' || k === 'error') && !col.manual && <button className="small primary" onClick={() => run('p', () => api.playbookPrepare({ shop_ids: [shop.shop_id], keys: [`${col.kind}:${col.key}`] }), (r) => { window.location.search = `?account=${shop.account_id}&rollout=${r.rollout.id}`; })}>Prepare just this</button>}
        </div>
      )}
      {isAdmin && (
        <details style={{ marginTop: 12 }}>
          <summary className="sub" style={{ cursor: 'pointer' }}>Paste a Cruva MCP listing for this shop instead</summary>
          <textarea rows={6} style={{ width: '100%', fontFamily: 'monospace', marginTop: 6 }} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'Automations (total: 3):\n\n- Sample sent (ID: 699d…) | Status: active | Message: dm | Audience: groups'} />
          <button className="small" disabled={!paste.trim()} onClick={() => run('imp', () => api.playbookImport(shop.shop_id, paste), onClose)}>Import</button>
        </details>
      )}
    </>
  );
}

function LinkShops({ data, isAdmin, run }: { data: PlaybookData; isAdmin: boolean; run: <T>(k: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void> }) {
  const [accounts, setAccounts] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => { api.listAccounts().then((r) => setAccounts(r.accounts.map((x) => x.account).filter((a) => a.enabled).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => setAccounts([])); }, []);
  if (!data.unlinked.length) return <p className="sub">Every Cruva shop is linked. Press Sync shops on the main page to look for new ones.</p>;
  return (
    <div className="grid-wrap"><table><thead><tr><th>Cruva shop</th><th>Plan</th><th>Account</th></tr></thead><tbody>
      {data.unlinked.map((u) => <tr key={u.shop_id}><td><b>{u.shop_name}</b><div className="sub mono">{u.shop_id}</div></td><td>{u.plan ?? '–'}</td><td>{isAdmin ? <select defaultValue="" onChange={(e) => { if (e.target.value) run('link', () => api.playbookLinkShop({ shop_id: u.shop_id, shop_name: u.shop_name, account_id: Number(e.target.value) })); }} style={{ width: 'auto' }}><option value="">pick an account</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select> : '–'}</td></tr>)}
    </tbody></table></div>
  );
}

function Library({ data, isAdmin, run }: { data: PlaybookData; isAdmin: boolean; run: <T>(k: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void> }) {
  const [lang, setLang] = useState('');
  const [edit, setEdit] = useState<(Partial<PlaybookItem> & { configText?: string }) | null>(null);
  const items = data.items.filter((i) => !lang || i.language === lang || i.language === '*').sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.key.localeCompare(b.key) || a.language.localeCompare(b.language));
  return (
    <>
      <div className="toolbar">
        <select value={lang} onChange={(e) => setLang(e.target.value)}><option value="">All languages</option>{data.languages.map((l) => <option key={l} value={l}>{LANG[l] ?? l}</option>)}</select>
        {isAdmin && <button className="small" onClick={() => setEdit({ kind: 'automation', key: '', language: 'en', name: '', description: '', configText: '{\n  "title": "",\n  "message_type": "dm",\n  "outreach_audience": "groups",\n  "group_key": "existing_creators",\n  "dm_messages": [{ "type": "message", "content": "Hi [affiliate_name], …" }],\n  "status": "stopped"\n}' })}>+ New item</button>}
        <span className="sub">[brand], [month], [brief_link] and [tomorrow] are filled in at prepare time; [affiliate_name] is Cruva's placeholder. "core" marks the bots the monitor warns about.</span>
      </div>
      {edit && isAdmin && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="inline-form">
            <label className="field" style={{ minWidth: 130 }}><span className="lbl">Kind</span><select value={edit.kind} disabled={Boolean(edit.id)} onChange={(e) => setEdit({ ...edit, kind: e.target.value as PlaybookKind })}>{KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_ONE[k]}</option>)}</select></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">Key</span><input type="text" value={edit.key ?? ''} disabled={Boolean(edit.id)} onChange={(e) => setEdit({ ...edit, key: e.target.value })} /></label>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Language</span><select value={edit.language ?? '*'} onChange={(e) => setEdit({ ...edit, language: e.target.value })}>{Object.entries(LANG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field" style={{ flex: 1, minWidth: 180 }}><span className="lbl">Name (matched against Cruva names)</span><input type="text" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field" style={{ flex: 1, minWidth: 180 }}><span className="lbl">Description</span><input type="text" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
          </div>
          <label className="field"><span className="lbl">Config (JSON, the create payload)</span><textarea rows={10} style={{ width: '100%', fontFamily: 'monospace' }} value={edit.configText ?? ''} onChange={(e) => setEdit({ ...edit, configText: e.target.value })} /></label>
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => run('item', () => edit.id ? api.playbookItemUpdate(edit.id, { name: edit.name, description: edit.description ?? null, language: edit.language, config: edit.configText }) : api.playbookItemCreate({ kind: edit.kind!, key: edit.key!, language: edit.language ?? '*', name: edit.name!, description: edit.description ?? undefined, config: edit.configText ?? '{}' }), () => setEdit(null))}>Save</button>
            <button onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="grid-wrap"><table><thead><tr><th>On</th><th>Kind</th><th>Name</th><th>Lang</th><th>What it is</th><th /></tr></thead><tbody>
        {items.map((i) => (
          <tr key={i.id} className={i.enabled ? '' : 'dim'}>
            <td>{isAdmin ? <input type="checkbox" checked={i.enabled} onChange={(e) => run(`e${i.id}`, () => api.playbookItemUpdate(i.id, { enabled: e.target.checked }))} /> : i.enabled ? 'on' : 'off'}</td>
            <td><span className="badge muted">{KIND_ONE[i.kind]}</span>{i.config.core ? <span className="badge good" style={{ marginLeft: 4 }}>core</span> : null}</td>
            <td><b>{i.name}</b><div className="sub">{i.key}</div></td>
            <td>{LANG[i.language] ?? i.language}</td>
            <td className="sub" style={{ maxWidth: 420 }}>{i.description}{typeof (i.config as { dm_messages?: { content?: string }[] }).dm_messages?.find((m) => typeof m.content === 'string')?.content === 'string' && <details><summary style={{ cursor: 'pointer' }}>Message</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{(i.config as { dm_messages: { content?: string }[] }).dm_messages.filter((m) => m.content).map((m) => m.content).join('\n---\n')}</pre></details>}</td>
            <td>{isAdmin && <span className="actions"><button className="small" onClick={() => setEdit({ ...i, configText: JSON.stringify(i.config, null, 2) })}>Edit</button><button className="small danger" onClick={() => { if (window.confirm(`Delete "${i.name}" (${i.language}) from the library?`)) run(`d${i.id}`, () => api.playbookItemDelete(i.id)); }}>Delete</button></span>}</td>
          </tr>
        ))}
      </tbody></table></div>
    </>
  );
}

/** Prepare rollout: the drafts per shop on the left, the one being reviewed on the right. */
function RolloutView({ id, data, isAdmin, onBack, onError }: { id: number; data: PlaybookData; isAdmin: boolean; onBack: () => void; onError: (e: string | null) => void }) {
  const [rollout, setRollout] = useState<PlaybookRollout | null>(null);
  const [drafts, setDrafts] = useState<PlaybookDraft[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'needs_input' | 'blocked' | 'approved'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copy, setCopy] = useState('');
  const [payloadText, setPayloadText] = useState('');
  const [showJson, setShowJson] = useState(false);
  const [instruction, setInstruction] = useState('');
  const load = useCallback(() => api.playbookRollout(id).then((r) => { setRollout(r.rollout); setDrafts(r.drafts); }).catch((e) => onError((e as Error).message)), [id, onError]);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'playbook') load(); });
  const sel = drafts.find((d) => d.id === selId) ?? null;
  useEffect(() => { if (!sel && drafts.length) setSelId(drafts.find((d) => d.status === 'needs_input' || d.status === 'ready')?.id ?? drafts[0].id); }, [drafts, sel]);
  useEffect(() => { setCopy(sel?.copy ?? ''); setPayloadText(sel ? JSON.stringify(sel.payload, null, 2) : ''); setInstruction(''); }, [sel?.id, sel?.updated_at]);
  const run = async <T,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => { setBusy(key); onError(null); try { const r = await fn(); after?.(r); await load(); } catch (e) { onError((e as Error).message); } finally { setBusy(null); } };
  if (!rollout) return <p className="sub">Loading rollout…</p>;
  const byShop = new Map<string, PlaybookDraft[]>();
  for (const d of drafts.filter((d) => filter === 'all' || d.status === filter)) byShop.set(d.shop_name, [...(byShop.get(d.shop_name) ?? []), d]);
  const counts = rollout.counts;
  const next = () => { const i = drafts.findIndex((d) => d.id === selId); const after = drafts.slice(i + 1).find((d) => ['ready', 'needs_input', 'blocked'].includes(d.status)) ?? drafts.find((d) => ['ready', 'needs_input', 'blocked'].includes(d.status)); setSelId(after?.id ?? selId); };
  const save = (extra: Parameters<typeof api.playbookDraftUpdate>[1] = {}) => {
    if (!sel) return Promise.resolve();
    let payload: Record<string, unknown> | undefined;
    if (showJson && payloadText !== JSON.stringify(sel.payload, null, 2)) { try { payload = JSON.parse(payloadText) as Record<string, unknown>; } catch { onError('The payload JSON does not parse.'); return Promise.resolve(); } }
    return run('save', () => api.playbookDraftUpdate(sel.id, { copy: copy !== (sel.copy ?? '') ? copy : undefined, payload, ...extra }));
  };
  const done = rollout.status === 'done' || rollout.status === 'undone';
  const ready = drafts.filter((d) => d.status === 'ready').map((d) => d.id);
  return (
    <>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <div className="actions" style={{ alignItems: 'baseline' }}><a href="#back" onClick={(e) => { e.preventDefault(); onBack(); }}>← Cruva setup</a><h2 style={{ margin: 0 }}>{done ? `Rollout #${rollout.id}` : 'Prepare rollout'}</h2><span className="sub">{rollout.shop_ids.length} shop{rollout.shop_ids.length === 1 ? '' : 's'} · {drafts.length} drafts · {rollout.created_by ?? ''} {fmtRelative(rollout.created_at)}</span></div>
          <p className="hint" style={{ margin: '4px 0 0' }}>Built from the library in each shop's language with brand, products, categories and the brief link filled in from what the shop already has. Nothing reaches Cruva until you roll out.</p>
        </div>
        <div className="actions">
          {counts.approved ? <span className="badge good">{counts.approved} approved</span> : null}
          {counts.ready ? <span className="badge muted">{counts.ready} ready</span> : null}
          {counts.needs_input ? <span className="badge warn">{counts.needs_input} need input</span> : null}
          {counts.blocked ? <span className="badge crit">{counts.blocked} blocked</span> : null}
          {counts.done ? <span className="badge good">{counts.done} done</span> : null}
          {counts.error ? <span className="badge crit">{counts.error} failed</span> : null}
          {isAdmin && !done && ready.length > 0 && <button className="small" disabled={busy !== null} onClick={() => run('bulk', () => api.playbookDraftsBulk(rollout.id, ready, 'approved'))}>Approve all ready ({ready.length})</button>}
        </div>
      </div>
      {notice && <div className="banner info">{notice}</div>}

      <div className="rollout-grid">
        <div className="draft-list">
          <div style={{ display: 'flex', gap: 6, padding: '4px 6px 8px', alignItems: 'center' }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ width: 'auto' }}><option value="all">All drafts</option><option value="needs_input">Needs input</option><option value="blocked">Blocked</option><option value="approved">Approved</option></select>
          </div>
          {[...byShop.entries()].map(([shop, list]) => (
            <div key={shop}>
              <div className="shop">{shop}<span className="sub" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{list.length}</span></div>
              {list.map((d) => <div key={d.id} className={`draft-row ${d.id === selId ? 'sel' : ''}`} onClick={() => setSelId(d.id)}><span className="n">{KIND_ONE[d.kind]} · {d.name}</span><span className={`badge ${DRAFT_BADGE[d.status].cls}`}>{d.action !== 'create' && d.status !== 'done' ? `${ACTION_LABEL[d.action]} · ` : ''}{DRAFT_BADGE[d.status].label}</span></div>)}
            </div>
          ))}
          {drafts.length === 0 && <p className="sub" style={{ padding: 10 }}>Nothing to draft: everything the library knows is already in place on these shops.</p>}
        </div>

        {sel ? (
          <div className="draft-pane">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div><div className="lbl">{sel.shop_name} · {KIND_ONE[sel.kind]} · {ACTION_LABEL[sel.action]}</div><input type="text" value={sel.name} onChange={(e) => setDrafts(drafts.map((d) => (d.id === sel.id ? { ...d, name: e.target.value } : d)))} onBlur={(e) => { if (e.target.value !== sel.name) run('name', () => api.playbookDraftUpdate(sel.id, { name: e.target.value })); }} style={{ fontSize: 17, fontWeight: 800, width: 'min(520px, 100%)' }} disabled={!isAdmin || done} /></div>
              <span style={{ flex: 1 }} />
              <span className={`badge ${DRAFT_BADGE[sel.status].cls}`}>{DRAFT_BADGE[sel.status].label}</span>
              {sel.remote_name && <span className="badge muted" title={sel.remote_id ?? ''}>in Cruva: {sel.remote_name}</span>}
              <span className="badge muted">{LANG[sel.language] ?? sel.language}</span>
            </div>
            {sel.description && <div className="sub">{sel.description}</div>}
            {sel.blockers.length > 0 && <ul className="flaglist">{sel.blockers.map((b, i) => <li key={i} className={sel.status === 'blocked' ? 'crit' : 'warn'}><span>{b}</span></li>)}</ul>}
            {sel.result && <div className={`banner ${sel.status === 'error' ? 'crit' : 'info'}`} style={{ whiteSpace: 'pre-wrap' }}>{sel.result}</div>}

            <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              <div className="kpi"><span className="k">Tool</span><span className="v" style={{ fontSize: 13 }}><code>{sel.tool}</code></span></div>
              {typeof sel.payload.outreach_audience === 'string' && <div className="kpi"><span className="k">Audience</span><span className="v" style={{ fontSize: 13 }}>{String(sel.payload.outreach_audience)}{sel.payload.group_id ? ` · group ${String(sel.payload.group_id).slice(0, 12)}` : ''}{Array.isArray(sel.payload.list_ids) ? ` · list ${(sel.payload.list_ids as unknown[]).join(', ')}` : ''}</span></div>}
              {sel.payload.time_limits ? <div className="kpi"><span className="k">Sending window</span><span className="v" style={{ fontSize: 13 }}>{String((sel.payload.time_limits as { start?: string }).start ?? '')} – {String((sel.payload.time_limits as { end?: string }).end ?? '')}{sel.payload.daily_limits_timezone ? ` · ${String(sel.payload.daily_limits_timezone)}` : ''}</span></div> : null}
              {sel.payload.outreach_filters ? <div className="kpi"><span className="k">Filters</span><span className="v" style={{ fontSize: 12 }}>{summarise(sel.payload.outreach_filters)}</span></div> : null}
              {sel.payload.filters ? <div className="kpi"><span className="k">Filters</span><span className="v" style={{ fontSize: 12 }}>{summarise(sel.payload.filters)}</span></div> : null}
              {sel.payload.invite_details ? <div className="kpi"><span className="k">Invite</span><span className="v" style={{ fontSize: 12 }}>{String((sel.payload.invite_details as { title?: string }).title ?? '')} · {((sel.payload.invite_details as { products?: unknown[] }).products ?? []).length} product(s)</span></div> : null}
              {Array.isArray(sel.payload.sender_emails) ? <div className="kpi"><span className="k">From</span><span className="v" style={{ fontSize: 12 }}>{(sel.payload.sender_emails as string[]).join(', ') || '–'}</span></div> : null}
            </div>

            {sel.copy !== null && (
              <div className="field">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}><span className="lbl">{sel.kind === 'email_campaign' ? 'Email body' : 'Message'} · {LANG[sel.language] ?? sel.language}</span><span className="sub">[affiliate_name] is Cruva's placeholder</span><span style={{ flex: 1 }} />
                  {isAdmin && !done && <><input type="text" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Optional steer for the rewrite" style={{ width: 220, fontSize: 12 }} /><button className="small" disabled={busy !== null} onClick={() => run('rw', () => api.playbookDraftRewrite(sel.id, instruction || null))}>{busy === 'rw' ? 'Rewriting…' : "Rewrite in the brand's voice"}</button></>}</div>
                <textarea className="copy" value={copy} onChange={(e) => setCopy(e.target.value)} disabled={!isAdmin || done} />
              </div>
            )}
            <details open={showJson} onToggle={(e) => setShowJson((e.target as HTMLDetailsElement).open)}>
              <summary className="sub" style={{ cursor: 'pointer' }}>Exact payload sent to Cruva ({sel.tool})</summary>
              <textarea className="json" value={payloadText} onChange={(e) => setPayloadText(e.target.value)} disabled={!isAdmin || done} />
            </details>

            {isAdmin && !done && (
              <div className="actions" style={{ paddingTop: 8, borderTop: '1px solid var(--border-2)', flexWrap: 'wrap' }}>
                {sel.action !== 'start' && sel.kind === 'automation' && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}><input type="checkbox" checked={sel.start_after} onChange={(e) => run('sa', () => api.playbookDraftUpdate(sel.id, { start_after: e.target.checked }))} /> Start after rollout</label>}
                {sel.action !== 'start' && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}><input type="checkbox" checked={sel.save_override} onChange={(e) => run('so', () => api.playbookDraftUpdate(sel.id, { save_override: e.target.checked }))} /> Keep this copy as {sel.shop_name}'s override</label>}
                <span style={{ flex: 1 }} />
                <button className="small" disabled={busy !== null} onClick={() => save()}>Save</button>
                {sel.status !== 'skipped' ? <button className="small" disabled={busy !== null} onClick={() => run('skip', () => api.playbookDraftUpdate(sel.id, { status: 'skipped' }), next)}>Skip this one</button> : <button className="small" disabled={busy !== null} onClick={() => run('un', () => api.playbookDraftUpdate(sel.id, { status: 'ready' }))}>Unskip</button>}
                {sel.status !== 'approved' ? <button className="small primary" disabled={busy !== null || sel.status === 'blocked'} onClick={() => save({ status: 'approved' }).then(next)}>Approve · next ▸</button> : <button className="small" disabled={busy !== null} onClick={() => run('ua', () => api.playbookDraftUpdate(sel.id, { status: 'ready' }))}>Unapprove</button>}
              </div>
            )}
          </div>
        ) : <div className="empty">Pick a draft on the left.</div>}
      </div>

      {isAdmin && (
        <div className="rollout-bar">
          {done ? <><b>{counts.done} done · {counts.error} failed · {counts.undone} undone</b><span className="sub">· {rollout.status === 'undone' ? 'undone' : `ran ${rollout.ran_at ? fmtRelative(rollout.ran_at) : ''}`}</span></> : <><b>{counts.approved} approved</b><span className="sub">· groups first, then lists, bots, brief, email · everything lands paused unless "Start after rollout" is ticked · outreach bots never auto-start (weekly TikTok cap)</span></>}
          <span style={{ flex: 1 }} />
          <button className="small" onClick={() => navigator.clipboard.writeText(JSON.stringify(drafts.filter((d) => d.status === 'approved' || d.status === 'ready').map((d) => ({ tool: d.tool, args: d.payload })), null, 2)).then(() => setNotice('Pack copied as JSON (tool + args per draft).'))}>Export pack</button>
          {rollout.status === 'done' && counts.done > 0 && <button className="small danger" disabled={busy !== null} onClick={() => { if (window.confirm('Undo this rollout? Created items are deleted in Cruva, started ones stopped.')) run('undo', () => api.playbookUndo(rollout.id), (r) => setNotice(`${r.undone} undone${r.errors.length ? `; ${r.errors.slice(0, 2).join(' · ')}` : ''}.`)); }}>Undo rollout</button>}
          {!done && <button className="primary" disabled={busy !== null || !counts.approved || !data.mcp_configured} title={data.mcp_configured ? '' : 'CRUVA_API_KEY is not set'} onClick={() => { if (window.confirm(`Roll out ${counts.approved} draft(s) to Cruva now?`)) run('run', () => api.playbookRun(rollout.id), (r) => setNotice(`${r.done} done${r.errors.length ? `; ${r.errors.length} failed: ${r.errors.slice(0, 2).join(' · ')}` : ''}.`)); }}>{busy === 'run' ? 'Rolling out…' : `Roll out ${counts.approved} to Cruva`}</button>}
        </div>
      )}
      <p className="sub" style={{ marginTop: 8 }}><Link to="/cruva">Back to the matrix</Link></p>
    </>
  );
}

const summarise = (v: unknown): string => { if (!v || typeof v !== 'object') return String(v ?? ''); return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${Array.isArray(x) ? (x.length ? x.join(', ') : '–') : typeof x === 'object' && x ? JSON.stringify(x) : String(x)}`).join(' · ').slice(0, 160); };
