import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { DEFAULT_THRESHOLDS, evaluateCruva, evaluateWindsor, parseThresholds, type WindsorRows } from '../src/health/rules';
import { HealthEngine, parseAssessment } from '../src/health/index';
import { AccountMonitor } from '../src/monitor/index';
import { incidentsFromFlags } from '../src/incidents/index';
import { buildGmv, buildGmvExplore } from '../src/reports/index';
import type { WindsorClient, WindsorOrderDetail, WindsorProductDetail } from '../src/gmv/windsor';

const NOW = Date.parse('2026-09-23T10:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * 3600000).toISOString();
const ahead = (hours: number) => new Date(NOW + hours * 3600000).toISOString();
const shop = { shop_id: 'DEDELCXXXXXX', shop_name: 'Clearly DE', account_id: 1, currency: 'EUR' };

function order(p: Partial<WindsorOrderDetail>): WindsorOrderDetail {
  return { account_id: shop.shop_id, order_id: String(Math.random()).slice(2, 10), order_status: 'COMPLETED', order_create_datetime: ago(24), order_paid_datetime: ago(24), order_rts_datetime: null, order_rts_sla_datetime: null, order_collection_datetime: null, order_collection_due_datetime: null, order_delivery_datetime: null, order_delivery_sla_datetime: null, order_cancel_sla_datetime: null, order_cancel_reason: null, order_cancellation_initiator: null, order_is_buyer_request_cancel: false, order_is_on_hold: false, order_is_sample_order: false, order_shipping_provider: 'DHL', order_tracking_number: null, order_payment_total_amount: 25, order_payment_currency: 'EUR', order_buyer_message: null, order_seller_note: null, data_fetched_at: ago(1), ...p };
}
function product(p: Partial<WindsorProductDetail>): WindsorProductDetail {
  return { account_id: shop.shop_id, product_id: 'p1', product_title: 'Magnesium', product_status: 'ACTIVATE', product_is_not_for_sale: null, product_has_draft: null, product_listing_quality_tier: null, product_sku_id: 's1', product_sku_seller_sku: 'MAG-60', product_sku_inventory_quantity: 100, product_sku_inventory_backorder_quantity: 0, product_sku_price_sale_price: 19.9, product_update_datetime: ago(48), ...p };
}
const empty: WindsorRows = { orders: [], products: [], payments: [], statements: [], unsettled: [] };

describe('windsor rules', () => {
  it('flags orders past the ship-by deadline, due soon and close to auto-cancel', () => {
    const rows: WindsorRows = { ...empty, orders: [
      order({ order_id: 'late', order_status: 'AWAITING_SHIPMENT', order_rts_sla_datetime: ago(3) }),
      order({ order_id: 'soon', order_status: 'AWAITING_SHIPMENT', order_rts_sla_datetime: ahead(5) }),
      order({ order_id: 'old', order_status: 'AWAITING_SHIPMENT', order_create_datetime: ago(60), order_cancel_sla_datetime: ahead(10) }),
      order({ order_id: 'fine', order_status: 'AWAITING_SHIPMENT', order_rts_sla_datetime: ahead(40) }),
    ] };
    const { flags, metrics } = evaluateWindsor(shop, rows, DEFAULT_THRESHOLDS, { now: NOW });
    const codes = flags.map((f) => f.code);
    expect(codes).toContain('w_ship_sla_breach');
    expect(flags.find((f) => f.code === 'w_ship_sla_breach')!.detail).toContain('late');
    expect(flags.find((f) => f.code === 'w_ship_sla_breach')!.detail).toContain('old');
    expect(flags.find((f) => f.code === 'w_ship_due_soon')!.detail).toBe('soon');
    expect(flags.find((f) => f.code === 'w_auto_cancel_risk')!.detail).toContain('old');
    expect(metrics.awaiting_shipment).toBe(4);
    expect(metrics.ship_sla_breached).toBe(2);
    expect(flags.every((f) => f.account_id === 1 && f.shop_id === shop.shop_id)).toBe(true);
  });

  it('computes cancel rate with reasons, order drop and AOV shift over 7 vs 7 days', () => {
    const orders: WindsorOrderDetail[] = [];
    for (let i = 0; i < 30; i += 1) orders.push(order({ order_create_datetime: ago(24 * 10 + i), order_payment_total_amount: 20 }));
    for (let i = 0; i < 20; i += 1) orders.push(order({ order_create_datetime: ago(24 + i), order_payment_total_amount: 40, ...(i < 5 ? { order_status: 'CANCELLED', order_cancel_reason: 'Changed mind', order_cancellation_initiator: 'BUYER' } : {}) }));
    const { flags, metrics } = evaluateWindsor(shop, { ...empty, orders }, DEFAULT_THRESHOLDS, { now: NOW });
    expect(metrics.orders_7d).toBe(20);
    expect(metrics.orders_prev_7d).toBe(30);
    expect(flags.find((f) => f.code === 'w_cancel_rate')!.detail).toContain('5× BUYER: Changed mind');
    expect(flags.some((f) => f.code === 'w_order_drop')).toBe(false); // 33% down, under the 40% threshold
    expect(flags.find((f) => f.code === 'w_aov_shift')!.message).toContain('+100%');
    const strict = evaluateWindsor(shop, { ...empty, orders }, { ...DEFAULT_THRESHOLDS, order_drop_pct: 30 }, { now: NOW });
    expect(strict.flags.some((f) => f.code === 'w_order_drop')).toBe(true);
  });

  it('flags logistics by carrier: late pickups and late deliveries', () => {
    const rows: WindsorRows = { ...empty, orders: [
      order({ order_status: 'AWAITING_COLLECTION', order_rts_datetime: ago(70), order_shipping_provider: 'GLS' }),
      order({ order_status: 'AWAITING_COLLECTION', order_rts_datetime: ago(10), order_shipping_provider: 'GLS' }),
      order({ order_status: 'IN_TRANSIT', order_collection_datetime: ago(24 * 9), order_shipping_provider: 'DHL' }),
      order({ order_status: 'IN_TRANSIT', order_collection_datetime: ago(24 * 2), order_delivery_sla_datetime: ago(2), order_shipping_provider: 'DPD' }),
    ] };
    const { flags } = evaluateWindsor(shop, rows, DEFAULT_THRESHOLDS, { now: NOW });
    expect(flags.find((f) => f.code === 'w_late_pickup')!.message).toContain('1 shipped');
    expect(flags.find((f) => f.code === 'w_late_pickup')!.detail).toBe('GLS: 1');
    expect(flags.find((f) => f.code === 'w_late_delivery')!.detail).toContain('DHL: 1');
    expect(flags.find((f) => f.code === 'w_late_delivery')!.detail).toContain('DPD: 1');
  });

  it('flags stock, deactivated and failed listings, and a shop with nothing live', () => {
    const rows: WindsorRows = { ...empty, products: [
      product({ product_id: 'a', product_sku_id: 'a1', product_sku_inventory_quantity: 0 }),
      product({ product_id: 'a', product_sku_id: 'a2', product_sku_inventory_quantity: 4 }),
      product({ product_id: 'b', product_sku_id: 'b1', product_title: 'Frozen one', product_status: 'PLATFORM_DEACTIVATED' }),
      product({ product_id: 'c', product_sku_id: 'c1', product_title: 'Rejected', product_status: 'FAILED' }),
      product({ product_id: 'd', product_sku_id: 'd1', product_status: 'ACTIVATE', product_listing_quality_tier: 'POOR' }),
    ] };
    const { flags, metrics } = evaluateWindsor(shop, rows, DEFAULT_THRESHOLDS, { now: NOW });
    expect(flags.find((f) => f.code === 'w_out_of_stock')!.message).toContain('1 live SKU');
    expect(flags.find((f) => f.code === 'w_low_stock')!.detail).toContain('MAG-60): 4');
    expect(flags.find((f) => f.code === 'w_product_deactivated')!.detail).toBe('Frozen one');
    expect(flags.find((f) => f.code === 'w_listing_failed')!.detail).toBe('Rejected');
    expect(flags.find((f) => f.code === 'w_listing_quality')).toBeTruthy();
    expect(metrics.active_products).toBe(2);
    const off = evaluateWindsor(shop, { ...empty, products: [product({ product_status: 'SELLER_DEACTIVATED' })] }, DEFAULT_THRESHOLDS, { now: NOW });
    expect(off.flags.find((f) => f.code === 'w_no_live_products')!.message).toContain('1 switched off by the seller');
  });

  it('flags finance: negative statements, failed and missing payouts, reserves, unsettled backlog', () => {
    const rows: WindsorRows = {
      orders: [order({ order_create_datetime: ago(24 * 3), order_payment_total_amount: 500 })],
      products: [],
      payments: [{ account_id: shop.shop_id, payment_id: 'pay1', payment_status: 'FAILED', payment_create_datetime: ago(24 * 5), payment_paid_datetime: null, payment_amount_value: 1000, payment_reserve_amount_value: 300, payment_settlement_amount_value: 700, payment_settlement_amount_currency: 'EUR', payment_bank_account: '***1' }],
      statements: [{ account_id: shop.shop_id, statement_id: 'st1', statement_statement_datetime: ago(24 * 4), statement_payment_status: 'PROCESSING', statement_payment_datetime: null, statement_currency: 'EUR', statement_revenue_amount: -20, statement_fee_amount: 2.98, statement_adjustment_amount: 0, statement_shipping_cost_amount: 0, statement_net_sales_amount: -20, statement_settlement_amount: -17.02 }],
      unsettled: [{ account_id: shop.shop_id, unsettled_transaction_id: 'u1', unsettled_transaction_status: 'UNSETTLED', unsettled_transaction_type: 'ORDER', unsettled_transaction_currency: 'EUR', unsettled_transaction_est_settlement_amount: 120, unsettled_transaction_unsettled_reason: 'Awaiting delivery confirmation', unsettled_transaction_estimated_settlement: null, unsettled_transaction_order_id: 'o1', unsettled_transaction_order_create_datetime: ago(24 * 40) }],
    };
    const { flags, metrics } = evaluateWindsor(shop, rows, DEFAULT_THRESHOLDS, { now: NOW });
    const codes = flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['w_negative_statement', 'w_payout_failed', 'w_payout_missing', 'w_reserve_spike', 'w_unsettled_backlog']));
    expect(flags.find((f) => f.code === 'w_unsettled_backlog')!.detail).toContain('Awaiting delivery confirmation');
    expect(metrics.reserve_share_30d).toBe(30);
    expect(metrics.unsettled_old_amount).toBe(120);
  });

  it('flags stale data when the pull failed or the rows are old', () => {
    expect(evaluateWindsor(shop, empty, DEFAULT_THRESHOLDS, { now: NOW, pullOk: false, pullError: 'HTTP 500' }).flags[0].message).toContain('HTTP 500');
    const old = evaluateWindsor(shop, { ...empty, orders: [order({ data_fetched_at: ago(50) })] }, DEFAULT_THRESHOLDS, { now: NOW });
    expect(old.flags.find((f) => f.code === 'w_data_stale')!.message).toContain('50h ago');
    expect(evaluateWindsor(shop, empty, DEFAULT_THRESHOLDS, { now: NOW }).flags).toHaveLength(0);
  });

  it('honours disabled rules and parses thresholds safely', () => {
    const rows: WindsorRows = { ...empty, orders: [order({ order_status: 'AWAITING_SHIPMENT', order_rts_sla_datetime: ago(3) })] };
    expect(evaluateWindsor(shop, rows, DEFAULT_THRESHOLDS, { now: NOW, enabled: new Set(['w_low_stock']) }).flags).toHaveLength(0);
    const t = parseThresholds({ low_stock_units: '25', sps_min: -1, nonsense: 5 });
    expect(t.low_stock_units).toBe(25);
    expect(t.sps_min).toBe(DEFAULT_THRESHOLDS.sps_min);
  });
});

