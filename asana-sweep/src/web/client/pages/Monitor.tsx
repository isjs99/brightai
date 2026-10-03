import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AccountCampaign, AccountKpi, AccountOverview, AccountSection, AccountSkuPrice, AccountTarget, HealthAssessment, HealthThresholds, Incident, IncidentsData, MonitorAccountRow, MonitorData, MonitorFlag, MonitorRule, TargetKey, TtsScope, TtsScopeStatus } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { fmtValue, LineChart, PaceBar, StackedBars } from '../charts';

const SOURCE_LABEL: Record<MonitorRule['source'], string> = { tts: 'TikTok API', targets: 'Targets', cruva: 'Cruva', checklist: 'Checklist', dashboard: 'Dashboard', windsor: 'Windsor', ai: 'AI review' };
const SCOPE_LABEL: Record<TtsScope, string> = { analytics: 'Analytics and reporting', order: 'Order management', product: 'Product management', return_refund: 'Return and refund', affiliate_seller: 'Affiliate (seller)', customer_service: 'Customer service', finance: 'Finance', promotion: 'Promotion', seller: 'Seller information', none: 'Dashboard data' };
const RISK: Record<HealthAssessment['risk'], { label: string; cls: string }> = { red: { label: 'Red', cls: 'crit' }, amber: { label: 'Amber', cls: 'warn' }, green: { label: 'Green', cls: 'good' } };
const TARGET_FIELDS: { key: TargetKey; label: string; unit: string; help: string; bool?: boolean }[] = [
  { key: 'samples_per_week', label: 'Samples a week', unit: 'samples', help: 'Target samples approved per week; flagged when behind pro rata' },
  { key: 'gmv_target_month', label: 'GMV target', unit: 'per month', help: 'Monthly GMV target in the shop currency; month to date is checked pro rata' },
  { key: 'gmv_max_weekly_spend', label: 'GMV Max spend ceiling', unit: 'per week', help: 'Flagged when this week\'s spend is over it' },
  { key: 'gmv_max_min_roi', label: 'GMV Max minimum ROI', unit: 'x', help: 'GMV divided by spend for the week must stay above this' },
  { key: 'gmv_max_spend_actual_week', label: 'GMV Max spend this week', unit: 'actual', help: 'Typed in weekly until the TikTok Ads API is connected' },
  { key: 'gmv_max_gmv_actual_week', label: 'GMV Max GMV this week', unit: 'actual', help: 'Typed in weekly until the TikTok Ads API is connected' },
  { key: 'promo_max_discount_pct', label: 'Promo max discount', unit: '%', help: 'A promotion over this is flagged' },
  { key: 'campaign_full_participation', label: 'Full campaign participation', unit: 'yes/no', help: 'Yes: a campaign must be on file for the current period', bool: true },
  { key: 'campaign_max_discount_pct', label: 'Campaign max discount', unit: '%', help: 'A platform campaign over this is flagged' },
];
const sev = (s: MonitorFlag['severity']) => <span className={`badge ${s === 'crit' ? 'crit' : s === 'warn' ? 'warn' : 'muted'}`}>{s === 'crit' ? 'Critical' : s === 'warn' ? 'Warning' : 'Info'}</span>;
const targetOf = (targets: AccountTarget[], accountId: number, key: TargetKey, market = '') => targets.find((t) => t.account_id === accountId && t.key === key && t.market === market)?.value ?? null;
const scopeBadge = (s: TtsScopeStatus | undefined, label: string) => <span className={`badge ${s?.state === 'ok' ? 'good' : s?.state === 'denied' ? 'crit' : s?.state === 'error' ? 'warn' : 'muted'}`} title={s?.message ?? (s?.state === 'ok' ? `Live on ${s.shops_ok} of ${s.shops_total} shop(s)` : 'Not pulled yet')}>{label}: {s?.state === 'ok' ? 'live' : s?.state === 'denied' ? 'needs approval' : s?.state === 'error' ? 'error' : 'not pulled'}</span>;

