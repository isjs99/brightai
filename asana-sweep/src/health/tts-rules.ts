import type { AccountCampaign, AccountSkuPrice, AccountTarget, HealthThresholds, MonitorFlag, MonitorRule, Promotion, TtsScope } from '../sweep/types.js';

/**
 * The account monitor's rules over the TikTok Shop OpenAPI, one scope at a time, and the rules that compare
 * an account against the targets typed in under Account monitor › Targets (samples a week, GMV, GMV Max
 * spend and ROI, promotion pricing, platform campaigns). Each rule names the scope it reads so the UI can say
 * exactly which approval is missing when a check cannot run yet. Every rule is pure: it reads the stored
 * pull for a shop and the thresholds, so it re-runs on every scan without a new API call.
 */

export type Found = { account_id: number | null; shop_id: string | null; code: string; severity: MonitorFlag['severity']; message: string; detail?: string | null };
export type RuleDef = Omit<MonitorRule, 'enabled'> & { scope: TtsScope };

/** Checklist section names, exactly as the AM checklist template spells them. */
export const SECTIONS = {
  homepage: 'Homepage', orders: 'Orders', growth: 'Growth', live: 'LIVE & video Analytics', affiliate: 'Affiliate', cs: 'CS / Returns / Aftercare',
  products: 'Products', finance: 'Finance', logistics: 'Logistics', analytics: 'Analytics', marketing: 'Marketing', health: 'Account health',
} as const;

export const SCOPE_LABELS: Record<TtsScope, string> = {
  analytics: 'Analytics and reporting', order: 'Order management', product: 'Product management', return_refund: 'Return and refund', affiliate_seller: 'Affiliate (seller)',
  customer_service: 'Customer service', finance: 'Finance', promotion: 'Promotion', seller: 'Seller information', none: 'Dashboard data',
};

