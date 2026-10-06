import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ConnectionRow } from '../api';
import { WindsorPanel } from './Gmv';
import type { InboxSettings } from '../../../sweep/types';
import { useIsAdmin } from '../session';
import { LlmCostCard } from '../llm';

/** Every integration the dashboard runs on, whether it is live, and a test where one exists. */
export default function ConnectionsPage() {
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api.connections().then((r) => setRows(r.connections)).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);

  const test = async (key: string) => {
    setBusy(key); setError(null); setNotice(null);
    try {
      if (key === 'windsor') { const r = await api.windsorTest(); const dbg = r.shops === 0 && r.debug ? ` Shop query: HTTP ${r.debug.shops_call?.status ?? '?'} ${r.debug.shops_call?.url ?? ''} → ${r.debug.shops_call?.body ?? ''} | Orders (30d): ${r.debug.orders_30d_rows ?? '?'} rows${r.debug.orders_call ? ` (HTTP ${r.debug.orders_call.status ?? '?'}: ${r.debug.orders_call.body.slice(0, 300)})` : ''}` : ''; setNotice(`Windsor connected: ${r.shops} shop(s) on the connector, ${r.linked} linked to accounts${r.sample.length ? `, e.g. ${r.sample.join(', ')}` : ''}.${dbg} Unlinked shops: pick an account in the Windsor.ai shops panel below.`); }
      else if (key === 'apollo') { const r = await api.apolloTest(); setNotice(`Apollo: ${r.healthy ? `connected, ${r.apollo.remaining ?? '?'} credits left` : r.health_error ?? 'not ok'}.`); }
      else if (key === 'cruva') { const r = await api.cruvaPull(); if (r.errors.length && !r.shops) setError(`Cruva pull: ${r.errors.slice(0, 2).join(' · ')}`); else setNotice(`Cruva pull: ${r.shops} shop(s) read (stats, score, samples, stock)${r.errors.length ? `; ${r.errors.length} failed: ${r.errors[0]}` : ''}.`); }
      else if (key === 'cruva_mcp') { const r = await api.playbookTest(); if (r.ok) setNotice(`Cruva MCP: connected over ${r.transport}, ${r.shops} shop(s) on the account.`); else setError(`Cruva MCP: ${r.error}`); }
      else if (key === 'fastmoss') { const r = await api.fastmossTest(); setNotice(`FastMoss: ${r.ok ? `connected over ${r.transport}, ${r.tools} tools` : r.error ?? 'not ok'}.`); }
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const live = rows?.filter((r) => r.ok).length ?? 0;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <p className="hint" style={{ margin: 0 }}>Every data source the dashboard runs on. Keys live in <code>.env</code> on the server (restart after changing them); shop links and OAuth connections are made in the app. Account management runs on Windsor.ai: link every client shop there.</p>
        </div>
        <button className="small" onClick={load}>Refresh</button>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {rows === null ? <p>Loading…</p> : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="v">{live}/{rows.length}</div><div className="k">integrations live</div></div>
            <div className="kpi"><div className="v">{rows.filter((r) => r.configured && !r.ok).length}</div><div className="k">configured but not healthy</div></div>
            <div className="kpi"><div className="v">{rows.filter((r) => !r.configured).length}</div><div className="k">not set up</div></div>
          </div>
          <table>
            <thead><tr><th>Integration</th><th>Status</th><th>Detail</th><th className="hide-sm">Used for</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td><b>{r.name}</b></td>
                  <td>{r.ok ? <span className="badge good">● Live</span> : r.configured ? <span className="badge warn">◐ Check</span> : <span className="badge muted">○ Not set</span>}</td>
                  <td className="sub" style={{ maxWidth: 420 }}>{r.detail}</td>
                  <td className="sub hide-sm">{r.role}</td>
                  <td><div className="actions">{r.testable && <button className="small" disabled={busy !== null} onClick={() => test(r.key)}>{busy === r.key ? 'Testing…' : 'Test'}</button>}<Link className="button small" to={r.link}>Open</Link></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h2>Claude</h2>
      <LlmCostCard />
      <h2>Automatic replies</h2>
      <RepliesMaster onError={setError} />
      <h2>Windsor.ai shops</h2>
      <WindsorPanel onSynced={load} />
    </>
  );
}

/** The one kill switch for every automatic send, plus how often inboxes are read. Policies per account live under Accounts › Creators / Customer service. */
function RepliesMaster({ onError }: { onError: (e: string | null) => void }) {
  const isAdmin = useIsAdmin();
  const [s, setS] = useState<InboxSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.inbox().then((d) => setS(d.settings)).catch((e) => onError((e as Error).message)); }, [onError]);
  if (!s) return <p className="sub">Loading…</p>;
  const save = async (patch: Parameters<typeof api.saveInboxSettings>[0]) => { setBusy(true); try { setS((await api.saveInboxSettings(patch)).settings); } catch (e) { onError((e as Error).message); } finally { setBusy(false); } };
  const ok = s.tts_configured && s.llm_configured;
  return (
    <div className={`card master ${s.auto_reply_master ? 'on' : 'off'}`} style={{ marginBottom: 16 }}>
      <div className="master-row">
        <div>
          <div className="master-title">Master switch is <b>{s.auto_reply_master ? 'ON' : 'OFF'}</b></div>
          <div className="sub">
            {s.auto_reply_master ? 'Accounts set to Automatic under Creators or Customer service send on their own, within their cap, filters and quiet hours.' : 'Nothing is sent automatically anywhere. Accounts set to Automatic behave like Draft until this is on.'}
            {!s.tts_configured && ' TikTok app not configured (TTS_APP_KEY / TTS_APP_SECRET).'}
            {!s.llm_configured && ' ANTHROPIC_API_KEY not set, so nothing is classified or drafted.'}
            {s.last_sync_at && ` Inboxes last read ${new Date(s.last_sync_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`}{s.last_sync_error && ` Last error: ${s.last_sync_error}`}
          </div>
        </div>
        {isAdmin && (
          <button className={`switch ${s.auto_reply_master ? 'on' : ''}`} disabled={busy || (!s.auto_reply_master && !ok)} title={!s.auto_reply_master && !ok ? 'Configure the TikTok app and ANTHROPIC_API_KEY first' : ''}
            onClick={() => { if (s.auto_reply_master || window.confirm('Turn the master switch ON? Accounts set to Automatic will answer creators and buyers without a human reading first.')) void save({ auto_reply_master: !s.auto_reply_master }); }}>
            <span className="knob" /> {s.auto_reply_master ? 'ON' : 'OFF'}
          </button>
        )}
      </div>
      {isAdmin && (
        <div className="inline-form" style={{ marginTop: 12 }}>
          <label className="field" style={{ minWidth: 140 }}><span className="lbl">Read inboxes every (s)</span><input type="number" min={30} defaultValue={s.poll_seconds} onBlur={(e) => Number(e.target.value) !== s.poll_seconds && void save({ poll_seconds: Number(e.target.value) })} /></label>
          <label className="field check"><input type="checkbox" checked={s.inbox_enabled} onChange={(e) => void save({ inbox_enabled: e.target.checked })} /> Read inboxes in the background</label>
          <span className="sub">Models per feature are set under Claude above.</span>
        </div>
      )}
    </div>
  );
}