/** Account management > Account monitor: every account against the TikTok Shop API and its targets, scanned continuously; the first thing an AM opens. */
export default function MonitorPage() {
  const [params, setParams] = useSearchParams();
  const tabs = ['accounts', 'flags', 'targets', 'rules', 'review', 'incidents'] as const;
  type Tab = (typeof tabs)[number];
  const tab: Tab = tabs.find((t) => t === params.get('tab')) ?? 'accounts';
  const selected = params.get('account') ? Number(params.get('account')) : null;
  const setTab = (t: Tab) => { const n = new URLSearchParams(params); if (t === 'accounts') n.delete('tab'); else n.set('tab', t); setParams(n); };
  const select = (id: number | null) => { const n = new URLSearchParams(params); if (id === null) n.delete('account'); else n.set('account', String(id)); n.delete('tab'); setParams(n); };
  const [data, setData] = useState<MonitorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showThresholds, setShowThresholds] = useState(false);
  const isAdmin = useIsAdmin();
  const load = useCallback(() => api.monitor().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'monitor' || e.kind === 'settings') load(); });
  const run = async <T extends MonitorData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key);
    setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const h = data.health;
  const live = data.scopes.filter((s) => s.state === 'ok').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Account monitor</h1>
          <p className="hint" style={{ margin: 0 }}>Every managed account checked continuously against the TikTok Shop API (GMV by channel, traffic, orders and ship-by deadlines, stock, returns, samples, CS, payouts), against the targets set per account (samples a week, GMV, GMV Max, pricing, campaigns) and against what the dashboard knows. Flags clear themselves when the condition goes away. The scan runs every {data.interval_minutes} minutes; operational data is pulled on every scan, analytics and finance hourly.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${h.tts_last_pull_error ? 'warn' : h.tts_last_pull_at ? 'good' : 'muted'}`} title={h.tts_last_pull_error ?? ''}>{h.pulling_tts ? 'Pulling TikTok…' : h.tts_last_pull_at ? `TikTok pull ${fmtRelative(h.tts_last_pull_at)}` : data.tts_configured ? (data.tts_shops ? 'No TikTok pull yet' : 'No shop authorised') : 'TikTok app not configured'}</span>
          <span className={`badge ${live === data.scopes.length ? 'good' : live ? 'warn' : 'muted'}`} title="API scopes live on the app">{live}/{data.scopes.length} scopes live</span>
          <span className={`badge ${data.last_scan_error ? 'crit' : data.last_scan_at ? 'good' : 'muted'}`} title={data.last_scan_error ?? ''}>{data.scanning ? 'Scanning…' : data.last_scan_at ? `Scanned ${fmtRelative(data.last_scan_at)}` : 'Not scanned yet'}</span>
          {isAdmin && <button className="primary" disabled={busy !== null || data.scanning || h.pulling_tts} onClick={() => run('pull', () => api.monitorPull(), (r) => setNotice(`Pulled ${r.shops} shop(s) from TikTok and re-ran the rules${r.errors.length ? `; ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))}>{busy === 'pull' ? 'Pulling…' : 'Pull TikTok now'}</button>}
          {isAdmin && <button disabled={busy !== null || data.scanning} onClick={() => run('scan', api.monitorScan, (r) => setNotice(`Rules re-run: ${r.found} flag(s) found, ${r.opened} new, ${r.resolved} resolved.`))}>{busy === 'scan' ? 'Scanning…' : 'Re-run rules'}</button>}
          {isAdmin && <button disabled={busy !== null || data.scanning || h.pulling} onClick={() => run('daily', api.healthDaily, (r) => setNotice(`Daily pass done: ${r.pulled} shop(s) pulled, ${r.reviewed} account(s) reviewed${r.errors.length ? `; ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))} title="Full pull, scan and AI review">{busy === 'daily' ? 'Running…' : 'Daily pass'}</button>}
          <button onClick={() => setShowThresholds(!showThresholds)}>{showThresholds ? 'Hide thresholds' : 'Thresholds'}</button>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data.last_scan_error && <div className="banner crit">Last scan failed: {data.last_scan_error}</div>}
      {h.tts_last_pull_error && <div className="banner warn">Last TikTok pull: {h.tts_last_pull_error}</div>}
      {showThresholds && <Thresholds isAdmin={isAdmin} initial={h.thresholds} onSaved={() => { load(); setNotice('Thresholds saved. The rules re-run on the next scan (or press Re-run rules).'); }} onError={setError} />}

      <div className="tabs">
        <button className={`tab ${tab === 'accounts' ? 'active' : ''}`} onClick={() => setTab('accounts')}>Accounts <span className="sub">{data.accounts.filter((a) => a.crit).length} red</span></button>
        <button className={`tab ${tab === 'flags' ? 'active' : ''}`} onClick={() => setTab('flags')}>All flags <span className="sub">{data.flags.length}</span></button>
        <button className={`tab ${tab === 'targets' ? 'active' : ''}`} onClick={() => setTab('targets')}>Targets</button>
        <button className={`tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>Rules & API coverage</button>
        <button className={`tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>Daily review <span className="sub">{h.assessments.filter((a) => a.risk !== 'green').length}</span></button>
        <button className={`tab ${tab === 'incidents' ? 'active' : ''}`} onClick={() => setTab('incidents')}>Instant alerts to Slack</button>
      </div>

      {tab === 'accounts' && <Accounts data={data} selected={selected} onSelect={select} isAdmin={isAdmin} onError={setError} onNotice={setNotice} reload={load} />}
      {tab === 'flags' && <Flags data={data} isAdmin={isAdmin} run={run} onSelect={select} />}
      {tab === 'targets' && <Targets data={data} isAdmin={isAdmin} onError={setError} onNotice={setNotice} reload={load} onSelect={select} />}
      {tab === 'rules' && <Rules data={data} isAdmin={isAdmin} run={run} />}
      {tab === 'incidents' && <Incidents isAdmin={isAdmin} onError={setError} onNotice={setNotice} />}
      {tab === 'review' && <DailyReview data={data} isAdmin={isAdmin} busy={busy} onRun={(id) => run(`rev${id ?? 'all'}`, () => api.healthReview(id), (r) => setNotice(`${r.reviewed} account(s) reviewed${r.errors.length ? `; ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))} />}
    </>
  );
}

/** The scope strip: which TikTok API scopes the app holds, so every "no data" on the page has a reason. */
function ScopeStrip({ scopes }: { scopes: TtsScopeStatus[] }) {
  return (
    <div className="scope-chips">
      {scopes.map((s) => <span key={s.scope}>{scopeBadge(s, SCOPE_LABEL[s.scope])}</span>)}
      <span className="badge muted" title="Shop score, violations, missions and campaign enrolment have no API">Shop score: Seller Center only</span>
    </div>
  );
}

const arrow = (value: number | null, previous: number | null, direction: 'higher' | 'lower') => {
  if (value === null || previous === null || previous === 0) return null;
  const ch = ((value - previous) / previous) * 100;
  const good = direction === 'higher' ? ch >= 0 : ch <= 0;
  return <span className={`sub ${Math.abs(ch) < 1 ? '' : good ? 'good-ink' : 'crit-ink'}`} style={{ color: Math.abs(ch) < 1 ? undefined : good ? 'var(--good-ink)' : 'var(--crit-ink)' }}>{ch > 0 ? '▲' : ch < 0 ? '▼' : '•'} {Math.abs(ch).toFixed(0)}%</span>;
};

function Accounts({ data, selected, onSelect, isAdmin, onError, onNotice, reload }: { data: MonitorData; selected: number | null; onSelect: (id: number | null) => void; isAdmin: boolean; onError: (e: string | null) => void; onNotice: (n: string | null) => void; reload: () => void }) {
  const [sort, setSort] = useState<'risk' | 'name' | 'gmv'>('risk');
  const rank = (a: MonitorAccountRow) => a.crit * 100 + a.warn * 10 + a.info + (a.risk === 'red' ? 50 : a.risk === 'amber' ? 20 : 0);
  const rows = [...data.accounts].sort((a, b) => (sort === 'risk' ? rank(b) - rank(a) : sort === 'gmv' ? (b.gmv_7d ?? -1) - (a.gmv_7d ?? -1) : a.name.localeCompare(b.name)) || a.name.localeCompare(b.name));
  const pace = (p: number | null) => (p === null ? <span className="sub">–</span> : <span className={`badge ${p >= 1 ? 'good' : p >= 1 - data.health.thresholds.target_behind_pct / 100 ? 'warn' : 'crit'}`}>{Math.round(p * 100)}%</span>);
  return (
    <>
      <ScopeStrip scopes={data.scopes} />
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{data.accounts.filter((a) => a.crit).length}</span><span className="k">accounts with a critical flag</span></div>
        <div className="stat"><span className="v">{data.accounts.filter((a) => !a.open).length}/{data.accounts.length}</span><span className="k">accounts clean</span></div>
        <div className="stat"><span className="v">{data.accounts.filter((a) => a.shops).length}</span><span className="k">accounts with a TikTok shop connected</span></div>
        <div className="stat"><span className="v">{data.accounts.filter((a) => a.gmv_pace !== null && a.gmv_pace < 1).length}</span><span className="k">behind GMV target</span></div>
        <div className="stat"><span className="v">{data.accounts.filter((a) => a.samples_pace !== null && a.samples_pace < 1).length}</span><span className="k">behind samples target</span></div>
      </div>
      <div className="toolbar">
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="risk">Most at risk first</option><option value="gmv">Highest GMV first</option><option value="name">By name</option></select>
        <span className="sub">Click an account for its numbers against targets, charts and the checklist walk-through.</span>
      </div>
      <div className="grid-wrap"><table><thead><tr><th>Account</th><th>Risk</th><th>Flags</th><th>GMV 7d</th><th>vs target</th><th>Samples</th><th>GMV Max ROI</th><th>Shops</th><th>Last pull</th></tr></thead><tbody>
        {rows.map((a) => (
          <tr key={a.id} className={`clickable ${selected === a.id ? 'active' : ''}`} onClick={() => onSelect(selected === a.id ? null : a.id)} style={selected === a.id ? { outline: '2px solid var(--accent)' } : undefined}>
            <td><b>{a.name}</b><div className="sub">{a.markets ?? ''}{a.am_name ? ` · ${a.am_name}` : ''}</div></td>
            <td>{a.risk ? <span className={`badge ${RISK[a.risk].cls}`}>{RISK[a.risk].label}</span> : <span className="sub">–</span>}</td>
            <td><span className="actions">{a.crit > 0 && <span className="badge crit">{a.crit}</span>}{a.warn > 0 && <span className="badge warn">{a.warn}</span>}{a.info > 0 && <span className="badge muted">{a.info}</span>}{!a.open && <span className="badge good">clean</span>}</span></td>
            <td>{a.gmv_7d === null ? <span className="sub" title="Needs a TikTok shop authorised and the Analytics scope">no data</span> : <><b>{fmtValue(a.gmv_7d, 'money', a.currency)}</b> {arrow(a.gmv_7d, a.gmv_prev_7d, 'higher')}</>}</td>
            <td>{pace(a.gmv_pace)}</td>
            <td>{pace(a.samples_pace)}</td>
            <td>{pace(a.roi_pace)}</td>
            <td>{a.shops ? <span className="badge good">{a.shops}</span> : <span className="badge muted" title="Authorise the shop under Promotions › Connection and link it to this account">none</span>}</td>
            <td className="sub">{a.last_pull_at ? fmtRelative(a.last_pull_at) : '–'}</td>
          </tr>
        ))}
      </tbody></table></div>
      {selected !== null && <AccountDetail key={selected} id={selected} data={data} isAdmin={isAdmin} onError={onError} onNotice={onNotice} reload={reload} onClose={() => onSelect(null)} />}
    </>
  );
}

function kpiValue(k: AccountKpi, currency: string): string {
  if (k.value === null) return '–';
  return fmtValue(k.value, k.unit, currency);
}

function AccountDetail({ id, data, isAdmin, onError, onNotice, reload, onClose }: { id: number; data: MonitorData; isAdmin: boolean; onError: (e: string | null) => void; onNotice: (n: string | null) => void; reload: () => void; onClose: () => void }) {
  const [o, setO] = useState<AccountOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showResolved, setShowResolved] = useState(false);
  const load = useCallback(() => api.monitorAccount(id).then(setO).catch((e) => onError((e as Error).message)), [id, onError]);
  useEffect(() => { load(); }, [load, data.last_scan_at]);
  const run = async (key: string, fn: () => Promise<AccountOverview>, after?: (r: AccountOverview) => void) => {
    setBusy(key); onError(null);
    try { const r = await fn(); setO(r); after?.(r); reload(); } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  if (!o) return <div className="card" style={{ marginTop: 14 }}><p className="sub">Loading {data.accounts.find((a) => a.id === id)?.name ?? 'account'}…</p></div>;
  const cur = o.currency;
  const series28 = o.series.slice(-28);
  const series14 = o.series.slice(-14);
  const stateCls = (s: AccountSection['state']) => (s === 'crit' ? 'crit' : s === 'warn' ? 'warn' : s === 'good' ? 'good' : 'muted');
  const stateLabel = (s: AccountSection['state']) => (s === 'crit' ? 'Critical' : s === 'warn' ? 'Warning' : s === 'good' ? 'Clear' : s === 'nodata' ? 'No data' : 'Manual');
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>{o.account.name} <span className="sub" style={{ fontWeight: 400 }}>{o.account.markets ?? ''}{o.account.am_name ? ` · AM ${o.account.am_name}` : ''}{o.account.aa_name ? ` · AA ${o.account.aa_name}` : ''}</span></h2>
          <div className="actions" style={{ marginTop: 4 }}>
            {o.assessment && <span className={`badge ${RISK[o.assessment.risk].cls}`} title={o.assessment.summary}>{RISK[o.assessment.risk].label} · {o.assessment.assess_date}</span>}
            {o.shops.length ? o.shops.map((sh) => <span key={sh.id} className={`badge ${!sh.token_ok ? 'crit' : sh.pull_error ? 'warn' : sh.last_pull_at ? 'good' : 'muted'}`} title={sh.pull_error ?? (sh.last_pull_at ? `Pulled ${fmtRelative(sh.last_pull_at)}` : 'Not pulled yet')}>{sh.name}{sh.market ? ` · ${sh.market}` : ''}{!sh.token_ok ? ' · re-authorise' : ''}</span>) : <span className="badge muted">No TikTok shop linked: authorise it under <Link to="/promotions">Promotions › Connection</Link></span>}
          </div>
        </div>
        <div className="actions">
          {isAdmin && o.shops.length > 0 && <button className="small" disabled={busy !== null} onClick={async () => { setBusy('pull'); try { const r = await api.monitorPull(o.shops.map((s) => s.id)); onNotice(`Pulled ${r.shops} shop(s)${r.errors.length ? `; ${r.errors.join(' · ')}` : ''}.`); reload(); await load(); } catch (e) { onError((e as Error).message); } finally { setBusy(null); } }}>{busy === 'pull' ? 'Pulling…' : 'Pull this account now'}</button>}
          <Link className="button small" to={`/checklists`}>Checklist</Link>
          <button className="small" onClick={onClose}>Close</button>
        </div>
      </div>
      {o.assessment && <div className={`banner ${o.assessment.risk === 'red' ? 'crit' : o.assessment.risk === 'amber' ? 'warn' : 'good'}`}><b>Daily review:</b> {o.assessment.summary} <b>Today:</b> {o.assessment.action}</div>}

      <div className="kpis">
        {o.kpis.map((k) => (
          <div key={k.key} className="kpi" title={k.note ?? ''}>
            <span className="k">{k.label}</span>
            <span className={`v ${k.value === null ? 'nodata' : ''}`}>{k.value === null ? (k.note ?? 'no data') : kpiValue(k, cur)} {k.value !== null && arrow(k.value, k.previous, k.direction)}</span>
            {k.target !== null && k.value !== null && <span className="t">{k.direction === 'higher' ? 'target' : 'limit'} {fmtValue(k.target, k.unit, cur)} · {k.state === 'good' ? 'on track' : k.state === 'warn' ? 'slightly behind' : 'behind'}</span>}
            {k.target === null && k.value !== null && k.note && <span className="t">{k.note}</span>}
            {k.value !== null && k.target === null && k.previous !== null && <span className="t">vs {fmtValue(k.previous, k.unit, cur)} the week before</span>}
            <PaceBar value={k.value} target={k.target} direction={k.direction} state={k.state} />
          </div>
        ))}
      </div>

      {series28.length ? (
        <div className="charts">
          <LineChart title={`GMV per day (${cur})`} points={series28.map((d) => ({ date: d.date, value: d.gmv }))} kind="money" currency={cur} />
          <StackedBars title="GMV by channel, last 14 days" days={series14.map((d) => ({ date: d.date, values: [d.video_gmv, d.live_gmv, d.card_gmv] }))} series={[{ label: 'Video', color: 'var(--s1)' }, { label: 'LIVE', color: 'var(--s2)' }, { label: 'Product card', color: 'var(--s3)' }]} currency={cur} />
          <LineChart title="Orders per day" points={series28.map((d) => ({ date: d.date, value: d.orders }))} kind="count" />
          <LineChart title="Visitors per day" points={series28.map((d) => ({ date: d.date, value: d.visitors }))} kind="count" />
        </div>
      ) : <div className="empty" style={{ marginBottom: 14 }}>{o.shops.length ? 'No analytics pulled yet for this account. Press "Pull this account now"; the charts need the Analytics and reporting scope, which is live.' : 'Charts appear once a TikTok shop is authorised and linked to this account.'}</div>}

      <h3 style={{ margin: '0 0 8px' }}>Daily checklist, scanned</h3>
      <p className="sub" style={{ marginTop: 0 }}>Every section of the AM daily checklist, what the scan checks for it, and what it found. "No data" names the API scope still to approve; "Manual" is what only Seller Center shows.</p>
      <div className="sections">
        {o.sections.map((s) => (
          <div key={s.section} className="section-row">
            <div className="head" onClick={() => setOpen({ ...open, [s.section]: !open[s.section] })}>
              <span className={`badge ${stateCls(s.state)}`}>{stateLabel(s.state)}</span>
              <b>{s.section}</b>
              <span className="sub">{s.flags.length ? `${s.flags.length} flag(s)` : s.rules.length ? `${s.rules.filter((r) => r.available && r.enabled).length}/${s.rules.length} checks live` : 'no automated check'}</span>
              <span className="sub">{open[s.section] ? '▾' : '▸'}</span>
            </div>
            {open[s.section] && (
              <div style={{ marginTop: 8 }}>
                {s.guidance && <p className="sub" style={{ marginTop: 0 }}><b>AM checks:</b> {s.guidance}</p>}
                {s.flags.length > 0 && <ul className="flaglist">{s.flags.map((f) => <li key={f.id} className={f.severity}>{sev(f.severity)} <span><b>{data.rules.find((r) => r.code === f.code)?.title ?? f.code}.</b> {f.message}{f.detail ? <span className="sub"> · {f.detail}</span> : null}</span></li>)}</ul>}
                {s.rules.length > 0 && <div className="actions" style={{ marginTop: 6 }}>{s.rules.map((r) => <span key={r.code} className={`badge ${!r.enabled ? 'muted' : r.available ? 'good' : 'warn'}`} title={`${SCOPE_LABEL[r.scope]}${r.enabled ? '' : ' · switched off'}`}>{r.title}{!r.enabled ? ' (off)' : r.available ? '' : ` · needs ${SCOPE_LABEL[r.scope]}`}</span>)}</div>}
                {s.missing.length > 0 && <ul className="sub" style={{ margin: '6px 0 0 18px' }}>{s.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}
              </div>
            )}
          </div>
        ))}
      </div>

      <TargetsForm overview={o} isAdmin={isAdmin} busy={busy} run={run} />
      <SkuPrices overview={o} isAdmin={isAdmin} busy={busy} run={run} onNotice={onNotice} />
      <Campaigns overview={o} isAdmin={isAdmin} busy={busy} run={run} />

      {o.resolved_14d.length > 0 && (
        <details style={{ marginTop: 14 }} open={showResolved} onToggle={(e) => setShowResolved((e.target as HTMLDetailsElement).open)}>
          <summary className="sub" style={{ cursor: 'pointer' }}>Resolved in the last 14 days ({o.resolved_14d.length})</summary>
          <ul className="flaglist" style={{ marginTop: 6 }}>{o.resolved_14d.map((f) => <li key={f.id}><span className="badge good">Resolved</span> <span>{f.message} <span className="sub">· {f.first_seen_at.slice(0, 10)} to {f.resolved_at?.slice(0, 10)}</span></span></li>)}</ul>
        </details>
      )}
    </div>
  );
}

/** The per-account targets, per market where the account trades in several. */
function TargetsForm({ overview: o, isAdmin, busy, run }: { overview: AccountOverview; isAdmin: boolean; busy: string | null; run: (key: string, fn: () => Promise<AccountOverview>, after?: (r: AccountOverview) => void) => Promise<void> }) {
  const markets = (o.account.markets ?? '').toUpperCase().split(/[\/,\s]+/).filter((m) => /^[A-Z]{2}$/.test(m));
  const [market, setMarket] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => { setForm(Object.fromEntries(TARGET_FIELDS.map((f) => [f.key, String(o.targets.find((t) => t.market === market && t.key === f.key)?.value ?? '')]))); }, [o.targets, market]);
  const save = () => run('targets', () => api.saveAccountTargets(o.account.id, TARGET_FIELDS.map((f) => ({ market, key: f.key, value: form[f.key] === '' || form[f.key] === undefined ? null : Number(form[f.key]) }))));
  return (
    <div style={{ marginTop: 16 }}>
      <div className="page-head" style={{ marginBottom: 6 }}>
        <div><h3 style={{ margin: 0 }}>Targets</h3><p className="sub" style={{ margin: 0 }}>What the rules measure this account against. "All markets" applies everywhere; a market row overrides it for that country. Spend and GMV for GMV Max are typed in each week until the TikTok Ads API is connected.</p></div>
        {markets.length > 1 && <select value={market} onChange={(e) => setMarket(e.target.value)}><option value="">All markets</option>{markets.map((m) => <option key={m} value={m}>{m}</option>)}</select>}
      </div>
      <div className="inline-form">
        {TARGET_FIELDS.map((f) => (
          <label key={f.key} className="field" style={{ minWidth: 150 }} title={f.help}><span className="lbl">{f.label}</span>
            {f.bool ? <select value={form[f.key] ?? ''} disabled={!isAdmin} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}><option value="">–</option><option value="1">Yes</option><option value="0">No</option></select>
              : <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="number" step="any" min={0} style={{ width: 110 }} value={form[f.key] ?? ''} disabled={!isAdmin} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} /><span className="sub">{f.unit}</span></span>}
          </label>
        ))}
        {isAdmin && <button className="primary" disabled={busy !== null} onClick={save}>{busy === 'targets' ? 'Saving…' : 'Save targets'}</button>}
      </div>
    </div>
  );
}

/** The agreed price per SKU: list, floor and promo price, with what the shop currently charges from the product pull. */
function SkuPrices({ overview: o, isAdmin, busy, run, onNotice }: { overview: AccountOverview; isAdmin: boolean; busy: string | null; run: (key: string, fn: () => Promise<AccountOverview>, after?: (r: AccountOverview) => void) => Promise<void>; onNotice: (n: string | null) => void }) {
  const [rows, setRows] = useState<Partial<AccountSkuPrice>[]>(o.sku_prices);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setRows(o.sku_prices); }, [o.sku_prices]);
  const set = (i: number, k: keyof AccountSkuPrice, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: k === 'name' || k === 'market' || k === 'seller_sku' ? v : v === '' ? null : Number(v) } : r)));
  const list = showAll ? rows : rows.slice(0, 25);
  return (
    <div style={{ marginTop: 16 }}>
      <div className="page-head" style={{ marginBottom: 6 }}>
        <div><h3 style={{ margin: 0 }}>SKU price list</h3><p className="sub" style={{ margin: 0 }}>Agreed list price, the floor no promotion may go under, and the promo price. "Shop now" is what TikTok currently shows (from the product pull, needs the Product management scope); a difference over 2% is flagged.</p></div>
        {isAdmin && <div className="actions">
          <button className="small" disabled={busy !== null} onClick={() => run('import', () => api.importSkuPrices(o.account.id), (r) => onNotice(`${(r as AccountOverview & { imported?: number }).imported ?? 0} SKU row(s) imported from the product pull.`))} title="Add every SKU from the last product pull with its current price as the list price">{busy === 'import' ? 'Importing…' : 'Import from shop'}</button>
          <button className="small" onClick={() => setRows([...rows, { account_id: o.account.id, market: '', name: '', currency: o.currency }])}>+ SKU</button>
          <button className="primary small" disabled={busy !== null} onClick={() => run('sku', () => api.saveSkuPrices(o.account.id, rows))}>{busy === 'sku' ? 'Saving…' : 'Save prices'}</button>
        </div>}
      </div>
      {rows.length === 0 ? <div className="empty">No SKUs on file. Import from the shop, or add them by hand.</div> : (
        <div className="grid-wrap"><table><thead><tr><th>SKU</th><th>Market</th><th>List</th><th>Floor</th><th>Promo</th><th>Shop now</th><th></th></tr></thead><tbody>
          {list.map((r, i) => (
            <tr key={r.id ?? `new${i}`}>
              <td><input type="text" value={r.name ?? ''} disabled={!isAdmin} onChange={(e) => set(i, 'name', e.target.value)} style={{ minWidth: 220 }} />{r.seller_sku && <div className="sub">{r.seller_sku}</div>}</td>
              <td><input type="text" value={r.market ?? ''} disabled={!isAdmin} placeholder="all" style={{ width: 60 }} onChange={(e) => set(i, 'market', e.target.value.toUpperCase())} /></td>
              <td><input type="number" step="0.01" value={r.list_price ?? ''} disabled={!isAdmin} style={{ width: 90 }} onChange={(e) => set(i, 'list_price', e.target.value)} /></td>
              <td><input type="number" step="0.01" value={r.floor_price ?? ''} disabled={!isAdmin} style={{ width: 90 }} onChange={(e) => set(i, 'floor_price', e.target.value)} /></td>
              <td><input type="number" step="0.01" value={r.promo_price ?? ''} disabled={!isAdmin} style={{ width: 90 }} onChange={(e) => set(i, 'promo_price', e.target.value)} /></td>
              <td className={r.current_price !== null && r.current_price !== undefined && r.list_price ? (Math.abs(r.current_price - r.list_price) / r.list_price > 0.02 ? 'crit-ink' : '') : ''}>{r.current_price === null || r.current_price === undefined ? <span className="sub">–</span> : <span style={r.list_price && Math.abs(r.current_price - r.list_price) / r.list_price > 0.02 ? { color: 'var(--crit-ink)', fontWeight: 700 } : undefined}>{r.current_price.toFixed(2)} {r.currency}</span>}</td>
              <td>{isAdmin && r.id && <button className="small danger" disabled={busy !== null} onClick={() => run('skudel', () => api.deleteSkuPrice(r.id!))}>×</button>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {rows.length > 25 && <button className="small" style={{ marginTop: 6 }} onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </div>
  );
}

/** Platform campaigns the account takes part in (typed in; no API for enrolment). */
function Campaigns({ overview: o, isAdmin, busy, run }: { overview: AccountOverview; isAdmin: boolean; busy: string | null; run: (key: string, fn: () => Promise<AccountOverview>, after?: (r: AccountOverview) => void) => Promise<void> }) {
  const blank = (): Partial<AccountCampaign> => ({ market: '', name: '', begin_at: new Date().toISOString().slice(0, 10), end_at: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), participation: 'full', discount_pct: null, sku_scope: '', notes: '' });
  const [edit, setEdit] = useState<Partial<AccountCampaign> | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div style={{ marginTop: 16 }}>
      <div className="page-head" style={{ marginBottom: 6 }}>
        <div><h3 style={{ margin: 0 }}>Platform campaigns</h3><p className="sub" style={{ margin: 0 }}>Campaign registrations per market with the discount and whether participation is full. Checked against the maximum discount and against our own promotions for clashes. TikTok has no API for this, so it is typed in.</p></div>
        {isAdmin && !edit && <button className="small" onClick={() => setEdit(blank())}>+ Campaign</button>}
      </div>
      {edit && (
        <div className="inline-form" style={{ marginBottom: 8 }}>
          <label className="field" style={{ minWidth: 200 }}><span className="lbl">Name</span><input type="text" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Black Friday DE" /></label>
          <label className="field" style={{ minWidth: 80 }}><span className="lbl">Market</span><input type="text" value={edit.market ?? ''} placeholder="all" style={{ width: 70 }} onChange={(e) => setEdit({ ...edit, market: e.target.value.toUpperCase() })} /></label>
          <label className="field"><span className="lbl">From</span><input type="date" value={edit.begin_at ?? ''} onChange={(e) => setEdit({ ...edit, begin_at: e.target.value })} /></label>
          <label className="field"><span className="lbl">To</span><input type="date" value={edit.end_at ?? ''} onChange={(e) => setEdit({ ...edit, end_at: e.target.value })} /></label>
          <label className="field"><span className="lbl">Participation</span><select value={edit.participation ?? 'full'} onChange={(e) => setEdit({ ...edit, participation: e.target.value as AccountCampaign['participation'] })}><option value="full">Full</option><option value="partial">Partial</option><option value="none">None</option></select></label>
          <label className="field"><span className="lbl">Discount %</span><input type="number" step="any" min={0} style={{ width: 80 }} value={edit.discount_pct ?? ''} onChange={(e) => setEdit({ ...edit, discount_pct: e.target.value === '' ? null : Number(e.target.value) })} /></label>
          <label className="field" style={{ minWidth: 180 }}><span className="lbl">SKUs / notes</span><input type="text" value={edit.sku_scope ?? ''} onChange={(e) => setEdit({ ...edit, sku_scope: e.target.value })} placeholder="all, or which SKUs" /></label>
          <button className="primary" disabled={busy !== null || !edit.name} onClick={() => run('camp', () => api.saveCampaign(o.account.id, edit), () => setEdit(null))}>{busy === 'camp' ? 'Saving…' : 'Save'}</button>
          <button onClick={() => setEdit(null)}>Cancel</button>
        </div>
      )}
      {o.campaigns.length === 0 ? <div className="empty">No campaigns on file.</div> : (
        <div className="grid-wrap"><table><thead><tr><th>Campaign</th><th>Market</th><th>Dates</th><th>Participation</th><th>Discount</th><th>SKUs</th><th></th></tr></thead><tbody>
          {o.campaigns.map((c) => (
            <tr key={c.id} className={c.end_at < today ? 'dim' : ''}>
              <td><b>{c.name}</b></td><td>{c.market || 'all'}</td><td className="sub">{c.begin_at} to {c.end_at}{c.begin_at <= today && c.end_at >= today ? <span className="badge good" style={{ marginLeft: 6 }}>live</span> : null}</td><td>{c.participation}</td><td>{c.discount_pct !== null ? `${c.discount_pct}%` : '–'}</td><td className="sub">{c.sku_scope ?? ''}</td>
              <td>{isAdmin && <span className="actions"><button className="small" onClick={() => setEdit(c)}>Edit</button><button className="small danger" disabled={busy !== null} onClick={() => window.confirm(`Remove "${c.name}"?`) && run('campdel', () => api.deleteCampaign(c.id))}>×</button></span>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </div>
  );
}

/** Every account's targets in one grid, so the whole book can be set up in a sitting. */
function Targets({ data, isAdmin, onError, onNotice, reload, onSelect }: { data: MonitorData; isAdmin: boolean; onError: (e: string | null) => void; onNotice: (n: string | null) => void; reload: () => void; onSelect: (id: number) => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const save = async (accountId: number, key: TargetKey, raw: string) => {
    const value = raw === '' ? null : Number(raw);
    if (value !== null && !Number.isFinite(value)) return;
    if (targetOf(data.targets, accountId, key) === value) return;
    setBusy(accountId); onError(null);
    try { await api.saveAccountTargets(accountId, [{ market: '', key, value }]); reload(); onNotice('Target saved; the rules re-ran.'); } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  const fields = TARGET_FIELDS.filter((f) => !['gmv_max_spend_actual_week', 'gmv_max_gmv_actual_week'].includes(f.key));
  return (
    <>
      <p className="hint">The settings every account is measured against, for all its markets. Open an account on the Accounts tab to set a market-specific target, type in this week's GMV Max spend and GMV, keep its SKU price list or log platform campaigns. A blank cell means no target, and the rule stays quiet.</p>
      <div className="grid-wrap"><table><thead><tr><th>Account</th>{fields.map((f) => <th key={f.key} title={f.help}>{f.label}<div className="sub" style={{ fontWeight: 400 }}>{f.unit}</div></th>)}<th>Pace</th></tr></thead><tbody>
        {data.accounts.map((a) => (
          <tr key={a.id} className={busy === a.id ? 'dim' : ''}>
            <td><a href="#" onClick={(e) => { e.preventDefault(); onSelect(a.id); }}><b>{a.name}</b></a><div className="sub">{a.markets ?? ''}</div></td>
            {fields.map((f) => <td key={f.key}>{f.bool
              ? <select defaultValue={targetOf(data.targets, a.id, f.key) === null ? '' : String(targetOf(data.targets, a.id, f.key))} disabled={!isAdmin} onChange={(e) => save(a.id, f.key, e.target.value)}><option value="">–</option><option value="1">Yes</option><option value="0">No</option></select>
              : <input type="number" step="any" min={0} style={{ width: 96 }} defaultValue={targetOf(data.targets, a.id, f.key) ?? ''} disabled={!isAdmin} onBlur={(e) => save(a.id, f.key, e.target.value)} />}</td>)}
            <td className="sub">{a.gmv_pace !== null ? `GMV ${Math.round(a.gmv_pace * 100)}%` : ''}{a.samples_pace !== null ? ` · samples ${Math.round(a.samples_pace * 100)}%` : ''}{a.roi_pace !== null ? ` · ROI ${Math.round(a.roi_pace * 100)}%` : ''}</td>
          </tr>
        ))}
      </tbody></table></div>
    </>
  );
}

function Flags({ data, isAdmin, run, onSelect }: { data: MonitorData; isAdmin: boolean; run: <T extends MonitorData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; onSelect: (id: number) => void }) {
  const [account, setAccount] = useState('');
  const [severity, setSeverity] = useState('');
  const [source, setSource] = useState('');
  const ruleOf = (code: string) => data.rules.find((r) => r.code === code);
  const flags = data.flags.filter((f) => (!account || String(f.account_id ?? '') === account) && (!severity || f.severity === severity) && (!source || ruleOf(f.code)?.source === source));
  const groups = [...new Set(data.rules.map((r) => r.source))];
  return (
    <>
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{data.flags.filter((f) => f.severity === 'crit').length}</span><span className="k">critical</span></div>
        <div className="stat"><span className="v">{data.flags.filter((f) => f.severity === 'warn').length}</span><span className="k">warnings</span></div>
        <div className="stat"><span className="v">{data.flags.filter((f) => f.severity === 'info').length}</span><span className="k">info</span></div>
        <div className="stat"><span className="v">{data.accounts.filter((a) => a.open === 0).length}/{data.accounts.length}</span><span className="k">accounts clean</span></div>
      </div>
      <div className="toolbar">
        <select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">All accounts</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.open ? ` (${a.open})` : ''}</option>)}</select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="">All severities</option><option value="crit">Critical</option><option value="warn">Warning</option><option value="info">Info</option></select>
        <select value={source} onChange={(e) => setSource(e.target.value)}><option value="">All sources</option>{groups.map((g) => <option key={g} value={g}>{SOURCE_LABEL[g]}</option>)}</select>
        <span className="sub">{flags.length} open flag{flags.length === 1 ? '' : 's'}</span>
      </div>
      {flags.length === 0 ? <div className="empty">Nothing flagged{account || severity || source ? ' for this filter' : ''}. {data.last_scan_at ? '' : 'The first scan runs shortly after start-up.'}</div> : (
        <div className="grid-wrap"><table><thead><tr><th>Severity</th><th>Account</th><th>Flag</th><th>Detail</th><th>Since</th><th>Seen</th><th></th></tr></thead><tbody>
          {flags.map((f) => (
            <tr key={f.id} className={f.acknowledged_at ? 'dim' : ''}>
              <td>{sev(f.severity)}</td>
              <td>{f.account_id ? <a href="#" onClick={(e) => { e.preventDefault(); onSelect(f.account_id!); }}><b>{f.account_name}</b></a> : <b>{f.shop_id ? `Shop ${f.shop_id}` : '–'}</b>}<div className="sub">{SOURCE_LABEL[ruleOf(f.code)?.source ?? 'dashboard']}{ruleOf(f.code)?.section ? ` · ${ruleOf(f.code)?.section}` : ''}</div></td>
              <td><div>{ruleOf(f.code)?.title ?? f.code}</div><div className="sub">{f.message}</div></td>
              <td className="sub" style={{ maxWidth: 380, whiteSpace: 'pre-wrap' }}>{f.detail ?? ''}</td>
              <td className="sub">{fmtRelative(f.first_seen_at)}</td>
              <td className="sub">{fmtRelative(f.last_seen_at)}</td>
              <td>{isAdmin && !f.acknowledged_at && <button className="small" onClick={() => run(`a${f.id}`, () => api.ackFlag(f.id))} title="Seen it; keeps the flag but dims it">Ack</button>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </>
  );
}

/** Every rule with the API scope it needs and whether that scope is live, so the gaps are explicit. */
function Rules({ data, isAdmin, run }: { data: MonitorData; isAdmin: boolean; run: <T extends MonitorData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void> }) {
  const scopeOf = (s: TtsScope) => data.scopes.find((x) => x.scope === s);
  const liveScope = (s: TtsScope | undefined) => !s || s === 'none' || scopeOf(s)?.state === 'ok';
  const groups = [...new Set(data.rules.map((r) => r.source))].filter((g) => g !== 'cruva');
  const needed = data.scopes.filter((s) => s.state !== 'ok');
  return (
    <>
      <ScopeStrip scopes={data.scopes} />
      {needed.length > 0 && (
        <div className="banner warn">
          <b>Scopes still to approve on the TikTok Shop app:</b> {needed.map((s) => `${SCOPE_LABEL[s.scope]} (${data.rules.filter((r) => r.scope === s.scope).length} check${data.rules.filter((r) => r.scope === s.scope).length === 1 ? '' : 's'})`).join(', ')}. Each one unlocks the rules marked "needs approval" below; the dashboard retries on every scan, so nothing needs re-wiring once TikTok grants it. Shop score, violations, missions and campaign enrolment have no API at all.
        </div>
      )}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Rules</h3>
          {isAdmin && <div className="inline-form"><label className="field" style={{ minWidth: 120 }}><span className="lbl">Scan every (min)</span><input type="number" min={5} defaultValue={data.interval_minutes} onBlur={(e) => run('int', () => api.monitorSettings({ interval_minutes: Number(e.target.value) || 15 }))} /></label></div>}
        </div>
        <div className="grid-wrap"><table><thead><tr><th>On</th><th>Rule</th><th>Needs</th><th>Checklist section</th><th>Severity</th><th>What it checks</th></tr></thead><tbody>
          {groups.map((g) => data.rules.filter((r) => r.source === g).map((r) => (
            <tr key={r.code} className={r.enabled ? '' : 'dim'}>
              <td>{isAdmin ? <input type="checkbox" checked={r.enabled} onChange={(e) => run(`r${r.code}`, () => api.monitorRule(r.code, e.target.checked))} /> : r.enabled ? 'on' : 'off'}</td>
              <td><b>{r.title}</b><div className="sub mono">{r.code} · {SOURCE_LABEL[r.source]}</div></td>
              <td>{!r.scope || r.scope === 'none' ? <span className="badge muted">dashboard data</span> : <span className={`badge ${liveScope(r.scope) ? 'good' : scopeOf(r.scope)?.state === 'denied' ? 'crit' : 'warn'}`} title={scopeOf(r.scope)?.message ?? ''}>{SCOPE_LABEL[r.scope]}{liveScope(r.scope) ? '' : scopeOf(r.scope)?.state === 'denied' ? ' · needs approval' : ' · not live'}</span>}</td>
              <td className="sub">{r.section ?? ''}</td>
              <td>{sev(r.severity)}</td>
              <td className="sub">{r.description}</td>
            </tr>
          )))}
        </tbody></table></div>
        <p className="sub" style={{ marginTop: 8 }}>TikTok rules read the pull of every authorised shop linked to an account (Promotions › Connection). Targets rules read the Targets tab, the SKU price lists, the campaigns on file and the promotions we hold. Windsor rules still run for shops linked on the Connections page until every TikTok scope is live.</p>
      </div>
    </>
  );
}

/** The AI's daily read of every account: risk, what matters, the one action. */
function DailyReview({ data, isAdmin, busy, onRun }: { data: MonitorData; isAdmin: boolean; busy: string | null; onRun: (accountId?: number) => void }) {
  const h = data.health;
  const [open, setOpen] = useState<number | null>(null);
  const [ctx, setCtx] = useState<Record<number, string>>({});
  const showContext = async (id: number) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (!ctx[id]) { try { const c = await api.healthContext(id); setCtx({ ...ctx, [id]: JSON.stringify(c, null, 1) }); } catch (e) { setCtx({ ...ctx, [id]: (e as Error).message }); } }
  };
  const reviewed = new Set(h.assessments.map((a) => a.account_id));
  const missing = data.accounts.filter((a) => !reviewed.has(a.id));
  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="page-head" style={{ marginBottom: 6 }}>
          <div>
            <h3 style={{ margin: 0 }}>Daily review</h3>
            <p className="sub" style={{ margin: 0 }}>After the 06:30 daily pass, Claude reads each account: the TikTok Shop metrics and their 14-day trend, the targets, the open and recently resolved flags, checklist completion and the inbox, then rates it red, amber or green with a short summary and one action for today. Red and amber ratings also appear as flags and red ones go to Slack.</p>
          </div>
          <div className="actions">
            <span className={`badge ${h.llm_configured ? 'good' : 'muted'}`}>{h.llm_configured ? 'Claude configured' : 'No ANTHROPIC_API_KEY: the routine posts the assessments'}</span>
            <span className={`badge ${h.last_review_error ? 'warn' : h.last_review_at ? 'good' : 'muted'}`} title={h.last_review_error ?? ''}>{h.reviewing ? 'Reviewing…' : h.last_review_at ? `Last review ${fmtRelative(h.last_review_at)}` : 'No review yet'}</span>
            {isAdmin && <button className="primary" disabled={busy !== null || h.reviewing || !h.llm_configured} onClick={() => onRun()}>{busy === 'revall' ? 'Reviewing…' : 'Review all accounts now'}</button>}
          </div>
        </div>
        {h.last_review_error && <div className="banner warn" style={{ marginTop: 8 }}>{h.last_review_error}</div>}
      </div>
      {h.assessments.length === 0 ? <div className="empty">No assessments yet. Run the daily pass, or let the routine post its first one.</div> : (
        <div className="grid-wrap"><table><thead><tr><th>Risk</th><th>Account</th><th>What matters</th><th>Action today</th><th>Watch</th><th>When</th><th></th></tr></thead><tbody>
          {h.assessments.map((a) => (
            <>
              <tr key={a.id}>
                <td><span className={`badge ${RISK[a.risk].cls}`}>{RISK[a.risk].label}</span></td>
                <td><b>{a.account_name ?? a.account_id}</b><div className="sub">{a.source === 'ai' ? 'Claude (server)' : a.source === 'routine' ? 'Daily routine' : 'Manual'}</div></td>
                <td style={{ maxWidth: 420 }}>{a.summary}</td>
                <td className="sub" style={{ maxWidth: 360 }}>{a.action}</td>
                <td className="sub">{a.watch.join(' · ')}</td>
                <td className="sub">{a.assess_date}<div>{fmtRelative(a.assessed_at)}</div></td>
                <td><div className="actions">{isAdmin && h.llm_configured && <button className="small" disabled={busy !== null} onClick={() => onRun(a.account_id)}>{busy === `rev${a.account_id}` ? '…' : 'Re-review'}</button>}<button className="small" onClick={() => void showContext(a.account_id)}>{open === a.account_id ? 'Hide input' : 'What it saw'}</button></div></td>
              </tr>
              {open === a.account_id && <tr key={`${a.id}-ctx`} className="expand"><td colSpan={7}><pre style={{ maxHeight: 360, overflow: 'auto', fontSize: 11 }}>{ctx[a.account_id] ?? 'Loading…'}</pre></td></tr>}
            </>
          ))}
        </tbody></table></div>
      )}
      {missing.length > 0 && <p className="sub" style={{ marginTop: 10 }}>Not reviewed yet: {missing.map((a) => a.name).join(' · ')} (no shop data or no flags to read).</p>}
    </>
  );
}

/** Every numeric threshold behind the Windsor and Cruva rules, grouped by area. */
function Thresholds({ isAdmin, initial, onSaved, onError }: { isAdmin: boolean; initial: HealthThresholds; onSaved: () => void; onError: (e: string | null) => void }) {
  const [labels, setLabels] = useState<Record<string, { label: string; unit: string; group: string }> | null>(null);
  const [form, setForm] = useState<Record<string, string>>(Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, String(v)])));
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.healthThresholds().then((r) => { setLabels(r.labels); setForm(Object.fromEntries(Object.entries(r.thresholds).map(([k, v]) => [k, String(v)]))); }).catch((e) => onError((e as Error).message)); }, [onError]);
  if (!labels) return <p>Loading…</p>;
  const groups = [...new Set(Object.values(labels).map((l) => l.group))];
  const save = async (reset = false) => {
    setBusy(true); onError(null);
    try {
      const patch: Record<string, unknown> = reset ? { reset: true } : Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)]));
      const r = await api.saveHealthThresholds(patch as Partial<HealthThresholds> & { reset?: boolean });
      setForm(Object.fromEntries(Object.entries(r.thresholds).map(([k, v]) => [k, String(v)])));
      onSaved();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="page-head" style={{ marginBottom: 6 }}>
        <div><h3 style={{ margin: 0 }}>Thresholds</h3><p className="sub" style={{ margin: 0 }}>Every number the TikTok, targets and Windsor rules compare against. Changes apply on the next scan over the stored pull, no new pull needed.</p></div>
        {isAdmin && <div className="actions"><button className="small" disabled={busy} onClick={() => save(true)}>Reset to defaults</button><button className="primary small" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save thresholds'}</button></div>}
      </div>
      {groups.map((g) => (
        <div key={g} style={{ marginTop: 10 }}>
          <div className="sub" style={{ fontWeight: 700, marginBottom: 4 }}>{g}</div>
          <div className="inline-form">
            {Object.entries(labels).filter(([, l]) => l.group === g).map(([k, l]) => (
              <label key={k} className="field" style={{ minWidth: 200 }}><span className="lbl">{l.label}</span><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="number" step="any" min={0} style={{ width: 90 }} value={form[k] ?? ''} disabled={!isAdmin} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /><span className="sub">{l.unit}</span></span></label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const SEV: Record<Incident['severity'], { label: string; cls: string }> = { crit: { label: 'Critical', cls: 'crit' }, warn: { label: 'Warning', cls: 'warn' }, info: { label: 'Info', cls: 'muted' } };

/** Incidents: every issue that needs a human today, posted to the account's internal Slack channel with what happened, severity, action and owner. */
function Incidents({ isAdmin, onError, onNotice }: { isAdmin: boolean; onError: (e: string | null) => void; onNotice: (n: string | null) => void }) {
  const [data, setData] = useState<IncidentsData | null>(null);
  const [only, setOnly] = useState<'open' | 'all'>('open');
  const [busy, setBusy] = useState<string | null>(null);
  const [showKinds, setShowKinds] = useState(false);
  const [manual, setManual] = useState({ account_id: '', kind: 'ad_account_disconnected', message: '' });
  const load = useCallback(() => api.incidents().then(setData).catch((e) => onError((e as Error).message)), [onError]);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'incidents') load(); });
  const run = async <T extends IncidentsData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key);
    onError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>Loading…</p>;
  const list = data.incidents.filter((i) => only === 'all' || !i.resolved_at);
  const kindTitle = (k: string) => data.kinds.find((x) => x.kind === k)?.title ?? k;
  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="page-head" style={{ marginBottom: 6 }}>
          <div>
            <h3 style={{ margin: 0 }}>Instant issue alerts</h3>
            <p className="sub" style={{ margin: 0 }}>Negative balance, payout failures, account status changes, violations, listing and EPR failures, overdue shipments, expiring authorisation, stock-outs, GMV drops and inbox SLA breaches are picked up on every monitor scan and posted straight to Slack: what happened, severity, the recommended action and the owner (the account's AM). Ad account and campaign issues come in through the ingest endpoint or the form below.</p>
          </div>
          <div className="actions">
            <span className={`badge ${data.slack_configured ? 'good' : 'muted'}`}>{data.slack_configured ? 'Slack bot ready' : 'No SLACK_BOT_TOKEN'}</span>
            <span className={`badge ${data.llm_configured ? 'good' : 'muted'}`} title="Claude tailors the what-happened and the action per incident">{data.llm_configured ? 'Claude notes' : 'Template notes'}</span>
            <span className="badge muted">{data.last_scan_at ? `Last pass ${fmtRelative(data.last_scan_at)}` : 'No pass yet'}</span>
            {isAdmin && <button className="primary" disabled={busy === 'scan'} onClick={() => run('scan', api.incidentsScan, (r) => onNotice(`${r.opened} new incident(s), ${r.resolved} resolved${r.errors.length ? `; ${r.errors.length} source error(s): ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))}>{busy === 'scan' ? 'Scanning…' : 'Scan now'}</button>}
            <button onClick={() => setShowKinds(!showKinds)}>{showKinds ? 'Hide kinds' : 'Kinds'}</button>
          </div>
        </div>
        {isAdmin && (
          <div className="inline-form">
            <label className="field check"><input type="checkbox" checked={data.settings.enabled} onChange={(e) => run('s', () => api.incidentsSettings({ enabled: e.target.checked }))} /> Alerts on</label>
            <label className="field check"><input type="checkbox" checked={data.settings.post_to_slack} onChange={(e) => run('s', () => api.incidentsSettings({ post_to_slack: e.target.checked }))} /> Post to Slack</label>
            <label className="field" style={{ minWidth: 200 }}><span className="lbl">Default Slack channel</span><input type="text" defaultValue={data.settings.default_channel} placeholder="#ops-alerts" onBlur={(e) => e.target.value !== data.settings.default_channel && run('s', () => api.incidentsSettings({ default_channel: e.target.value }))} /><span className="help">Used when the account has no internal channel.</span></label>
            <label className="field" style={{ minWidth: 120 }}><span className="lbl">Re-alert after (hours)</span><input type="number" min={0} defaultValue={data.settings.cooldown_hours} onBlur={(e) => run('s', () => api.incidentsSettings({ cooldown_hours: Number(e.target.value) || 0 }))} /></label>
          </div>
        )}
        {showKinds && (
          <div className="grid-wrap" style={{ marginTop: 10 }}><table><thead><tr><th>Kind</th><th>Severity</th><th>Source</th><th>Detects</th><th>Recommended action</th></tr></thead><tbody>
            {data.kinds.map((k) => <tr key={k.kind}><td><b>{k.title}</b><div className="sub">{k.kind}</div></td><td><span className={`badge ${SEV[k.severity].cls}`}>{SEV[k.severity].label}</span></td><td><span className="badge muted">{k.source === 'tts' ? 'TikTok API' : k.source === 'monitor' ? 'Monitor flags' : k.source === 'stock' ? 'Stock' : 'Ingest / manual'}</span></td><td className="sub">{k.description}</td><td className="sub">{k.action}</td></tr>)}
          </tbody></table></div>
        )}
      </div>

      {isAdmin && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="page-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Channels per account</h3><span className="sub">Internal channel the account's incidents post to (the bot must be a member). Also on the Accounts page.</span></div>
          <div className="inline-form">
            {data.accounts.map((a) => <label key={a.id} className="field" style={{ minWidth: 200 }}><span className="lbl">{a.name}{a.open ? ` (${a.open} open)` : ''}</span><input type="text" defaultValue={a.slack_channel ?? ''} placeholder={data.settings.default_channel || '#channel'} onBlur={(e) => e.target.value !== (a.slack_channel ?? '') && run(`c${a.id}`, () => api.incidentChannel(a.id, e.target.value))} /></label>)}
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="sub" style={{ cursor: 'pointer' }}>Raise an incident by hand (ad account disconnected, campaign rejected)</summary>
            <div className="inline-form" style={{ marginTop: 6 }}>
              <label className="field" style={{ minWidth: 180 }}><span className="lbl">Account</span><select value={manual.account_id} onChange={(e) => setManual({ ...manual, account_id: e.target.value })}><option value="">None</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label className="field" style={{ minWidth: 200 }}><span className="lbl">Kind</span><select value={manual.kind} onChange={(e) => setManual({ ...manual, kind: e.target.value })}>{data.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.title}</option>)}</select></label>
              <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">What happened</span><input type="text" value={manual.message} onChange={(e) => setManual({ ...manual, message: e.target.value })} placeholder="e.g. GMV Max campaign 'DE Sept' rejected: product image policy" /></label>
              <button className="primary" disabled={!manual.message.trim() || busy === 'man'} onClick={() => run('man', () => api.incidentIngest({ account_id: manual.account_id ? Number(manual.account_id) : null, kind: manual.kind, message: manual.message }), (r) => { onNotice(r.opened ? 'Incident raised and posted.' : 'Already open (deduped).'); setManual({ ...manual, message: '' }); })}>Raise</button>
            </div>
            <p className="sub" style={{ marginBottom: 0 }}>Other tools can post the same thing to <code>POST /api/incidents/ingest</code> with <code>{'{ "account": "Kijimea DE", "kind": "campaign_issue", "message": "..." }'}</code>.</p>
          </details>
        </div>
      )}

      <div className="toolbar">
        <select value={only} onChange={(e) => setOnly(e.target.value as 'open' | 'all')}><option value="open">Open</option><option value="all">All incl. resolved</option></select>
        <span className="sub">{list.length} incident{list.length === 1 ? '' : 's'}</span>
      </div>
      {list.length === 0 ? <div className="empty">No incidents{only === 'open' ? ' open' : ''}.</div> : (
        <div className="grid-wrap"><table><thead><tr><th>Severity</th><th>Account</th><th>What happened</th><th>Recommended action</th><th>Owner</th><th>Slack</th><th>When</th><th></th></tr></thead><tbody>
          {list.map((i) => (
            <tr key={i.id} className={i.resolved_at ? 'dim' : ''}>
              <td><span className={`badge ${SEV[i.severity].cls}`}>{SEV[i.severity].label}</span></td>
              <td><b>{i.account_name ?? '–'}</b><div className="sub">{i.source}</div></td>
              <td style={{ maxWidth: 360 }}><div><b>{i.title}</b>{i.kind !== i.title ? <span className="sub"> · {kindTitle(i.kind)}</span> : null}</div><div className="sub">{i.message}</div></td>
              <td className="sub" style={{ maxWidth: 360 }}>{i.recommended_action}</td>
              <td className="sub">{i.owner ?? 'unassigned'}</td>
              <td className="sub">{i.posted_at ? <span className="badge good" title={i.slack_channel ?? ''}>Posted {fmtRelative(i.posted_at)}</span> : i.post_error ? <span className="badge crit" title={i.post_error}>Not posted</span> : <span className="badge muted">Not posted</span>}</td>
              <td className="sub">{fmtRelative(i.created_at)}{i.resolved_at ? <div>resolved {fmtRelative(i.resolved_at)}</div> : null}</td>
              <td>{isAdmin && <span className="actions">{!i.posted_at && <button className="small" onClick={() => run(`p${i.id}`, () => api.repostIncident(i.id, window.prompt('Slack channel', i.slack_channel ?? data.settings.default_channel) ?? undefined), () => onNotice('Posted.'))}>Post</button>}{!i.resolved_at && <button className="small" onClick={() => run(`r${i.id}`, () => api.resolveIncident(i.id))}>Resolve</button>}</span>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </>
  );
}
