import { useCallback, useEffect, useState } from 'react';
import type { PnlData, PnlForecastInputs, PnlInputs, PnlLine, PnlSummaryRow } from '../../../sweep/types';
import { api, currentMonth, fmtMoney, fmtRelative, monthLabel, shiftMonth, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { useAccountScope, useAllowedAccounts, useInScope } from '../hubs';
import { AccountGroup, GroupsHead, useOpenGroups, type GroupLight } from '../groups';
import { LineChart, StackedBars } from '../charts';

/**
 * Accounts > P&L: profit and loss per account and month. GMV, affiliate GMV and units come from the synced
 * figures; fees, COGS (blended or per SKU), ads, samples and the agency deal are inputs that carry forward
 * month to month. The forecast rolls the month forward with growth, ad and sampling assumptions, and the
 * CSV is the client-facing sheet with live formulas.
 */
const PCT = (n: number | null) => (n === null ? '–' : `${n.toFixed(1)}%`);
const signed = (n: number, cur: string) => (n < 0 ? `−${fmtMoney(-n, cur)}` : fmtMoney(Math.abs(n), cur));

export default function PnlPage() {
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows] = useState<PnlSummaryRow[] | null>(null);
  const [currentM, setCurrentM] = useState(currentMonth());
  const [error, setError] = useState<string | null>(null);
  const groups = useOpenGroups('pnl');
  const scope = useAccountScope();
  const inScope = useInScope();
  const allowed = useAllowedAccounts();
  const load = useCallback(() => api.pnlSummary(month).then((r) => { setRows(r.rows); setCurrentM(r.current_month); }).catch((e) => setError((e as Error).message)), [month]);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'reports' || e.kind === 'cruva') load(); });
  if (!rows) return <p>{error ?? 'Loading…'}</p>;
  const mine = rows.filter((r) => inScope(r.account_id));
  const order: GroupLight[] = ['red', 'amber', 'green', 'grey'];
  const sorted = [...mine].sort((a, b) => order.indexOf(a.light) - order.indexOf(b.light) || b.gmv - a.gmv || a.account_name.localeCompare(b.account_name));
  const cur = mine[0]?.currency ?? 'EUR';
  const tot = (k: 'gmv' | 'net' | 'agency_billing') => mine.reduce((n, r) => n + r[k], 0);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>P&amp;L</h1>
          <p className="hint" style={{ margin: 0 }}>Profit and loss per account: GMV from the shop data, every cost from the inputs the AM keeps (they carry forward month to month). Green at 20% net margin or better, amber from 5%, red below. Open an account for the charts, the per-SKU costs, the forecast and the client CSV.</p>
        </div>
        <div className="actions">
          <button className="small" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <b>{monthLabel(month)}</b>
          <button className="small" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= shiftMonth(currentM, 12)}>›</button>
          {month !== currentM && <button className="small" onClick={() => setMonth(currentM)}>This month</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{fmtMoney(tot('gmv'), cur)}</span><span className="k">GMV {month === currentM ? 'month to date' : monthLabel(month)}</span></div>
        <div className="stat"><span className="v">{signed(tot('net'), cur)}</span><span className="k">client net profit</span></div>
        <div className="stat"><span className="v">{fmtMoney(tot('agency_billing'), cur)}</span><span className="k">Brightform billing</span></div>
        <div className="stat"><span className="v">{mine.filter((r) => r.has_inputs).length}/{mine.length}</span><span className="k">accounts with inputs</span></div>
      </div>
      {sorted.length === 0 ? <div className="empty">No enabled accounts.</div> : (
        <>
          <GroupsHead items={sorted.length} lights={sorted.map((r) => r.light)} open={sorted.every((r) => groups.isOpen(r.account_id))} onAll={(o) => groups.setAll(sorted.map((r) => r.account_id), o)} />
          <div className="areas">
            {sorted.map((r) => (
              <AccountGroup key={r.account_id} light={r.light} name={r.account_name} sub={r.markets ?? undefined} open={groups.isOpen(r.account_id)} onToggle={() => groups.toggle(r.account_id)}
                summary={r.gmv > 0 ? `GMV ${fmtMoney(r.gmv, r.currency)} · net ${signed(r.net, r.currency)} · margin ${PCT(r.margin_pct)}` : 'No GMV this month yet'}
                nums={<><span className="num"><span className="k">Billing</span><span className="v">{fmtMoney(r.agency_billing, r.currency)}</span></span><span className={`num ${r.light === 'red' ? 'crit' : r.light === 'amber' ? 'warn' : ''}`}><span className="k">Margin</span><span className="v">{PCT(r.margin_pct)}</span></span></>}
                right={!r.has_inputs ? <span className="badge muted" title="Defaults in use: open to enter the real fees and costs">defaults</span> : null}>
                {groups.isOpen(r.account_id) && <PnlAccount accountId={r.account_id} month={month} onSaved={load} />}
              </AccountGroup>
            ))}
          </div>
        </>
      )}
    </>
  );
}

