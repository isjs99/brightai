import type { HealthThresholds, MonitorFlag, MonitorRule } from '../sweep/types.js';
import type { WindsorOrderDetail, WindsorPaymentDetail, WindsorProductDetail, WindsorStatement, WindsorUnsettled } from '../gmv/windsor.js';

/**
 * Account health rules. Windsor rules read the daily Windsor pull (orders, products, payouts,
 * statements, unsettled money) for a shop; Cruva rules read the creator-side metrics the daily
 * Claude routine posts to /api/flags/ingest (or a Cruva API pull when one is configured). Every
 * threshold is editable from the Monitor page and the rules are pure, so they can be re-run over a
 * stored pull whenever a threshold changes.
 */

export type Found = { account_id: number | null; shop_id: string | null; code: string; severity: MonitorFlag['severity']; message: string; detail?: string | null };

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  ship_grace_hours: 48,
  ship_due_within_hours: 12,
  auto_cancel_within_hours: 24,
  pickup_late_hours: 48,
  delivery_late_days: 7,
  cancel_rate_pct: 15,
  refund_rate_pct: 12,
  order_drop_pct: 40,
  aov_shift_pct: 25,
  min_orders_for_rates: 20,
  low_stock_units: 10,
  drafts_max: 3,
  payout_missing_days: 14,
  reserve_share_pct: 20,
  adjustment_share_pct: 10,
  unsettled_age_days: 30,
  fee_share_pct: 35,
  data_stale_hours: 36,
  sps_min: 3.5,
  sps_drop: 0.3,
  dms_drop_pct: 60,
  samples_drop_pct: 30,
  samples_review_hours: 48,
  content_pending_max: 50,
  affiliate_share_drop_pts: 15,
  affiliate_gmv_drop_pct: 30,
};

export const THRESHOLD_LABELS: Record<keyof HealthThresholds, { label: string; unit: string; group: string }> = {
  ship_grace_hours: { label: 'Unshipped for more than', unit: 'hours', group: 'Orders' },
  ship_due_within_hours: { label: 'Ship-by deadline within', unit: 'hours', group: 'Orders' },
  auto_cancel_within_hours: { label: 'Auto-cancel within', unit: 'hours', group: 'Orders' },
  pickup_late_hours: { label: 'Shipped but not collected for', unit: 'hours', group: 'Logistics' },
  delivery_late_days: { label: 'In transit for more than', unit: 'days', group: 'Logistics' },
  cancel_rate_pct: { label: 'Cancellation rate above', unit: '%', group: 'Orders' },
  refund_rate_pct: { label: 'Refund rate above', unit: '%', group: 'Orders' },
  order_drop_pct: { label: 'Orders down week on week by', unit: '%', group: 'Orders' },
  aov_shift_pct: { label: 'Average order value moved by', unit: '%', group: 'Orders' },
  min_orders_for_rates: { label: 'Minimum orders before rates count', unit: 'orders', group: 'Orders' },
  low_stock_units: { label: 'Low stock under', unit: 'units', group: 'Products' },
  drafts_max: { label: 'Drafts or pending listings above', unit: 'products', group: 'Products' },
  payout_missing_days: { label: 'No payout for', unit: 'days', group: 'Finance' },
  reserve_share_pct: { label: 'Reserve withheld above', unit: '% of payouts', group: 'Finance' },
  adjustment_share_pct: { label: 'Adjustments above', unit: '% of revenue', group: 'Finance' },
  unsettled_age_days: { label: 'Unsettled orders older than', unit: 'days', group: 'Finance' },
  fee_share_pct: { label: 'Fees above', unit: '% of revenue', group: 'Finance' },
  data_stale_hours: { label: 'Data older than', unit: 'hours', group: 'Account health' },
  sps_min: { label: 'Shop performance score under', unit: 'score', group: 'Cruva' },
  sps_drop: { label: 'Shop performance score dropped by', unit: 'points', group: 'Cruva' },
  dms_drop_pct: { label: 'DMs sent down by', unit: '%', group: 'Cruva' },
  samples_drop_pct: { label: 'Samples approved or shipped down by', unit: '%', group: 'Cruva' },
  samples_review_hours: { label: 'Sample requests waiting on review for', unit: 'hours', group: 'Cruva' },
  content_pending_max: { label: 'Creators awaiting content above', unit: 'creators', group: 'Cruva' },
  affiliate_share_drop_pts: { label: 'Affiliate share of GMV down by', unit: 'points', group: 'Cruva' },
  affiliate_gmv_drop_pct: { label: 'Affiliate GMV down by', unit: '%', group: 'Cruva' },
};

export function parseThresholds(raw: unknown): HealthThresholds {
  const out = { ...DEFAULT_THRESHOLDS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof HealthThresholds)[]) {
      const v = Number((raw as Record<string, unknown>)[k]);
      if (Number.isFinite(v) && v >= 0) out[k] = v;
    }
  }
  return out;
}

