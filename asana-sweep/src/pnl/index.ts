import type { Queries } from '../db/queries.js';
import type { Account, PnlData, PnlForecastInputs, PnlInputs, PnlLine, PnlMonth, PnlSkuCogs, PnlSummaryRow } from '../sweep/types.js';
import { monthRange, previousMonth } from '../checklist/calendar.js';
import { todayIn } from '../checklist/checker.js';
import { toReportCurrency } from '../gmv/currency.js';
import { gmvSettings, shopsForGmv } from '../reports/index.js';

/**
 * Profit and loss per account and month. GMV, affiliate GMV and units come from the synced daily figures
 * (Windsor first, Cruva where Windsor has nothing); everything else is an input the AM keeps per month.
 * Inputs carry forward: a month with nothing saved uses the latest month that has, so a client with a
 * fixed deal only needs entering once. The forecast rolls the current month forward with the growth,
 * ad and sampling assumptions, and the CSV ships the same model as live spreadsheet formulas.
 */

export const PNL_DEFAULTS: PnlInputs = {
  platform_fee_pct: 9, creator_commission_pct: 15, agency_fee: 0, agency_commission_pct: 0,
  cogs_mode: 'blended', cogs_pct: 30, shipping_pct: 8, ad_spend: 0, samples_sent: 0, sample_unit_cost: 0, other_costs: 0, notes: '',
};

export const DEFAULT_FORECAST: PnlForecastInputs = { months: 6, gmv_growth_pct: 10, ad_spend: 0, ad_roi: 3, samples_per_month: 0, sample_gmv_each: 0, keep_fees: true };

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

export function normaliseInputs(raw: Partial<PnlInputs> | null | undefined, base: PnlInputs): PnlInputs {
  const r = raw ?? {};
  return {
    platform_fee_pct: num(r.platform_fee_pct, base.platform_fee_pct),
    creator_commission_pct: num(r.creator_commission_pct, base.creator_commission_pct),
    agency_fee: num(r.agency_fee, base.agency_fee),
    agency_commission_pct: num(r.agency_commission_pct, base.agency_commission_pct),
    cogs_mode: r.cogs_mode === 'sku' ? 'sku' : r.cogs_mode === 'blended' ? 'blended' : base.cogs_mode,
    cogs_pct: num(r.cogs_pct, base.cogs_pct),
    shipping_pct: num(r.shipping_pct, base.shipping_pct),
    ad_spend: num(r.ad_spend, base.ad_spend),
    samples_sent: num(r.samples_sent, base.samples_sent),
    sample_unit_cost: num(r.sample_unit_cost, base.sample_unit_cost),
    other_costs: num(r.other_costs, base.other_costs),
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 2000) : base.notes,
  };
}

export function normaliseForecast(raw: Partial<PnlForecastInputs> | null | undefined, base: PnlForecastInputs = DEFAULT_FORECAST): PnlForecastInputs {
  const r = raw ?? {};
  return {
    months: Math.min(Math.max(Math.round(num(r.months, base.months)), 1), 24),
    gmv_growth_pct: num(r.gmv_growth_pct, base.gmv_growth_pct),
    ad_spend: num(r.ad_spend, base.ad_spend),
    ad_roi: num(r.ad_roi, base.ad_roi),
    samples_per_month: num(r.samples_per_month, base.samples_per_month),
    sample_gmv_each: num(r.sample_gmv_each, base.sample_gmv_each),
    keep_fees: typeof r.keep_fees === 'boolean' ? r.keep_fees : base.keep_fees,
  };
}

/** Account-level defaults: the agency deal recorded on the account is the starting point for the commission. */
export function pnlDefaults(account: Account): PnlInputs {
  return { ...PNL_DEFAULTS, agency_commission_pct: account.commission_pct ?? 0 };
}

