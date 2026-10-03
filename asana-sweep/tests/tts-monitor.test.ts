import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { DEFAULT_THRESHOLDS } from '../src/health/rules';
import { ALL_TTS_RULES, emptyTtsRows, evaluateTargets, evaluateTts, lastDays, startOfWeek, type TtsDay, type TtsRows } from '../src/health/tts-rules';
import { classifyError, parseDay, parseOrder, parseProduct, parseReturn, parseSample, pullShop } from '../src/health/tts-pull';
import { HealthEngine } from '../src/health/index';
import { AccountMonitor } from '../src/monitor/index';
import { TtsError, type TtsClient } from '../src/tts/client';

const NOW = Date.parse('2026-10-07T10:00:00Z'); // a Wednesday
const S = Math.floor(NOW / 1000);
const shop = { shop_id: 'DEDELCP6QWNP', shop_name: 'BiFi', account_id: 1, currency: 'EUR', market: 'DE' };
const live = (rows: TtsRows, ...scopes: (keyof TtsRows['scopes'])[]) => { for (const s of scopes) rows.scopes[s] = { ok: true, state: 'ok', message: null, at: new Date(NOW).toISOString() }; return rows; };
const day = (daysAgo: number, p: Partial<TtsDay> = {}): TtsDay => ({ date: new Date(NOW - daysAgo * 86400000).toISOString().slice(0, 10), gmv: 1000, orders: 40, sku_orders: 45, items: 50, visitors: 500, page_views: 900, conversion: 2.5, refunds: 20, customers: 38, video_gmv: 500, live_gmv: 300, card_gmv: 200, ads_gmv: 100, organic_gmv: 900, ...p });

describe('TikTok analytics rules', () => {
  it('flags a GMV drop, a visitor drop, a collapsed channel and a refund share from the daily series', () => {
    const rows = live(emptyTtsRows(), 'analytics');
    rows.analytics = [...Array.from({ length: 7 }, (_, i) => day(i + 1, { gmv: 500, visitors: 200, live_gmv: 0, video_gmv: 300, card_gmv: 200, refunds: 100 })), ...Array.from({ length: 7 }, (_, i) => day(i + 8))];
    rows.latest_available_date = new Date(NOW - 86400000).toISOString().slice(0, 10);
    const { metrics, flags } = evaluateTts(shop, rows, DEFAULT_THRESHOLDS, { now: NOW });
    expect(metrics.gmv_7d).toBe(3500);
    expect(metrics.gmv_prev_7d).toBe(7000);
    const codes = flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['t_gmv_drop', 't_visitors_drop', 't_channel_drop', 't_no_live_gmv', 't_refund_share']));
    expect(flags.find((f) => f.code === 't_gmv_drop')!.message).toContain('EUR 3,500');
    expect(codes).not.toContain('t_analytics_stale');
  });
  it('says nothing for a block whose scope is not live, and flags stale analytics', () => {
    const rows = emptyTtsRows();
    rows.analytics = [day(1, { gmv: 0 })];
    expect(evaluateTts(shop, rows, DEFAULT_THRESHOLDS, { now: NOW }).flags).toHaveLength(0);
    rows.scopes.analytics = { ok: false, state: 'error', message: 'HTTP 500', at: new Date(NOW).toISOString() };
    expect(evaluateTts(shop, rows, DEFAULT_THRESHOLDS, { now: NOW }).flags[0].message).toContain('HTTP 500');
    const old = live(emptyTtsRows(), 'analytics');
    old.latest_available_date = new Date(NOW - 5 * 86400000).toISOString().slice(0, 10);
    expect(evaluateTts(shop, old, DEFAULT_THRESHOLDS, { now: NOW }).flags.map((f) => f.code)).toContain('t_analytics_stale');
  });
  it('slices the daily series by window', () => {
    const days = Array.from({ length: 20 }, (_, i) => day(i + 1));
    expect(lastDays(days, 7, NOW)).toHaveLength(7);
    expect(lastDays(days, 7, NOW, 7)).toHaveLength(7);
    expect(lastDays(days, 7, NOW)[6].date).toBe(new Date(NOW - 86400000).toISOString().slice(0, 10));
  });
});