type RuleDef = Omit<MonitorRule, 'enabled'>;

export const WINDSOR_RULES: RuleDef[] = [
  { code: 'w_ship_sla_breach', title: 'Orders past the ship-by deadline', description: 'Orders awaiting shipment past the platform ship-by time (or older than the grace period). Late dispatch hits the shop score.', severity: 'crit', source: 'windsor', section: 'Orders' },
  { code: 'w_ship_due_soon', title: 'Orders due to ship soon', description: 'Orders awaiting shipment whose ship-by deadline is within the next hours.', severity: 'warn', source: 'windsor', section: 'Orders' },
  { code: 'w_auto_cancel_risk', title: 'Orders close to auto-cancel', description: 'Unshipped orders the platform will cancel automatically within the window.', severity: 'crit', source: 'windsor', section: 'Orders' },
  { code: 'w_buyer_cancel_requests', title: 'Buyer cancellation requests pending', description: 'Buyers asked to cancel and the request has not been handled.', severity: 'warn', source: 'windsor', section: 'Orders' },
  { code: 'w_on_hold', title: 'Orders on hold', description: 'Orders in ON_HOLD (payment or risk review); they cannot ship until released.', severity: 'warn', source: 'windsor', section: 'Orders' },
  { code: 'w_buyer_notes', title: 'Unshipped orders with a buyer note', description: 'Orders still to ship where the buyer left a message (address change, gift note, urgency).', severity: 'info', source: 'windsor', section: 'CS/Returns/Aftercare' },
  { code: 'w_cancel_rate', title: 'High cancellation rate', description: 'Share of orders cancelled in the last 7 days above the threshold, with the reasons and who cancelled.', severity: 'warn', source: 'windsor', section: 'Orders' },
  { code: 'w_order_drop', title: 'Orders down week on week', description: 'Order count in the last 7 days is down by the threshold against the 7 days before.', severity: 'warn', source: 'windsor', section: 'Analytics' },
  { code: 'w_aov_shift', title: 'Average order value moved', description: 'Average order value in the last 7 days moved by the threshold against the week before (bundle or pricing change, or a promotion misfiring).', severity: 'info', source: 'windsor', section: 'Analytics' },
  { code: 'w_late_pickup', title: 'Shipped but not collected', description: 'Orders marked shipped that the carrier has not collected past the collection deadline, grouped by provider.', severity: 'warn', source: 'windsor', section: 'Logistics' },
  { code: 'w_late_delivery', title: 'Deliveries running late', description: 'Orders in transit past the delivery deadline or longer than the threshold, grouped by provider.', severity: 'warn', source: 'windsor', section: 'Logistics' },
  { code: 'w_out_of_stock', title: 'Live SKUs out of stock', description: 'Active listings with a SKU at zero inventory.', severity: 'crit', source: 'windsor', section: 'Products' },
  { code: 'w_low_stock', title: 'Live SKUs low on stock', description: 'Active listings with a SKU under the low-stock threshold.', severity: 'warn', source: 'windsor', section: 'Products' },
  { code: 'w_product_deactivated', title: 'Products deactivated or frozen by the platform', description: 'Listings in PLATFORM_DEACTIVATED, FREEZE or SUSPENDED status.', severity: 'crit', source: 'windsor', section: 'Products' },
  { code: 'w_listing_failed', title: 'Listings failed review', description: 'Products in FAILED status: the listing audit rejected them.', severity: 'warn', source: 'windsor', section: 'Products' },
  { code: 'w_no_live_products', title: 'No live listings', description: 'The shop has products but none is active (all seller-deactivated, draft or failed).', severity: 'warn', source: 'windsor', section: 'Products' },
  { code: 'w_drafts_pending', title: 'Drafts or pending listings piling up', description: 'More draft or pending-review products than the threshold.', severity: 'info', source: 'windsor', section: 'Products' },
  { code: 'w_listing_quality', title: 'Listings rated poor', description: 'Active products whose listing quality tier is POOR.', severity: 'info', source: 'windsor', section: 'Products' },
  { code: 'w_payout_failed', title: 'Payout failed', description: 'A payment to the seller failed or was rejected.', severity: 'crit', source: 'windsor', section: 'Finance' },
  { code: 'w_payout_missing', title: 'No payout received', description: 'Orders are being paid but no payout has landed within the threshold.', severity: 'warn', source: 'windsor', section: 'Finance' },
  { code: 'w_reserve_spike', title: 'Reserve withheld', description: 'The platform is holding back more than the threshold share of payouts as a reserve.', severity: 'warn', source: 'windsor', section: 'Finance' },
  { code: 'w_negative_statement', title: 'Statement settled negative', description: 'A finance statement in the last 30 days settled below zero (refunds, penalties or adjustments exceed sales).', severity: 'crit', source: 'windsor', section: 'Finance' },
  { code: 'w_adjustment_spike', title: 'Adjustments high', description: 'Adjustments on statements in the last 30 days above the threshold share of revenue.', severity: 'warn', source: 'windsor', section: 'Finance' },
  { code: 'w_unsettled_backlog', title: 'Unsettled money ageing', description: 'Unsettled transactions on orders older than the threshold.', severity: 'warn', source: 'windsor', section: 'Finance' },
  { code: 'w_fee_share', title: 'Fees eating revenue', description: 'Platform, affiliate and ad fees above the threshold share of revenue on recent statements.', severity: 'info', source: 'windsor', section: 'Finance' },
  { code: 'w_data_stale', title: 'Windsor data stale', description: 'The last pull failed or the rows Windsor returned are older than the threshold.', severity: 'info', source: 'windsor', section: 'Account health' },
];