/** The inputs for a month: what was saved for it, else the latest saved month before it, else the defaults. */
export function pnlInputsFor(q: Queries, account: Account, month: string): { inputs: PnlInputs; saved: boolean } {
  const defaults = pnlDefaults(account);
  const own = q.getPnlInputs(account.id, month);
  if (own) return { inputs: normaliseInputs(own, defaults), saved: true };
  const prev = q.latestPnlInputs(account.id, month);
  return { inputs: normaliseInputs(prev, defaults), saved: false };
}

export interface MonthFigures { gmv: number; affiliate_gmv: number; units: number; days_with_data: number; by_sku_share: Map<string, number> }

/** GMV, affiliate GMV and units for the month in the report currency, through the same shop selection as the GMV page. */
export function figuresFor(q: Queries, account: Account, month: string): MonthFigures {
  const settings = gmvSettings(q);
  const fx = settings.fx_to_eur;
  const { from, to } = monthRange(month);
  const rows = q.listGmvBetween(from, to);
  const has = new Set(rows.map((r) => r.shop_id));
  const shops = shopsForGmv(q.listShops().filter((s) => s.account_id === account.id), (id) => has.has(id));
  const ids = new Map(shops.map((s) => [s.shop_id, s]));
  let gmv = 0, aff = 0, units = 0;
  const days = new Set<string>();
  for (const r of rows) {
    const shop = ids.get(r.shop_id);
    if (!shop) continue;
    gmv += toReportCurrency(r.total_gmv, shop.currency, fx);
    aff += toReportCurrency(r.affiliate_gmv, shop.currency, fx);
    units += r.units;
    if (r.total_gmv > 0 || r.units > 0) days.add(r.date);
  }
  return { gmv: round2(gmv), affiliate_gmv: round2(aff), units, days_with_data: days.size, by_sku_share: new Map() };
}

/** SKUs known for the account from the stock snapshots, with their 30-day sales as the weight for per-SKU COGS. */
export function skusFor(q: Queries, account: Account): PnlData['skus'] {
  const shops = new Map(q.listShops().map((s) => [s.shop_id, s.shop_name]));
  const tts = new Map(q.listTtsShops().map((s) => [s.id, s.name]));
  return q.listStock().filter((s) => s.account_id === account.id && !s.exclude).map((s) => ({
    key: s.seller_sku || s.sku_id, label: [s.product_title, s.sku_name].filter(Boolean).join(' / '), sold_30d: s.sold_30d, shop_name: shops.get(s.shop_id) ?? tts.get(s.shop_id) ?? s.shop_id,
  }));
}

/**
 * Cost of goods for the month. Per SKU: each priced SKU's unit cost weighted by its share of the last 30 days'
 * units, applied to the month's units (SKUs without a price fall back to the blended percent for their share).
 */
export function cogsFor(inputs: PnlInputs, gmv: number, units: number, skus: PnlData['skus'], prices: PnlSkuCogs[], fx: Record<string, number>): { amount: number; source: PnlMonth['cogs_source']; note: string | null } {
  if (gmv <= 0 && units <= 0) return { amount: 0, source: 'none', note: null };
  if (inputs.cogs_mode === 'sku' && prices.length) {
    const priced = new Map(prices.map((p) => [p.key, toReportCurrency(p.cogs, p.currency, fx)]));
    const total30 = skus.reduce((n, s) => n + s.sold_30d, 0);
    if (total30 > 0) {
      let perUnit = 0, pricedShare = 0;
      for (const s of skus) {
        const share = s.sold_30d / total30;
        const cost = priced.get(s.key);
        if (cost === undefined) continue;
        perUnit += share * cost;
        pricedShare += share;
      }
      const unpriced = Math.max(0, 1 - pricedShare);
      const amount = perUnit * units + unpriced * gmv * (inputs.cogs_pct / 100);
      return { amount: round2(amount), source: 'sku', note: unpriced > 0.005 ? `${Math.round(unpriced * 100)}% of units have no SKU cost; blended ${inputs.cogs_pct}% used for those` : null };
    }
    // No sales weights: a flat average of the priced SKUs.
    const avg = [...priced.values()].reduce((a, b) => a + b, 0) / priced.size;
    return { amount: round2(avg * units), source: 'sku', note: 'no 30-day sales to weight SKUs; flat average unit cost used' };
  }
  return { amount: round2(gmv * (inputs.cogs_pct / 100)), source: inputs.cogs_mode === 'sku' ? 'blended' : 'blended', note: inputs.cogs_mode === 'sku' ? 'no SKU costs entered; blended percent used' : null };
}