describe('TikTok order, product, return, sample, CS and finance rules', () => {
  it('flags ship-by breaches, due soon, auto-cancel, cancel requests, holds, notes, cancel rate, late pickups and deliveries', () => {
    const rows = live(emptyTtsRows(), 'order');
    const base = { paid_time: S - 3600, rts_time: null, tts_sla_time: null, collection_time: null, delivery_sla_time: null, delivery_due_time: null, delivery_time: null, cancel_order_sla_time: null, cancel_time: null, cancellation_initiator: null, is_buyer_request_cancel: false, is_on_hold: false, buyer_message: null, shipping_provider: null, total_amount: 20, currency: 'EUR', line_items: [] };
    rows.orders = [
      { ...base, id: 'late', status: 'AWAITING_SHIPMENT', create_time: S - 86400, rts_sla_time: S - 3 * 3600 },
      { ...base, id: 'soon', status: 'AWAITING_SHIPMENT', create_time: S - 3600, rts_sla_time: S + 5 * 3600, buyer_message: 'Please leave with neighbour' },
      { ...base, id: 'cancel', status: 'AWAITING_SHIPMENT', create_time: S - 40 * 3600, rts_sla_time: S + 40 * 3600, cancel_order_sla_time: S + 10 * 3600 },
      { ...base, id: 'req', status: 'AWAITING_SHIPMENT', create_time: S - 3600, rts_sla_time: S + 40 * 3600, is_buyer_request_cancel: true },
      { ...base, id: 'hold', status: 'ON_HOLD', create_time: S - 3600 },
      { ...base, id: 'pickup', status: 'AWAITING_COLLECTION', create_time: S - 5 * 86400, rts_time: S - 4 * 86400, tts_sla_time: S - 2 * 86400, shipping_provider: 'DHL' },
      { ...base, id: 'transit', status: 'IN_TRANSIT', create_time: S - 10 * 86400, collection_time: S - 9 * 86400, delivery_sla_time: S - 86400, shipping_provider: 'Hermes' },
      ...Array.from({ length: 20 }, (_, i) => ({ ...base, id: `c${i}`, status: i < 6 ? 'CANCELLED' : 'COMPLETED', create_time: S - 2 * 86400, cancellation_initiator: i < 6 ? 'SELLER' : null })),
      ...Array.from({ length: 60 }, (_, i) => ({ ...base, id: `p${i}`, status: 'COMPLETED', create_time: S - 10 * 86400 })),
    ];
    const { metrics, flags } = evaluateTts(shop, rows, DEFAULT_THRESHOLDS, { now: NOW });
    const codes = flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['t_ship_sla_breach', 't_ship_due_soon', 't_auto_cancel_risk', 't_buyer_cancel_requests', 't_on_hold', 't_buyer_notes', 't_cancel_rate', 't_order_drop', 't_late_pickup', 't_late_delivery']));
    expect(flags.find((f) => f.code === 't_ship_sla_breach')!.detail).toContain('late (3h late)');
    expect(flags.find((f) => f.code === 't_late_pickup')!.detail).toContain('DHL: 1');
    expect(flags.find((f) => f.code === 't_cancel_rate')!.detail).toContain('seller: 6');
    expect(metrics.awaiting_shipment).toBe(4);
    expect(metrics.orders_7d).toBe(26);
  });
  it('flags stock, deactivated, failed and poor listings', () => {
    const rows = live(emptyTtsRows(), 'product');
    rows.products = [
      { id: '1', title: 'Magnesium', status: 'ACTIVATE', audit_status: null, quality_tier: 'POOR', skus: [{ id: 's1', seller_sku: 'MAG-60', price: 19.9, currency: 'EUR', qty: 0, status: 'NORMAL' }, { id: 's2', seller_sku: 'MAG-120', price: 29.9, currency: 'EUR', qty: 4, status: 'NORMAL' }] },
      { id: '2', title: 'Zinc', status: 'PLATFORM_DEACTIVATED', audit_status: null, quality_tier: null, skus: [] },
      { id: '3', title: 'Iron', status: 'FAILED', audit_status: 'FAILED', quality_tier: null, skus: [] },
    ];
    const { metrics, flags } = evaluateTts(shop, rows, DEFAULT_THRESHOLDS, { now: NOW });
    expect(flags.map((f) => f.code)).toEqual(expect.arrayContaining(['t_out_of_stock', 't_low_stock', 't_product_deactivated', 't_listing_failed', 't_listing_quality']));
    expect(flags.find((f) => f.code === 't_low_stock')!.detail).toContain('MAG-120');
    expect(metrics.out_of_stock_skus).toBe(1);
  });
  it('flags returns waiting on the seller, samples waiting and late to ship, samples below target, CS and finance', () => {
    const rows = live(emptyTtsRows(), 'return_refund', 'affiliate_seller', 'customer_service', 'finance', 'order');
    rows.orders = Array.from({ length: 25 }, (_, i) => ({ id: `o${i}`, status: 'COMPLETED', create_time: S - 2 * 86400, paid_time: null, rts_sla_time: null, rts_time: null, tts_sla_time: null, collection_time: null, delivery_sla_time: null, delivery_due_time: null, delivery_time: null, cancel_order_sla_time: null, cancel_time: null, cancellation_initiator: null, is_buyer_request_cancel: false, is_on_hold: false, buyer_message: null, shipping_provider: null, total_amount: 20, currency: 'EUR', line_items: [] }));
    rows.returns = [
      { return_id: 'r1', order_id: 'o1', status: 'RETURN_OR_REFUND_REQUEST_PENDING', type: 'REFUND', create_time: S - 2 * 86400, update_time: null, role: 'BUYER', next_action: 'SELLER_RESPOND_REFUND', next_deadline: S - 3600, refund_total: 20, currency: 'EUR' },
      ...Array.from({ length: 4 }, (_, i) => ({ return_id: `r${i + 2}`, order_id: null, status: 'RETURN_OR_REFUND_REQUEST_SUCCESS', type: 'REFUND', create_time: S - 86400, update_time: null, role: 'BUYER', next_action: null, next_deadline: null, refund_total: 20, currency: 'EUR' })),
    ];
    rows.samples = [
      { id: 'a1', status: 'PENDING', fulfillment_status: null, approve_expiration_time: S - 3600, shipment_expiration_time: null, tracking_number: null, order_id: null, creator: '@anna', product: 'Magnesium' },
      { id: 'a2', status: 'APPROVED', fulfillment_status: 'PENDING', approve_expiration_time: S + 86400, shipment_expiration_time: S - 3600, tracking_number: null, order_id: 'so1', creator: '@ben', product: 'Zinc' },
      { id: 'a3', status: 'APPROVED', fulfillment_status: 'SHIPPED', approve_expiration_time: S + 2 * 86400, shipment_expiration_time: S + 86400, tracking_number: 'TR1', order_id: 'so2', creator: '@cy', product: 'Zinc' },
    ];
    rows.cs = { sessions: 40, response_pct: 70, response_mins: 300, satisfaction_pct: 50 };
    rows.payments = [{ id: 'p1', status: 'FAILED', create_time: S - 86400, paid_time: null, amount: 900, reserve: 400, currency: 'EUR' }];
    rows.statements = [{ id: 's1', statement_time: S - 2 * 86400, settlement: -50, revenue: 1000, fee: 400, adjustment: 200, payment_status: 'PAID', currency: 'EUR' }];
    const { metrics, flags } = evaluateTts(shop, rows, DEFAULT_THRESHOLDS, { now: NOW, targets: { samples_per_week: 20 } });
    const codes = flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['t_returns_waiting', 't_return_rate', 't_samples_waiting', 't_samples_late_ship', 't_samples_below_target', 't_cs_response_low', 't_cs_satisfaction_low', 't_payout_failed', 't_payout_missing', 't_reserve_spike', 't_negative_statement', 't_adjustment_spike', 't_fee_share']));
    expect(flags.find((f) => f.code === 't_returns_waiting')!.message).toContain('past the TikTok deadline');
    expect(metrics.samples_week).toBe(2);
    expect(metrics.returns_waiting).toBe(1);
    // Every rule code the evaluator can emit is declared.
    for (const c of codes) expect(ALL_TTS_RULES.some((r) => r.code === c)).toBe(true);
  });
  it('knows the start of the week', () => {
    expect(new Date(startOfWeek(NOW)).toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('targets rules', () => {
  const ctx = (over: Partial<Parameters<typeof evaluateTargets>[0]> = {}) => ({
    account: { id: 1, name: 'BiFi', markets: 'DE/ES' },
    targets: [] as Parameters<typeof evaluateTargets>[0]['targets'],
    promotions: [],
    campaigns: [],
    skuPrices: [],
    gmvMax: [],
    gmv_month_to_date: null,
    currency: 'EUR',
    shopIdsByMarket: { DE: ['shopDE'] },
    ...over,
  });
  const t = (key: string, value: number, market = '') => ({ account_id: 1, market, key: key as never, value, updated_at: '', updated_by: null });
  const promo = (p: Record<string, unknown>) => ({ id: 1, name: 'Promo', activity_type: 'DIRECT_DISCOUNT', product_level: 'SHOP', discount_type: 'PERCENTAGE_OFF', discount_value: 20, begin_at: new Date(NOW - 86400000).toISOString(), end_at: new Date(NOW + 5 * 86400000).toISOString(), participation: 'BUYER_NO_LIMIT', products: {}, notes: null, created_by: null, created_at: '', updated_at: '', targets: [{ id: 1, promotion_id: 1, account_id: 1, account_name: 'BiFi', market: 'DE', tts_shop_id: 'shopDE', tts_shop_name: null, status: 'pushed', tts_activity_id: null, tts_status: null, error_message: null, pushed_at: null, actor: null }], ...p }) as never;

  it('asks for targets when there are none, then measures GMV and GMV Max against them', () => {
    expect(evaluateTargets(ctx(), DEFAULT_THRESHOLDS, { now: NOW })[0].code).toBe('g_no_targets');
    const flags = evaluateTargets(ctx({ targets: [t('gmv_target_month', 31000), t('gmv_max_weekly_spend', 1000), t('gmv_max_min_roi', 3), t('gmv_max_spend_actual_week', 1500), t('gmv_max_gmv_actual_week', 3000)], gmv_month_to_date: 3000 }), DEFAULT_THRESHOLDS, { now: NOW });
    const codes = flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['g_gmv_behind_target', 'g_gmv_max_overspend', 'g_gmv_max_roi_low']));
    expect(flags.find((f) => f.code === 'g_gmv_behind_target')!.message).toContain('day 7');
    expect(evaluateTargets(ctx({ targets: [t('gmv_max_weekly_spend', 1000)] }), DEFAULT_THRESHOLDS, { now: NOW }).map((f) => f.code)).toContain('g_gmv_max_no_actuals');
  });
  it('checks promotions against floors, the maximum discount, each other and campaigns, and spots price drift', () => {
    const sku = { id: 1, account_id: 1, market: 'DE', tts_shop_id: 'shopDE', product_id: 'p1', sku_id: 's1', seller_sku: 'MAG', name: 'Magnesium', list_price: 20, floor_price: 18, promo_price: 19, current_price: 22, currency: 'EUR', updated_at: '' };
    const flags = evaluateTargets(ctx({
      targets: [t('promo_max_discount_pct', 15), t('campaign_max_discount_pct', 10), t('campaign_full_participation', 1)],
      promotions: [promo({ id: 1, name: 'Spring' }), promo({ id: 2, name: 'Flash', product_level: 'PRODUCT', products: { shopDE: ['p1'] } })],
      campaigns: [{ id: 1, account_id: 1, market: 'DE', name: 'Prime Days', begin_at: new Date(NOW).toISOString().slice(0, 10), end_at: new Date(NOW + 3 * 86400000).toISOString().slice(0, 10), participation: 'full', discount_pct: 25, sku_scope: null, notes: null, created_at: '', updated_at: '' }],
      skuPrices: [sku],
    }), DEFAULT_THRESHOLDS, { now: NOW });
    const codes = flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['g_promo_below_floor', 'g_promo_over_max_discount', 'g_promo_clash', 'g_campaign_discount_over_max', 'g_price_drift']));
    expect(codes).not.toContain('g_campaign_missing');
    expect(flags.filter((f) => f.code === 'g_promo_clash').length).toBeGreaterThanOrEqual(2); // Spring vs Flash, and each vs the campaign at a different discount
    expect(flags.find((f) => f.code === 'g_promo_below_floor')!.detail).toContain('16.00 vs floor 18.00');
    const missing = evaluateTargets(ctx({ targets: [t('campaign_full_participation', 1)] }), DEFAULT_THRESHOLDS, { now: NOW });
    expect(missing.map((f) => f.code)).toContain('g_campaign_missing');
  });
});

