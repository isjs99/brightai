import { useCallback, useEffect, useState } from 'react';
import type { MonitorData, MonitorFlag } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

/** Account management > Account monitor: every managed account scanned on a schedule for the flags the team otherwise catches by hand. */
export default function MonitorPage() {
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
                <td><span className="badge muted">{r.source === 'tts' ? 'TikTok API' : r.source === 'cruva' ? 'Cruva GMV' : r.source === 'asana' ? 'Asana' : 'Dashboard'}</span></td>
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
    </>
  );
}
