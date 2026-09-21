import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Incident, IncidentsData, MonitorData, MonitorFlag } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

/** Account management > Account monitor: every managed account scanned on a schedule for the flags the team otherwise catches by hand. */
export default function MonitorPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'incidents' ? 'incidents' : 'flags';
  const setTab = (t: 'flags' | 'incidents') => setParams(t === 'flags' ? {} : { tab: t });
  const [data, setData] = useState<MonitorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [account, setAccount] = useState('');
  const [severity, setSeverity] = useState('');
  const [showRules, setShowRules] = useState(false);
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
  const flags = data.flags.filter((f) => (!account || String(f.account_id ?? '') === account) && (!severity || f.severity === severity));
  const sev = (s: MonitorFlag['severity']) => <span className={`badge ${s === 'crit' ? 'crit' : s === 'warn' ? 'warn' : 'muted'}`}>{s === 'crit' ? 'Critical' : s === 'warn' ? 'Warning' : 'Info'}</span>;
  const ruleTitle = (code: string) => data.rules.find((r) => r.code === code)?.title ?? code;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Account monitor</h1>
          <p className="hint" style={{ margin: 0 }}>Every managed account, scanned every {data.interval_minutes} minutes for the things that go wrong quietly: orders waiting to ship, GMV or order drops, deactivated products, low stock, unanswered buyers and creators, missing promotions, expiring TikTok authorisations, unfinished checklists. Flags clear themselves when the condition goes away.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${data.last_scan_error ? 'crit' : data.last_scan_at ? 'good' : 'muted'}`} title={data.last_scan_error ?? ''}>{data.scanning ? 'Scanning…' : data.last_scan_at ? `Scanned ${fmtRelative(data.last_scan_at)}` : 'Not scanned yet'}</span>
          {!data.tts_configured && <span className="badge muted" title="TTS_APP_KEY / TTS_APP_SECRET">TikTok API not configured</span>}
          {isAdmin && <button className="primary" disabled={busy === 'scan' || data.scanning} onClick={() => run('scan', api.monitorScan, (r) => setNotice(`Scan done: ${r.found} flag(s) found, ${r.opened} new, ${r.resolved} resolved.`))}>{busy === 'scan' ? 'Scanning…' : 'Scan now'}</button>}
          <button onClick={() => setShowRules(!showRules)}>{showRules ? 'Hide rules' : 'Rules'}</button>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data.last_scan_error && <div className="banner crit">Last scan failed: {data.last_scan_error}</div>}

      <div className="tabs">
        <button className={`tab ${tab === 'flags' ? 'active' : ''}`} onClick={() => setTab('flags')}>Flags <span className="sub">{data.flags.length}</span></button>
        <button className={`tab ${tab === 'incidents' ? 'active' : ''}`} onClick={() => setTab('incidents')}>Instant alerts to Slack</button>
      </div>
      {tab === 'incidents' && <Incidents isAdmin={isAdmin} onError={setError} onNotice={setNotice} />}
      {tab === 'flags' && <>
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{data.flags.filter((f) => f.severity === 'crit').length}</span><span className="k">critical</span></div>
        <div className="stat"><span className="v">{data.flags.filter((f) => f.severity === 'warn').length}</span><span className="k">warnings</span></div>
        <div className="stat"><span className="v">{data.flags.filter((f) => f.severity === 'info').length}</span><span className="k">info</span></div>
        <div className="stat"><span className="v">{data.accounts.filter((a) => a.open === 0).length}/{data.accounts.length}</span><span className="k">accounts clean</span></div>
      </div>

      {showRules && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="page-head" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>Rules</h3>
            {isAdmin && <div className="inline-form"><label className="field" style={{ minWidth: 120 }}><span className="lbl">Scan every (min)</span><input type="number" min={5} defaultValue={data.interval_minutes} onBlur={(e) => run('int', () => api.monitorSettings({ interval_minutes: Number(e.target.value) || 15 }))} /></label></div>}
          </div>
          <div className="grid-wrap"><table><thead><tr><th>On</th><th>Rule</th><th>Source</th><th>Severity</th><th>What it checks</th></tr></thead><tbody>
            {data.rules.map((r) => (
              <tr key={r.code} className={r.enabled ? '' : 'dim'}>
                <td>{isAdmin ? <input type="checkbox" checked={r.enabled} onChange={(e) => run(`r${r.code}`, () => api.monitorRule(r.code, e.target.checked))} /> : r.enabled ? 'on' : 'off'}</td>
                <td><b>{r.title}</b></td>
                <td><span className="badge muted">{r.source === 'tts' ? 'TikTok API' : r.source === 'cruva' ? 'Cruva GMV' : r.source === 'checklist' ? 'Checklist' : 'Dashboard'}</span></td>
                <td>{sev(r.severity)}</td>
                <td className="sub">{r.description}</td>
              </tr>
            ))}
          </tbody></table></div>
          <p className="sub" style={{ marginTop: 8 }}>TikTok rules need the shop authorised under Promotions (TikTok Shop) with order and product scopes. Missing a flag you keep catching by hand? Add it to the list in <code>src/monitor/index.ts</code>.</p>
        </div>
      )}

      <div className="toolbar">
        <select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">All accounts</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.open ? ` (${a.open})` : ''}</option>)}</select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="">All severities</option><option value="crit">Critical</option><option value="warn">Warning</option><option value="info">Info</option></select>
        <span className="sub">{flags.length} open flag{flags.length === 1 ? '' : 's'}</span>
      </div>

      {flags.length === 0 ? <div className="empty">Nothing flagged{account || severity ? ' for this filter' : ''}. {data.last_scan_at ? '' : 'The first scan runs shortly after start-up.'}</div> : (
        <div className="grid-wrap"><table><thead><tr><th>Severity</th><th>Account</th><th>Flag</th><th>Detail</th><th>Since</th><th>Seen</th><th></th></tr></thead><tbody>
          {flags.map((f) => (
            <tr key={f.id} className={f.acknowledged_at ? 'dim' : ''}>
              <td>{sev(f.severity)}</td>
              <td><b>{f.account_name ?? (f.shop_id ? `Shop ${f.shop_id}` : '–')}</b></td>
              <td><div>{ruleTitle(f.code)}</div><div className="sub">{f.message}</div></td>
              <td className="sub" style={{ maxWidth: 360 }}>{f.detail ?? ''}</td>
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