describe('TikTok pull', () => {
  it('parses the API shapes into lite rows', () => {
    const d = parseDay({ start_date: '2026-10-01', end_date: '2026-10-02', sales: { gmv: { overall: { amount: '1234.5', currency: 'EUR' }, breakdowns: [{ type: 'VIDEO', gmv: { amount: '400' } }, { type: 'LIVE', gmv: { amount: '300' } }, { type: 'ADS', gmv: { amount: '100' } }] }, orders_count: 40, items_sold: 50, refunds: { amount: '12' } }, traffic: { avg_visitors: 600, avg_page_views: 1000, avg_conversation_rate: '2.5' } })!;
    expect(d.gmv).toBe(1234.5); expect(d.video_gmv).toBe(400); expect(d.live_gmv).toBe(300); expect(d.card_gmv).toBe(0); expect(d.ads_gmv).toBe(100); expect(d.organic_gmv).toBeNull(); expect(d.visitors).toBe(600);
    const o = parseOrder({ id: '1', status: 'AWAITING_SHIPMENT', create_time: 1700000000, rts_sla_time: 1700100000, is_buyer_request_cancel: true, payment: { total_amount: '19.90', currency: 'EUR' }, line_items: [{ product_id: 'p', sku_id: 's', sale_price: '19.90' }] });
    expect(o.rts_sla_time).toBe(1700100000); expect(o.is_buyer_request_cancel).toBe(true); expect(o.total_amount).toBe(19.9); expect(o.line_items[0].sku_id).toBe('s');
    const p = parseProduct({ id: 'p', title: 'T', status: 'ACTIVATE', listing_quality_tier: 'GOOD', skus: [{ id: 's', seller_sku: 'X', price: { tax_exclusive_price: '9.99', currency: 'EUR' }, inventory: [{ quantity: 3 }, { quantity: 4 }], status_info: { status: 'NORMAL' } }] });
    expect(p.skus[0].qty).toBe(7); expect(p.skus[0].price).toBe(9.99);
    const r = parseReturn({ return_id: 'r', order_id: 'o', return_status: 'RETURN_OR_REFUND_REQUEST_PENDING', create_time: 1700000000, seller_next_action_response: [{ action: 'SELLER_RESPOND_RETURN', deadline: 1700050000 }], refund_amount: { refund_total: '5', currency: 'EUR' } });
    expect(r.next_action).toBe('SELLER_RESPOND_RETURN'); expect(r.next_deadline).toBe(1700050000);
    const s = parseSample({ id: 'a', status: 'PENDING', approve_expiration_time: 1700000000, creator: { username: 'anna' }, product: { title: 'Mag' } });
    expect(s.creator).toBe('anna'); expect(s.product).toBe('Mag');
  });
  it('tells a missing scope from a transient error', () => {
    expect(classifyError(new TtsError('TikTok Shop error 105002: no permission for this api', 105002)).state).toBe('denied');
    expect(classifyError(new TtsError('TikTok Shop error 36009: The app does not have the required scope', 36009)).state).toBe('denied');
    expect(classifyError(new Error('fetch failed')).state).toBe('error');
  });
  it('pulls every block, marks denied scopes, keeps old rows on errors and skips fresh daily blocks', async () => {
    const calls: string[] = [];
    const client = {
      configured: true,
      async call(_m: string, path: string) {
        calls.push(path);
        if (path.startsWith('/analytics')) return { latest_available_date: '2026-10-06', performance: { intervals: [{ start_date: '2026-10-06', sales: { gmv: { overall: { amount: '10' } } }, traffic: {} }] } };
        if (path.startsWith('/order')) throw new TtsError('TikTok Shop error 105002: no permission', 105002);
        if (path.startsWith('/product')) throw new Error('timeout');
        if (path.startsWith('/return_refund')) return { return_orders: [] };
        if (path.startsWith('/affiliate_seller')) return { sample_applications: [{ id: 'a', status: 'PENDING' }] };
        if (path.startsWith('/customer_service')) return { performance: { support_session_count: 3, response_percentage: 100 } };
        if (path.startsWith('/finance/202309/payments')) return { payments: [] };
        if (path.startsWith('/finance/202309/statements')) return { statements: [] };
        throw new Error(`unexpected ${path}`);
      },
    } as unknown as TtsClient;
    const previous = { ...emptyTtsRows(), products: [{ id: 'old', title: 'Old', status: 'ACTIVATE', audit_status: null, quality_tier: null, skus: [] }], scopes: { product: { ok: true, state: 'ok' as const, message: null, at: new Date(NOW - 3600000).toISOString() } } };
    const rows = await pullShop(client, { accessToken: 't', cipher: 'c' }, { now: NOW, previous });
    expect(rows.scopes.analytics?.state).toBe('ok');
    expect(rows.analytics[0].gmv).toBe(10);
    expect(rows.scopes.order?.state).toBe('denied');
    expect(rows.scopes.order?.ok).toBe(false);
    expect(rows.scopes.product?.state).toBe('error');
    expect(rows.scopes.product?.ok).toBe(true); // last good rows carried over
    expect(rows.products[0].id).toBe('old');
    expect(rows.samples).toHaveLength(1);
    expect(rows.cs?.sessions).toBe(3);
    // A second pull ten minutes later reuses the analytics and finance blocks.
    calls.length = 0;
    const again = await pullShop(client, { accessToken: 't', cipher: 'c' }, { now: NOW + 600000, previous: rows });
    expect(calls.some((c) => c.startsWith('/analytics'))).toBe(false);
    expect(calls.some((c) => c.startsWith('/finance'))).toBe(false);
    expect(again.scopes.analytics?.state).toBe('skipped');
    expect(again.analytics).toHaveLength(1);
  });
});

