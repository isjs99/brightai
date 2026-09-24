import { useEffect, useState } from 'react';
import type { Account, BonusStatus, GmvData, GmvExplore, WindsorStatus } from '../../../sweep/types';
import { api, currentMonth, fmtDate, fmtMoney, fmtPct, fmtRelative, monthLabel, shiftMonth } from '../api';

function Attain({ value }: { value: number | null }) {
  if (value === null) return <span className="sub">–</span>;
  return <span className={`frac ${value >= 100 ? 'ok' : value >= 80 ? 'warn-ink' : 'bad'}`}>{fmtPct(value)}</span>;
}

function Growth({ value, needed }: { value: number | null; needed: number | null }) {
  if (value === null) return <span className="sub">–</span>;
  const sign = value > 0 ? '+' : '';
  const cls = needed === null ? '' : value >= needed ? 'ok' : value >= needed * 0.7 ? 'warn-ink' : 'bad';
  return <span className={`frac ${cls}`}>{sign}{Math.round(value)}%</span>;
}

/** Plain up/down percentage: green when up, red when down. */
function UpDown({ value }: { value: number | null }) {
  if (value === null) return <span className="sub">–</span>;
  const cls = value > 0 ? 'ok' : value < 0 ? 'bad' : '';
  return <span className={`frac ${cls}`}>{value > 0 ? '▲' : value < 0 ? '▼' : ''} {value > 0 ? '+' : ''}{Math.round(value)}%</span>;
}

function Bonus({ status }: { status: BonusStatus }) {
  switch (status) {
    case 'eligible': return <span className="badge good">✓ Eligible</span>;
    case 'on_track': return <span className="badge good">On track</span>;
    case 'behind': return <span className="badge crit">Behind</span>;
    case 'no_base': return <span className="badge muted" title="No GMV last month, so no growth base">No base</span>;
    default: return <span className="badge muted">No data</span>;
  }
}