export const CRUVA_RULES: RuleDef[] = [
  { code: 'c_sps_low', title: 'Shop performance score restricts DMs', description: 'The shop performance score is under the threshold; Cruva cannot send DMs until it recovers.', severity: 'crit', source: 'cruva', section: 'Affiliate daily' },
  { code: 'c_sps_drop', title: 'Shop performance score dropped', description: 'The shop performance score fell by more than the threshold since the last pull.', severity: 'warn', source: 'cruva', section: 'Affiliate daily' },
  { code: 'c_dms_stopped', title: 'Outreach stopped', description: 'DMs sent in the last 7 days are down by the threshold, or zero while automations are active.', severity: 'warn', source: 'cruva', section: 'Affiliate daily' },
  { code: 'c_samples_drop', title: 'Sample approvals or shipping down', description: 'Samples approved or shipped in the last 7 days down by the threshold against the week before.', severity: 'warn', source: 'cruva', section: 'Affiliate daily' },
  { code: 'c_samples_waiting', title: 'Sample requests waiting on review', description: 'Sample requests sitting in review longer than the threshold.', severity: 'warn', source: 'cruva', section: 'Affiliate daily' },
  { code: 'c_content_pending', title: 'Creators owing content', description: 'More creators with a delivered sample and no post than the threshold.', severity: 'info', source: 'cruva', section: 'Affiliate weekly' },
  { code: 'c_affiliate_share_drop', title: 'Affiliate share of GMV falling', description: 'Affiliate GMV as a share of total GMV fell by more than the threshold points week on week.', severity: 'warn', source: 'cruva', section: 'Cruva' },
  { code: 'c_affiliate_gmv_drop', title: 'Affiliate GMV down', description: 'Affiliate GMV in the last 7 days down by the threshold against the week before.', severity: 'warn', source: 'cruva', section: 'Cruva' },
  { code: 'c_videos_no_sales', title: 'Videos posting but not selling', description: 'Creators posted videos in the last 7 days and none produced a sale.', severity: 'info', source: 'cruva', section: 'LIVE & video Analytics' },
  { code: 'c_automations_off', title: 'No active automations', description: 'The shop has no automation running in Cruva.', severity: 'warn', source: 'cruva', section: 'Cruva' },
  { code: 'c_data_stale', title: 'Cruva data stale', description: 'No Cruva metrics have been posted for the shop in the last 2 days (the daily routine did not run or could not reach the dashboard).', severity: 'info', source: 'cruva', section: 'Account health' },
];

export const AI_RULES: RuleDef[] = [
  { code: 'ai_risk_red', title: 'Daily review: account at risk', description: 'The AI review of the day rated the account red: the summary and the one action are on the Daily review tab.', severity: 'crit', source: 'ai', section: 'Account health' },
  { code: 'ai_risk_amber', title: 'Daily review: watch this account', description: 'The AI review of the day rated the account amber.', severity: 'warn', source: 'ai', section: 'Account health' },
];

export const HEALTH_RULES: RuleDef[] = [...WINDSOR_RULES, ...CRUVA_RULES, ...AI_RULES];
export const HEALTH_RULE_CODES = new Set(HEALTH_RULES.map((r) => r.code));

// ---- Windsor ----

export interface WindsorRows {
  orders: WindsorOrderDetail[];
  products: WindsorProductDetail[];
  payments: WindsorPaymentDetail[];
  statements: WindsorStatement[];
  unsettled: WindsorUnsettled[];
}

export interface ShopRef { shop_id: string; shop_name: string; account_id: number | null; currency?: string }

const ts = (v: string | null | undefined): number | null => { if (!v) return null; const n = Date.parse(v); return Number.isFinite(n) ? n : null; };
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;
const pctChange = (cur: number, prev: number): number | null => (prev > 0 ? round(((cur - prev) / prev) * 100, 1) : null);
const listOf = (items: string[], max = 8): string => items.slice(0, max).join(' · ') + (items.length > max ? ` · +${items.length - max} more` : '');
const fmtMoney = (n: number, cur?: string | null): string => `${Math.round(n).toLocaleString('en-GB')}${cur ? ` ${cur}` : ''}`;
const ACTIVE = /^(ACTIVATE|ACTIVATED|ACTIVE|LIVE)$/i;
const CANCELLED = /CANCEL/i;

