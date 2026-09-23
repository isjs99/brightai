import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { HealthAssessment, HealthThresholds, Incident, IncidentsData, MonitorData, MonitorFlag, MonitorRule } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

const SOURCE_LABEL: Record<MonitorRule['source'], string> = { tts: 'TikTok API', cruva: 'Cruva', checklist: 'Checklist', dashboard: 'Dashboard', windsor: 'Windsor', ai: 'AI review' };
const RISK: Record<HealthAssessment['risk'], { label: string; cls: string }> = { red: { label: 'Red', cls: 'crit' }, amber: { label: 'Amber', cls: 'warn' }, green: { label: 'Green', cls: 'good' } };

/** Account management > Account monitor: every managed account scanned on a schedule for the flags the team otherwise catches by hand, plus the daily Windsor / Cruva health pass and the AI review. */
export default function MonitorPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'incidents' ? 'incidents' : params.get('tab') === 'review' ? 'review' : 'flags';
  const setTab = (t: 'flags' | 'review' | 'incidents') => setParams(t === 'flags' ? {} : { tab: t });
  const [data, setData] = useState<MonitorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [account, setAccount] = useState('');
  const [severity, setSeverity] = useState('');
  const [source, setSource] = useState('');
  const [showRules, setShowRules] = useState(false);
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
  const ruleOf = (code: string) => data.rules.find((r) => r.code === code);
  const flags = data.flags.filter((f) => (!account || String(f.account_id ?? '') === account) && (!severity || f.severity === severity) && (!source || ruleOf(f.code)?.source === source));
  const sev = (s: MonitorFlag['severity']) => <span className={`badge ${s === 'crit' ? 'crit' : s === 'warn' ? 'warn' : 'muted'}`}>{s === 'crit' ? 'Critical' : s === 'warn' ? 'Warning' : 'Info'}</span>;
  const ruleTitle = (code: string) => ruleOf(code)?.title ?? code;
  const groups = [...new Set(data.rules.map((r) => r.source))];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Account monitor</h1>
          <p className="hint" style={{ margin: 0 }}>Every managed account checked daily against Windsor.ai (orders, ship-by deadlines, stock, payouts, statements, unsettled money), Cruva (shop performance score, outreach, samples, affiliate GMV) and what the dashboard already knows, then read by the AI review. Flags clear themselves when the condition goes away; the rules re-run every {data.interval_minutes} minutes over the last pull.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${h.last_pull_error ? 'warn' : h.last_pull_at ? 'good' : 'muted'}`} title={h.last_pull_error ?? ''}>{h.pulling ? 'Pulling Windsor…' : h.last_pull_at ? `Windsor pull ${fmtRelative(h.last_pull_at)}` : h.windsor_configured ? 'No Windsor pull yet' : 'Windsor not configured'}</span>
          <span className={`badge ${h.last_ingest_at ? 'good' : 'muted'}`} title="The daily Claude routine posts Cruva metrics and its assessment here">{h.last_ingest_at ? `Routine posted ${fmtRelative(h.last_ingest_at)}` : 'Routine has not posted yet'}</span>
          <span className={`badge ${data.last_scan_error ? 'crit' : data.last_scan_at ? 'good' : 'muted'}`} title={data.last_scan_error ?? ''}>{data.scanning ? 'Scanning…' : data.last_scan_at ? `Rules ran ${fmtRelative(data.last_scan_at)}` : 'Not scanned yet'}</span>
          {isAdmin && <button className="primary" disabled={busy !== null || data.scanning || h.pulling} onClick={() => run('daily', api.healthDaily, (r) => setNotice(`Daily pass done: ${r.pulled} shop(s) pulled from Windsor, ${r.reviewed} account(s) reviewed${r.errors.length ? `; ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))}>{busy === 'daily' ? 'Running…' : 'Run daily pass now'}</button>}
          {isAdmin && <button disabled={busy !== null || data.scanning} onClick={() => run('scan', api.monitorScan, (r) => setNotice(`Rules re-run: ${r.found} flag(s) found, ${r.opened} new, ${r.resolved} resolved.`))}>{busy === 'scan' ? 'Scanning…' : 'Re-run rules'}</button>}
          <button onClick={() => { setShowRules(!showRules); setShowThresholds(false); }}>{showRules ? 'Hide rules' : 'Rules'}</button>
          <button onClick={() => { setShowThresholds(!showThresholds); setShowRules(false); }}>{showThresholds ? 'Hide thresholds' : 'Thresholds'}</button>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data.last_scan_error && <div className="banner crit">Last scan failed: {data.last_scan_error}</div>}
      {h.last_pull_error && <div className="banner warn">Last Windsor pull: {h.last_pull_error}</div>}

      <div className="tabs">
        <button className={`tab ${tab === 'flags' ? 'active' : ''}`} onClick={() => setTab('flags')}>Flags <span className="sub">{data.flags.length}</span></button>
        <button className={`tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>Daily review <span className="sub">{h.assessments.filter((a) => a.risk !== 'green').length}</span></button>
        <button className={`tab ${tab === 'incidents' ? 'active' : ''}`} onClick={() => setTab('incidents')}>Instant alerts to Slack</button>
      </div>

      {showRules && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="page-head" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>Rules</h3>
            {isAdmin && <div className="inline-form"><label className="field" style={{ minWidth: 120 }}><span className="lbl">Re-run every (min)</span><input type="number" min={5} defaultValue={data.interval_minutes} onBlur={(e) => run('int', () => api.monitorSettings({ interval_minutes: Number(e.target.value) || 15 }))} /></label></div>}
          </div>
          <div className="grid-wrap"><table><thead><tr><th>On</th><th>Rule</th><th>Source</th><th>Checklist section</th><th>Severity</th><th>What it checks</th></tr></thead><tbody>
            {groups.map((g) => data.rules.filter((r) => r.source === g).map((r) => (
              <tr key={r.code} className={r.enabled ? '' : 'dim'}>
                <td>{isAdmin ? <input type="checkbox" checked={r.enabled} onChange={(e) => run(`r${r.code}`, () => api.monitorRule(r.code, e.target.checked))} /> : r.enabled ? 'on' : 'off'}</td>
                <td><b>{r.title}</b><div className="sub mono">{r.code}</div></td>
                <td><span className="badge muted">{SOURCE_LABEL[r.source]}</span></td>
                <td className="sub">{r.section ?? ''}</td>
                <td>{sev(r.severity)}</td>
                <td className="sub">{r.description}</td>
              </tr>
            )))}
          </tbody></table></div>
          <p className="sub" style={{ marginTop: 8 }}>Windsor rules read the daily pull for every shop linked on the Connections page. Cruva rules read the metrics the daily Claude routine posts to <code>/api/flags/ingest</code> (see the README for the routine). TikTok rules need a shop authorised under Promotions.</p>
        </div>
      )}
      {showThresholds && <Thresholds isAdmin={isAdmin} initial={h.thresholds} onSaved={() => { load(); setNotice('Thresholds saved. The rules re-run on the next scan (or press Re-run rules).'); }} onError={setError} />}

      {tab === 'incidents' && <Incidents isAdmin={isAdmin} onError={setError} onNotice={setNotice} />}
      {tab === 'review' && <DailyReview data={data} isAdmin={isAdmin} busy={busy} onRun={(id) => run(`rev${id ?? 'all'}`, () => api.healthReview(id), (r) => setNotice(`${r.reviewed} account(s) reviewed${r.errors.length ? `; ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))} />}
      {tab === 'flags' && <>
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{data.flags.filter((f) => f.severity === 'crit').length}</span><span className="k">critical</span></div>
        <div className="stat"><span className="v">{data.flags.filter((f) => f.severity === 'warn').length}</span><span className="k">warnings</span></div>
        <div className="stat"><span className="v">{data.flags.filter((f) => f.severity === 'info').length}</span><span className="k">info</span></div>
        <div className="stat"><span className="v">{data.accounts.filter((a) => a.open === 0).length}/{data.accounts.length}</span><span className="k">accounts clean</span></div>
        <div className="stat"><span className="v">{h.pulls.filter((p) => p.source === 'windsor').length}</span><span className="k">shops pulled from Windsor</span></div>
        <div className="stat"><span className="v">{h.pulls.filter((p) => p.source === 'cruva').length}</span><span className="k">shops with Cruva metrics</span></div>
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
              <td><b>{f.account_name ?? (f.shop_id ? `Shop ${f.shop_id}` : '–')}</b><div className="sub">{SOURCE_LABEL[ruleOf(f.code)?.source ?? 'dashboard']}{ruleOf(f.code)?.section ? ` · ${ruleOf(f.code)?.section}` : ''}</div></td>
              <td><div>{ruleTitle(f.code)}</div><div className="sub">{f.message}</div></td>
              <td className="sub" style={{ maxWidth: 380, whiteSpace: 'pre-wrap' }}>{f.detail ?? ''}</td>
              <td className="sub">{fmtRelative(f.first_seen_at)}</td>
              <td className="sub">{fmtRelative(f.last_seen_at)}</td>
              <td>{isAdmin && !f.acknowledged_at && <button className="small" onClick={() => run(`a${f.id}`, () => api.ackFlag(f.id))} title="Seen it; keeps the flag but dims it">Ack</button>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      </>}
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
            <p className="sub" style={{ margin: 0 }}>After the 06:30 Windsor pull, Claude reads each account: the shop metrics and their 14-day trend, the Cruva numbers from the routine, the open and recently resolved flags, checklist completion and the inbox, then rates it red, amber or green with a short summary and one action for today. Red and amber ratings also appear as flags and red ones go to Slack.</p>
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
        <div><h3 style={{ margin: 0 }}>Thresholds</h3><p className="sub" style={{ margin: 0 }}>Every number the Windsor and Cruva rules compare against. Changes apply on the next scan over the stored pull, no new pull needed.</p></div>
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
