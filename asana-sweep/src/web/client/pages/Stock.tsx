import { useCallback, useEffect, useState } from 'react';
import type { StockData, StockProjection, StockProjectionRow } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

const LEVEL: Record<StockProjectionRow['level'], { label: string; cls: string }> = { out: { label: 'Out', cls: 'crit' }, crit: { label: 'Critical', cls: 'crit' }, warn: { label: 'Low', cls: 'warn' }, ok: { label: 'OK', cls: 'good' }, idle: { label: 'No sales', cls: 'muted' } };

const countdown = (r: Pick<StockProjectionRow, 'days_left' | 'level' | 'stockout_at'>) => {
  if (r.level === 'idle') return <span className="sub">no sales in 30d</span>;
  if (r.days_left === null) return <span className="sub">–</span>;
  const d = r.days_left;
  const txt = d <= 0 ? 'out now' : d < 1 ? 'under a day' : d < 2 ? '1 day' : `${Math.round(d)} days`;
  return <span title={r.stockout_at ? `Runs out around ${r.stockout_at}` : ''}><b>{txt}</b>{r.stockout_at && d > 0 ? <span className="sub"> · {r.stockout_at}</span> : null}</span>;
};

/** Account management > Stock: days of stock left per SKU, and the replenishment CSV for a chosen number of days of cover. */
export default function StockPage() {
  const [data, setData] = useState<StockData | null>(null);
  const [proj, setProj] = useState<StockProjection | null>(null);
  const [shop, setShop] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [lead, setLead] = useState<number | null>(null);
  const [onlyNeeded, setOnlyNeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const load = useCallback(() => api.stock().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'stock') load(); });
  const cover = days ?? data?.settings.default_cover_days ?? 30;
  const leadDays = lead ?? data?.settings.default_lead_days ?? 0;
  useEffect(() => {
    if (!shop) { setProj(null); return; }
    const t = setTimeout(() => api.stockProjection(shop, cover, leadDays).then(setProj).catch((e) => setError((e as Error).message)), 150);
    return () => clearTimeout(t);
  }, [shop, cover, leadDays, data?.last_scan_at]);
  const run = async (key: string, fn: () => Promise<StockData | StockProjection>, ok?: string) => {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      if ('rows' in r) setProj(r); else setData(r);
      if (ok) setNotice(ok);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const rows = proj ? proj.rows.filter((r) => !onlyNeeded || r.send_in > 0) : [];
  const badge = (l: StockProjectionRow['level']) => <span className={`badge ${LEVEL[l].cls}`}>{LEVEL[l].label}</span>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Stock</h1>
          <p className="hint" style={{ margin: 0 }}>Days of stock left per SKU from the TikTok Shop inventory and the last 30 days of orders, and what to send in to cover the days you choose. The CSV goes straight to the client or the 3PL.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${data.last_scan_error ? 'crit' : data.last_scan_at ? 'good' : 'muted'}`} title={data.last_scan_error ?? ''}>{data.scanning ? 'Refreshing…' : data.last_scan_at ? `Refreshed ${fmtRelative(data.last_scan_at)}` : 'Not refreshed yet'}</span>
          {!data.tts_configured && <span className="badge muted" title="TTS_APP_KEY / TTS_APP_SECRET">TikTok API not configured</span>}
          {isAdmin && <button className="primary" disabled={busy === 'scan' || data.scanning} onClick={() => run('scan', () => api.stockScan(shop || undefined), 'Stock refreshed from TikTok Shop.')}>{busy === 'scan' ? 'Refreshing…' : shop ? 'Refresh this shop' : 'Refresh all shops'}</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data.last_scan_error && <div className="banner crit">Last refresh had errors: {data.last_scan_error}</div>}

      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{data.shops.reduce((n, s) => n + s.out, 0)}</span><span className="k">SKUs out of stock</span></div>
        <div className="stat"><span className="v">{data.shops.reduce((n, s) => n + s.crit, 0)}</span><span className="k">under {data.settings.crit_days} days</span></div>
        <div className="stat"><span className="v">{data.shops.reduce((n, s) => n + s.warn, 0)}</span><span className="k">under {data.settings.warn_days} days</span></div>
        <div className="stat"><span className="v">{data.shops.filter((s) => s.skus > 0).length}/{data.shops.length}</span><span className="k">shops with a snapshot</span></div>
      </div>

      {data.alerts.length > 0 && !shop && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3 style={{ marginTop: 0 }}>Stock alerts</h3>
          <div className="grid-wrap"><table><thead><tr><th>Level</th><th>Shop</th><th>Product</th><th className="num">On hand</th><th className="num">Per day</th><th>Countdown</th></tr></thead><tbody>
            {data.alerts.slice(0, 40).map((r) => (
              <tr key={`${r.shop_id}-${r.sku_id}`} className="clickable" onClick={() => setShop(r.shop_id)}>
                <td>{badge(r.level)}</td>
                <td><b>{r.shop_name}</b>{r.account_name ? <div className="sub">{r.account_name}</div> : null}</td>
                <td>{r.product_title}{r.sku_name ? <div className="sub">{r.sku_name}{r.seller_sku ? ` · ${r.seller_sku}` : ''}</div> : r.seller_sku ? <div className="sub">{r.seller_sku}</div> : null}</td>
                <td className="num">{r.on_hand}</td>
                <td className="num">{r.velocity}</td>
                <td>{countdown(r)}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      )}

      <div className="toolbar">
        <select value={shop} onChange={(e) => setShop(e.target.value)}>
          <option value="">Pick a shop for the projection…</option>
          {data.shops.map((s) => <option key={s.shop_id} value={s.shop_id}>{s.account_name ? `${s.account_name} · ` : ''}{s.shop_name}{s.next_stockout_days !== null ? ` (next stock-out in ${Math.max(0, Math.round(s.next_stockout_days))}d)` : s.skus ? '' : ' (no snapshot)'}</option>)}
        </select>
        {isAdmin && (
          <details style={{ marginLeft: 'auto' }}>
            <summary className="sub" style={{ cursor: 'pointer' }}>Thresholds</summary>
            <div className="inline-form" style={{ marginTop: 6 }}>
              <label className="field" style={{ minWidth: 100 }}><span className="lbl">Critical (days)</span><input type="number" min={1} defaultValue={data.settings.crit_days} onBlur={(e) => run('s', () => api.stockSettings({ crit_days: Number(e.target.value) || 7 }))} /></label>
              <label className="field" style={{ minWidth: 100 }}><span className="lbl">Low (days)</span><input type="number" min={1} defaultValue={data.settings.warn_days} onBlur={(e) => run('s', () => api.stockSettings({ warn_days: Number(e.target.value) || 14 }))} /></label>
              <label className="field" style={{ minWidth: 100 }}><span className="lbl">Default cover</span><input type="number" min={1} defaultValue={data.settings.default_cover_days} onBlur={(e) => run('s', () => api.stockSettings({ default_cover_days: Number(e.target.value) || 30 }))} /></label>
              <label className="field" style={{ minWidth: 100 }}><span className="lbl">Default lead time</span><input type="number" min={0} defaultValue={data.settings.default_lead_days} onBlur={(e) => run('s', () => api.stockSettings({ default_lead_days: Number(e.target.value) || 0 }))} /></label>
            </div>
          </details>
        )}
      </div>

      {!shop ? (
        data.shops.length === 0 ? <div className="empty">No TikTok shops authorised yet. Authorise them under Promotions (TikTok Shop) and the stock snapshot follows.</div> : (
          <div className="grid-wrap"><table><thead><tr><th>Shop</th><th>Account</th><th className="num">SKUs</th><th className="num">Out</th><th className="num">Critical</th><th className="num">Low</th><th>Next stock-out</th><th>Snapshot</th></tr></thead><tbody>
            {data.shops.map((s) => (
              <tr key={s.shop_id} className="clickable" onClick={() => setShop(s.shop_id)}>
                <td><b>{s.shop_name}</b>{s.market ? <span className="badge muted" style={{ marginLeft: 6 }}>{s.market}</span> : null}{!s.token_ok && <span className="badge crit" style={{ marginLeft: 6 }}>auth</span>}</td>
                <td className="sub">{s.account_name ?? '–'}</td>
                <td className="num">{s.skus}</td>
                <td className="num">{s.out || ''}</td>
                <td className="num">{s.crit || ''}</td>
                <td className="num">{s.warn || ''}</td>
                <td>{s.next_stockout_days === null ? <span className="sub">–</span> : countdown({ days_left: s.next_stockout_days, level: s.next_stockout_days < data.settings.crit_days ? 'crit' : 'ok', stockout_at: null })}</td>
                <td className="sub">{s.captured_at ? fmtRelative(s.captured_at) : 'none'}</td>
              </tr>
            ))}
          </tbody></table></div>
        )
      ) : !proj ? <p>Loading projection…</p> : (
        <div className="card">
          <div className="page-head" style={{ marginBottom: 8 }}>
            <div>
              <h3 style={{ margin: 0 }}>{proj.shop_name} <span className="sub">{proj.account_name ?? ''}</span></h3>
              <p className="sub" style={{ margin: 0 }}>{proj.totals.skus} SKUs · {proj.totals.out} out · {proj.totals.crit} critical · {proj.totals.warn} low · snapshot {proj.captured_at ? fmtRelative(proj.captured_at) : 'none yet'}</p>
            </div>
            <div className="actions">
              <a className="button primary" href={api.stockCsvUrl(proj.shop_id, proj.cover_days, proj.lead_days, false)} download title="Only the SKUs that need sending in">Download CSV ({proj.totals.send_in_skus} SKUs, {proj.totals.send_in_units} units)</a>
              <a className="button" href={api.stockCsvUrl(proj.shop_id, proj.cover_days, proj.lead_days, true)} download title="Every SKU with its countdown">Full CSV</a>
            </div>
          </div>
          <div className="inline-form" style={{ marginBottom: 10, alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: 1, minWidth: 260 }}>
              <span className="lbl">Days of stock to cover: <b>{proj.cover_days}</b>{proj.lead_days ? ` (+ ${proj.lead_days} days lead time)` : ''}</span>
              <input type="range" min={7} max={120} step={1} value={cover} onChange={(e) => setDays(Number(e.target.value))} style={{ width: '100%' }} />
              <span className="help">Send-in = units per day × ({proj.cover_days}{proj.lead_days ? ` + ${proj.lead_days}` : ''} days) − on hand. Units per day blends the last 7 days (60%) and 30 days (40%); override it per SKU below.</span>
            </label>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Lead time (days)</span><input type="number" min={0} max={120} value={leadDays} onChange={(e) => setLead(Math.max(0, Number(e.target.value) || 0))} /></label>
            <label className="field check"><input type="checkbox" checked={onlyNeeded} onChange={(e) => setOnlyNeeded(e.target.checked)} /> Only SKUs to send in</label>
          </div>
          {rows.length === 0 ? <div className="empty">{proj.rows.length ? 'Nothing needs sending in for this cover.' : 'No snapshot for this shop yet. Click "Refresh this shop".'}</div> : (
            <div className="grid-wrap"><table><thead><tr><th>Level</th><th>Product</th><th>Seller SKU</th><th className="num">On hand</th><th className="num">Sold 7d</th><th className="num">Sold 30d</th><th className="num">Per day</th><th>Countdown</th><th className="num">Send in</th><th></th></tr></thead><tbody>
              {rows.map((r) => (
                <tr key={r.sku_id} className={r.exclude ? 'dim' : ''}>
                  <td>{badge(r.level)}</td>
                  <td>{r.product_title}{r.sku_name ? <div className="sub">{r.sku_name}</div> : null}{r.product_status && !/ACTIV/i.test(r.product_status) ? <div className="sub">{r.product_status}</div> : null}</td>
                  <td className="sub">{r.seller_sku ?? '–'}</td>
                  <td className="num">{r.on_hand}</td>
                  <td className="num">{r.sold_7d}</td>
                  <td className="num">{r.sold_30d}</td>
                  <td className="num">{isAdmin ? <input type="number" min={0} step={0.1} style={{ width: 72 }} value={r.velocity_override ?? r.velocity} title={r.velocity_override !== null ? 'Manual override' : 'Computed from sales; edit to override'} onChange={(e) => setProj({ ...proj, rows: proj.rows.map((x) => x.sku_id === r.sku_id ? { ...x, velocity_override: Number(e.target.value) } : x) })} onBlur={(e) => run(`v${r.sku_id}`, () => api.stockOverride(proj.shop_id, r.sku_id, { velocity: e.target.value === '' ? null : Number(e.target.value) }, proj.cover_days))} /> : r.velocity}{r.velocity_override !== null && isAdmin && <button className="small" style={{ marginLeft: 4 }} title="Back to the computed velocity" onClick={() => run(`v${r.sku_id}`, () => api.stockOverride(proj.shop_id, r.sku_id, { velocity: null }, proj.cover_days))}>×</button>}</td>
                  <td>{countdown(r)}</td>
                  <td className="num"><b>{r.send_in || ''}</b></td>
                  <td>{isAdmin && <button className="small" title={r.exclude ? 'Include in the CSV again' : 'Leave out of the CSV (discontinued, client handles it)'} onClick={() => run(`x${r.sku_id}`, () => api.stockOverride(proj.shop_id, r.sku_id, { exclude: !r.exclude }, proj.cover_days))}>{r.exclude ? 'Include' : 'Exclude'}</button>}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </div>
      )}
    </>
  );
}