describe('health engine with TikTok shops', () => {
  it('pulls the shops, stores the pull, flags through the monitor, builds the overview and the scope status', async () => {
    const q = new Queries(openTestDb());
    const account = q.listAccounts().find((a) => a.name === 'Clearly')!;
    q.upsertTtsShop({ id: 'DEDELCTEST', name: 'Clearly DE', region: 'DE', seller_type: 'LOCAL', cipher: 'cph', seller_name: null }, { access_token: 'a', refresh_token: 'r', access_token_expire_in: Math.floor(Date.now() / 1000) + 86400, refresh_token_expire_in: Math.floor(Date.now() / 1000) + 30 * 86400 } as never);
    q.linkTtsShop('DEDELCTEST', account.id, 'DE');
    q.setAccountTarget(account.id, '', 'samples_per_week', 10, 'Isaac');
    q.setAccountTarget(account.id, '', 'gmv_target_month', 100000, 'Isaac');
    const S2 = Math.floor(Date.now() / 1000);
    const client = {
      configured: true,
      async call(_m: string, path: string) {
        if (path.startsWith('/analytics')) return { latest_available_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), performance: { intervals: Array.from({ length: 14 }, (_, i) => ({ start_date: new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 10), sales: { gmv: { overall: { amount: i < 7 ? '100' : '1000' }, breakdowns: [{ type: 'VIDEO', gmv: { amount: '50' } }] }, orders_count: 5, items_sold: 6, refunds: { amount: '0' } }, traffic: { avg_visitors: 100, avg_page_views: 200, avg_conversation_rate: '2' } })) } };
        if (path.startsWith('/order')) return { orders: [{ id: 'late', status: 'AWAITING_SHIPMENT', create_time: S2 - 86400, rts_sla_time: S2 - 7200 }] };
        if (path.startsWith('/product')) return { products: [{ id: 'p1', title: 'Mag', status: 'ACTIVATE', skus: [{ id: 's1', seller_sku: 'MAG', price: { tax_exclusive_price: '12', currency: 'EUR' }, inventory: [{ quantity: 0 }] }] }] };
        throw new TtsError('TikTok Shop error 105002: no permission for this api', 105002);
      },
    } as unknown as TtsClient;
    const health = new HealthEngine(q, { tts: client, windsor: { configured: false } as never, llm: null });
    const monitor = new AccountMonitor(q, client);
    monitor.health = health;
    const r = await health.pullTikTok();
    expect(r.shops).toBe(1);
    expect(r.errors).toEqual([]);
    const pull = q.latestHealthPulls('tts')[0];
    expect(pull.metrics.gmv_7d).toBe(700);
    expect(pull.metrics.ship_sla_breached).toBe(1);
    expect(pull.metrics.out_of_stock_skus).toBe(1);
    const scopes = health.scopeStatus();
    expect(scopes.find((s) => s.scope === 'analytics')!.state).toBe('ok');
    expect(scopes.find((s) => s.scope === 'affiliate_seller')!.state).toBe('denied');
    await monitor.scan();
    const codes = q.listFlags(false).filter((f) => f.account_id === account.id).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['t_gmv_drop', 't_ship_sla_breach', 't_out_of_stock', 'g_gmv_behind_target']));
    expect(codes.some((c) => c.startsWith('t_samples'))).toBe(false);
    const data = monitor.data();
    const row = data.accounts.find((a) => a.id === account.id)!;
    expect(row.gmv_7d).toBe(700);
    expect(row.shops).toBe(1);
    expect(row.gmv_pace).not.toBeNull();
    expect(data.scopes).toHaveLength(7);
    const o = health.accountOverview(account.id, monitor.rules())!;
    expect(o.series).toHaveLength(14);
    expect(o.kpis.find((k) => k.key === 'gmv_7d')!.value).toBe(700);
    expect(o.kpis.find((k) => k.key === 'samples_week')!.note).toContain('Affiliate (seller)');
    expect(o.kpis.find((k) => k.key === 'shop_score')!.note).toContain('Seller Center');
    const orders = o.sections.find((s) => s.section === 'Orders')!;
    expect(orders.state).toBe('crit');
    expect(o.sections.find((s) => s.section === 'Affiliate')!.state).toBe('nodata');
    expect(o.sections.find((s) => s.section === 'Account health')!.missing.join(' ')).toContain('Seller Center');
    // The product pull refreshed the current price on the SKU list.
    q.saveSkuPrice({ account_id: account.id, market: 'DE', name: 'Mag', sku_id: 's1', list_price: 10, floor_price: 9 });
    await health.pullTikTok({ force: true });
    expect(q.listSkuPrices(account.id)[0].current_price).toBe(12);
    await monitor.scan();
    expect(q.listFlags(false).some((f) => f.code === 'g_price_drift')).toBe(true);
  });
});