/** Evaluate every Windsor rule for one shop from its pull. Returns the metrics to store and the flags found. */
export function evaluateWindsor(shop: ShopRef, rows: WindsorRows, t: HealthThresholds, opts: { now?: number; enabled?: Set<string>; pullOk?: boolean; pullError?: string | null } = {}): { metrics: Record<string, number | string | null>; flags: Found[] } {
  const now = opts.now ?? Date.now();
  const on = (code: string) => !opts.enabled || opts.enabled.has(code);
  const flags: Found[] = [];
  const label = shop.shop_name;
  const push = (code: string, message: string, detail?: string | null, severity?: MonitorFlag['severity']) => {
    if (!on(code)) return;
    const def = WINDSOR_RULES.find((r) => r.code === code)!;
    flags.push({ account_id: shop.account_id, shop_id: shop.shop_id, code, severity: severity ?? def.severity, message: `${label}: ${message}`, detail: detail ?? null });
  };
  const h = 3600000;
  const cur = shop.currency ?? rows.orders.find((o) => o.order_payment_currency)?.order_payment_currency ?? null;

  // ---- Orders ----
  const orders = rows.orders.filter((o) => o.order_id);
  const created = (o: WindsorOrderDetail) => ts(o.order_create_datetime) ?? ts(o.order_paid_datetime) ?? 0;
  const status = (o: WindsorOrderDetail) => String(o.order_status ?? '').toUpperCase();
  const last7 = orders.filter((o) => created(o) >= now - 7 * 86400000 && created(o) <= now);
  const prev7 = orders.filter((o) => created(o) >= now - 14 * 86400000 && created(o) < now - 7 * 86400000);
  const live = (list: WindsorOrderDetail[]) => list.filter((o) => !CANCELLED.test(status(o)) && status(o) !== 'UNPAID');
  const sum = (list: WindsorOrderDetail[]) => list.reduce((n, o) => n + num(o.order_payment_total_amount), 0);
  const gmv7 = sum(live(last7));
  const gmvPrev7 = sum(live(prev7));
  const aov7 = live(last7).length ? gmv7 / live(last7).length : 0;
  const aovPrev7 = live(prev7).length ? gmvPrev7 / live(prev7).length : 0;

  const awaiting = orders.filter((o) => /AWAITING_SHIPMENT|PARTIALLY_SHIPPING/.test(status(o)));
  const breached = awaiting.filter((o) => { const sla = ts(o.order_rts_sla_datetime); return sla !== null ? sla < now : created(o) < now - t.ship_grace_hours * h; });
  if (breached.length) push('w_ship_sla_breach', `${breached.length} order(s) past the ship-by deadline`, listOf(breached.map((o) => `${o.order_id}${o.order_rts_sla_datetime ? ` (due ${o.order_rts_sla_datetime.slice(0, 16).replace('T', ' ')})` : ''}`)));
  const dueSoon = awaiting.filter((o) => { const sla = ts(o.order_rts_sla_datetime); return sla !== null && sla >= now && sla < now + t.ship_due_within_hours * h; });
  if (dueSoon.length) push('w_ship_due_soon', `${dueSoon.length} order(s) must ship within ${t.ship_due_within_hours}h`, listOf(dueSoon.map((o) => o.order_id)));
  const autoCancel = orders.filter((o) => /AWAITING_SHIPMENT|PARTIALLY_SHIPPING|AWAITING_COLLECTION/.test(status(o))).filter((o) => { const sla = ts(o.order_cancel_sla_datetime); return sla !== null && sla < now + t.auto_cancel_within_hours * h; });
  if (autoCancel.length) push('w_auto_cancel_risk', `${autoCancel.length} order(s) will auto-cancel within ${t.auto_cancel_within_hours}h`, listOf(autoCancel.map((o) => `${o.order_id} (${o.order_cancel_sla_datetime?.slice(0, 16).replace('T', ' ')})`)));
  const cancelReq = orders.filter((o) => o.order_is_buyer_request_cancel === true && !CANCELLED.test(status(o)));
  if (cancelReq.length) push('w_buyer_cancel_requests', `${cancelReq.length} buyer cancellation request(s) waiting`, listOf(cancelReq.map((o) => `${o.order_id}${o.order_cancel_reason ? ` (${o.order_cancel_reason})` : ''}`)));
  const onHold = orders.filter((o) => status(o) === 'ON_HOLD' || (o.order_is_on_hold === true && !CANCELLED.test(status(o)) && !/DELIVERED|COMPLETED|IN_TRANSIT/.test(status(o))));
  if (onHold.length) push('w_on_hold', `${onHold.length} order(s) on hold`, listOf(onHold.map((o) => o.order_id)));
  const noted = awaiting.filter((o) => (o.order_buyer_message ?? '').trim());
  if (noted.length) push('w_buyer_notes', `${noted.length} unshipped order(s) carry a buyer note`, listOf(noted.map((o) => `${o.order_id}: "${(o.order_buyer_message ?? '').trim().slice(0, 60)}"`), 5));

  const cancelled7 = last7.filter((o) => CANCELLED.test(status(o)));
  const cancelRate = last7.length ? (cancelled7.length / last7.length) * 100 : 0;
  if (last7.length >= t.min_orders_for_rates && cancelRate > t.cancel_rate_pct) {
    const reasons = new Map<string, number>();
    for (const o of cancelled7) { const k = `${o.order_cancellation_initiator ?? 'unknown'}: ${o.order_cancel_reason ?? 'no reason'}`; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
    push('w_cancel_rate', `${cancelled7.length} of ${last7.length} orders cancelled in the last 7 days (${Math.round(cancelRate)}%)`, listOf([...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${k}`), 6));
  }
  const orderChange = pctChange(last7.length, prev7.length);
  if (prev7.length >= t.min_orders_for_rates && orderChange !== null && orderChange <= -t.order_drop_pct) push('w_order_drop', `${last7.length} orders in the last 7 days vs ${prev7.length} the week before (${Math.round(orderChange)}%)`);
  const aovChange = pctChange(aov7, aovPrev7);
  if (live(prev7).length >= t.min_orders_for_rates && live(last7).length >= 5 && aovChange !== null && Math.abs(aovChange) >= t.aov_shift_pct) push('w_aov_shift', `average order value ${fmtMoney(aov7, cur)} vs ${fmtMoney(aovPrev7, cur)} the week before (${aovChange > 0 ? '+' : ''}${Math.round(aovChange)}%)`);

  // ---- Logistics ----
  const byProvider = (list: WindsorOrderDetail[]) => { const m = new Map<string, number>(); for (const o of list) { const k = o.order_shipping_provider || 'unknown carrier'; m.set(k, (m.get(k) ?? 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(' · '); };
  const awaitingCollection = orders.filter((o) => status(o) === 'AWAITING_COLLECTION');
  const latePickup = awaitingCollection.filter((o) => { const due = ts(o.order_collection_due_datetime); const rts = ts(o.order_rts_datetime); return (due !== null && due < now) || (rts !== null && rts < now - t.pickup_late_hours * h); });
  if (latePickup.length) push('w_late_pickup', `${latePickup.length} shipped order(s) not collected by the carrier`, byProvider(latePickup));
  const inTransit = orders.filter((o) => status(o) === 'IN_TRANSIT');
  const lateDelivery = inTransit.filter((o) => { const sla = ts(o.order_delivery_sla_datetime); const col = ts(o.order_collection_datetime) ?? ts(o.order_rts_datetime); return (sla !== null && sla < now) || (col !== null && col < now - t.delivery_late_days * 86400000); });
  if (lateDelivery.length) push('w_late_delivery', `${lateDelivery.length} delivery(ies) running late`, byProvider(lateDelivery));

  // ---- Products ----
  const products = rows.products.filter((p) => p.product_id);
  const byProduct = new Map<string, WindsorProductDetail[]>();
  for (const p of products) byProduct.set(p.product_id, [...(byProduct.get(p.product_id) ?? []), p]);
  const pstatus = (p: WindsorProductDetail) => String(p.product_status ?? '').toUpperCase();
  const activeProducts = [...byProduct.values()].filter((skus) => ACTIVE.test(pstatus(skus[0])));
  const activeSkus = activeProducts.flat().filter((p) => p.product_sku_id);
  const qty = (p: WindsorProductDetail) => num(p.product_sku_inventory_quantity) + num(p.product_sku_inventory_backorder_quantity);
  const skuLabel = (p: WindsorProductDetail) => `${p.product_title.slice(0, 40)}${p.product_sku_seller_sku ? ` (${p.product_sku_seller_sku})` : ''}`;
  const outOfStock = activeSkus.filter((p) => qty(p) <= 0);
  if (outOfStock.length) push('w_out_of_stock', `${outOfStock.length} live SKU(s) out of stock`, listOf(outOfStock.map(skuLabel)));
  const lowStock = activeSkus.filter((p) => qty(p) > 0 && qty(p) < t.low_stock_units);
  if (lowStock.length) push('w_low_stock', `${lowStock.length} live SKU(s) under ${t.low_stock_units} units`, listOf(lowStock.map((p) => `${skuLabel(p)}: ${qty(p)}`)));
  const deactivated = [...byProduct.values()].filter((s) => /PLATFORM_DEACTIVATED|FREEZE|FROZEN|SUSPEND/.test(pstatus(s[0])));
  if (deactivated.length) push('w_product_deactivated', `${deactivated.length} product(s) deactivated or frozen by the platform`, listOf(deactivated.map((s) => s[0].product_title.slice(0, 50))));
  const failed = [...byProduct.values()].filter((s) => pstatus(s[0]) === 'FAILED');
  if (failed.length) push('w_listing_failed', `${failed.length} product(s) failed the listing review`, listOf(failed.map((s) => s[0].product_title.slice(0, 50))));
  const sellerOff = [...byProduct.values()].filter((s) => pstatus(s[0]) === 'SELLER_DEACTIVATED');
  if (byProduct.size > 0 && activeProducts.length === 0) push('w_no_live_products', `no live listings (${byProduct.size} product(s): ${sellerOff.length} switched off by the seller, ${deactivated.length} platform, ${failed.length} failed)`);
  const drafts = [...byProduct.values()].filter((s) => /DRAFT|PENDING/.test(pstatus(s[0])) || s[0].product_has_draft === true);
  if (drafts.length > t.drafts_max) push('w_drafts_pending', `${drafts.length} product(s) in draft or pending review`, listOf(drafts.map((s) => s[0].product_title.slice(0, 50))));
  const poor = activeProducts.filter((s) => String(s[0].product_listing_quality_tier ?? '').toUpperCase() === 'POOR');
  if (poor.length) push('w_listing_quality', `${poor.length} live product(s) rated POOR listing quality`, listOf(poor.map((s) => s[0].product_title.slice(0, 50))));

  // ---- Finance ----
  const payments = rows.payments.filter((p) => p.payment_id);
  const failedPay = payments.filter((p) => /FAIL|REJECT/i.test(p.payment_status ?? ''));
  if (failedPay.length) push('w_payout_failed', `${failedPay.length} payout(s) failed or rejected`, listOf(failedPay.map((p) => `${p.payment_id}: ${fmtMoney(num(p.payment_settlement_amount_value), p.payment_settlement_amount_currency)} ${p.payment_status ?? ''}`)));
  const paidTimes = payments.map((p) => ts(p.payment_paid_datetime)).filter((x): x is number => x !== null);
  const lastPaid = paidTimes.length ? Math.max(...paidTimes) : null;
  const revenue14 = sum(live(orders.filter((o) => created(o) >= now - 14 * 86400000)));
  if (revenue14 > 0 && (lastPaid === null || lastPaid < now - t.payout_missing_days * 86400000)) push('w_payout_missing', `no payout ${lastPaid ? `since ${new Date(lastPaid).toISOString().slice(0, 10)}` : 'on record'} while ${fmtMoney(revenue14, cur)} was sold in the last 14 days`);
  const pay30 = payments.filter((p) => (ts(p.payment_create_datetime) ?? 0) >= now - 30 * 86400000);
  const reserve = pay30.reduce((n, p) => n + num(p.payment_reserve_amount_value), 0);
  const payAmount = pay30.reduce((n, p) => n + num(p.payment_amount_value), 0);
  const reserveShare = payAmount > 0 ? (reserve / payAmount) * 100 : 0;
  if (payAmount > 0 && reserveShare > t.reserve_share_pct) push('w_reserve_spike', `${Math.round(reserveShare)}% of the last 30 days of payouts held as reserve (${fmtMoney(reserve, cur)} of ${fmtMoney(payAmount, cur)})`);
  const statements = rows.statements.filter((s) => s.statement_id && (ts(s.statement_statement_datetime) ?? now) >= now - 30 * 86400000);
  const negative = statements.filter((s) => num(s.statement_settlement_amount) < 0);
  if (negative.length) push('w_negative_statement', `${negative.length} statement(s) settled negative in the last 30 days`, listOf(negative.map((s) => `${s.statement_statement_datetime?.slice(0, 10) ?? '?'}: ${fmtMoney(num(s.statement_settlement_amount), s.statement_currency)} (revenue ${fmtMoney(num(s.statement_revenue_amount), s.statement_currency)}, fees ${fmtMoney(num(s.statement_fee_amount), s.statement_currency)})`)));
  const stRevenue = statements.reduce((n, s) => n + Math.max(0, num(s.statement_revenue_amount)), 0);
  const stAdjust = statements.reduce((n, s) => n + Math.abs(num(s.statement_adjustment_amount)), 0);
  const stFees = statements.reduce((n, s) => n + Math.abs(num(s.statement_fee_amount)), 0);
  const adjustShare = stRevenue > 0 ? (stAdjust / stRevenue) * 100 : 0;
  if (stRevenue > 0 && adjustShare > t.adjustment_share_pct) push('w_adjustment_spike', `adjustments of ${fmtMoney(stAdjust, cur)} against ${fmtMoney(stRevenue, cur)} revenue on the last 30 days of statements (${Math.round(adjustShare)}%)`);
  const feeShare = stRevenue > 0 ? (stFees / stRevenue) * 100 : 0;
  if (stRevenue > 0 && feeShare > t.fee_share_pct) push('w_fee_share', `fees of ${fmtMoney(stFees, cur)} against ${fmtMoney(stRevenue, cur)} revenue (${Math.round(feeShare)}%) on the last 30 days of statements`);
  const unsettled = rows.unsettled.filter((u) => u.unsettled_transaction_id && !/SETTLED$/i.test(u.unsettled_transaction_status ?? 'UNSETTLED') || /^UNSETTLED/i.test(u.unsettled_transaction_status ?? ''));
  const unsettledAmount = unsettled.reduce((n, u) => n + num(u.unsettled_transaction_est_settlement_amount), 0);
  const old = unsettled.filter((u) => { const c = ts(u.unsettled_transaction_order_create_datetime); return c !== null && c < now - t.unsettled_age_days * 86400000; });
  const oldAmount = old.reduce((n, u) => n + num(u.unsettled_transaction_est_settlement_amount), 0);
  if (old.length) {
    const reasons = new Map<string, number>();
    for (const u of old) { const k = u.unsettled_transaction_unsettled_reason || u.unsettled_transaction_estimated_settlement || 'no reason given'; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
    push('w_unsettled_backlog', `${fmtMoney(oldAmount, cur)} unsettled on ${old.length} order(s) older than ${t.unsettled_age_days} days`, listOf([...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${k}`), 5));
  }

  // ---- Freshness ----
  const fetched = orders.map((o) => ts(o.data_fetched_at)).filter((x): x is number => x !== null);
  const fetchedAt = fetched.length ? Math.max(...fetched) : null;
  if (opts.pullOk === false) push('w_data_stale', `the last Windsor pull failed${opts.pullError ? `: ${opts.pullError.slice(0, 160)}` : ''}`);
  else if (fetchedAt !== null && fetchedAt < now - t.data_stale_hours * h) push('w_data_stale', `Windsor rows were fetched ${Math.round((now - fetchedAt) / h)}h ago`);

  const metrics: Record<string, number | string | null> = {
    orders_7d: last7.length, orders_prev_7d: prev7.length, gmv_7d: round(gmv7), gmv_prev_7d: round(gmvPrev7), aov_7d: round(aov7), aov_prev_7d: round(aovPrev7), currency: cur,
    cancelled_7d: cancelled7.length, cancel_rate_7d: round(cancelRate, 1), awaiting_shipment: awaiting.length, ship_sla_breached: breached.length, ship_due_soon: dueSoon.length, auto_cancel_risk: autoCancel.length,
    buyer_cancel_requests: cancelReq.length, on_hold: onHold.length, awaiting_collection: awaitingCollection.length, late_pickup: latePickup.length, in_transit: inTransit.length, late_delivery: lateDelivery.length,
    products: byProduct.size, active_products: activeProducts.length, active_skus: activeSkus.length, out_of_stock_skus: outOfStock.length, low_stock_skus: lowStock.length, deactivated_products: deactivated.length, failed_products: failed.length, seller_deactivated_products: sellerOff.length, draft_products: drafts.length, poor_listings: poor.length,
    payments_30d: pay30.length, payments_failed: failedPay.length, last_paid_at: lastPaid ? new Date(lastPaid).toISOString() : null, reserve_share_30d: round(reserveShare, 1), statements_30d: statements.length, negative_statements_30d: negative.length, statement_revenue_30d: round(stRevenue), statement_fees_30d: round(stFees), adjustment_share_30d: round(adjustShare, 1), fee_share_30d: round(feeShare, 1),
    unsettled_count: unsettled.length, unsettled_amount: round(unsettledAmount), unsettled_old_count: old.length, unsettled_old_amount: round(oldAmount), data_fetched_at: fetchedAt ? new Date(fetchedAt).toISOString() : null,
  };
  return { metrics, flags };
}

// ---- Cruva ----

/** Metric keys the daily routine posts per Cruva shop (all optional; missing keys skip their rules). */
export const CRUVA_METRIC_KEYS = ['sps', 'affiliate_gmv_7d', 'affiliate_gmv_prev_7d', 'total_gmv_7d', 'total_gmv_prev_7d', 'dms_sent_7d', 'dms_sent_prev_7d', 'samples_requested_7d', 'samples_approved_7d', 'samples_approved_prev_7d', 'samples_shipped_7d', 'samples_shipped_prev_7d', 'videos_posted_7d', 'videos_with_sales_7d', 'video_views_7d', 'samples_pending_review', 'samples_pending_review_oldest_hours', 'content_pending', 'automations_active', 'automations_total', 'creators_reached_30d', 'creators_with_sales_30d'] as const;

export type CruvaMetrics = Partial<Record<(typeof CRUVA_METRIC_KEYS)[number], number | null>>;

export function parseCruvaMetrics(raw: unknown): CruvaMetrics {
  const out: CruvaMetrics = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of CRUVA_METRIC_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === null) out[k] = null;
    else if (v !== undefined && v !== '' && Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
}

export function evaluateCruva(shop: ShopRef, m: CruvaMetrics, t: HealthThresholds, opts: { enabled?: Set<string>; previous?: CruvaMetrics | null; stale?: boolean } = {}): Found[] {
  const on = (code: string) => !opts.enabled || opts.enabled.has(code);
  const flags: Found[] = [];
  const push = (code: string, message: string, detail?: string | null) => {
    if (!on(code)) return;
    const def = CRUVA_RULES.find((r) => r.code === code)!;
    flags.push({ account_id: shop.account_id, shop_id: shop.shop_id, code, severity: def.severity, message: `${shop.shop_name}: ${message}`, detail: detail ?? null });
  };
  if (opts.stale) { push('c_data_stale', 'no Cruva metrics posted in the last 2 days'); return flags; }
  const has = (k: keyof CruvaMetrics) => typeof m[k] === 'number';
  const v = (k: keyof CruvaMetrics) => m[k] as number;
  if (has('sps') && v('sps') < t.sps_min) push('c_sps_low', `shop performance score ${v('sps').toFixed(1)} is under ${t.sps_min}, DM sending is restricted`);
  const prevSps = opts.previous?.sps;
  if (has('sps') && typeof prevSps === 'number' && prevSps - v('sps') >= t.sps_drop) push('c_sps_drop', `shop performance score fell from ${prevSps.toFixed(1)} to ${v('sps').toFixed(1)}`);
  if (has('dms_sent_7d')) {
    const cur = v('dms_sent_7d');
    const prev = has('dms_sent_prev_7d') ? v('dms_sent_prev_7d') : null;
    const change = prev !== null ? pctChange(cur, prev) : null;
    if (prev !== null && prev >= 20 && change !== null && change <= -t.dms_drop_pct) push('c_dms_stopped', `${cur} DMs sent in the last 7 days vs ${prev} the week before (${Math.round(change)}%)`);
    else if (cur === 0 && has('automations_active') && v('automations_active') > 0) push('c_dms_stopped', `0 DMs sent in the last 7 days with ${v('automations_active')} automation(s) active`);
  }
  const drop = (curK: keyof CruvaMetrics, prevK: keyof CruvaMetrics, what: string) => {
    if (!has(curK) || !has(prevK)) return null;
    const change = pctChange(v(curK), v(prevK));
    return v(prevK) >= 10 && change !== null && change <= -t.samples_drop_pct ? `${what} ${v(curK)} vs ${v(prevK)} the week before (${Math.round(change)}%)` : null;
  };
  const sd = [drop('samples_approved_7d', 'samples_approved_prev_7d', 'samples approved'), drop('samples_shipped_7d', 'samples_shipped_prev_7d', 'samples shipped')].filter((x): x is string => Boolean(x));
  if (sd.length) push('c_samples_drop', sd.join('; '));
  if (has('samples_pending_review') && v('samples_pending_review') > 0 && has('samples_pending_review_oldest_hours') && v('samples_pending_review_oldest_hours') >= t.samples_review_hours) push('c_samples_waiting', `${v('samples_pending_review')} sample request(s) waiting on review, the oldest for ${Math.round(v('samples_pending_review_oldest_hours') / 24)} day(s)`);
  if (has('content_pending') && v('content_pending') > t.content_pending_max) push('c_content_pending', `${v('content_pending')} creators have a sample and no post yet`);
  if (has('affiliate_gmv_7d') && has('total_gmv_7d') && has('affiliate_gmv_prev_7d') && has('total_gmv_prev_7d') && v('total_gmv_7d') > 0 && v('total_gmv_prev_7d') > 0) {
    const share = (v('affiliate_gmv_7d') / v('total_gmv_7d')) * 100;
    const prevShare = (v('affiliate_gmv_prev_7d') / v('total_gmv_prev_7d')) * 100;
    if (prevShare - share >= t.affiliate_share_drop_pts) push('c_affiliate_share_drop', `affiliate share of GMV ${Math.round(share)}% vs ${Math.round(prevShare)}% the week before`);
  }
  if (has('affiliate_gmv_7d') && has('affiliate_gmv_prev_7d')) {
    const change = pctChange(v('affiliate_gmv_7d'), v('affiliate_gmv_prev_7d'));
    if (v('affiliate_gmv_prev_7d') >= 100 && change !== null && change <= -t.affiliate_gmv_drop_pct) push('c_affiliate_gmv_drop', `affiliate GMV ${Math.round(v('affiliate_gmv_7d')).toLocaleString('en-GB')} in the last 7 days vs ${Math.round(v('affiliate_gmv_prev_7d')).toLocaleString('en-GB')} the week before (${Math.round(change)}%)`);
  }
  if (has('videos_posted_7d') && has('videos_with_sales_7d') && v('videos_posted_7d') >= 10 && v('videos_with_sales_7d') === 0) push('c_videos_no_sales', `${v('videos_posted_7d')} videos posted in the last 7 days, none with a sale`);
  if (has('automations_active') && v('automations_active') === 0) push('c_automations_off', `no active automation${has('automations_total') ? ` (${v('automations_total')} set up)` : ''}`);
  return flags;
}

/** Which checklist section a flag code belongs to (for the Checklists page). */
export function sectionOfRule(code: string, rules: { code: string; section?: string | null }[]): string | null {
  return rules.find((r) => r.code === code)?.section ?? null;
}
