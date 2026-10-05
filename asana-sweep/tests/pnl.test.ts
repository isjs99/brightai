import { describe, expect, it } from 'vitest';
import { Queries } from '../src/db/queries';
import { openTestDb } from '../src/db/index';
import { cogsFor, computeMonth, forecastMonths, lightOf, PNL_DEFAULTS, pnlCsv, pnlData, pnlInputsFor, pnlSummary } from '../src/pnl/index';
import type { Account, PnlInputs } from '../src/sweep/types';

const account = (over: Partial<Account> = {}): Account => ({ id: 1, name: 'Nutori', markets: 'ES', am_name: 'Ana', aa_name: null, enabled: true, notes: null, commission_pct: 10, commission_basis: 'gmv', settlement_pct: 85, slack_channel: null, client_slack_channel: null, client_domain: null, created_at: '', updated_at: '', ...over });
const inputs = (over: Partial<PnlInputs> = {}): PnlInputs => ({ ...PNL_DEFAULTS, agency_commission_pct: 10, agency_fee: 1000, ad_spend: 500, samples_sent: 20, sample_unit_cost: 5, ...over });

describe('P&L engine', () => {
  it('walks GMV down to net profit with every line as a share of GMV', () => {
    const m = computeMonth({ account: account(), month: '2026-09', actual: true, inputs: inputs(), gmv: 10000, affiliate_gmv: 6000, units: 400, days_with_data: 30, skus: [], prices: [], fx: {}, settlement: null });
    const line = (k: string) => m.lines.find((l) => l.key === k)!.amount;
    expect(line('platform_fee')).toBe(-900); // 9%
    expect(line('creator_commission')).toBe(-900); // 15% of affiliate
    expect(line('net_revenue')).toBe(8200);
    expect(line('cogs')).toBe(-3000); // 30% blended
    expect(line('shipping')).toBe(-800);
    expect(line('gross_profit')).toBe(4400);
    expect(line('ads')).toBe(-500);
    expect(line('samples')).toBe(-100);
    expect(line('agency_fee')).toBe(-1000);
    expect(line('agency_commission')).toBe(-1000); // 10% of GMV
    expect(m.net).toBe(1800);
    expect(m.margin_pct).toBe(18);
    expect(m.agency_billing).toBe(2000);
    expect(lightOf(m)).toBe('amber');
  });

  it('bases the commission on the settlement for MoR deals and uses the real settlement when entered', () => {
    const est = computeMonth({ account: account({ commission_basis: 'mor', settlement_pct: 80 }), month: '2026-09', actual: true, inputs: inputs(), gmv: 10000, affiliate_gmv: 0, units: 0, days_with_data: 30, skus: [], prices: [], fx: {}, settlement: null });
    expect(est.lines.find((l) => l.key === 'agency_commission')!.amount).toBe(-800);
    const real = computeMonth({ account: account({ commission_basis: 'mor', settlement_pct: 80 }), month: '2026-09', actual: true, inputs: inputs(), gmv: 10000, affiliate_gmv: 0, units: 0, days_with_data: 30, skus: [], prices: [], fx: {}, settlement: 7000 });
    expect(real.lines.find((l) => l.key === 'agency_commission')!.amount).toBe(-700);
  });

  it('prices COGS per SKU weighted by the sales mix, with the blended percent for unpriced SKUs', () => {
    const skus = [{ key: 'A', label: 'A', sold_30d: 300, shop_name: 's' }, { key: 'B', label: 'B', sold_30d: 100, shop_name: 's' }];
    const prices = [{ account_id: 1, key: 'A', label: 'A', cogs: 4, currency: 'EUR', updated_at: null }, { account_id: 1, key: 'B', label: 'B', cogs: 8, currency: 'EUR', updated_at: null }];
    const full = cogsFor(inputs({ cogs_mode: 'sku' }), 10000, 400, skus, prices, {});
    expect(full).toMatchObject({ amount: 2000, source: 'sku', note: null }); // (0.75×4 + 0.25×8) × 400
    const partial = cogsFor(inputs({ cogs_mode: 'sku', cogs_pct: 40 }), 10000, 400, skus, [prices[0]], {});
    expect(partial.amount).toBe(0.75 * 4 * 400 + 0.25 * 10000 * 0.4);
    expect(partial.note).toMatch(/25% of units have no SKU cost/);
    expect(cogsFor(inputs({ cogs_mode: 'sku' }), 10000, 400, skus, [], {})).toMatchObject({ amount: 3000, source: 'blended' });
  });

  it('rolls the forecast forward with growth, ads and samples, scaling a running month up first', () => {
    const cur = computeMonth({ account: account(), month: '2026-10', actual: true, inputs: inputs({ ad_spend: 0, samples_sent: 0 }), gmv: 5000, affiliate_gmv: 2500, units: 200, days_with_data: 10, skus: [], prices: [], fx: {}, settlement: null });
    const f = forecastMonths(new Queries(openTestDb()), account(), cur, { months: 2, gmv_growth_pct: 10, ad_spend: 1000, ad_roi: 3, samples_per_month: 10, sample_gmv_each: 50, keep_fees: true }, [], [], {});
    expect(f.map((m) => m.month)).toEqual(['2026-11', '2026-12']);
    // 5000 over 10 days → 15500 for 31 days; ×1.1 + 3000 ads + 500 samples
    expect(f[0].gmv).toBe(15500 * 1.1 + 3000 + 500);
    expect(f[1].gmv).toBeCloseTo(15500 * 1.21 + 3000 + 500, 2);
    expect(f[0].inputs.ad_spend).toBe(1000);
    expect(f[0].inputs.samples_sent).toBe(10);
    expect(f[0].actual).toBe(false);
    const noFees = forecastMonths(new Queries(openTestDb()), account(), cur, { months: 1, gmv_growth_pct: 0, ad_spend: 0, ad_roi: 0, samples_per_month: 0, sample_gmv_each: 0, keep_fees: false }, [], [], {});
    expect(noFees[0].agency_billing).toBe(0);
  });

  it('carries inputs forward from the latest saved month and reads actuals from the synced GMV', () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Nutori', markets: 'ES', am_name: 'Ana', aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    q.setAccountDeal(a.id, { commission_pct: 12, commission_basis: 'gmv', settlement_pct: 100 });
    const acc = q.getAccount(a.id)!;
    expect(pnlInputsFor(q, acc, '2026-09').inputs.agency_commission_pct).toBe(12);
    q.savePnlInputs(a.id, '2026-07', { agency_fee: 1500, cogs_pct: 35 });
    const sep = pnlInputsFor(q, acc, '2026-09');
    expect(sep.saved).toBe(false);
    expect(sep.inputs).toMatchObject({ agency_fee: 1500, cogs_pct: 35, agency_commission_pct: 12 });
    q.addShop(a.id, 'cruva-1', 'Nutori ES', 'EUR', 'cruva');
    q.upsertGmv([{ shop_id: 'cruva-1', date: '2026-09-01', total_gmv: 1000, affiliate_gmv: 600, units: 40 }, { shop_id: 'cruva-1', date: '2026-09-02', total_gmv: 500, affiliate_gmv: 100, units: 20 }]);
    const d = pnlData(q, acc, '2026-09');
    expect(d.current).toMatchObject({ gmv: 1500, affiliate_gmv: 700, units: 60, days_with_data: 2 });
    expect(d.history).toHaveLength(6);
    expect(d.forecast).toHaveLength(6);
    const rows = pnlSummary(q, '2026-09');
    expect(rows.find((r) => r.account_id === a.id)).toMatchObject({ account_name: 'Nutori', gmv: 1500, has_inputs: true });
    const csv = pnlCsv(d);
    expect(csv.startsWith('BRIGHTFORM')).toBe(true);
    expect(csv).toContain('Inputs (edit these)');
    expect(csv).toMatch(/TikTok platform fee,=-[A-Z]+\d+\*\$B\$\d+\/100/);
    expect(csv).toContain('Net margin %');
    expect(csv).toContain('=SUM(');
  });
});
