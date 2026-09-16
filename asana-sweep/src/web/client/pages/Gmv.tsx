import { useEffect, useState } from 'react';
import type { GmvData } from '../../../sweep/types';
import { api, currentMonth, fmtDate, fmtMoney, fmtPct, fmtRelative, monthLabel, shiftMonth } from '../api';

function Attain({ value }: { value: number | null }) {
  if (value === null) return <span className="sub">–</span>;
  return <span className={`frac ${value >= 100 ? 'ok' : value >= 80 ? 'warn-ink' : 'bad'}`}>{fmtPct(value)}</span>;
}

function Spark({ points }: { points: { date: string; gmv: number }[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.gmv), 1);
  const w = 120, h = 24;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - (p.gmv / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg width={w} height={h} className="spark" aria-hidden="true">
      <polyline points={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}

export default function GmvPage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<GmvData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  const load = () => api.gmv(month).then((d) => { setData(d); setTargets(Object.fromEntries(d.accounts.map((a) => [a.account.id, a.target === null ? '' : String(a.target)]))); }).catch((e) => setError((e as Error).message));
  useEffect(() => { setData(null); load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveTargets = async () => {
    setBusy('targets');
    setError(null);
    try {
      const payload: Record<number, number | null> = {};
      for (const [id, v] of Object.entries(targets)) payload[Number(id)] = v.trim() === '' ? null : Number(v.replace(/[^0-9.]/g, ''));
      const d = await api.saveTargets(month, payload);
      setData(d);
      setEditing(false);
      setNotice('Targets saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copyPrev = async () => {
    setBusy('copy');
    try {
      const { copied } = await api.copyTargets(shiftMonth(month, -1), month);
      setNotice(`Copied ${copied} target(s) from ${monthLabel(shiftMonth(month, -1))}.`);
      load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  };

  const sync = async () => {
    setBusy('sync');
    setError(null);
    try {
      const { sync } = await api.syncGmv();
      setNotice(sync.status === 'ok' ? `Synced ${sync.shops_synced} shops from Cruva.${sync.error_message ? ` Some failed: ${sync.error_message}` : ''}` : `Sync failed: ${sync.error_message}`);
      load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  };

  const doImport = async () => {
    setBusy('import');
    setError(null);
    try {
      const parsed = JSON.parse(importText);
      const rows = Array.isArray(parsed) ? parsed : parsed.rows;
      const r = await api.importGmv(rows);
      setNotice(`Imported ${r.imported} rows${r.skipped ? `, skipped ${r.skipped} (unknown shop or bad date)` : ''}.`);
      setImportText('');
      setShowImport(false);
      load();
    } catch (err) { setError(`Import failed: ${(err as Error).message}`); } finally { setBusy(null); }
  };

  const cur = data?.currency ?? '$';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>GMV</h1>
          <p className="hint" style={{ margin: 0 }}>Total GMV per account and AM from Cruva, against the monthly target. Projection is straight-line from month to date.</p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="small" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <b>{monthLabel(month)}</b>
          <button className="small" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= currentMonth()}>›</button>
          <button onClick={sync} disabled={busy === 'sync' || !data?.cruva_configured} title={data?.cruva_configured ? '' : 'Set CRUVA_API_KEY in .env'}>{busy === 'sync' ? 'Syncing…' : 'Sync from Cruva'}</button>
          <button onClick={() => setShowImport((s) => !s)}>Import</button>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data && !data.cruva_configured && (
        <div className="banner warn"><b>Cruva API key not set.</b> Add <code>CRUVA_API_KEY</code> to <code>.env</code> and restart for the daily sync, or use Import to paste figures.</div>
      )}
      {showImport && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>Import daily GMV</h2>
          <p className="hint">Paste JSON: an array of {'{ "shop_id", "date", "total_gmv", "affiliate_gmv", "units" }'} rows. Shop ids come from the Cruva shop list (Accounts › shops). Existing days are overwritten.</p>
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={6} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }} placeholder='[{"shop_id":"698ca8a11bc07d2529d16d1d","date":"2026-09-15","total_gmv":8466.39,"affiliate_gmv":6161.73,"units":452}]' />
          <div className="form-foot"><button className="primary" onClick={doImport} disabled={busy === 'import' || !importText.trim()}>Import</button><button onClick={() => setShowImport(false)}>Cancel</button></div>
        </div>
      )}
      {data === null ? <p>Loading…</p> : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="v">{fmtMoney(data.totals.gmv, cur)}</div><div className="k">GMV month to date</div><div className="d">{data.days_elapsed}/{data.days_in_month} days</div></div>
            <div className="kpi"><div className="v">{fmtMoney(data.totals.target, cur)}</div><div className="k">target (accounts with one)</div></div>
            <div className="kpi"><div className="v"><Attain value={data.totals.attainment} /></div><div className="k">attainment to date</div></div>
            <div className="kpi"><div className="v">{fmtMoney(data.totals.projected, cur)}</div><div className="k">projected month end</div><div className="d">{data.last_sync ? `synced ${fmtRelative(data.last_sync.finished_at ?? data.last_sync.started_at)}` : 'never synced'}</div></div>
          </div>

          <h2>By account manager</h2>
          <table>
            <thead><tr><th>AM</th><th className="num">Accounts</th><th className="num">GMV</th><th className="num">Target</th><th className="num">Attainment</th><th className="num hide-sm">Projected</th><th className="num hide-sm">Proj. %</th></tr></thead>
            <tbody>
              {data.ams.map((a) => (
                <tr key={a.am_name}>
                  <td><b>{a.am_name}</b></td>
                  <td className="num">{a.accounts}</td>
                  <td className="num">{fmtMoney(a.gmv, cur)}</td>
                  <td className="num">{fmtMoney(a.target, cur)}</td>
                  <td className="num"><Attain value={a.attainment} /></td>
                  <td className="num hide-sm">{fmtMoney(a.projected, cur)}</td>
                  <td className="num hide-sm"><Attain value={a.projected_attainment} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="page-head" style={{ marginTop: 24 }}>
            <h2 style={{ margin: 0 }}>By account</h2>
            <div className="actions">
              {editing ? (
                <>
                  <button className="primary small" onClick={saveTargets} disabled={busy === 'targets'}>Save targets</button>
                  <button className="small" onClick={() => setEditing(false)}>Cancel</button>
                </>
              ) : (
                <>
                  <button className="small" onClick={() => setEditing(true)}>Set monthly targets</button>
                  <button className="small" onClick={copyPrev} disabled={busy === 'copy'}>Copy from {monthLabel(shiftMonth(month, -1))}</button>
                </>
              )}
            </div>
          </div>
          <table>
            <thead><tr><th>Account</th><th>AM</th><th className="hide-sm">Trend</th><th className="num">GMV</th><th className="num hide-sm">Affiliate</th><th className="num">Target</th><th className="num">Attainment</th><th className="num hide-sm">Proj. %</th></tr></thead>
            <tbody>
              {data.accounts.map((a) => (
                <>
                  <tr key={a.account.id} className="clickable" onClick={() => setOpen(open === a.account.id ? null : a.account.id)}>
                    <td><b>{a.account.name}</b><div className="sub">{a.shops.length} shop{a.shops.length === 1 ? '' : 's'}</div></td>
                    <td>{a.account.am_name ?? <span className="sub">–</span>}</td>
                    <td className="hide-sm"><Spark points={a.daily} /></td>
                    <td className="num">{fmtMoney(a.gmv, cur)}</td>
                    <td className="num hide-sm sub">{fmtMoney(a.affiliate_gmv, cur)}</td>
                    <td className="num" onClick={(e) => editing && e.stopPropagation()}>
                      {editing ? <input type="text" inputMode="decimal" style={{ width: 110, textAlign: 'right' }} value={targets[a.account.id] ?? ''} onChange={(e) => setTargets({ ...targets, [a.account.id]: e.target.value })} placeholder="none" /> : fmtMoney(a.target, cur)}
                    </td>
                    <td className="num"><Attain value={a.attainment} /></td>
                    <td className="num hide-sm"><Attain value={a.projected_attainment} /></td>
                  </tr>
                  {open === a.account.id && (
                    <tr key={`${a.account.id}-shops`} className="expand">
                      <td colSpan={8}>
                        <table>
                          <thead><tr><th>Shop</th><th className="mono">Cruva id</th><th className="num">GMV</th><th className="num">Affiliate</th><th className="num">Units</th><th>Last synced</th></tr></thead>
                          <tbody>
                            {a.shops.map((s) => (
                              <tr key={s.shop.id}><td>{s.shop.shop_name}</td><td className="mono sub">{s.shop.shop_id}</td><td className="num">{fmtMoney(s.gmv, cur)}</td><td className="num">{fmtMoney(s.affiliate_gmv, cur)}</td><td className="num">{s.units.toLocaleString()}</td><td className="sub">{s.last_synced ? fmtDate(s.last_synced) : 'no data'}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