export const TTS_RULES: RuleDef[] = [
  // Analytics and reporting (approved)
  { code: 't_gmv_drop', title: 'GMV down week on week', description: 'GMV in the last 7 days is down by the threshold against the 7 days before (Analytics API, shop local currency).', severity: 'warn', source: 'tts', section: SECTIONS.analytics, scope: 'analytics' },
  { code: 't_visitors_drop', title: 'Visitors down week on week', description: 'Average daily visitors in the last 7 days down by the threshold against the week before.', severity: 'warn', source: 'tts', section: SECTIONS.analytics, scope: 'analytics' },
  { code: 't_conversion_drop', title: 'Conversion rate down', description: 'Average conversion rate in the last 7 days down by the threshold against the week before: traffic still comes but buys less (price, stock, PDP or reviews).', severity: 'warn', source: 'tts', section: SECTIONS.analytics, scope: 'analytics' },
  { code: 't_channel_drop', title: 'One sales channel collapsed', description: 'Video, LIVE or product-card GMV in the last 7 days is down by half or more against the week before while the shop still sells: that channel stopped working.', severity: 'warn', source: 'tts', section: SECTIONS.live, scope: 'analytics' },
  { code: 't_no_live_gmv', title: 'No LIVE sales this week', description: 'The shop sold nothing through LIVE in the last 7 days although it did the week before: scheduled lives did not happen or did not convert.', severity: 'info', source: 'tts', section: SECTIONS.live, scope: 'analytics' },
  { code: 't_refund_share', title: 'Refunds eating GMV', description: 'Refunded amount in the last 7 days above the refund-rate threshold share of GMV.', severity: 'warn', source: 'tts', section: SECTIONS.cs, scope: 'analytics' },
  { code: 't_analytics_stale', title: 'Analytics data stale', description: 'The last analytics pull failed or TikTok has no data newer than the threshold.', severity: 'info', source: 'tts', section: SECTIONS.health, scope: 'analytics' },
  // Order management
  { code: 't_ship_sla_breach', title: 'Orders past the ship-by deadline', description: 'Orders awaiting shipment past the platform ship-by time. Late dispatch hits the shop score.', severity: 'crit', source: 'tts', section: SECTIONS.orders, scope: 'order' },
  { code: 't_ship_due_soon', title: 'Orders due to ship soon', description: 'Orders awaiting shipment whose ship-by deadline is within the next hours.', severity: 'warn', source: 'tts', section: SECTIONS.orders, scope: 'order' },
  { code: 't_auto_cancel_risk', title: 'Orders close to auto-cancel', description: 'Unshipped orders the platform will cancel automatically within the window.', severity: 'crit', source: 'tts', section: SECTIONS.orders, scope: 'order' },
  { code: 't_buyer_cancel_requests', title: 'Buyer cancellation requests pending', description: 'Buyers asked to cancel and the request has not been handled.', severity: 'warn', source: 'tts', section: SECTIONS.orders, scope: 'order' },
  { code: 't_on_hold', title: 'Orders on hold', description: 'Orders in ON_HOLD (payment or risk review); they cannot ship until released.', severity: 'warn', source: 'tts', section: SECTIONS.orders, scope: 'order' },
  { code: 't_buyer_notes', title: 'Unshipped orders with a buyer note', description: 'Orders still to ship where the buyer left a message (address change, gift note, urgency).', severity: 'info', source: 'tts', section: SECTIONS.cs, scope: 'order' },
  { code: 't_cancel_rate', title: 'High cancellation rate', description: 'Share of orders cancelled in the last 7 days above the threshold, with who cancelled.', severity: 'warn', source: 'tts', section: SECTIONS.orders, scope: 'order' },
  { code: 't_order_drop', title: 'Orders down week on week', description: 'Order count in the last 7 days is down by the threshold against the 7 days before.', severity: 'warn', source: 'tts', section: SECTIONS.analytics, scope: 'order' },
  { code: 't_late_pickup', title: 'Shipped but not collected', description: 'Orders marked shipped that the carrier has not collected past the collection deadline, grouped by provider.', severity: 'warn', source: 'tts', section: SECTIONS.logistics, scope: 'order' },
  { code: 't_late_delivery', title: 'Deliveries running late', description: 'Orders in transit past the delivery deadline or longer than the threshold, grouped by provider.', severity: 'warn', source: 'tts', section: SECTIONS.logistics, scope: 'order' },
  // Product management
  { code: 't_out_of_stock', title: 'Live SKUs out of stock', description: 'Active listings with a SKU at zero inventory.', severity: 'crit', source: 'tts', section: SECTIONS.products, scope: 'product' },
  { code: 't_low_stock', title: 'Live SKUs low on stock', description: 'Active listings with a SKU under the low-stock threshold.', severity: 'warn', source: 'tts', section: SECTIONS.products, scope: 'product' },
  { code: 't_product_deactivated', title: 'Products deactivated or frozen by the platform', description: 'Listings in PLATFORM_DEACTIVATED, FREEZE or SUSPENDED status.', severity: 'crit', source: 'tts', section: SECTIONS.products, scope: 'product' },
  { code: 't_listing_failed', title: 'Listings failed review', description: 'Products in FAILED status: the listing audit rejected them.', severity: 'warn', source: 'tts', section: SECTIONS.products, scope: 'product' },
  { code: 't_no_live_products', title: 'No live listings', description: 'The shop has products but none is active.', severity: 'warn', source: 'tts', section: SECTIONS.products, scope: 'product' },
  { code: 't_drafts_pending', title: 'Drafts or pending listings piling up', description: 'More draft or pending-review products than the threshold.', severity: 'info', source: 'tts', section: SECTIONS.products, scope: 'product' },
  { code: 't_listing_quality', title: 'Listings rated poor', description: 'Active products whose listing quality tier is POOR.', severity: 'info', source: 'tts', section: SECTIONS.products, scope: 'product' },
  // Return and refund
  { code: 't_returns_waiting', title: 'Returns waiting on the seller', description: 'Return or refund requests where the next action is the seller\'s and the TikTok deadline has passed or is inside the grace window.', severity: 'crit', source: 'tts', section: SECTIONS.cs, scope: 'return_refund' },
  { code: 't_return_rate', title: 'High return rate', description: 'Returns opened in the last 7 days above the refund-rate threshold share of orders.', severity: 'warn', source: 'tts', section: SECTIONS.cs, scope: 'return_refund' },
  // Affiliate (seller)
  { code: 't_samples_waiting', title: 'Sample requests waiting on review', description: 'Sample applications pending the seller\'s approval longer than the threshold, or past TikTok\'s approval deadline.', severity: 'warn', source: 'tts', section: SECTIONS.affiliate, scope: 'affiliate_seller' },
  { code: 't_samples_late_ship', title: 'Approved samples not shipped', description: 'Approved sample orders past TikTok\'s shipment deadline without a tracking number.', severity: 'warn', source: 'tts', section: SECTIONS.affiliate, scope: 'affiliate_seller' },
  { code: 't_samples_below_target', title: 'Samples sent below the weekly target', description: 'Samples approved this week against the target per week on the account (Targets tab), pro rata for the days elapsed.', severity: 'warn', source: 'targets', section: SECTIONS.affiliate, scope: 'affiliate_seller' },
  { code: 't_samples_drop', title: 'Sample approvals down', description: 'Samples approved in the last 7 days down by the threshold against the week before.', severity: 'info', source: 'tts', section: SECTIONS.affiliate, scope: 'affiliate_seller' },
  // Customer service
  { code: 't_cs_response_low', title: 'CS response rate under target', description: 'Share of chat sessions answered within 24 hours under the threshold (last 7 days).', severity: 'warn', source: 'tts', section: SECTIONS.cs, scope: 'customer_service' },
  { code: 't_cs_satisfaction_low', title: 'CS satisfaction under target', description: 'Share of chat sessions rated satisfied under the threshold (last 7 days).', severity: 'info', source: 'tts', section: SECTIONS.cs, scope: 'customer_service' },
  // Finance
  { code: 't_payout_failed', title: 'Payout failed', description: 'A payment to the seller failed or was rejected.', severity: 'crit', source: 'tts', section: SECTIONS.finance, scope: 'finance' },
  { code: 't_payout_missing', title: 'No payout received', description: 'Orders are being paid but no payout has landed within the threshold.', severity: 'warn', source: 'tts', section: SECTIONS.finance, scope: 'finance' },
  { code: 't_reserve_spike', title: 'Reserve withheld', description: 'The platform is holding back more than the threshold share of payouts as a reserve.', severity: 'warn', source: 'tts', section: SECTIONS.finance, scope: 'finance' },
  { code: 't_negative_statement', title: 'Statement settled negative', description: 'A statement in the last 30 days settled below zero.', severity: 'crit', source: 'tts', section: SECTIONS.finance, scope: 'finance' },
  { code: 't_adjustment_spike', title: 'Adjustments high', description: 'Adjustments on statements in the last 30 days above the threshold share of revenue.', severity: 'warn', source: 'tts', section: SECTIONS.finance, scope: 'finance' },
  { code: 't_fee_share', title: 'Fees eating revenue', description: 'Fees above the threshold share of revenue on recent statements.', severity: 'info', source: 'tts', section: SECTIONS.finance, scope: 'finance' },
];