describe('cruva rules', () => {
  const ref = { shop_id: '6973a15e06f8df59ef3f02eb', shop_name: 'Clearly DE', account_id: 1 };
  it('flags a restricted score, outreach stopping, sample drops and waiting requests', () => {
    const flags = evaluateCruva(ref, { sps: 2.9, dms_sent_7d: 284, dms_sent_prev_7d: 79000, samples_approved_7d: 69, samples_approved_prev_7d: 106, samples_shipped_7d: 66, samples_shipped_prev_7d: 113, samples_pending_review: 12, samples_pending_review_oldest_hours: 96, automations_active: 3, automations_total: 5, videos_posted_7d: 194, videos_with_sales_7d: 5 }, DEFAULT_THRESHOLDS, { previous: { sps: 3.4 } });
    const codes = flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['c_sps_low', 'c_sps_drop', 'c_dms_stopped', 'c_samples_drop', 'c_samples_waiting']));
    expect(codes).not.toContain('c_videos_no_sales');
    expect(codes).not.toContain('c_automations_off');
    expect(flags.find((f) => f.code === 'c_samples_drop')!.message).toContain('samples approved 69 vs 106');
  });
  it('flags zero DMs with automations active, no automations, and stale metrics', () => {
    expect(evaluateCruva(ref, { dms_sent_7d: 0, automations_active: 2 }, DEFAULT_THRESHOLDS).map((f) => f.code)).toContain('c_dms_stopped');
    expect(evaluateCruva(ref, { automations_active: 0, automations_total: 4 }, DEFAULT_THRESHOLDS)[0].message).toContain('(4 set up)');
    expect(evaluateCruva(ref, {}, DEFAULT_THRESHOLDS, { stale: true })[0].code).toBe('c_data_stale');
    expect(evaluateCruva(ref, {}, DEFAULT_THRESHOLDS)).toHaveLength(0);
  });
  it('flags affiliate share and affiliate GMV falling', () => {
    const flags = evaluateCruva(ref, { affiliate_gmv_7d: 400, affiliate_gmv_prev_7d: 900, total_gmv_7d: 1000, total_gmv_prev_7d: 1000 }, DEFAULT_THRESHOLDS);
    expect(flags.map((f) => f.code).sort()).toEqual(['c_affiliate_gmv_drop', 'c_affiliate_share_drop']);
  });
});