const INPUT_FIELDS: { key: keyof PnlInputs; label: string; help: string; step?: number; money?: boolean }[] = [
  { key: 'platform_fee_pct', label: 'TikTok platform fee %', help: 'Commission TikTok keeps on GMV' , step: 0.1 },
  { key: 'creator_commission_pct', label: 'Creator commission %', help: 'On affiliate GMV only', step: 0.1 },
  { key: 'shipping_pct', label: 'Shipping & fulfilment %', help: 'Of GMV', step: 0.1 },
  { key: 'agency_fee', label: 'Agency fee', help: 'Brightform retainer for the month', money: true },
  { key: 'agency_commission_pct', label: 'Agency commission %', help: 'From the deal on the account; of GMV or of the settlement for MoR deals', step: 0.1 },
  { key: 'ad_spend', label: 'Ad spend', help: 'GMV Max and other ads this month', money: true },
  { key: 'samples_sent', label: 'Samples sent', help: 'Units sent to creators' },
  { key: 'sample_unit_cost', label: 'Cost per sample', help: 'Product + shipping', money: true, step: 0.01 },
  { key: 'other_costs', label: 'Other costs', help: 'Anything else for the month', money: true },
];

function PnlAccount({ accountId, month, onSaved }: { accountId: number; month: string; onSaved: () => void }) {
  const [d, setD] = useState<PnlData | null>(null);
  const [form, setForm] = useState<PnlInputs | null>(null);
  const [fc, setFc] = useState<PnlForecastInputs | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'pnl' | 'inputs' | 'forecast'>('pnl');
  const isAdmin = useIsAdmin();
  useEffect(() => { api.pnl(accountId, month).then((x) => { setD(x); setForm(x.inputs); setFc(x.forecast_inputs); }).catch((e) => setError((e as Error).message)); }, [accountId, month]);
  const run = async (key: string, fn: () => Promise<PnlData>) => {
    setBusy(key); setError(null);
    try { const x = await fn(); setD(x); setForm(x.inputs); setFc(x.forecast_inputs); onSaved(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!d || !form || !fc) return <p className="sub">{error ?? 'Loading…'}</p>;
  const cur = d.currency;
  const all = [...d.history, d.current, ...d.forecast];
  const line = (m: typeof d.current, key: string) => m.lines.find((l) => l.key === key)?.amount ?? 0;
  const dirty = JSON.stringify(form) !== JSON.stringify(d.inputs);
  const fcDirty = JSON.stringify(fc) !== JSON.stringify(d.forecast_inputs);
  const kpi = (k: string, v: string, t?: string, cls = '') => <div className="kpi"><div className="k">{k}</div><div className={`v ${cls}`}>{v}</div>{t ? <div className="t">{t}</div> : null}</div>;
  const c = d.current;
  const fcTotal = d.forecast.reduce((n, m) => n + m.net, 0);
  return (
    <div>
      {error && <div className="banner crit">{error}</div>}
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div className="presets">
          <button className={tab === 'pnl' ? 'active' : ''} onClick={() => setTab('pnl')}>P&amp;L</button>
          <button className={tab === 'inputs' ? 'active' : ''} onClick={() => setTab('inputs')}>Inputs{!d.history.length && !c.gmv ? '' : ''}</button>
          <button className={tab === 'forecast' ? 'active' : ''} onClick={() => setTab('forecast')}>Forecast</button>
        </div>
        <div className="actions">
          <span className="sub">{c.actual && c.days_with_data ? `${c.days_with_data} day${c.days_with_data === 1 ? '' : 's'} of data` : 'no sales data this month'}{c.cogs_source === 'sku' ? ' · COGS per SKU' : c.cogs_source === 'blended' ? ` · COGS ${c.inputs.cogs_pct}% blended` : ''}</span>
          <a className="button primary" href={api.pnlCsvUrl(accountId, month)} download title="Client-facing P&L with the Brightform header, an inputs block and live formulas per month">Download client P&amp;L (CSV)</a>
        </div>
      </div>

      <div className="kpis">
        {kpi('GMV', fmtMoney(c.gmv, cur), `affiliate ${fmtMoney(c.affiliate_gmv, cur)} · ${c.units} units`)}
        {kpi('Net revenue', fmtMoney(line(c, 'net_revenue'), cur), 'after TikTok and creator commission')}
        {kpi('Gross profit', signed(line(c, 'gross_profit'), cur), 'after COGS and shipping')}
        {kpi('Net profit', signed(c.net, cur), `margin ${PCT(c.margin_pct)}`, c.net < 0 ? 'crit' : '')}
        {kpi('Brightform billing', fmtMoney(c.agency_billing, cur), `fee ${fmtMoney(c.inputs.agency_fee, cur)} + commission ${fmtMoney(Math.abs(line(c, 'agency_commission')), cur)}`)}
        {kpi(`Forecast net, next ${d.forecast.length} mo`, signed(fcTotal, cur), `${d.forecast_inputs.gmv_growth_pct}% growth / month`)}
      </div>

      {tab === 'pnl' && (
        <>
          <div className="charts" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 12 }}>
            <StackedBars title="Where the GMV goes" note="actuals then forecast" currency={cur}
              days={all.map((m) => ({ date: m.month, values: [Math.max(0, m.net), -line(m, 'cogs') - line(m, 'shipping'), -line(m, 'platform_fee') - line(m, 'creator_commission'), -line(m, 'ads') - line(m, 'samples') - line(m, 'other'), m.agency_billing] }))}
              series={[{ label: 'Net profit', color: 'var(--s1)' }, { label: 'COGS + shipping', color: 'var(--s2)' }, { label: 'TikTok + creators', color: 'var(--s3)' }, { label: 'Ads + samples + other', color: 'var(--warn)' }, { label: 'Brightform', color: 'var(--muted)' }]} />
            <LineChart title="GMV" note="six months of actuals, this month, then the forecast" kind="money" currency={cur} points={all.map((m) => ({ date: m.month, value: m.gmv }))} />
            <LineChart title="Net margin %" kind="pct" points={all.map((m) => ({ date: m.month, value: m.margin_pct ?? 0 }))} />
          </div>
          <div className="grid-wrap"><table className="pnl"><thead><tr><th>Line</th>{all.map((m) => <th key={m.month} className={`num ${m.actual ? '' : 'sub'}`} title={m.actual ? 'Actual' : 'Forecast'}>{monthLabel(m.month).slice(0, 3)} {m.month.slice(2, 4)}{m.month === month ? ' ●' : ''}{!m.actual ? ' ƒ' : ''}</th>)}</tr></thead><tbody>
            {c.lines.map((l: PnlLine) => (
              <tr key={l.key} className={l.kind === 'result' ? 'total' : ''}>
                <td>{l.kind === 'result' ? <b>{l.label}</b> : l.label}{l.note ? <div className="sub">{l.note}</div> : null}</td>
                {all.map((m) => { const a = m.lines.find((x) => x.key === l.key); const v = a?.amount ?? 0; return <td key={m.month} className={`num ${l.kind === 'result' ? '' : 'sub'} ${l.kind === 'result' && v < 0 ? 'crit' : ''}`}>{v === 0 && l.kind !== 'result' ? '' : signed(v, cur)}{l.kind === 'result' && a?.pct_of_gmv !== null && a?.pct_of_gmv !== undefined && l.key !== 'gmv' ? <div className="sub">{PCT(a.pct_of_gmv)}</div> : null}</td>; })}
              </tr>
            ))}
            <tr><td><b>Brightform billing</b></td>{all.map((m) => <td key={m.month} className="num">{fmtMoney(m.agency_billing, cur)}</td>)}</tr>
          </tbody></table></div>
          <p className="help">● this month · ƒ forecast. Months without inputs of their own use the latest month that has.</p>
        </>
      )}

      {tab === 'inputs' && (
        <div className="card">
          <h4 style={{ marginTop: 0 }}>Inputs for {monthLabel(month)} <span className="sub">in {cur}; saved per month and carried forward</span></h4>
          <div className="inline-form" style={{ marginBottom: 10 }}>
            {INPUT_FIELDS.map((f) => (
              <label key={f.key} className="field" style={{ minWidth: 150 }} title={f.help}><span className="lbl">{f.label}</span><input type="number" min={0} step={f.step ?? 1} value={form[f.key] as number} disabled={!isAdmin} onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })} /><span className="help">{f.help}</span></label>
            ))}
          </div>
          <div className="inline-form" style={{ marginBottom: 10 }}>
            <label className="field" style={{ minWidth: 180 }}><span className="lbl">Cost of goods</span><select value={form.cogs_mode} disabled={!isAdmin} onChange={(e) => setForm({ ...form, cogs_mode: e.target.value as 'blended' | 'sku' })}><option value="blended">Blended % of GMV</option><option value="sku">Per SKU (unit cost × sales mix)</option></select></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">COGS % of GMV</span><input type="number" min={0} step={0.1} value={form.cogs_pct} disabled={!isAdmin} onChange={(e) => setForm({ ...form, cogs_pct: Number(e.target.value) })} /><span className="help">{form.cogs_mode === 'sku' ? 'Fallback for SKUs without a cost and the forecast' : 'Blended across all SKUs'}</span></label>
            <label className="field" style={{ flex: 1, minWidth: 240 }}><span className="lbl">Notes</span><input type="text" value={form.notes} disabled={!isAdmin} placeholder="e.g. Q4 retainer agreed at…" onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
            {isAdmin && <button className="primary" disabled={!dirty || busy === 'inputs'} onClick={() => run('inputs', () => api.pnlInputs(accountId, month, form))}>{busy === 'inputs' ? 'Saving…' : 'Save inputs'}</button>}
            {dirty && <button onClick={() => setForm(d.inputs)}>Discard</button>}
          </div>
          {form.cogs_mode === 'sku' && (
            <>
              <h4>Unit cost per SKU <span className="sub">from the stock snapshots of this account; weighted by each SKU's last 30 days of sales</span></h4>
              {d.skus.length === 0 ? <div className="empty">No SKUs known for this account yet. The Stock tab fills them in once a shop has a snapshot.</div> : (
                <div className="grid-wrap"><table><thead><tr><th>SKU</th><th>Product</th><th>Shop</th><th className="num">Sold 30d</th><th className="num">Unit cost ({cur})</th><th>Updated</th></tr></thead><tbody>
                  {d.skus.map((s) => { const p = d.sku_cogs.find((x) => x.key === s.key); return (
                    <tr key={`${s.shop_name}-${s.key}`}>
                      <td><b>{s.key}</b></td><td>{s.label}</td><td className="sub">{s.shop_name}</td><td className="num">{s.sold_30d}</td>
                      <td className="num"><input type="number" min={0} step={0.01} style={{ width: 90 }} defaultValue={p?.cogs ?? ''} disabled={!isAdmin} key={`${s.key}-${p?.updated_at ?? ''}`} onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== (p?.cogs ?? null)) void run(`sku${s.key}`, () => api.pnlSkuCogs(accountId, month, { key: s.key, label: s.label, cogs: v, currency: cur })); }} /></td>
                      <td className="sub">{p?.updated_at ? fmtRelative(p.updated_at) : '–'}</td>
                    </tr>
                  ); })}
                </tbody></table></div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'forecast' && (
        <div className="card">
          <h4 style={{ marginTop: 0 }}>Forecast assumptions <span className="sub">starting from this month ({c.days_with_data && c.days_with_data < 28 ? 'scaled to a full month' : 'as is'})</span></h4>
          <div className="inline-form" style={{ marginBottom: 10 }}>
            <label className="field" style={{ minWidth: 120 }}><span className="lbl">Months ahead</span><input type="number" min={1} max={24} value={fc.months} disabled={!isAdmin} onChange={(e) => setFc({ ...fc, months: Number(e.target.value) })} /></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">GMV growth % / month</span><input type="number" step={0.5} value={fc.gmv_growth_pct} disabled={!isAdmin} onChange={(e) => setFc({ ...fc, gmv_growth_pct: Number(e.target.value) })} /><span className="help">Organic, compounding; negative for a decline</span></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">Ad spend / month</span><input type="number" min={0} value={fc.ad_spend} disabled={!isAdmin} onChange={(e) => setFc({ ...fc, ad_spend: Number(e.target.value) })} /></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">Ad ROI (GMV per 1 spent)</span><input type="number" min={0} step={0.1} value={fc.ad_roi} disabled={!isAdmin} onChange={(e) => setFc({ ...fc, ad_roi: Number(e.target.value) })} /><span className="help">Adds spend × ROI of GMV each month</span></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">Samples / month</span><input type="number" min={0} value={fc.samples_per_month} disabled={!isAdmin} onChange={(e) => setFc({ ...fc, samples_per_month: Number(e.target.value) })} /><span className="help">Costed at the sample unit cost</span></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">GMV per sample</span><input type="number" min={0} value={fc.sample_gmv_each} disabled={!isAdmin} onChange={(e) => setFc({ ...fc, sample_gmv_each: Number(e.target.value) })} /><span className="help">Expected GMV each sample brings</span></label>
            <label className="field check"><input type="checkbox" checked={fc.keep_fees} disabled={!isAdmin} onChange={(e) => setFc({ ...fc, keep_fees: e.target.checked })} /> Keep agency fee and commission</label>
            {isAdmin && <button className="primary" disabled={!fcDirty || busy === 'fc'} onClick={() => run('fc', () => api.pnlForecast(accountId, month, fc))}>{busy === 'fc' ? 'Applying…' : 'Apply forecast'}</button>}
            {fcDirty && <button onClick={() => setFc(d.forecast_inputs)}>Discard</button>}
          </div>
          <div className="grid-wrap"><table><thead><tr><th>Month</th><th className="num">GMV</th><th className="num">Net revenue</th><th className="num">Gross profit</th><th className="num">Ads</th><th className="num">Samples</th><th className="num">Brightform</th><th className="num">Net profit</th><th className="num">Margin</th></tr></thead><tbody>
            {[c, ...d.forecast].map((m) => (
              <tr key={m.month} className={m.actual ? 'total' : ''}>
                <td>{monthLabel(m.month)}{m.actual ? <span className="badge muted" style={{ marginLeft: 6 }}>actual{m.days_with_data && m.days_with_data < 28 ? ' to date' : ''}</span> : <span className="badge accent" style={{ marginLeft: 6 }}>forecast</span>}</td>
                <td className="num">{fmtMoney(m.gmv, cur)}</td><td className="num">{fmtMoney(line(m, 'net_revenue'), cur)}</td><td className="num">{signed(line(m, 'gross_profit'), cur)}</td>
                <td className="num sub">{fmtMoney(Math.abs(line(m, 'ads')), cur)}</td><td className="num sub">{fmtMoney(Math.abs(line(m, 'samples')), cur)}</td><td className="num">{fmtMoney(m.agency_billing, cur)}</td>
                <td className={`num ${m.net < 0 ? 'crit' : ''}`}><b>{signed(m.net, cur)}</b></td><td className="num">{PCT(m.margin_pct)}</td>
              </tr>
            ))}
            <tr className="total"><td><b>Forecast total</b></td><td className="num"><b>{fmtMoney(d.forecast.reduce((n, m) => n + m.gmv, 0), cur)}</b></td><td /><td /><td className="num sub">{fmtMoney(Math.abs(d.forecast.reduce((n, m) => n - line(m, 'ads'), 0)), cur)}</td><td className="num sub">{fmtMoney(Math.abs(d.forecast.reduce((n, m) => n - line(m, 'samples'), 0)), cur)}</td><td className="num"><b>{fmtMoney(d.forecast.reduce((n, m) => n + m.agency_billing, 0), cur)}</b></td><td className={`num ${fcTotal < 0 ? 'crit' : ''}`}><b>{signed(fcTotal, cur)}</b></td><td /></tr>
          </tbody></table></div>
        </div>
      )}
    </div>
  );
}