export const TARGET_RULES: RuleDef[] = [
  { code: 'g_gmv_behind_target', title: 'GMV behind the monthly target', description: 'Month-to-date GMV is behind the monthly target pro rata by more than the threshold (target on the Targets tab, GMV from the Analytics API).', severity: 'warn', source: 'targets', section: SECTIONS.analytics, scope: 'analytics' },
  { code: 'g_gmv_max_overspend', title: 'GMV Max spend over the weekly ceiling', description: 'This week\'s GMV Max spend (typed in on the Targets tab until the Ads API is connected) is over the weekly ceiling by more than the threshold.', severity: 'warn', source: 'targets', section: SECTIONS.marketing, scope: 'none' },
  { code: 'g_gmv_max_roi_low', title: 'GMV Max ROI under the minimum', description: 'This week\'s GMV Max GMV divided by spend is under the minimum ROI on the account (or the campaign\'s target ROI on the GMV Max page).', severity: 'warn', source: 'targets', section: SECTIONS.marketing, scope: 'none' },
  { code: 'g_gmv_max_no_actuals', title: 'GMV Max actuals missing', description: 'The account has GMV Max targets but no spend and GMV typed in for this week, so ROI cannot be checked.', severity: 'info', source: 'targets', section: SECTIONS.marketing, scope: 'none' },
  { code: 'g_promo_below_floor', title: 'Promotion prices a SKU under its floor', description: 'A live or scheduled promotion we hold takes a SKU under the floor price on the account\'s price list.', severity: 'crit', source: 'targets', section: SECTIONS.marketing, scope: 'none' },
  { code: 'g_promo_over_max_discount', title: 'Promotion discount over the maximum', description: 'A live or scheduled promotion discounts more than the maximum allowed on the account.', severity: 'warn', source: 'targets', section: SECTIONS.marketing, scope: 'none' },
  { code: 'g_promo_clash', title: 'Promotions clash', description: 'Two of our promotions overlap on the same shop and products, or a promotion overlaps a platform campaign the account fully participates in with a different discount.', severity: 'warn', source: 'targets', section: SECTIONS.marketing, scope: 'none' },
  { code: 'g_price_drift', title: 'Shop price differs from the agreed price', description: 'The price the shop currently shows for a SKU differs from the list price on the account\'s price list by more than 2% (read from the product pull).', severity: 'warn', source: 'targets', section: SECTIONS.marketing, scope: 'product' },
  { code: 'g_campaign_discount_over_max', title: 'Campaign discount over the maximum', description: 'A platform campaign on file discounts more than the campaign maximum on the account.', severity: 'warn', source: 'targets', section: SECTIONS.marketing, scope: 'none' },
  { code: 'g_campaign_missing', title: 'Full campaign participation set but no campaign live', description: 'The account is marked as participating fully in platform campaigns but no campaign is on file for the current period.', severity: 'info', source: 'targets', section: SECTIONS.marketing, scope: 'none' },
  { code: 'g_no_targets', title: 'No targets on file', description: 'The account has no targets yet (samples a week, GMV, GMV Max), so nothing can be measured against plan.', severity: 'info', source: 'targets', section: SECTIONS.health, scope: 'none' },
];

export const ALL_TTS_RULES: RuleDef[] = [...TTS_RULES, ...TARGET_RULES];

// ---- The pull payload (lite rows per shop), stored in health_pulls.rows_json ----

export interface TtsDay { date: string; gmv: number; orders: number; sku_orders: number; items: number; visitors: number; page_views: number; conversion: number; refunds: number; customers: number; video_gmv: number; live_gmv: number; card_gmv: number; ads_gmv: number | null; organic_gmv: number | null }
export interface TtsOrderLite { user_id?: string | null; recipient_name?: string | null; id: string; status: string; create_time: number; paid_time: number | null; rts_sla_time: number | null; rts_time: number | null; tts_sla_time: number | null; collection_time: number | null; delivery_sla_time: number | null; delivery_due_time: number | null; delivery_time: number | null; cancel_order_sla_time: number | null; cancel_time: number | null; cancellation_initiator: string | null; is_buyer_request_cancel: boolean; is_on_hold: boolean; buyer_message: string | null; shipping_provider: string | null; total_amount: number | null; currency: string | null; line_items: { product_id: string | null; sku_id: string | null; sale_price: number | null }[] }
export interface TtsProductLite { id: string; title: string; status: string; audit_status: string | null; quality_tier: string | null; skus: { id: string; seller_sku: string | null; price: number | null; currency: string | null; qty: number; status: string | null }[] }
export interface TtsReturnLite { return_id: string; order_id: string | null; status: string; type: string | null; create_time: number; update_time: number | null; role: string | null; next_action: string | null; next_deadline: number | null; refund_total: number | null; currency: string | null }
export interface TtsSampleLite { id: string; status: string; fulfillment_status: string | null; approve_expiration_time: number | null; shipment_expiration_time: number | null; tracking_number: string | null; order_id: string | null; creator: string | null; product: string | null }
export interface TtsPaymentLite { id: string; status: string; create_time: number; paid_time: number | null; amount: number; reserve: number; currency: string | null }
export interface TtsStatementLite { id: string; statement_time: number; settlement: number; revenue: number; fee: number; adjustment: number; payment_status: string | null; currency: string | null }
export interface TtsCsLite { sessions: number; response_pct: number | null; response_mins: number | null; satisfaction_pct: number | null }
export type ScopeResult = { ok: boolean; state: 'ok' | 'denied' | 'error' | 'skipped'; message: string | null; at: string };

export interface TtsRows {
  analytics: TtsDay[];
  latest_available_date: string | null;
  orders: TtsOrderLite[];
  products: TtsProductLite[];
  returns: TtsReturnLite[];
  samples: TtsSampleLite[];
  cs: TtsCsLite | null;
  payments: TtsPaymentLite[];
  statements: TtsStatementLite[];
  scopes: Partial<Record<TtsScope, ScopeResult>>;
  fetched_at: string;
}

export const emptyTtsRows = (): TtsRows => ({ analytics: [], latest_available_date: null, orders: [], products: [], returns: [], samples: [], cs: null, payments: [], statements: [], scopes: {}, fetched_at: new Date().toISOString() });

export interface ShopRef { shop_id: string; shop_name: string; account_id: number | null; currency?: string; market?: string | null }

const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const pctChange = (cur: number, prev: number): number | null => (prev > 0 ? round(((cur - prev) / prev) * 100, 1) : null);
const money = (n: number, currency: string | undefined) => `${currency ?? ''} ${Math.round(n).toLocaleString('en-GB')}`.trim();
const hours = (sec: number) => Math.round(sec / 3600);

/** Daily series for [now-days, now) from the pull, oldest first. */
export function lastDays(days: TtsDay[], n: number, now: number, offsetDays = 0): TtsDay[] {
  const end = new Date(now - offsetDays * 86400000).toISOString().slice(0, 10);
  const start = new Date(now - (offsetDays + n) * 86400000).toISOString().slice(0, 10);
  return days.filter((d) => d.date >= start && d.date < end).sort((a, b) => a.date.localeCompare(b.date));
}
const sum = (rows: TtsDay[], k: keyof TtsDay) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const avg = (rows: TtsDay[], k: keyof TtsDay) => (rows.length ? sum(rows, k) / rows.length : 0);