export interface ComputeOpts { account: Account; month: string; actual: boolean; inputs: PnlInputs; gmv: number; affiliate_gmv: number; units: number; days_with_data: number; skus: PnlData['skus']; prices: PnlSkuCogs[]; fx: Record<string, number>; settlement: number | null }

export function computeMonth(o: ComputeOpts): PnlMonth {
  const { inputs, gmv, affiliate_gmv, units } = o;
  const pct = (amount: number) => (gmv > 0 ? round2((amount / gmv) * 100) : null);
  const platform = round2(gmv * (inputs.platform_fee_pct / 100));
  const creator = round2(affiliate_gmv * (inputs.creator_commission_pct / 100));
  const netRevenue = round2(gmv - platform - creator);
  const cogs = cogsFor(inputs, gmv, units, o.skus, o.prices, o.fx);
  const shipping = round2(gmv * (inputs.shipping_pct / 100));
  const grossProfit = round2(netRevenue - cogs.amount - shipping);
  const ads = round2(inputs.ad_spend);
  const samples = round2(inputs.samples_sent * inputs.sample_unit_cost);
  // Agency commission: on GMV, or on the settlement (MoR deals) with the estimated settlement until the real one lands.
  const base = o.account.commission_basis === 'mor' ? (o.settlement ?? gmv * (o.account.settlement_pct / 100)) : gmv;
  const commission = round2(base * (inputs.agency_commission_pct / 100));
  const fee = round2(inputs.agency_fee);
  const other = round2(inputs.other_costs);
  const net = round2(grossProfit - ads - samples - fee - commission - other);
  const lines: PnlLine[] = [
    { key: 'gmv', label: 'GMV', amount: gmv, pct_of_gmv: pct(gmv), kind: 'revenue' },
    { key: 'platform_fee', label: `TikTok platform fee (${inputs.platform_fee_pct}%)`, amount: -platform, pct_of_gmv: pct(platform), kind: 'cost' },
    { key: 'creator_commission', label: `Creator commission (${inputs.creator_commission_pct}% of affiliate GMV)`, amount: -creator, pct_of_gmv: pct(creator), kind: 'cost' },
    { key: 'net_revenue', label: 'Net revenue', amount: netRevenue, pct_of_gmv: pct(netRevenue), kind: 'result' },
    { key: 'cogs', label: cogs.source === 'sku' ? 'Cost of goods (per SKU)' : `Cost of goods (${inputs.cogs_pct}% blended)`, amount: -cogs.amount, pct_of_gmv: pct(cogs.amount), kind: 'cost', note: cogs.note },
    { key: 'shipping', label: `Shipping & fulfilment (${inputs.shipping_pct}%)`, amount: -shipping, pct_of_gmv: pct(shipping), kind: 'cost' },
    { key: 'gross_profit', label: 'Gross profit', amount: grossProfit, pct_of_gmv: pct(grossProfit), kind: 'result' },
    { key: 'ads', label: 'Ad spend', amount: -ads, pct_of_gmv: pct(ads), kind: 'cost' },
    { key: 'samples', label: `Samples (${inputs.samples_sent} × ${inputs.sample_unit_cost})`, amount: -samples, pct_of_gmv: pct(samples), kind: 'cost' },
    { key: 'agency_fee', label: 'Agency fee', amount: -fee, pct_of_gmv: pct(fee), kind: 'cost' },
    { key: 'agency_commission', label: `Agency commission (${inputs.agency_commission_pct}%${o.account.commission_basis === 'mor' ? ' of settlement' : ''})`, amount: -commission, pct_of_gmv: pct(commission), kind: 'cost' },
    { key: 'other', label: 'Other costs', amount: -other, pct_of_gmv: pct(other), kind: 'cost' },
    { key: 'net', label: 'Net profit', amount: net, pct_of_gmv: pct(net), kind: 'result' },
  ];
  return {
    month: o.month, actual: o.actual, gmv, affiliate_gmv, units, days_with_data: o.days_with_data, inputs, lines, net,
    margin_pct: gmv > 0 ? round2((net / gmv) * 100) : null, agency_billing: round2(fee + commission), client_profit: net, cogs_source: cogs.source,
  };
}