function Spark({ points }: { points: { date: string; gmv: number }[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.gmv), 1);
  const w = 120, h = 24;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - (p.gmv / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg width={w} height={h} className="spark" aria-hidden="true">
      <polyline points={d} fill="none" stroke="var(--ink)" strokeWidth="1.5" />
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
  const [showSettings, setShowSettings] = useState(false);
  const [importText, setImportText] = useState('');
  const [fxText, setFxText] = useState('');
  const [rule, setRule] = useState({ threshold: 30000, below: 100, above: 40 });
  const [dealEdit, setDealEdit] = useState(false);
  const [deals, setDeals] = useState<Record<number, { commission_pct: string; commission_basis: 'gmv' | 'mor'; settlement_pct: string; net_settlement: string }>>({});
  const [amShare, setAmShare] = useState('10');

  const absorbDeals = (d: GmvData) => {
    setDeals(
      Object.fromEntries(
        d.accounts.map((a) => [
          a.account.id,
          {
            commission_pct: a.commission_pct === null ? '' : String(a.commission_pct),
            commission_basis: a.commission_basis,
            settlement_pct: String(a.settlement_pct),
            net_settlement: a.net_settlement === null ? '' : String(a.net_settlement),
          },
        ]),
      ),
    );
    setAmShare(String(d.settings.am_share_pct));
  };

  const saveDeals = async () => {
    setBusy('deals');
    setError(null);
    try {
      const payload: Record<number, { commission_pct: number | null; commission_basis: 'gmv' | 'mor'; settlement_pct: number; net_settlement: number | null }> = {};
      for (const [id, d] of Object.entries(deals)) {
        payload[Number(id)] = {
          commission_pct: d.commission_pct.trim() === '' ? null : Number(d.commission_pct),
          commission_basis: d.commission_basis,
          settlement_pct: d.settlement_pct.trim() === '' ? 100 : Number(d.settlement_pct),
          net_settlement: d.net_settlement.trim() === '' ? null : Number(d.net_settlement.replace(/[^0-9.]/g, '')),
        };
      }
      const d = await api.saveDeals({ month, am_share_pct: Number(amShare), deals: payload });
      absorb(d);
      absorbDeals(d);
      setDealEdit(false);
      setNotice('Commission deals saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const absorb = (d: GmvData) => {
    setData(d);
    setTargets(Object.fromEntries(d.accounts.map((a) => [a.account.id, a.target_source === 'manual' && a.target !== null ? String(a.target) : ''])));
    setFxText(Object.entries(d.settings.fx_to_eur).filter(([k]) => k !== 'EUR').map(([k, v]) => `${k}=${v}`).join(', '));
    setRule({ threshold: d.settings.bonus_threshold, below: d.settings.bonus_growth_below, above: d.settings.bonus_growth_above });
  };
  const load = () => api.gmv(month).then((d) => { absorb(d); absorbDeals(d); }).catch((e) => setError((e as Error).message));
  useEffect(() => { setData(null); load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveTargets = async () => {
    setBusy('targets');
    setError(null);
    try {
      const payload: Record<number, number | null> = {};
      for (const [id, v] of Object.entries(targets)) payload[Number(id)] = v.trim() === '' ? null : Number(v.replace(/[^0-9.]/g, ''));
      absorb(await api.saveTargets(month, payload));
      setEditing(false);
      setNotice('Manual targets saved. Blank means the bonus rule applies.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async () => {
    setBusy('settings');
    setError(null);
    try {
      const fx: Record<string, number> = {};
      for (const part of fxText.split(/[,\n]/)) {
        const [k, v] = part.split('=').map((s) => s.trim());
        if (k && v) fx[k.toUpperCase()] = Number(v);
      }
      absorb(await api.saveGmvSettings({ month, fx_to_eur: fx, bonus_threshold: rule.threshold, bonus_growth_below: rule.below, bonus_growth_above: rule.above }));
      setNotice('Rates and bonus rule saved.');
      setShowSettings(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    setError(null);
    try {
      const { sync } = await api.syncGmv();
      const source = data?.windsor_configured && data?.cruva_configured ? 'Windsor and Cruva' : data?.windsor_configured ? 'Windsor' : 'Cruva';
      setNotice(sync.status === 'ok' ? `Synced ${sync.shops_synced} shop(s) from ${source}.${sync.error_message ? ` Some failed: ${sync.error_message}` : ''}` : `Sync failed: ${sync.error_message}`);
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

  const cur = data?.currency ?? 'EUR';
  const running = data ? !data.month_closed && data.month === currentMonth() : true;
  const [showWindsor, setShowWindsor] = useState(false);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>GMV</h1>
          <p className="hint" style={{ margin: 0 }}>
            Sales per account and AM from {data?.windsor_configured ? 'Windsor.ai (TikTok Shop orders)' : 'Cruva'}, in each shop's market currency and totalled in {cur}. {running ? 'Month to date excludes today.' : ''} Bonus: {data ? `${data.settings.bonus_growth_below}% growth on last month under ${fmtMoney(data.settings.bonus_threshold, cur)}, ${data.settings.bonus_growth_above}% at or above.` : ''}{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setShowSettings((s) => !s); }}>{showSettings ? 'Hide rates' : 'Rates & rule'}</a>
          </p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="small" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <b>{monthLabel(month)}</b>
          <button className="small" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= currentMonth()}>›</button>
          <button className="admin-only" onClick={sync} disabled={busy === 'sync' || !(data?.cruva_configured || data?.windsor_configured)} title={data?.cruva_configured || data?.windsor_configured ? '' : 'Set CRUVA_API_KEY or WINDSOR_API_KEY in .env'}>{busy === 'sync' ? 'Syncing…' : data?.windsor_configured && !data?.cruva_configured ? 'Sync from Windsor' : 'Sync'}</button>
          <button className="admin-only" onClick={() => setShowWindsor((s) => !s)}>{showWindsor ? 'Hide Windsor' : 'Windsor.ai shops'}</button>
          <button className="admin-only" onClick={() => setShowImport((s) => !s)}>Import</button>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data && !data.cruva_configured && !data.windsor_configured && (
        <div className="banner warn"><b>No GMV source set.</b> Add <code>WINDSOR_API_KEY</code> (Windsor.ai › API key) or <code>CRUVA_API_KEY</code> to <code>.env</code> and restart for the daily sync, or use Import to paste figures.</div>
      )}
      {showWindsor && <WindsorPanel onSynced={load} />}
      {showSettings && data && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span className="lbl">FX rates to {cur} (1 unit = x {cur})</span>
              <input type="text" value={fxText} onChange={(e) => setFxText(e.target.value)} placeholder="GBP=1.16, PLN=0.235, AUD=0.6" />
              <span className="help">Shops are in their market currency (UK → GBP, PL → PLN, everything else EUR). Totals convert with these rates.</span>
            </label>
            <label className="field"><span className="lbl">Bonus threshold ({cur}, last month)</span><input type="number" value={rule.threshold} onChange={(e) => setRule({ ...rule, threshold: Number(e.target.value) })} /></label>
            <label className="field"><span className="lbl">Growth needed below (%)</span><input type="number" value={rule.below} onChange={(e) => setRule({ ...rule, below: Number(e.target.value) })} /></label>
            <label className="field"><span className="lbl">Growth needed at or above (%)</span><input type="number" value={rule.above} onChange={(e) => setRule({ ...rule, above: Number(e.target.value) })} /></label>
          </div>
          <div className="form-foot"><button className="primary" onClick={saveSettings} disabled={busy === 'settings'}>Save</button><button onClick={() => setShowSettings(false)}>Cancel</button></div>
        </div>
      )}
      {showImport && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>Import daily GMV</h2>
          <p className="hint">Paste JSON: an array of {'{ "shop_id", "date", "total_gmv", "affiliate_gmv", "units" }'} rows, figures in the shop's market currency. Existing days are overwritten.</p>
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={6} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }} placeholder='[{"shop_id":"698ca8a11bc07d2529d16d1d","date":"2026-09-15","total_gmv":8466.39,"affiliate_gmv":6161.73,"units":452}]' />
          <div className="form-foot"><button className="primary" onClick={doImport} disabled={busy === 'import' || !importText.trim()}>Import</button><button onClick={() => setShowImport(false)}>Cancel</button></div>
        </div>
      )}
      {data === null ? <p>Loading…</p> : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="v">{fmtMoney(data.totals.gmv, cur)}</div><div className="k">{data.month_closed ? 'GMV for the month' : 'GMV to date (excl. today)'}</div><div className="d">{data.days_elapsed}/{data.days_in_month} days</div></div>
            <div className="kpi"><div className="v">{fmtMoney(data.totals.prev_gmv, cur)}</div><div className="k">{monthLabel(data.prev_month)}</div><div className="d">last month, full</div></div>
            <div className="kpi"><div className="v"><Growth value={data.totals.growth_pct} needed={null} /></div><div className="k">{data.month_closed ? 'growth vs last month' : 'projected growth vs last month'}</div></div>
            <div className="kpi"><div className="v">{fmtMoney(data.totals.target, cur)}</div><div className="k">bonus target (sum)</div><div className="d">{data.month_closed ? `${data.totals.eligible} eligible` : `${data.totals.on_track} on track`}</div></div>
            <div className="kpi"><div className="v">{fmtMoney(data.totals.projected, cur)}</div><div className="k">projected month end</div><div className="d">{data.last_sync ? `synced ${fmtRelative(data.last_sync.finished_at ?? data.last_sync.started_at)}` : 'never synced'}</div></div>
          </div>

          <h2>By account manager</h2>
          <table>
            <thead><tr><th>AM</th><th className="num">Accounts</th><th className="num hide-sm">Last month</th><th className="num">GMV</th><th className="num">Target</th><th className="num">Growth</th><th className="num hide-sm">Projected</th><th className="num">Bonus</th></tr></thead>
            <tbody>
              {data.ams.map((a) => (
                <tr key={a.am_name}>
                  <td><b>{a.am_name}</b></td>
                  <td className="num">{a.accounts}</td>
                  <td className="num hide-sm sub">{fmtMoney(a.prev_gmv, cur)}</td>
                  <td className="num">{fmtMoney(a.gmv, cur)}</td>
                  <td className="num">{fmtMoney(a.target, cur)}</td>
                  <td className="num"><Growth value={a.growth_pct} needed={null} /></td>
                  <td className="num hide-sm">{fmtMoney(a.projected, cur)}</td>
                  <td className="num">{data.month_closed ? `${a.eligible}/${a.accounts}` : `${a.on_track}/${a.accounts} on track`}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="page-head" style={{ marginTop: 24 }}>
            <h2 style={{ margin: 0 }}>By account</h2>
            <div className="actions">
              {editing ? (
                <>
                  <button className="primary small" onClick={saveTargets} disabled={busy === 'targets'}>Save overrides</button>
                  <button className="small" onClick={() => setEditing(false)}>Cancel</button>
                </>
              ) : (
                <button className="small admin-only" onClick={() => setEditing(true)}>Override targets</button>
              )}
            </div>
          </div>
          <table>
            <thead><tr><th>Account</th><th>AM</th><th className="hide-sm">Trend</th><th className="num hide-sm">Last month</th><th className="num hide-sm">Needs</th><th className="num">Target</th><th className="num">GMV</th><th className="num" title="Month to date against the same days last month">vs same days</th><th className="num" title="Projected month end against last month, or actual once the month is closed">Growth</th><th className="num hide-sm">Proj.</th><th>Bonus</th></tr></thead>
            <tbody>
              {data.accounts.map((a) => (
                <>
                  <tr key={a.account.id} className="clickable" onClick={() => setOpen(open === a.account.id ? null : a.account.id)}>
                    <td><b>{a.account.name}</b><div className="sub">{a.shops.length} shop{a.shops.length === 1 ? '' : 's'}{a.shops.some((s) => s.shop.currency !== cur) ? ` · ${[...new Set(a.shops.map((s) => s.shop.currency))].join(', ')}` : ''}</div></td>
                    <td>{a.account.am_name ?? <span className="sub">–</span>}</td>
                    <td className="hide-sm"><Spark points={a.daily} /></td>
                    <td className="num hide-sm sub">{fmtMoney(a.prev_gmv, cur)}</td>
                    <td className="num hide-sm sub">{a.required_growth_pct === null ? '–' : `+${Math.round(a.required_growth_pct)}%`}</td>
                    <td className="num" onClick={(e) => editing && e.stopPropagation()}>
                      {editing ? (
                        <input type="text" inputMode="decimal" style={{ width: 110, textAlign: 'right' }} value={targets[a.account.id] ?? ''} onChange={(e) => setTargets({ ...targets, [a.account.id]: e.target.value })} placeholder={a.target_source === 'rule' && a.target !== null ? String(a.target) : 'rule'} />
                      ) : (
                        <>{fmtMoney(a.target, cur)}{a.target_source === 'manual' && <div className="sub">manual</div>}</>
                      )}
                    </td>
                    <td className="num">{fmtMoney(a.gmv, cur)}</td>
                    <td className="num"><UpDown value={a.pace_pct} />{a.prev_same_days !== null && <div className="sub" title="Same days last month">{fmtMoney(a.prev_same_days, cur)}</div>}</td>
                    <td className="num"><Growth value={a.growth_pct} needed={a.required_growth_pct} /></td>
                    <td className="num hide-sm">{fmtMoney(a.projected, cur)}</td>
                    <td><Bonus status={a.bonus} /></td>
                  </tr>
                  {open === a.account.id && (
                    <tr key={`${a.account.id}-shops`} className="expand">
                      <td colSpan={11}>
                        <table>
                          <thead><tr><th>Shop</th><th className="mono">Source id</th><th>Currency</th><th className="num">GMV (local)</th><th className="num">GMV ({cur})</th><th className="num">Last month ({cur})</th><th className="num">Affiliate (local)</th><th className="num">Units</th><th>Last synced</th></tr></thead>
                          <tbody>
                            {a.shops.map((s) => (
                              <tr key={s.shop.id}>
                                <td>{s.shop.shop_name}</td>
                                <td className="mono sub">{s.shop.shop_id}</td>
                                <td>{s.shop.currency}</td>
                                <td className="num">{fmtMoney(s.gmv, s.shop.currency)}</td>
                                <td className="num">{fmtMoney(s.gmv_report, cur)}</td>
                                <td className="num sub">{fmtMoney(s.prev_gmv, cur)}</td>
                                <td className="num sub">{fmtMoney(s.affiliate_gmv, s.shop.currency)}</td>
                                <td className="num">{s.units.toLocaleString()}</td>
                                <td className="sub">{s.last_synced ? fmtDate(s.last_synced) : 'no data'}</td>
                              </tr>
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

          <Explorer accounts={data.accounts.map((a) => a.account)} currency={cur} />

          <div className="page-head" style={{ marginTop: 28 }}>
            <div>
              <h2 style={{ margin: 0 }}>Commission &amp; AM share</h2>
              <p className="hint" style={{ margin: 0 }}>
                Agency billing = commission % × base. Base is actual GMV, or the net settlement amount for Merchant of Record deals (actual once entered, otherwise estimated at the settlement %). AMs get {data.settings.am_share_pct}% of agency billing.
              </p>
            </div>
            <div className="actions">
              {dealEdit ? (
                <>
                  <label className="sub">AM share % <input type="number" min={0} max={100} value={amShare} onChange={(e) => setAmShare(e.target.value)} style={{ width: 70 }} /></label>
                  <button className="primary small" onClick={saveDeals} disabled={busy === 'deals'}>Save deals</button>
                  <button className="small" onClick={() => { setDealEdit(false); absorbDeals(data); }}>Cancel</button>
                </>
              ) : (
                <button className="small admin-only" onClick={() => setDealEdit(true)}>Edit deals</button>
              )}
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>AM</th>
                <th>Basis</th>
                <th className="num">Commission</th>
                <th className="num hide-sm">Settlement est.</th>
                <th className="num">Net settlement</th>
                <th className="num">Base</th>
                <th className="num">Agency billing</th>
                <th className="num">AM share</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => {
                const d = deals[a.account.id];
                return (
                  <tr key={a.account.id}>
                    <td><b>{a.account.name}</b></td>
                    <td>{a.account.am_name ?? <span className="sub">–</span>}</td>
                    <td>
                      {dealEdit && d ? (
                        <select value={d.commission_basis} onChange={(e) => setDeals({ ...deals, [a.account.id]: { ...d, commission_basis: e.target.value as 'gmv' | 'mor' } })} style={{ width: 'auto' }}>
                          <option value="gmv">Actual GMV</option>
                          <option value="mor">Net settlement (MoR)</option>
                        </select>
                      ) : a.commission_basis === 'mor' ? 'Net settlement (MoR)' : 'Actual GMV'}
                    </td>
                    <td className="num">
                      {dealEdit && d ? (
                        <input type="text" inputMode="decimal" value={d.commission_pct} onChange={(e) => setDeals({ ...deals, [a.account.id]: { ...d, commission_pct: e.target.value } })} placeholder="none" style={{ width: 70, textAlign: 'right' }} />
                      ) : a.commission_pct === null ? <span className="sub">no deal</span> : `${a.commission_pct}%`}
                    </td>
                    <td className="num hide-sm">
                      {dealEdit && d ? (
                        d.commission_basis === 'mor' ? <input type="text" inputMode="decimal" value={d.settlement_pct} onChange={(e) => setDeals({ ...deals, [a.account.id]: { ...d, settlement_pct: e.target.value } })} style={{ width: 70, textAlign: 'right' }} /> : <span className="sub">–</span>
                      ) : a.commission_basis === 'mor' ? `${a.settlement_pct}%` : <span className="sub">–</span>}
                    </td>
                    <td className="num">
                      {dealEdit && d ? (
                        d.commission_basis === 'mor' ? <input type="text" inputMode="decimal" value={d.net_settlement} onChange={(e) => setDeals({ ...deals, [a.account.id]: { ...d, net_settlement: e.target.value } })} placeholder="actual" style={{ width: 110, textAlign: 'right' }} /> : <span className="sub">–</span>
                      ) : a.commission_basis === 'mor' ? (
                        a.net_settlement !== null ? fmtMoney(a.net_settlement, cur) : <span className="sub">not entered</span>
                      ) : <span className="sub">–</span>}
                    </td>
                    <td className="num">
                      {fmtMoney(a.base_amount, cur)}
                      {a.base_source === 'settlement_estimate' && <div className="sub">estimate</div>}
                    </td>
                    <td className="num"><b>{fmtMoney(a.agency_billing, cur)}</b></td>
                    <td className="num">{fmtMoney(a.am_share, cur)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7}><b>Total</b></td>
                <td className="num"><b>{fmtMoney(data.totals.agency_billing, cur)}</b></td>
                <td className="num"><b>{fmtMoney(data.totals.am_share, cur)}</b></td>
              </tr>
            </tfoot>
          </table>

          <h2>AM share by account manager</h2>
          <table>
            <thead><tr><th>AM</th><th className="num">Accounts</th><th className="num">Agency billing</th><th className="num">AM share ({data.settings.am_share_pct}%)</th></tr></thead>
            <tbody>
              {data.ams.map((a) => (
                <tr key={a.am_name}>
                  <td><b>{a.am_name}</b></td>
                  <td className="num">{a.accounts}</td>
                  <td className="num">{fmtMoney(a.agency_billing, cur)}</td>
                  <td className="num"><b>{fmtMoney(a.am_share, cur)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}


const PRESETS: { key: string; label: string; days?: number; month?: 'this' | 'last' }[] = [
  { key: '7', label: 'Last 7 days', days: 7 }, { key: '14', label: 'Last 14 days', days: 14 }, { key: '30', label: 'Last 30 days', days: 30 }, { key: '90', label: 'Last 90 days', days: 90 }, { key: 'this', label: 'This month', month: 'this' }, { key: 'last', label: 'Last month', month: 'last' },
];

function presetRange(p: (typeof PRESETS)[number]): { from: string; to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000);
  if (p.days) return { from: iso(new Date(yesterday.getTime() - (p.days - 1) * 86400000)), to: iso(yesterday) };
  const now = new Date();
  if (p.month === 'this') return { from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to: iso(yesterday) };
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { from: iso(start), to: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))) };
}

/** Date explorer: any range, per account and shop, against the same-length period before it. */
function Explorer({ accounts, currency }: { accounts: Account[]; currency: string }) {
  const [range, setRange] = useState(() => presetRange(PRESETS[2]));
  const [preset, setPreset] = useState('30');
  const [accountId, setAccountId] = useState('');
  const [data, setData] = useState<GmvExplore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (!range.from || !range.to || range.from > range.to) return;
    api.gmvExplore(range.from, range.to, accountId ? Number(accountId) : null).then((d) => { setData(d); setError(null); }).catch((e) => setError((e as Error).message));
  }, [range, accountId]);
  const pick = (key: string) => { setPreset(key); const p = PRESETS.find((x) => x.key === key); if (p) setRange(presetRange(p)); };
  const cur = data?.currency ?? currency;
  return (
    <>
      <div className="page-head" style={{ marginTop: 28 }}>
        <div>
          <h2 style={{ margin: 0 }}>Explore by date</h2>
          <p className="hint" style={{ margin: 0 }}>Any range, per account and shop, against the same number of days just before it. Daily rows come from the Windsor and Cruva syncs (45 days back every morning, so last month is always complete).</p>
        </div>
      </div>
      <div className="toolbar">
        <select value={preset} onChange={(e) => pick(e.target.value)}>{PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}<option value="custom">Custom</option></select>
        <input type="date" value={range.from} max={range.to} onChange={(e) => { setPreset('custom'); setRange({ ...range, from: e.target.value }); }} />
        <span className="sub">to</span>
        <input type="date" value={range.to} min={range.from} onChange={(e) => { setPreset('custom'); setRange({ ...range, to: e.target.value }); }} />
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        {data && <span className="sub">{data.days} day{data.days === 1 ? '' : 's'} vs {data.prev_from} to {data.prev_to}{data.last_synced ? ` · synced ${fmtRelative(data.last_synced)}` : ''}</span>}
      </div>
      {error && <div className="banner crit">{error}</div>}
      {data && (
        <>
          <div className="kpis">
            <div className="kpi"><div className="v">{fmtMoney(data.totals.gmv, cur)}</div><div className="k">GMV {data.from} to {data.to}</div></div>
            <div className="kpi"><div className="v">{fmtMoney(data.totals.prev_gmv, cur)}</div><div className="k">the {data.days} days before</div><div className="d">{data.prev_from} to {data.prev_to}</div></div>
            <div className="kpi"><div className="v"><UpDown value={data.totals.change_pct} /></div><div className="k">change</div></div>
            <div className="kpi"><div className="v">{data.totals.units.toLocaleString()}</div><div className="k">units</div><div className="d">{data.days ? fmtMoney(data.totals.gmv / data.days, cur) : ''} per day</div></div>
          </div>
          <DailyBars daily={data.totals.daily} currency={cur} />
          <table>
            <thead><tr><th>Account</th><th className="hide-sm">Daily</th><th className="num">GMV</th><th className="num hide-sm">Affiliate</th><th className="num hide-sm">Units</th><th className="num">Before</th><th className="num">Change</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <>
                  <tr key={r.account_id ?? r.account_name} className="clickable" onClick={() => setOpen(open === r.account_id ? null : r.account_id)}>
                    <td><b>{r.account_name}</b><div className="sub">{r.shops.length} shop{r.shops.length === 1 ? '' : 's'}</div></td>
                    <td className="hide-sm"><Spark points={r.daily} /></td>
                    <td className="num">{fmtMoney(r.gmv, cur)}</td>
                    <td className="num hide-sm sub">{fmtMoney(r.affiliate_gmv, cur)}</td>
                    <td className="num hide-sm">{r.units.toLocaleString()}</td>
                    <td className="num sub">{fmtMoney(r.prev_gmv, cur)}</td>
                    <td className="num"><UpDown value={r.change_pct} /></td>
                  </tr>
                  {open === r.account_id && (
                    <tr key={`${r.account_id}-shops`} className="expand"><td colSpan={7}>
                      <table><thead><tr><th>Shop</th><th>Source</th><th className="num">GMV ({cur})</th><th className="num">Before</th><th className="num">Change</th><th className="num">Units</th></tr></thead><tbody>
                        {r.shops.map((s) => <tr key={s.shop_id}><td>{s.shop_name}</td><td className="sub">{s.source}</td><td className="num">{fmtMoney(s.gmv, cur)}</td><td className="num sub">{fmtMoney(s.prev_gmv, cur)}</td><td className="num"><UpDown value={s.prev_gmv > 0 ? Math.round(((s.gmv - s.prev_gmv) / s.prev_gmv) * 100) : null} /></td><td className="num">{s.units.toLocaleString()}</td></tr>)}
                      </tbody></table>
                    </td></tr>
                  )}
                </>
              ))}
              {data.rows.length === 0 && <tr><td colSpan={7} className="sub">No GMV rows in this range. Sync GMV (Windsor or Cruva) or import rows.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

/** Daily GMV for the range with the period before as a faint line behind it. */
function DailyBars({ daily, currency }: { daily: { date: string; gmv: number; prev_gmv: number }[]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (daily.length < 2) return null;
  const w = 720, h = 120, pad = 4;
  const max = Math.max(...daily.map((d) => Math.max(d.gmv, d.prev_gmv)), 1);
  const x = (i: number) => pad + (i / (daily.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - (v / max) * (h - 2 * pad);
  const line = (k: 'gmv' | 'prev_gmv') => daily.map((d, i) => `${x(i)},${y(d[k])}`).join(' ');
  return (
    <div className="card" style={{ marginBottom: 14, overflow: 'hidden' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} onMouseLeave={() => setHover(null)} onMouseMove={(e) => { const r = (e.target as SVGElement).closest('svg')!.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width) * (daily.length - 1)); setHover(Math.max(0, Math.min(daily.length - 1, i))); }}>
        <polyline points={line('prev_gmv')} fill="none" stroke="var(--faint)" strokeWidth="1" strokeDasharray="3 3" />
        <polyline points={line('gmv')} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad} y2={h - pad} stroke="var(--border)" />}
      </svg>
      <div className="sub" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{daily[0].date}</span>
        <span>{hover !== null ? `${daily[hover].date}: ${fmtMoney(daily[hover].gmv, currency)} (before: ${fmtMoney(daily[hover].prev_gmv, currency)})` : 'Solid: this range · dotted: the period before, day by day'}</span>
        <span>{daily[daily.length - 1].date}</span>
      </div>
    </div>
  );
}

/** Windsor.ai: the TikTok Shop connector that holds the shop authorisations. Discover shops, link them to accounts, sync orders into daily GMV. */
export function WindsorPanel({ onSynced }: { onSynced: () => void }) {
  const [st, setSt] = useState<WindsorStatus | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'info' | 'crit'; text: string } | null>(null);
  useEffect(() => {
    api.windsorStatus().then(setSt).catch((e) => setMsg({ kind: 'crit', text: (e as Error).message }));
    api.listAccounts().then((r) => setAccounts(r.accounts.map((x) => x.account))).catch(() => undefined);
  }, []);
  const run = async (key: string, fn: () => Promise<WindsorStatus | void>, done?: (r: WindsorStatus | void) => string) => {
    setBusy(key); setMsg(null);
    try { const r = await fn(); if (r) setSt(r); if (done) setMsg({ kind: 'info', text: done(r) }); } catch (e) { setMsg({ kind: 'crit', text: (e as Error).message }); } finally { setBusy(null); }
  };
  if (!st) return <div className="card" style={{ marginBottom: 16 }}><p className="sub">Loading Windsor status…</p></div>;
  const linkedIds = new Map(st.shops.map((s) => [s.shop_id, s]));
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Windsor.ai · TikTok Shop connector</h3>
      {!st.configured ? (
        <div className="banner warn"><b>WINDSOR_API_KEY is not set.</b> Windsor.ai › API key, paste it into <code>.env</code>, restart. Windsor already holds the shop authorisations, so no Partner Center app is needed for reading.</div>
      ) : (
        <p className="hint">Key set{st.last_sync_at ? `, last sync ${fmtRelative(st.last_sync_at)}` : ', never synced'}. Discover reads the shop list from the connector and links the ones whose name matches an account; Sync writes the last 40 days of orders into daily GMV for every linked shop (orders placed that day, cancelled ones excluded).</p>
      )}
      {st.last_error && <div className="banner crit">Last sync error: {st.last_error}</div>}
      {msg && <div className={`banner ${msg.kind}`}>{msg.text}</div>}
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="small" disabled={!st.configured || busy !== null} onClick={() => run('test', async () => { const r = await api.windsorTest(); const dbg = r.shops === 0 && r.debug ? ` Shop query: HTTP ${r.debug.shops_call?.status ?? '?'} ${r.debug.shops_call?.url ?? ''} → ${r.debug.shops_call?.body ?? ''} | Orders (30d): ${r.debug.orders_30d_rows ?? '?'} rows${r.debug.orders_call ? ` (HTTP ${r.debug.orders_call.status ?? '?'}: ${r.debug.orders_call.body.slice(0, 300)})` : ''}` : ''; setMsg({ kind: r.shops ? 'info' : 'crit', text: `Connected: ${r.shops} shop(s) on the connector, ${r.linked} linked${r.sample.length ? `, e.g. ${r.sample.join(', ')}` : ''}.${dbg}` }); setSt(await api.windsorStatus()); })}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        <button className="small" disabled={!st.configured || busy !== null} onClick={() => run('disc', () => api.windsorDiscover(), (r) => `${(r as WindsorStatus & { found: number; linked: number }).found} shop(s) found, ${(r as WindsorStatus & { linked: number }).linked} newly linked by name.`)}>{busy === 'disc' ? 'Discovering…' : 'Discover shops'}</button>
        <button className="small primary" disabled={!st.configured || busy !== null || st.shops.length === 0} onClick={() => run('sync', async () => { const r = await api.windsorSync(40); onSynced(); return r; }, (r) => `Synced ${(r as WindsorStatus & { synced_shops: number; rows: number }).synced_shops} shop(s), ${(r as WindsorStatus & { rows: number }).rows} daily rows.`)}>{busy === 'sync' ? 'Syncing…' : 'Sync GMV now'}</button>
      </div>
      {st.discovered.length === 0 ? <p className="sub">No shops discovered yet.</p> : (
        <table>
          <thead><tr><th>Shop on Windsor</th><th>Market</th><th>Linked account</th><th></th></tr></thead>
          <tbody>
            {st.discovered.map((d) => {
              const link = linkedIds.get(d.account_id);
              return (
                <tr key={d.account_id}>
                  <td><b>{d.shop_name || d.account_name}</b><div className="sub mono">{d.account_id}</div></td>
                  <td>{d.market}</td>
                  <td>
                    <select value={link?.account_id ?? ''} disabled={busy !== null} onChange={(e) => { const id = Number(e.target.value); if (id) void run('link', () => api.windsorLink(d.account_id, id, d.shop_name || d.account_name)); else if (link) void run('unlink', () => api.windsorUnlink(link.id)); }} style={{ width: 'auto' }}>
                      <option value="">not linked</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </td>
                  <td className="sub">{link ? `${link.currency} · counted in GMV` : 'not counted'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