describe('health engine', () => {
  const fakeWindsor = {
    configured: true,
    async ordersDetailed() { return [order({ order_id: 'late1', order_status: 'AWAITING_SHIPMENT', order_rts_sla_datetime: ago(5), account_id: 'DEESLCN8QWCV' })]; },
    async productsDetailed() { return [product({ account_id: 'DEESLCN8QWCV', product_sku_inventory_quantity: 0 })]; },
    async paymentsDetailed() { return []; },
    async statements() { return []; },
    async unsettled() { throw new Error('unsettled table unavailable'); },
  } as unknown as WindsorClient;

  function setup() {
    const q = new Queries(openTestDb());
    const clearly = q.listAccounts().find((a) => a.name === 'Clearly')!;
    q.addShop(clearly.id, 'DEESLCN8QWCV', 'Clearly_Spain', 'EUR', 'windsor');
    const health = new HealthEngine(q, { windsor: fakeWindsor, llm: null });
    const monitor = new AccountMonitor(q, { configured: false } as never);
    monitor.health = health;
    return { q, clearly, health, monitor };
  }

  it('pulls Windsor, stores one pull per shop, and the monitor turns it into flags that survive rescans', async () => {
    const { q, clearly, health, monitor } = setup();
    const r = await health.pullWindsor();
    expect(r.shops).toBe(1);
    expect(r.errors).toEqual(['unsettled: unsettled table unavailable']);
    const pulls = q.latestHealthPulls('windsor');
    expect(pulls).toHaveLength(1);
    expect(pulls[0].ok).toBe(true);
    expect(pulls[0].metrics.ship_sla_breached).toBe(1);
    const scan = await monitor.scan();
    expect(scan.opened).toBeGreaterThanOrEqual(2);
    const flags = q.listFlags(false);
    expect(flags.some((f) => f.code === 'w_ship_sla_breach' && f.account_id === clearly.id)).toBe(true);
    expect(flags.some((f) => f.code === 'w_out_of_stock')).toBe(true);
    // A second scan keeps them (same condition), and the rules list carries the new sources and sections.
    const again = await monitor.scan();
    expect(again.opened).toBe(0);
    expect(again.resolved).toBe(0);
    const rules = monitor.rules();
    expect(rules.find((x) => x.code === 'w_ship_sla_breach')!.section).toBe('Orders');
    expect(rules.some((x) => x.source === 'cruva') && rules.some((x) => x.source === 'ai')).toBe(true);
    // Thresholds change the outcome on the next scan without a new pull.
    health.setThresholds({ low_stock_units: 0 });
    expect(health.thresholds().low_stock_units).toBe(0);
    expect(incidentsFromFlags(q.listFlags(false)).map((i) => i.kind)).toEqual(expect.arrayContaining(['overdue_shipment', 'stock_out']));
    expect(monitor.data().health.pulls[0].shop_name).toBe('Clearly_Spain');
  });

  it('ingests the routine payload: Cruva metrics become rule flags, findings and assessments are stored, and rescans do not wipe them', async () => {
    const { q, clearly, health, monitor } = setup();
    const cruvaShop = q.listShops('cruva').find((s) => s.account_id === clearly.id)!;
    const r = health.ingest({ source: 'routine', accounts: [
      { account: 'Clearly', shops: [{ shop_id: cruvaShop.shop_id, metrics: { sps: 2.9, dms_sent_7d: 0, automations_active: 2 } }], findings: [{ message: 'Two automations are throttled by TikTok', severity: 'warn' }], assessment: { risk: 'red', summary: 'Outreach is blocked while the score sits at 2.9.', action: 'Switch automations to invites and fix late dispatch.', watch: ['SPS'] } },
      { account: 'Nobody', shops: [] },
    ] });
    expect(r.accounts).toBe(1);
    expect(r.shops).toBe(1);
    expect(r.findings).toBe(1);
    expect(r.assessments).toBe(1);
    expect(r.errors).toEqual(['Unknown account "Nobody"']);
    await monitor.scan();
    const codes = q.listFlags(false).filter((f) => f.account_id === clearly.id).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['c_sps_low', 'c_dms_stopped', 'c_custom', 'ai_risk_red']));
    // The routine finding is not owned by the scan, so a rescan leaves it; the next ingest replaces it.
    await monitor.scan();
    expect(q.listFlags(false).filter((f) => f.code === 'c_custom')).toHaveLength(1);
    health.ingest({ accounts: [{ account: clearly.id, findings: [] }] });
    expect(q.listFlags(false).filter((f) => f.code === 'c_custom')).toHaveLength(0);
    const a = q.latestAssessments();
    expect(a).toHaveLength(1);
    expect(a[0].risk).toBe('red');
    expect(a[0].source).toBe('routine');
    expect(a[0].watch).toEqual(['SPS']);
    const ctx = health.accountContext(clearly) as { open_flags: unknown[]; shops: { source: string; latest: Record<string, unknown> | null }[] };
    expect(ctx.open_flags.length).toBeGreaterThan(0);
    expect(ctx.shops.find((s) => s.source === 'cruva')!.latest!.sps).toBe(2.9);
    expect(incidentsFromFlags(q.listFlags(false)).map((i) => i.kind)).toEqual(expect.arrayContaining(['sps_restricted', 'account_at_risk', 'outreach_stopped']));
  });

  it('runs the AI review with the LLM it is given and stores the verdict as a flag', async () => {
    const q = new Queries(openTestDb());
    const clearly = q.listAccounts().find((a) => a.name === 'Clearly')!;
    q.addShop(clearly.id, 'DEESLCN8QWCV', 'Clearly_Spain', 'EUR', 'windsor');
    const seen: string[] = [];
    const health = new HealthEngine(q, { windsor: fakeWindsor, llm: async (_s, u) => { seen.push(u); return 'Sure: {"risk":"amber","summary":"One order is past the ship-by time and the magnesium SKU is out of stock.","action":"Ship order late1 today.","watch":["stock"]}'; } });
    await health.pullWindsor();
    const r = await health.review();
    expect(r.reviewed).toBe(1);
    expect(seen[0]).toContain('ship_sla_breached');
    const a = q.latestAssessments()[0];
    expect(a.risk).toBe('amber');
    expect(a.source).toBe('ai');
    const monitor = new AccountMonitor(q, { configured: false } as never);
    monitor.health = health;
    await monitor.scan();
    expect(q.listFlags(false).find((f) => f.code === 'ai_risk_amber')!.detail).toContain('Ship order late1 today.');
    expect(() => parseAssessment('no json here')).toThrow();
    expect(() => parseAssessment('{"risk":"purple","summary":"x"}')).toThrow();
  });
});