export interface SampleTargets { samples_per_week?: number | null; samples_min_per_week?: number | null }

/**
 * Metrics and flags for one shop from its stored TikTok pull. Blocks whose scope was denied or failed produce
 * no flags (the UI shows the missing scope instead); the analytics block is the only one that flags staleness.
 */
export function evaluateTts(shop: ShopRef, rows: TtsRows, t: HealthThresholds, opts: { now?: number; enabled?: Set<string>; targets?: SampleTargets } = {}): { metrics: Record<string, number | string | null>; flags: Found[] } {
  const now = opts.now ?? Date.now();
  const sec = now / 1000;
  const on = (code: string) => !opts.enabled || opts.enabled.has(code);
  const flags: Found[] = [];
  const metrics: Record<string, number | string | null> = {};
  const push = (code: string, message: string, detail?: string | null) => {
    if (!on(code)) return;
    const def = ALL_TTS_RULES.find((r) => r.code === code)!;
    flags.push({ account_id: shop.account_id, shop_id: shop.shop_id, code, severity: def.severity, message: `${shop.shop_name}: ${message}`, detail: detail ?? null });
  };
  const live = (scope: TtsScope) => rows.scopes[scope]?.ok === true;
  const cur = shop.currency;

  // ---- Analytics ----
  if (live('analytics')) {
    const last7 = lastDays(rows.analytics, 7, now);
    const prev7 = lastDays(rows.analytics, 7, now, 7);
    const gmv7 = sum(last7, 'gmv'); const gmvP = sum(prev7, 'gmv');
    metrics.gmv_7d = round(gmv7); metrics.gmv_prev_7d = round(gmvP);
    metrics.orders_7d_analytics = sum(last7, 'orders'); metrics.orders_prev_7d_analytics = sum(prev7, 'orders'); metrics.items_7d = sum(last7, 'items');
    metrics.visitors_7d = round(avg(last7, 'visitors')); metrics.visitors_prev_7d = round(avg(prev7, 'visitors'));
    metrics.conversion_7d = round(avg(last7, 'conversion'), 2); metrics.conversion_prev_7d = round(avg(prev7, 'conversion'), 2);
    metrics.refunds_7d = round(sum(last7, 'refunds'));
    metrics.video_gmv_7d = round(sum(last7, 'video_gmv')); metrics.live_gmv_7d = round(sum(last7, 'live_gmv')); metrics.card_gmv_7d = round(sum(last7, 'card_gmv'));
    const ads = last7.filter((d) => d.ads_gmv !== null);
    metrics.ads_gmv_7d = ads.length ? round(ads.reduce((s, d) => s + (d.ads_gmv ?? 0), 0)) : null;
    metrics.latest_available_date = rows.latest_available_date;
    const change = pctChange(gmv7, gmvP);
    if (gmvP >= 500 && change !== null && change <= -t.gmv_drop_pct) push('t_gmv_drop', `GMV ${money(gmv7, cur)} in the last 7 days vs ${money(gmvP, cur)} the week before (${Math.round(change)}%)`);
    const vch = pctChange(avg(last7, 'visitors'), avg(prev7, 'visitors'));
    if (avg(prev7, 'visitors') >= 100 && vch !== null && vch <= -t.visitors_drop_pct) push('t_visitors_drop', `${Math.round(avg(last7, 'visitors'))} visitors a day vs ${Math.round(avg(prev7, 'visitors'))} the week before (${Math.round(vch)}%)`);
    const cch = pctChange(avg(last7, 'conversion'), avg(prev7, 'conversion'));
    if (avg(prev7, 'conversion') > 0 && avg(last7, 'visitors') >= 100 && cch !== null && cch <= -t.conversion_drop_pct) push('t_conversion_drop', `conversion ${avg(last7, 'conversion').toFixed(2)}% vs ${avg(prev7, 'conversion').toFixed(2)}% the week before (${Math.round(cch)}%)`);
    for (const [k, label] of [['video_gmv', 'Video'], ['live_gmv', 'LIVE'], ['card_gmv', 'Product card']] as const) {
      const c = sum(last7, k); const p = sum(prev7, k);
      if (p >= 300 && gmv7 > 0 && c <= p * 0.5) push('t_channel_drop', `${label} GMV ${money(c, cur)} vs ${money(p, cur)} the week before (${Math.round(((c - p) / p) * 100)}%) while the shop did ${money(gmv7, cur)} overall`);
    }
    if (sum(prev7, 'live_gmv') >= 300 && sum(last7, 'live_gmv') === 0) push('t_no_live_gmv', `no LIVE sales in the last 7 days (${money(sum(prev7, 'live_gmv'), cur)} the week before)`);
    const refunds = sum(last7, 'refunds');
    if (gmv7 >= 500 && refunds / gmv7 * 100 > t.refund_rate_pct) push('t_refund_share', `refunds ${money(refunds, cur)} against ${money(gmv7, cur)} GMV in the last 7 days (${Math.round((refunds / gmv7) * 100)}%)`);
    const latest = rows.latest_available_date ? Date.parse(`${rows.latest_available_date}T23:59:59Z`) : null;
    if (latest !== null && now - latest > t.data_stale_hours * 3600000 + 86400000) push('t_analytics_stale', `TikTok's latest analytics date is ${rows.latest_available_date}`);
  } else if (rows.scopes.analytics && rows.scopes.analytics.state === 'error') {
    push('t_analytics_stale', `analytics pull failed: ${rows.scopes.analytics.message ?? 'unknown error'}`);
  }

  // ---- Orders ----
  if (live('order')) {
    const o = rows.orders;
    const open = o.filter((x) => x.status === 'AWAITING_SHIPMENT');
    metrics.awaiting_shipment = open.length;
    const breached = open.filter((x) => (x.rts_sla_time !== null ? x.rts_sla_time < sec : sec - x.create_time > t.ship_grace_hours * 3600));
    metrics.ship_sla_breached = breached.length;
    if (breached.length) push('t_ship_sla_breach', `${breached.length} order(s) past the ship-by deadline`, breached.slice(0, 10).map((x) => `${x.id} (${x.rts_sla_time ? `${hours(sec - x.rts_sla_time)}h late` : `${hours(sec - x.create_time)}h old`})`).join(', '));
    const dueSoon = open.filter((x) => x.rts_sla_time !== null && x.rts_sla_time >= sec && x.rts_sla_time - sec < t.ship_due_within_hours * 3600);
    if (dueSoon.length) push('t_ship_due_soon', `${dueSoon.length} order(s) must ship within ${t.ship_due_within_hours}h`, dueSoon.slice(0, 10).map((x) => x.id).join(', '));
    const autoCancel = open.filter((x) => x.cancel_order_sla_time !== null && x.cancel_order_sla_time - sec < t.auto_cancel_within_hours * 3600);
    if (autoCancel.length) push('t_auto_cancel_risk', `${autoCancel.length} unshipped order(s) auto-cancel within ${t.auto_cancel_within_hours}h`, autoCancel.slice(0, 10).map((x) => x.id).join(', '));
    const cancelReq = o.filter((x) => x.is_buyer_request_cancel && !['CANCELLED', 'COMPLETED', 'DELIVERED'].includes(x.status));
    if (cancelReq.length) push('t_buyer_cancel_requests', `${cancelReq.length} buyer cancellation request(s) waiting`, cancelReq.slice(0, 10).map((x) => x.id).join(', '));
    const onHold = o.filter((x) => x.status === 'ON_HOLD' || (x.is_on_hold && x.status === 'AWAITING_SHIPMENT'));
    if (onHold.length) push('t_on_hold', `${onHold.length} order(s) on hold`, onHold.slice(0, 10).map((x) => x.id).join(', '));
    const notes = open.filter((x) => x.buyer_message && x.buyer_message.trim());
    if (notes.length) push('t_buyer_notes', `${notes.length} unshipped order(s) carry a buyer note`, notes.slice(0, 6).map((x) => `${x.id}: "${(x.buyer_message ?? '').slice(0, 80)}"`).join(' · '));
    const last7 = o.filter((x) => x.create_time >= sec - 7 * 86400); const prev7 = o.filter((x) => x.create_time >= sec - 14 * 86400 && x.create_time < sec - 7 * 86400);
    metrics.orders_7d = last7.length; metrics.orders_prev_7d = prev7.length;
    const cancelled = last7.filter((x) => x.status === 'CANCELLED');
    metrics.cancel_rate_7d = last7.length ? round((cancelled.length / last7.length) * 100, 1) : null;
    if (last7.length >= t.min_orders_for_rates && cancelled.length / last7.length * 100 > t.cancel_rate_pct) {
      const by = new Map<string, number>(); for (const c of cancelled) by.set(c.cancellation_initiator ?? 'UNKNOWN', (by.get(c.cancellation_initiator ?? 'UNKNOWN') ?? 0) + 1);
      push('t_cancel_rate', `${cancelled.length} of ${last7.length} orders cancelled in the last 7 days (${Math.round((cancelled.length / last7.length) * 100)}%)`, [...by].map(([k, v]) => `${k.toLowerCase()}: ${v}`).join(' · '));
    }
    const och = pctChange(last7.length, prev7.length);
    if (prev7.length >= t.min_orders_for_rates && och !== null && och <= -t.order_drop_pct) push('t_order_drop', `${last7.length} orders in the last 7 days vs ${prev7.length} the week before (${Math.round(och)}%)`);
    const latePickup = o.filter((x) => x.status === 'AWAITING_COLLECTION' && (x.tts_sla_time !== null ? x.tts_sla_time < sec : x.rts_time !== null && sec - x.rts_time > t.pickup_late_hours * 3600));
    if (latePickup.length) { const by = group(latePickup.map((x) => x.shipping_provider ?? 'unknown carrier')); push('t_late_pickup', `${latePickup.length} shipped order(s) not collected past the deadline`, by); }
    const lateDelivery = o.filter((x) => x.status === 'IN_TRANSIT' && ((x.delivery_sla_time !== null && x.delivery_sla_time < sec) || (x.delivery_due_time !== null && x.delivery_due_time < sec) || (x.collection_time !== null && sec - x.collection_time > t.delivery_late_days * 86400)));
    if (lateDelivery.length) { const by = group(lateDelivery.map((x) => x.shipping_provider ?? 'unknown carrier')); push('t_late_delivery', `${lateDelivery.length} delivery(ies) running late`, by); }
  }

  // ---- Products ----
  if (live('product')) {
    const p = rows.products;
    const activeStatus = (s: string) => s === 'ACTIVATE' || s === 'ACTIVATED' || s === 'LIVE';
    const active = p.filter((x) => activeStatus(x.status));
    metrics.active_products = active.length; metrics.products_total = p.length;
    const skus = active.flatMap((x) => x.skus.filter((s) => s.status !== 'DEACTIVATED').map((s) => ({ p: x, s })));
    const oos = skus.filter(({ s }) => s.qty <= 0); const low = skus.filter(({ s }) => s.qty > 0 && s.qty < t.low_stock_units);
    metrics.out_of_stock_skus = oos.length; metrics.low_stock_skus = low.length;
    if (oos.length) push('t_out_of_stock', `${oos.length} live SKU(s) out of stock`, oos.slice(0, 8).map(({ p: x, s }) => `${x.title}${s.seller_sku ? ` (${s.seller_sku})` : ''}`).join(' · '));
    if (low.length) push('t_low_stock', `${low.length} live SKU(s) under ${t.low_stock_units} units`, low.slice(0, 8).map(({ p: x, s }) => `${x.title}${s.seller_sku ? ` (${s.seller_sku})` : ''}: ${s.qty}`).join(' · '));
    const bad = p.filter((x) => /PLATFORM_DEACTIVATED|FREEZE|SUSPENDED/.test(x.status));
    if (bad.length) push('t_product_deactivated', `${bad.length} product(s) deactivated or frozen by the platform`, bad.slice(0, 8).map((x) => x.title).join(' · '));
    const failed = p.filter((x) => x.status === 'FAILED' || x.audit_status === 'FAILED');
    if (failed.length) push('t_listing_failed', `${failed.length} listing(s) failed review`, failed.slice(0, 8).map((x) => x.title).join(' · '));
    if (p.length && !active.length) push('t_no_live_products', `${p.length} products and none is live`);
    const drafts = p.filter((x) => x.status === 'DRAFT' || x.status === 'PENDING');
    if (drafts.length > t.drafts_max) push('t_drafts_pending', `${drafts.length} draft or pending listing(s)`, drafts.slice(0, 8).map((x) => x.title).join(' · '));
    const poor = active.filter((x) => (x.quality_tier ?? '').toUpperCase() === 'POOR');
    if (poor.length) push('t_listing_quality', `${poor.length} live listing(s) rated poor`, poor.slice(0, 8).map((x) => x.title).join(' · '));
  }

  // ---- Returns ----
  if (live('return_refund')) {
    const r = rows.returns;
    const waiting = r.filter((x) => x.next_action && /SELLER/.test(x.next_action) && (x.next_deadline !== null ? x.next_deadline - sec < t.return_response_grace_hours * 3600 : sec - x.create_time > t.return_response_grace_hours * 3600));
    metrics.returns_waiting = waiting.length;
    if (waiting.length) push('t_returns_waiting', `${waiting.length} return(s) waiting on the seller${waiting.some((x) => x.next_deadline !== null && x.next_deadline < sec) ? ', some past the TikTok deadline' : ''}`, waiting.slice(0, 8).map((x) => `${x.return_id}${x.next_deadline ? ` (deadline ${x.next_deadline < sec ? `${hours(sec - x.next_deadline)}h ago` : `in ${hours(x.next_deadline - sec)}h`})` : ''}`).join(', '));
    const opened7 = r.filter((x) => x.create_time >= sec - 7 * 86400);
    metrics.returns_7d = opened7.length;
    const orders7 = typeof metrics.orders_7d === 'number' ? metrics.orders_7d : typeof metrics.orders_7d_analytics === 'number' ? metrics.orders_7d_analytics : null;
    if (orders7 !== null && orders7 >= t.min_orders_for_rates && (opened7.length / orders7) * 100 > t.refund_rate_pct) push('t_return_rate', `${opened7.length} return(s) against ${orders7} orders in the last 7 days (${Math.round((opened7.length / orders7) * 100)}%)`);
  }

  // ---- Samples ----
  if (live('affiliate_seller')) {
    const s = rows.samples;
    const pending = s.filter((x) => x.status === 'PENDING');
    const weekStart = startOfWeek(now) / 1000;
    const approvedThisWeek = s.filter((x) => x.status === 'APPROVED' && x.approve_expiration_time !== null && x.approve_expiration_time >= weekStart - 7 * 86400);
    metrics.samples_pending = pending.length;
    metrics.samples_week = approvedThisWeek.length;
    const overdue = pending.filter((x) => (x.approve_expiration_time !== null && x.approve_expiration_time - sec < (72 - t.samples_review_hours) * 3600));
    if (overdue.length) push('t_samples_waiting', `${overdue.length} sample request(s) waiting on review${overdue.some((x) => x.approve_expiration_time !== null && x.approve_expiration_time < sec) ? ', some past TikTok\'s approval deadline' : ''}`, overdue.slice(0, 8).map((x) => `${x.creator ?? x.id}${x.product ? ` · ${x.product}` : ''}`).join(' · '));
    const lateShip = s.filter((x) => x.status === 'APPROVED' && !x.tracking_number && x.shipment_expiration_time !== null && x.shipment_expiration_time < sec);
    if (lateShip.length) push('t_samples_late_ship', `${lateShip.length} approved sample(s) past the shipment deadline without tracking`, lateShip.slice(0, 8).map((x) => x.creator ?? x.id).join(' · '));
    const target = opts.targets?.samples_per_week ?? null;
    if (target !== null && target > 0) {
      const elapsed = Math.max(1, Math.min(7, Math.ceil((now - startOfWeek(now)) / 86400000)));
      const expected = (target * elapsed) / 7;
      metrics.samples_week_target = target;
      if (elapsed >= 2 && approvedThisWeek.length < expected * (1 - t.target_behind_pct / 100)) push('t_samples_below_target', `${approvedThisWeek.length} sample(s) approved this week, ${Math.round(expected)} expected by now for a target of ${target} a week`);
    }
  }

  // ---- Customer service ----
  if (live('customer_service') && rows.cs) {
    metrics.cs_sessions_7d = rows.cs.sessions; metrics.cs_response_pct = rows.cs.response_pct; metrics.cs_satisfaction_pct = rows.cs.satisfaction_pct; metrics.cs_response_mins = rows.cs.response_mins;
    if (rows.cs.sessions >= 10 && rows.cs.response_pct !== null && rows.cs.response_pct < t.cs_response_pct_min) push('t_cs_response_low', `${Math.round(rows.cs.response_pct)}% of ${rows.cs.sessions} chats answered within 24h (target ${t.cs_response_pct_min}%)`);
    if (rows.cs.sessions >= 10 && rows.cs.satisfaction_pct !== null && rows.cs.satisfaction_pct < t.cs_satisfaction_pct_min) push('t_cs_satisfaction_low', `${Math.round(rows.cs.satisfaction_pct)}% satisfied across ${rows.cs.sessions} chats (target ${t.cs_satisfaction_pct_min}%)`);
  }

  // ---- Finance ----
  if (live('finance')) {
    const pay = rows.payments; const st = rows.statements;
    const failed = pay.filter((x) => /FAIL|REJECT/.test(x.status.toUpperCase()));
    if (failed.length) push('t_payout_failed', `${failed.length} payout(s) failed`, failed.slice(0, 5).map((x) => `${x.id}: ${money(x.amount, x.currency ?? cur)}`).join(' · '));
    const paid = pay.filter((x) => /PAID|SUCCESS/.test(x.status.toUpperCase())).sort((a, b) => (b.paid_time ?? b.create_time) - (a.paid_time ?? a.create_time));
    metrics.last_payout_at = paid[0] ? new Date((paid[0].paid_time ?? paid[0].create_time) * 1000).toISOString().slice(0, 10) : null;
    const hasSales = (typeof metrics.gmv_7d === 'number' && metrics.gmv_7d > 0) || (typeof metrics.orders_7d === 'number' && metrics.orders_7d > 0);
    if (hasSales && (!paid[0] || sec - (paid[0].paid_time ?? paid[0].create_time) > t.payout_missing_days * 86400)) push('t_payout_missing', paid[0] ? `no payout since ${metrics.last_payout_at}` : 'no payout on record while orders are being paid');
    const recent = pay.filter((x) => x.create_time >= sec - 30 * 86400);
    const total = recent.reduce((n, x) => n + x.amount, 0); const reserve = recent.reduce((n, x) => n + x.reserve, 0);
    if (total > 0 && reserve / (total + reserve) * 100 > t.reserve_share_pct) push('t_reserve_spike', `${Math.round((reserve / (total + reserve)) * 100)}% of the last 30 days' payouts held as reserve (${money(reserve, cur)})`);
    const st30 = st.filter((x) => x.statement_time >= sec - 30 * 86400);
    const neg = st30.filter((x) => x.settlement < 0);
    if (neg.length) push('t_negative_statement', `${neg.length} statement(s) settled negative in the last 30 days`, neg.slice(0, 5).map((x) => `${new Date(x.statement_time * 1000).toISOString().slice(0, 10)}: ${money(x.settlement, x.currency ?? cur)}`).join(' · '));
    const revenue = st30.reduce((n, x) => n + x.revenue, 0); const adj = st30.reduce((n, x) => n + Math.abs(x.adjustment), 0); const fees = st30.reduce((n, x) => n + Math.abs(x.fee), 0);
    if (revenue > 0 && adj / revenue * 100 > t.adjustment_share_pct) push('t_adjustment_spike', `adjustments ${money(adj, cur)} against ${money(revenue, cur)} revenue in the last 30 days (${Math.round((adj / revenue) * 100)}%)`);
    if (revenue > 0 && fees / revenue * 100 > t.fee_share_pct) push('t_fee_share', `fees ${money(fees, cur)} against ${money(revenue, cur)} revenue (${Math.round((fees / revenue) * 100)}%)`);
    metrics.fee_share_30d = revenue > 0 ? round((fees / revenue) * 100, 1) : null;
  }

  return { metrics, flags };
}

