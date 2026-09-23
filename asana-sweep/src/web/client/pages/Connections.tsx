import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ConnectionRow } from '../api';
import { WindsorPanel } from './Gmv';

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
      if (key === 'windsor') { const r = await api.windsorTest(); setNotice(`Windsor connected: ${r.shops} shop(s) on the connector${r.sample.length ? `, e.g. ${r.sample.join(', ')}` : ''}.`); }
      else if (key === 'apollo') { const r = await api.apolloTest(); setNotice(`Apollo: ${r.healthy ? `connected, ${r.apollo.remaining ?? '?'} credits left` : r.health_error ?? 'not ok'}.`); }
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
      <h2>Windsor.ai shops</h2>
      <WindsorPanel onSynced={load} />
    </>
  );
}