describe('gmv explorer and pace', () => {
  it('compares any range with the same-length period before it and gives month-to-date pace', () => {
    const q = new Queries(openTestDb());
    const clearly = q.listAccounts().find((a) => a.name === 'Clearly')!;
    q.addShop(clearly.id, 'W1', 'Clearly_Spain', 'EUR', 'windsor');
    const rows: { shop_id: string; date: string; total_gmv: number; affiliate_gmv: number; units: number }[] = [];
    for (let i = 0; i < 20; i += 1) rows.push({ shop_id: 'W1', date: `2026-09-${String(i + 1).padStart(2, '0')}`, total_gmv: 100 + i, affiliate_gmv: 50, units: 2 });
    for (let i = 0; i < 30; i += 1) rows.push({ shop_id: 'W1', date: `2026-08-${String(i + 1).padStart(2, '0')}`, total_gmv: 80, affiliate_gmv: 40, units: 1 });
    q.upsertGmv(rows);
    const x = buildGmvExplore(q, '2026-09-11', '2026-09-20');
    expect(x.days).toBe(10);
    expect(x.prev_from).toBe('2026-09-01');
    expect(x.prev_to).toBe('2026-09-10');
    const r = x.rows.find((r) => r.account_id === clearly.id)!;
    expect(r.gmv).toBe(1145);
    expect(r.prev_gmv).toBe(1045);
    expect(r.change_pct).toBeCloseTo(9.57, 1);
    expect(r.daily).toHaveLength(10);
    expect(x.totals.daily[0]).toEqual({ date: '2026-09-11', gmv: 110, prev_gmv: 100 });
    const only = buildGmvExplore(q, '2026-09-01', '2026-09-05', { accountId: 999 });
    expect(only.rows).toHaveLength(0);
    // Month view: pace against the same number of days last month.
    const g = buildGmv(q, '2026-09');
    const row = g.accounts.find((a) => a.account.id === clearly.id)!;
    if (g.days_elapsed > 0 && g.days_elapsed <= 20) {
      expect(row.prev_same_days).toBe(80 * g.days_elapsed);
      expect(row.pace_pct).toBeGreaterThan(0);
    } else {
      expect(row.prev_same_days === null || row.prev_same_days > 0).toBe(true);
    }
  });
});