function group(labels: string[]): string {
  const by = new Map<string, number>();
  for (const l of labels) by.set(l, (by.get(l) ?? 0) + 1);
  return [...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

/** Monday 00:00 UTC of the week containing `now`. */
export function startOfWeek(now: number): number {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.getTime();
}

// ---- Targets rules (per account, over the dashboard's own data) ----

export interface TargetContext {
  account: { id: number; name: string; markets: string | null };
  targets: AccountTarget[];
  promotions: Promotion[];
  campaigns: AccountCampaign[];
  skuPrices: AccountSkuPrice[];
  gmvMax: { market: string; daily_budget: number | null; target_roi: number | null; status: string }[];
  /** Month-to-date GMV from the analytics pulls (sum over the account's shops), null without analytics. */
  gmv_month_to_date: number | null;
  currency: string;
  /** Shop ids per market, to match promotion products to SKU prices. */
  shopIdsByMarket: Record<string, string[]>;
}

export const targetValue = (targets: AccountTarget[], key: AccountTarget['key'], market = ''): number | null => {
  const m = market.toUpperCase();
  const exact = targets.find((t) => t.key === key && t.market === m);
  if (exact) return exact.value;
  const all = targets.find((t) => t.key === key && t.market === '');
  return all ? all.value : null;
};

export function evaluateTargets(ctx: TargetContext, t: HealthThresholds, opts: { now?: number; enabled?: Set<string> } = {}): Found[] {
  const now = opts.now ?? Date.now();
  const on = (code: string) => !opts.enabled || opts.enabled.has(code);
  const flags: Found[] = [];
  const push = (code: string, message: string, detail?: string | null) => {
    if (!on(code)) return;
    const def = TARGET_RULES.find((r) => r.code === code)!;
    flags.push({ account_id: ctx.account.id, shop_id: null, code, severity: def.severity, message: `${ctx.account.name}: ${message}`, detail: detail ?? null });
  };
  const tv = (key: AccountTarget['key'], market = '') => targetValue(ctx.targets, key, market);
  const markets = (ctx.account.markets ?? '').toUpperCase().split(/[\/,\s]+/).filter((m) => /^[A-Z]{2}$/.test(m));
  const cur = ctx.currency;

  if (!ctx.targets.length) { push('g_no_targets', 'no targets on file yet (Account monitor › Targets)'); return flags; }

  // GMV vs monthly target, pro rata.
  const gmvTarget = tv('gmv_target_month');
  if (gmvTarget !== null && gmvTarget > 0 && ctx.gmv_month_to_date !== null) {
    const d = new Date(now); const day = d.getUTCDate(); const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const expected = (gmvTarget * day) / days;
    if (day >= 3 && ctx.gmv_month_to_date < expected * (1 - t.target_behind_pct / 100)) push('g_gmv_behind_target', `GMV ${money(ctx.gmv_month_to_date, cur)} month to date, ${money(expected, cur)} expected by day ${day} for a target of ${money(gmvTarget, cur)} (${Math.round((1 - ctx.gmv_month_to_date / expected) * 100)}% behind)`);
  }

  // GMV Max: weekly spend ceiling and minimum ROI, against the actuals typed in for the week.
  const scopes = markets.length ? ['', ...markets] : [''];
  let anyGmvMaxTarget = false; let anyActual = false;
  for (const m of scopes) {
    const ceiling = tv('gmv_max_weekly_spend', m); const minRoi = tv('gmv_max_min_roi', m) ?? ctx.gmvMax.find((g) => (m === '' || g.market === m) && g.target_roi !== null && g.status === 'active')?.target_roi ?? null;
    const spend = ctx.targets.find((x) => x.key === 'gmv_max_spend_actual_week' && x.market === m); const gmv = ctx.targets.find((x) => x.key === 'gmv_max_gmv_actual_week' && x.market === m);
    if (ceiling !== null || minRoi !== null) anyGmvMaxTarget = true;
    if (!spend) continue;
    anyActual = true;
    const label = m ? ` (${m})` : '';
    if (ceiling !== null && ceiling > 0 && spend.value > ceiling * (1 + t.gmv_max_overspend_pct / 100)) push('g_gmv_max_overspend', `GMV Max spend ${money(spend.value, cur)} this week${label} against a ceiling of ${money(ceiling, cur)} (${Math.round((spend.value / ceiling - 1) * 100)}% over)`);
    if (minRoi !== null && gmv && spend.value > 0) { const roi = gmv.value / spend.value; if (roi < minRoi) push('g_gmv_max_roi_low', `GMV Max ROI ${roi.toFixed(2)} this week${label} (${money(gmv.value, cur)} GMV on ${money(spend.value, cur)} spend) against a minimum of ${minRoi}`); }
  }
  if (anyGmvMaxTarget && !anyActual) push('g_gmv_max_no_actuals', 'GMV Max targets are set but no spend and GMV for this week have been entered (Targets tab)');

  // Promotions: price floors, maximum discount, clashes with each other and with campaigns.
  const nowIso = new Date(now).toISOString();
  const activePromos = ctx.promotions.filter((p) => p.targets.some((x) => x.account_id === ctx.account.id && x.status !== 'error' && x.status !== 'deactivated') && p.end_at > nowIso);
  const maxDisc = tv('promo_max_discount_pct');
  const priceAfter = (p: Promotion, list: number): number | null => (p.discount_value === null ? null : p.discount_type === 'PERCENTAGE_OFF' ? list * (1 - p.discount_value / 100) : p.discount_type === 'AMOUNT_OFF' ? list - p.discount_value : p.discount_value);
  for (const p of activePromos) {
    const myTargets = p.targets.filter((x) => x.account_id === ctx.account.id);
    const mkts = myTargets.map((x) => x.market);
    if (maxDisc !== null && p.discount_type === 'PERCENTAGE_OFF' && p.discount_value !== null && p.discount_value > maxDisc) push('g_promo_over_max_discount', `promotion "${p.name}" gives ${p.discount_value}% off, maximum allowed is ${maxDisc}%`);
    // Which SKUs does it touch: listed products, or every SKU in the market for shop-wide promotions.
    const shopIds = mkts.flatMap((m) => ctx.shopIdsByMarket[m] ?? []);
    const listed = new Set(shopIds.flatMap((id) => p.products[id] ?? []));
    const touched = ctx.skuPrices.filter((s) => (s.market === '' || mkts.includes(s.market)) && (p.product_level === 'SHOP' || (s.product_id !== null && listed.has(s.product_id))));
    const under = touched.filter((s) => s.list_price !== null && s.floor_price !== null && (priceAfter(p, s.list_price) ?? Infinity) < s.floor_price);
    if (under.length) push('g_promo_below_floor', `promotion "${p.name}" takes ${under.length} SKU(s) under the floor price`, under.slice(0, 8).map((s) => `${s.name}: ${(priceAfter(p, s.list_price!) ?? 0).toFixed(2)} vs floor ${s.floor_price!.toFixed(2)}`).join(' · '));
  }
  for (let i = 0; i < activePromos.length; i += 1) for (let j = i + 1; j < activePromos.length; j += 1) {
    const a = activePromos[i]; const b = activePromos[j];
    if (a.begin_at >= b.end_at || b.begin_at >= a.end_at) continue;
    const am = a.targets.filter((x) => x.account_id === ctx.account.id).map((x) => x.market); const bm = b.targets.filter((x) => x.account_id === ctx.account.id).map((x) => x.market);
    const shared = am.filter((m) => bm.includes(m));
    if (!shared.length) continue;
    const overlapProducts = a.product_level === 'SHOP' || b.product_level === 'SHOP' || shared.some((m) => (ctx.shopIdsByMarket[m] ?? []).some((id) => (a.products[id] ?? []).some((pid) => (b.products[id] ?? []).includes(pid))));
    if (overlapProducts) push('g_promo_clash', `"${a.name}" and "${b.name}" overlap in ${shared.join('/')} from ${b.begin_at > a.begin_at ? b.begin_at.slice(0, 10) : a.begin_at.slice(0, 10)}`);
  }
  const campaigns = ctx.campaigns.filter((c) => c.end_at > nowIso);
  const campMax = tv('campaign_max_discount_pct');
  for (const c of campaigns) {
    if (campMax !== null && c.discount_pct !== null && c.discount_pct > campMax) push('g_campaign_discount_over_max', `campaign "${c.name}" (${c.market || 'all markets'}) is at ${c.discount_pct}% off, maximum allowed is ${campMax}%`);
    if (c.participation !== 'full') continue;
    for (const p of activePromos) {
      if (p.begin_at >= c.end_at || c.begin_at >= p.end_at) continue;
      const pm = p.targets.filter((x) => x.account_id === ctx.account.id).map((x) => x.market);
      if (c.market && !pm.includes(c.market.toUpperCase())) continue;
      const sameDiscount = p.discount_type === 'PERCENTAGE_OFF' && p.discount_value !== null && c.discount_pct !== null && Math.abs(p.discount_value - c.discount_pct) < 0.5;
      if (!sameDiscount) push('g_promo_clash', `promotion "${p.name}" (${p.discount_type === 'PERCENTAGE_OFF' ? `${p.discount_value}% off` : p.discount_type.toLowerCase().replace('_', ' ')}) overlaps campaign "${c.name}"${c.discount_pct !== null ? ` at ${c.discount_pct}% off` : ''} with full participation`);
    }
  }
  if (tv('campaign_full_participation') === 1 && !campaigns.some((c) => c.begin_at <= nowIso && c.participation === 'full')) push('g_campaign_missing', 'full campaign participation is set but no campaign is on file for the current period');

  // Price drift: what the shop charges now vs the agreed list price.
  const drift = ctx.skuPrices.filter((s) => s.list_price !== null && s.current_price !== null && s.list_price > 0 && Math.abs(s.current_price - s.list_price) / s.list_price > 0.02);
  if (drift.length) push('g_price_drift', `${drift.length} SKU(s) priced differently from the agreed list price`, drift.slice(0, 8).map((s) => `${s.name}: shop ${s.current_price!.toFixed(2)} vs agreed ${s.list_price!.toFixed(2)}`).join(' · '));

  return flags;
}