export function lightOf(m: PnlMonth | null): PnlData['light'] {
  if (!m || m.gmv <= 0) return 'grey';
  if (m.margin_pct === null) return 'grey';
  return m.margin_pct >= 20 ? 'green' : m.margin_pct >= 5 ? 'amber' : 'red';
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Roll the current month forward: GMV compounds with the growth rate, ads add their ROI, samples add their expected GMV. */
export function forecastMonths(q: Queries, account: Account, from: PnlMonth, f: PnlForecastInputs, skus: PnlData['skus'], prices: PnlSkuCogs[], fx: Record<string, number>): PnlMonth[] {
  const out: PnlMonth[] = [];
  // Base GMV: a running month is scaled up to a full month from its elapsed days.
  const dim = Number(monthRange(from.month).to.slice(8, 10));
  const elapsed = Math.max(1, Math.min(from.days_with_data, dim));
  const baseGmv = from.actual && from.days_with_data < dim && from.gmv > 0 ? (from.gmv / elapsed) * dim : from.gmv;
  const affShare = from.gmv > 0 ? from.affiliate_gmv / from.gmv : 0.5;
  const aov = from.units > 0 ? from.gmv / from.units : 0;
  let organic = baseGmv;
  for (let i = 1; i <= f.months; i++) {
    organic = organic * (1 + f.gmv_growth_pct / 100);
    const adGmv = f.ad_spend * f.ad_roi;
    const sampleGmv = f.samples_per_month * f.sample_gmv_each;
    const gmv = round2(organic + adGmv + sampleGmv);
    const month = addMonths(from.month, i);
    const inputs: PnlInputs = { ...from.inputs, ad_spend: f.ad_spend, samples_sent: f.samples_per_month, agency_fee: f.keep_fees ? from.inputs.agency_fee : 0, agency_commission_pct: f.keep_fees ? from.inputs.agency_commission_pct : 0 };
    out.push(computeMonth({ account, month, actual: false, inputs, gmv, affiliate_gmv: round2(gmv * affShare + sampleGmv), units: aov > 0 ? Math.round(gmv / aov) : 0, days_with_data: 0, skus, prices, fx, settlement: null }));
  }
  return out;
}

export function forecastInputsFor(q: Queries, accountId: number): PnlForecastInputs {
  try {
    return normaliseForecast(JSON.parse(q.getSetting(`pnl_forecast:${accountId}`, '{}')));
  } catch {
    return { ...DEFAULT_FORECAST };
  }
}

export function pnlData(q: Queries, account: Account, month: string, forecastOverride?: Partial<PnlForecastInputs>): PnlData {
  const settings = gmvSettings(q);
  const fx = settings.fx_to_eur;
  const skus = skusFor(q, account);
  const prices = q.listPnlSkuCogs(account.id);
  const build = (m: string): PnlMonth => {
    const { inputs } = pnlInputsFor(q, account, m);
    const fig = figuresFor(q, account, m);
    return computeMonth({ account, month: m, actual: true, inputs, gmv: fig.gmv, affiliate_gmv: fig.affiliate_gmv, units: fig.units, days_with_data: fig.days_with_data, skus, prices, fx, settlement: q.getSettlements(m).get(account.id) ?? null });
  };
  const history: PnlMonth[] = [];
  let m = month;
  for (let i = 0; i < 6; i++) {
    m = previousMonth(m);
    history.unshift(build(m));
  }
  const current = build(month);
  const forecast_inputs = normaliseForecast(forecastOverride, forecastInputsFor(q, account.id));
  const forecast = forecastMonths(q, account, current, forecast_inputs, skus, prices, fx);
  return {
    account, currency: settings.report_currency, month, inputs: current.inputs, defaults: pnlDefaults(account), sku_cogs: prices, skus, history, current, forecast_inputs, forecast,
    light: lightOf(current),
  };
}

export function pnlSummary(q: Queries, month: string): PnlSummaryRow[] {
  const settings = gmvSettings(q);
  const fx = settings.fx_to_eur;
  return q.listAccounts().filter((a) => a.enabled).map((a) => {
    const { inputs, saved } = pnlInputsFor(q, a, month);
    const fig = figuresFor(q, a, month);
    const m = computeMonth({ account: a, month, actual: true, inputs, gmv: fig.gmv, affiliate_gmv: fig.affiliate_gmv, units: fig.units, days_with_data: fig.days_with_data, skus: [], prices: [], fx, settlement: q.getSettlements(month).get(a.id) ?? null });
    return { account_id: a.id, account_name: a.name, am_name: a.am_name, markets: a.markets, currency: settings.report_currency, month, gmv: m.gmv, net: m.net, margin_pct: m.margin_pct, agency_billing: m.agency_billing, has_inputs: saved || q.listPnlMonths(a.id).length > 0, light: lightOf(m) };
  }).sort((a, b) => a.account_name.localeCompare(b.account_name));
}

export function currentMonth(q: Queries): string {
  return todayIn(q.getSetting('check_timezone', 'Europe/Madrid')).slice(0, 7);
}

// ---- CSV with formulas ----

export function colLetter(i: number): string {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

const csvCell = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells: (string | number | null | undefined)[]) => cells.map(csvCell).join(',');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/**
 * Client-facing P&L as a spreadsheet: a Brightform header, an inputs block the client can change, then one column
 * per month (actuals and forecast) where every cost line is a formula on the GMV row and the inputs block, so the
 * sheet recalculates when the client types a different fee or growth rate.
 */
export function pnlCsv(d: PnlData): string {
  const months = [...d.history, d.current, ...d.forecast];
  const rows: string[] = [];
  const title = `${d.account.name} · Profit & loss`;
  rows.push(csvRow(['BRIGHTFORM', '', 'TikTok Shop growth agency · brightform.agency']));
  rows.push(csvRow([title]));
  rows.push(csvRow([`Prepared ${new Date().toISOString().slice(0, 10)} · all figures in ${d.currency} · actuals from TikTok Shop, forecast from the assumptions below`]));
  rows.push('');
  // Inputs block (rows 5..): B holds the value, referenced as $B$n from the model.
  const inputStart = rows.length + 2; // 1-indexed row of the first input (after the "Inputs" heading)
  rows.push(csvRow(['Inputs (edit these)', 'Value', 'Notes']));
  const inputs: [string, number | string, string][] = [
    ['TikTok platform fee %', d.inputs.platform_fee_pct, 'Commission TikTok takes on GMV'],
    ['Creator commission %', d.inputs.creator_commission_pct, 'Paid on affiliate GMV only'],
    ['COGS % of GMV', d.inputs.cogs_pct, d.current.cogs_source === 'sku' ? 'Per-SKU costs used in actuals; this % drives the forecast' : 'Blended cost of goods'],
    ['Shipping & fulfilment %', d.inputs.shipping_pct, 'Of GMV'],
    ['Agency fee / month', d.inputs.agency_fee, 'Brightform retainer'],
    ['Agency commission %', d.inputs.agency_commission_pct, d.account.commission_basis === 'mor' ? 'Of net settlement' : 'Of GMV'],
    ['Settlement % (MoR)', d.account.commission_basis === 'mor' ? d.account.settlement_pct : 100, 'Share of GMV paid out; 100 when commission is on GMV'],
    ['Sample unit cost', d.inputs.sample_unit_cost, 'Cost of one sample sent to a creator'],
    ['Monthly GMV growth % (forecast)', d.forecast_inputs.gmv_growth_pct, 'Compounds month on month'],
    ['Forecast ad spend / month', d.forecast_inputs.ad_spend, ''],
    ['Ad ROI (GMV per 1 spent)', d.forecast_inputs.ad_roi, 'Forecast GMV from ads = spend × ROI'],
    ['Samples / month (forecast)', d.forecast_inputs.samples_per_month, ''],
    ['GMV per sample (forecast)', d.forecast_inputs.sample_gmv_each, 'Expected GMV each sample brings'],
  ];
  const ref: Record<string, string> = {};
  const keys = ['platform', 'creator', 'cogs', 'shipping', 'fee', 'commission', 'settlement', 'sample_cost', 'growth', 'f_ads', 'roi', 'f_samples', 'sample_gmv'];
  inputs.forEach((row, i) => {
    rows.push(csvRow(row));
    ref[keys[i]] = `$B$${inputStart + i}`;
  });
  rows.push('');
  // Model block.
  const headerRow = rows.length + 1;
  rows.push(csvRow(['', ...months.map((m) => monthLabel(m.month))]));
  rows.push(csvRow(['', ...months.map((m) => (m.actual ? (m.month === d.month ? 'Actual (month to date)' : 'Actual') : 'Forecast'))]));
  const r = (offset: number) => headerRow + 2 + offset; // 1-indexed row of a model line
  const L = { gmv: 0, aff: 1, units: 2, platform: 3, creator: 4, net_rev: 5, cogs: 6, shipping: 7, gross: 8, ads: 9, samples_n: 10, samples: 11, fee: 12, commission: 13, other: 14, net: 15, margin: 16, billing: 17 };
  const col = (i: number) => colLetter(i + 1); // months start in column B
  const cells = (label: string, f: (m: PnlMonth, i: number) => string | number) => csvRow([label, ...months.map((m, i) => f(m, i))]);
  const firstForecast = months.findIndex((m) => !m.actual);
  rows.push(cells('GMV', (m, i) => {
    if (m.actual) return m.gmv;
    const prev = col(i - 1);
    // Forecast GMV: last month's organic GMV grown by the growth rate, plus ads and samples.
    const prevOrganic = i - 1 >= firstForecast ? `(${prev}${r(L.gmv)}-${ref.f_ads}*${ref.roi}-${ref.f_samples}*${ref.sample_gmv})` : i - 1 === firstForecast - 1 && d.current.days_with_data > 0 && d.current.days_with_data < Number(monthRange(d.current.month).to.slice(8, 10)) ? `(${prev}${r(L.gmv)}/${d.current.days_with_data}*${Number(monthRange(d.current.month).to.slice(8, 10))})` : `${prev}${r(L.gmv)}`;
    return `=${prevOrganic}*(1+${ref.growth}/100)+${ref.f_ads}*${ref.roi}+${ref.f_samples}*${ref.sample_gmv}`;
  }));
  const affShare = d.current.gmv > 0 ? round2(d.current.affiliate_gmv / d.current.gmv) : 0.5;
  rows.push(cells('Affiliate GMV', (m, i) => (m.actual ? m.affiliate_gmv : `=${col(i)}${r(L.gmv)}*${affShare}`)));
  rows.push(cells('Units', (m, i) => (m.actual ? m.units : d.current.units > 0 && d.current.gmv > 0 ? `=ROUND(${col(i)}${r(L.gmv)}/${round2(d.current.gmv / d.current.units)},0)` : 0)));
  rows.push(cells('TikTok platform fee', (_m, i) => `=-${col(i)}${r(L.gmv)}*${ref.platform}/100`));
  rows.push(cells('Creator commission', (_m, i) => `=-${col(i)}${r(L.aff)}*${ref.creator}/100`));
  rows.push(cells('Net revenue', (_m, i) => `=${col(i)}${r(L.gmv)}+${col(i)}${r(L.platform)}+${col(i)}${r(L.creator)}`));
  rows.push(cells('Cost of goods', (m, i) => (m.actual && m.cogs_source === 'sku' ? -Math.abs(m.lines.find((l) => l.key === 'cogs')?.amount ?? 0) : `=-${col(i)}${r(L.gmv)}*${ref.cogs}/100`)));
  rows.push(cells('Shipping & fulfilment', (_m, i) => `=-${col(i)}${r(L.gmv)}*${ref.shipping}/100`));
  rows.push(cells('Gross profit', (_m, i) => `=${col(i)}${r(L.net_rev)}+${col(i)}${r(L.cogs)}+${col(i)}${r(L.shipping)}`));
  rows.push(cells('Ad spend', (m) => (m.actual ? -m.inputs.ad_spend : `=-${ref.f_ads}`)));
  rows.push(cells('Samples sent', (m) => (m.actual ? m.inputs.samples_sent : `=${ref.f_samples}`)));
  rows.push(cells('Sample cost', (_m, i) => `=-${col(i)}${r(L.samples_n)}*${ref.sample_cost}`));
  rows.push(cells('Agency fee', (m) => (m.actual ? -m.inputs.agency_fee : d.forecast_inputs.keep_fees ? `=-${ref.fee}` : 0)));
  rows.push(cells('Agency commission', (m, i) => (m.actual || d.forecast_inputs.keep_fees ? `=-${col(i)}${r(L.gmv)}*${ref.settlement}/100*${ref.commission}/100` : 0)));
  rows.push(cells('Other costs', (m) => (m.actual ? -m.inputs.other_costs : 0)));
  rows.push(cells('Net profit', (_m, i) => `=${col(i)}${r(L.gross)}+${col(i)}${r(L.ads)}+${col(i)}${r(L.samples)}+${col(i)}${r(L.fee)}+${col(i)}${r(L.commission)}+${col(i)}${r(L.other)}`));
  rows.push(cells('Net margin %', (_m, i) => `=IF(${col(i)}${r(L.gmv)}>0,${col(i)}${r(L.net)}/${col(i)}${r(L.gmv)}*100,0)`));
  rows.push(cells('Brightform billing', (_m, i) => `=-(${col(i)}${r(L.fee)}+${col(i)}${r(L.commission)})`));
  rows.push('');
  rows.push(csvRow(['Totals', 'Actual', 'Forecast']));
  const actualCols = months.map((m, i) => (m.actual ? col(i) : null)).filter(Boolean) as string[];
  const forecastCols = months.map((m, i) => (!m.actual ? col(i) : null)).filter(Boolean) as string[];
  const sumOf = (cols: string[], row: number) => (cols.length ? `=${cols[0]}${row}+${cols.slice(1).map((c) => `${c}${row}`).join('+')}`.replace(/\+$/, '') : 0);
  const sumRange = (cols: string[], row: number) => (cols.length ? `=SUM(${cols[0]}${row}:${cols[cols.length - 1]}${row})` : 0);
  void sumOf;
  rows.push(csvRow(['GMV', sumRange(actualCols, r(L.gmv)), sumRange(forecastCols, r(L.gmv))]));
  rows.push(csvRow(['Net profit', sumRange(actualCols, r(L.net)), sumRange(forecastCols, r(L.net))]));
  rows.push(csvRow(['Brightform billing', sumRange(actualCols, r(L.billing)), sumRange(forecastCols, r(L.billing))]));
  rows.push('');
  rows.push(csvRow(['Assumptions']));
  rows.push(csvRow(['Actual GMV, affiliate GMV and units are synced from TikTok Shop; costs are the inputs above applied to them.']));
  rows.push(csvRow([`Affiliate GMV is ${Math.round(affShare * 100)}% of GMV in the forecast (this month's share).`]));
  rows.push(csvRow(['Forecast GMV = last month grown by the monthly growth % + ad spend × ROI + samples × GMV per sample.']));
  if (d.inputs.notes) rows.push(csvRow([`Notes: ${d.inputs.notes}`]));
  rows.push(csvRow(['Questions: hello@brightform.agency']));
  return rows.join('\n') + '\n';
}
