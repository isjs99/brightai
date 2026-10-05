import type { TtsScope } from '../sweep/types.js';
import { TtsError, type TtsClient } from '../tts/client.js';
import { emptyTtsRows, type ScopeResult, type TtsCsLite, type TtsDay, type TtsOrderLite, type TtsPaymentLite, type TtsProductLite, type TtsReturnLite, type TtsRows, type TtsSampleLite, type TtsStatementLite } from './tts-rules.js';

/**
 * One pull per authorised shop over the TikTok Shop OpenAPI, one scope at a time. A block whose scope the app
 * does not hold comes back as "denied" (the UI then names the approval to request) instead of failing the pull;
 * a block that errors for another reason is "error" and the previous rows for it are kept.
 * The analytics and finance blocks change once a day, so they are refreshed hourly; the operational blocks
 * (orders, returns, samples, products, CS) run on every scan.
 */

export type Creds = { accessToken: string; cipher: string };

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const sec = (v: unknown): number | null => { const n = num(v); return n === null ? null : n > 1e12 ? Math.floor(n / 1000) : Math.floor(n); };
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** TikTok's permission errors say "scope", "permission" or "not authorized"; anything else is a transient error. */
export function classifyError(err: unknown): { state: 'denied' | 'error'; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof TtsError ? err.code : null;
  const denied = /scope|permission|not authori[sz]ed|unauthori[sz]ed|access denied|no access|forbidden|105002|105003|36009|36010/i.test(message) || code === 105002 || code === 105003 || code === 36009 || code === 36010;
  return { state: denied ? 'denied' : 'error', message: message.slice(0, 300) };
}

export const BLOCK_SCOPES: TtsScope[] = ['analytics', 'order', 'product', 'return_refund', 'affiliate_seller', 'customer_service', 'finance'];
const DAILY_BLOCKS: TtsScope[] = ['analytics', 'finance'];

/** How the affiliate block is read: through the affiliate app's own client and token, 'unauthorised' when that app is configured but this shop has not granted it yet, or undefined to use the main app. */
export type AffiliateAccess = { client: TtsClient; creds: Creds } | 'unauthorised' | undefined;

export interface PullOptions { now?: number; analyticsDays?: number; previous?: TtsRows | null; refreshDailyAfterMinutes?: number; blocks?: TtsScope[]; affiliate?: AffiliateAccess }

/** Pull every block for a shop, reusing the previous pull's rows for daily blocks that are still fresh. */
export async function pullShop(client: TtsClient, creds: Creds, opts: PullOptions = {}): Promise<TtsRows> {
  const now = opts.now ?? Date.now();
  const rows: TtsRows = { ...emptyTtsRows(), fetched_at: new Date(now).toISOString() };
  const prev = opts.previous ?? null;
  const want = opts.blocks ?? BLOCK_SCOPES;
  const freshMinutes = opts.refreshDailyAfterMinutes ?? 55;
  const run = async (scope: TtsScope, fn: () => Promise<void>, carry: () => void) => {
    if (!want.includes(scope)) { carry(); return; }
    const prevScope = prev?.scopes[scope];
    if (DAILY_BLOCKS.includes(scope) && prevScope?.ok && now - Date.parse(prevScope.at) < freshMinutes * 60000) { carry(); rows.scopes[scope] = { ...prevScope, state: 'skipped' }; return; }
    try {
      await fn();
      rows.scopes[scope] = { ok: true, state: 'ok', message: null, at: new Date(now).toISOString() };
    } catch (err) {
      const c = classifyError(err);
      // Keep the last good rows so the rules still have something to read, but say the block did not refresh.
      if (prevScope?.ok) carry();
      rows.scopes[scope] = { ok: c.state === 'denied' ? false : Boolean(prevScope?.ok), state: c.state, message: c.message, at: new Date(now).toISOString() } satisfies ScopeResult;
    }
  };

  await run('analytics', async () => {
    const days = opts.analyticsDays ?? 28;
    const end = new Date(now).toISOString().slice(0, 10); // exclusive: up to yesterday, which is the last full day
    const start = new Date(now - days * 86400000).toISOString().slice(0, 10);
    const data = await client.call<{ latest_available_date?: string; performance?: { intervals?: Record<string, unknown>[] } }>('GET', '/analytics/202509/shop/performance', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { start_date_ge: start, end_date_lt: end, granularity: '1D', currency: 'LOCAL' } });
    rows.latest_available_date = data.latest_available_date ?? null;
    rows.analytics = (data.performance?.intervals ?? []).map(parseDay).filter((d): d is TtsDay => d !== null);
  }, () => { if (prev) { rows.analytics = prev.analytics; rows.latest_available_date = prev.latest_available_date; } });

  await run('order', async () => {
    rows.orders = await searchOrders(client, creds, now);
  }, () => { if (prev) rows.orders = prev.orders; });

  await run('product', async () => {
    rows.products = await searchProducts(client, creds);
  }, () => { if (prev) rows.products = prev.products; });

  await run('return_refund', async () => {
    rows.returns = await searchReturns(client, creds, now);
  }, () => { if (prev) rows.returns = prev.returns; });

  await run('affiliate_seller', async () => {
    if (opts.affiliate === 'unauthorised') throw new TtsError('Shop not authorised under the affiliate app yet: authorise it under Promotions › Connection (no access until then)', 105002);
    const via = opts.affiliate ?? { client, creds };
    rows.samples = await searchSamples(via.client, via.creds);
  }, () => { if (prev) rows.samples = prev.samples; });

  await run('customer_service', async () => {
    const end = new Date(now).toISOString().slice(0, 10);
    const start = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
    const data = await client.call<{ performance?: Record<string, unknown> }>('GET', '/customer_service/202407/performance', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { support_date_ge: start, support_date_lt: end } });
    const p = data.performance ?? {};
    rows.cs = { sessions: num(p.support_session_count) ?? 0, response_pct: num(p.response_percentage), response_mins: num(p.response_time_mins), satisfaction_pct: num(p.satisfaction_percentage) } satisfies TtsCsLite;
  }, () => { if (prev) rows.cs = prev.cs; });

  await run('finance', async () => {
    const [payments, statements] = await Promise.all([listPayments(client, creds, now), listStatements(client, creds, now)]);
    rows.payments = payments; rows.statements = statements;
  }, () => { if (prev) { rows.payments = prev.payments; rows.statements = prev.statements; } });

  return rows;
}

// ---- Parsers (kept separate so they can be tested on recorded payloads) ----

export function parseDay(iv: Record<string, unknown>): TtsDay | null {
  const date = str(iv.start_date);
  if (!date) return null;
  const sales = (iv.sales ?? {}) as Record<string, unknown>;
  const traffic = (iv.traffic ?? {}) as Record<string, unknown>;
  const gmv = (sales.gmv ?? {}) as { overall?: { amount?: unknown }; breakdowns?: { type?: string; gmv?: { amount?: unknown } }[] };
  const by = (type: string) => { const b = (gmv.breakdowns ?? []).find((x) => x.type === type); return b ? num(b.gmv?.amount) : null; };
  return {
    date: date.slice(0, 10),
    gmv: num(gmv.overall?.amount) ?? 0,
    orders: num(sales.orders_count) ?? 0,
    sku_orders: num(sales.sku_orders_count) ?? 0,
    items: num(sales.items_sold) ?? 0,
    visitors: num(traffic.avg_visitors) ?? 0,
    page_views: num(traffic.avg_page_views) ?? 0,
    conversion: num(traffic.avg_conversation_rate) ?? 0,
    refunds: num((sales.refunds as { amount?: unknown } | undefined)?.amount) ?? 0,
    customers: num(sales.avg_customers_count) ?? 0,
    video_gmv: by('VIDEO') ?? 0,
    live_gmv: by('LIVE') ?? 0,
    card_gmv: by('PRODUCT_CARD') ?? 0,
    ads_gmv: by('ADS'),
    organic_gmv: by('ORGANIC'),
  };
}

export function parseOrder(o: Record<string, unknown>): TtsOrderLite {
  const pay = (o.payment ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''), user_id: str(o.user_id), recipient_name: str((o.recipient_address as { name?: unknown } | undefined)?.name), status: String(o.status ?? '').toUpperCase(), create_time: sec(o.create_time) ?? 0, paid_time: sec(o.paid_time),
    rts_sla_time: sec(o.rts_sla_time), rts_time: sec(o.rts_time), tts_sla_time: sec(o.tts_sla_time), collection_time: sec(o.collection_time),
    delivery_sla_time: sec(o.delivery_sla_time), delivery_due_time: sec(o.delivery_due_time), delivery_time: sec(o.delivery_time),
    cancel_order_sla_time: sec(o.cancel_order_sla_time), cancel_time: sec(o.cancel_time), cancellation_initiator: str(o.cancellation_initiator),
    is_buyer_request_cancel: Boolean(o.is_buyer_request_cancel), is_on_hold: Boolean(o.is_on_hold_order), buyer_message: str(o.buyer_message), shipping_provider: str(o.shipping_provider),
    total_amount: num(pay.total_amount), currency: str(pay.currency),
    line_items: ((o.line_items ?? []) as Record<string, unknown>[]).map((li) => ({ product_id: str(li.product_id), sku_id: str(li.sku_id), sale_price: num(li.sale_price) })),
  };
}

export function parseProduct(p: Record<string, unknown>): TtsProductLite {
  return {
    id: String(p.id ?? ''), title: String(p.title ?? ''), status: String(p.status ?? '').toUpperCase(), audit_status: str((p.audit as { status?: unknown } | undefined)?.status), quality_tier: str(p.listing_quality_tier),
    skus: ((p.skus ?? []) as Record<string, unknown>[]).map((s) => {
      const price = (s.price ?? {}) as Record<string, unknown>;
      return { id: String(s.id ?? ''), seller_sku: str(s.seller_sku), price: num(price.tax_exclusive_price) ?? num(price.sale_price), currency: str(price.currency), qty: ((s.inventory ?? []) as { quantity?: unknown }[]).reduce((n, i) => n + (num(i.quantity) ?? 0), 0), status: str((s.status_info as { status?: unknown } | undefined)?.status) };
    }),
  };
}

export function parseReturn(r: Record<string, unknown>): TtsReturnLite {
  const next = ((r.seller_next_action_response ?? []) as { action?: unknown; deadline?: unknown }[])[0];
  const refund = (r.refund_amount ?? {}) as Record<string, unknown>;
  return { return_id: String(r.return_id ?? ''), order_id: str(r.order_id), status: String(r.return_status ?? '').toUpperCase(), type: str(r.return_type), create_time: sec(r.create_time) ?? 0, update_time: sec(r.update_time), role: str(r.role), next_action: next ? str(next.action) : null, next_deadline: next ? sec(next.deadline) : null, refund_total: num(refund.refund_total), currency: str(refund.currency) };
}

export function parseSample(s: Record<string, unknown>): TtsSampleLite {
  const creator = (s.creator ?? {}) as Record<string, unknown>; const product = (s.product ?? {}) as Record<string, unknown>;
  return { id: String(s.id ?? ''), status: String(s.status ?? '').toUpperCase(), fulfillment_status: str(s.fulfillment_status), approve_expiration_time: sec(s.approve_expiration_time), shipment_expiration_time: sec(s.shipment_expiration_time), tracking_number: str(s.tracking_number), order_id: str(s.order_id), creator: str(creator.username) ?? str(creator.nickname), product: str(product.title) };
}

export function parsePayment(p: Record<string, unknown>): TtsPaymentLite {
  const amount = (p.amount ?? {}) as Record<string, unknown>; const reserve = (p.reserve_amount ?? {}) as Record<string, unknown>;
  return { id: String(p.id ?? ''), status: String(p.status ?? ''), create_time: sec(p.create_time) ?? 0, paid_time: sec(p.paid_time), amount: num(amount.value) ?? 0, reserve: num(reserve.value) ?? 0, currency: str(amount.currency) };
}

export function parseStatement(s: Record<string, unknown>): TtsStatementLite {
  return { id: String(s.id ?? ''), statement_time: sec(s.statement_time) ?? 0, settlement: num(s.settlement_amount) ?? 0, revenue: num(s.revenue_amount) ?? 0, fee: num(s.fee_amount) ?? 0, adjustment: num(s.adjustment_amount) ?? 0, payment_status: str(s.payment_status), currency: str(s.currency) };
}

// ---- Paged searches ----

async function searchOrders(client: TtsClient, creds: Creds, now: number): Promise<TtsOrderLite[]> {
  const out: TtsOrderLite[] = [];
  const from = Math.floor((now - 30 * 86400000) / 1000);
  let token = '';
  for (let page = 0; page < 10; page += 1) {
    const r = await client.call<{ orders?: Record<string, unknown>[]; next_page_token?: string }>('POST', '/order/202309/orders/search', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '100', sort_field: 'create_time', sort_order: 'DESC', ...(token ? { page_token: token } : {}) }, body: { create_time_ge: from, create_time_lt: Math.floor(now / 1000) } });
    out.push(...(r.orders ?? []).map(parseOrder));
    token = r.next_page_token ?? '';
    if (!token) break;
  }
  return out;
}

async function searchProducts(client: TtsClient, creds: Creds): Promise<TtsProductLite[]> {
  const out: TtsProductLite[] = [];
  let token = '';
  for (let page = 0; page < 10; page += 1) {
    const r = await client.call<{ products?: Record<string, unknown>[]; next_page_token?: string }>('POST', '/product/202502/products/search', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '100', ...(token ? { page_token: token } : {}) }, body: {} });
    out.push(...(r.products ?? []).map(parseProduct));
    token = r.next_page_token ?? '';
    if (!token) break;
  }
  return out;
}

async function searchReturns(client: TtsClient, creds: Creds, now: number): Promise<TtsReturnLite[]> {
  const out: TtsReturnLite[] = [];
  const from = Math.floor((now - 30 * 86400000) / 1000);
  let token = '';
  for (let page = 0; page < 10; page += 1) {
    const r = await client.call<{ return_orders?: Record<string, unknown>[]; next_page_token?: string }>('POST', '/return_refund/202309/returns/search', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '50', ...(token ? { page_token: token } : {}) }, body: { create_time_ge: from, create_time_lt: Math.floor(now / 1000) } });
    out.push(...(r.return_orders ?? []).map(parseReturn));
    token = r.next_page_token ?? '';
    if (!token) break;
  }
  return out;
}

async function searchSamples(client: TtsClient, creds: Creds): Promise<TtsSampleLite[]> {
  const out: TtsSampleLite[] = [];
  let token = '';
  for (let page = 0; page < 10; page += 1) {
    const r = await client.call<{ sample_applications?: Record<string, unknown>[]; next_page_token?: string }>('POST', '/affiliate_seller/202508/sample_applications/search', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '50', ...(token ? { page_token: token } : {}) }, body: {} });
    out.push(...(r.sample_applications ?? []).map(parseSample));
    token = r.next_page_token ?? '';
    if (!token) break;
  }
  return out;
}

async function listPayments(client: TtsClient, creds: Creds, now: number): Promise<TtsPaymentLite[]> {
  const out: TtsPaymentLite[] = [];
  let token = '';
  for (let page = 0; page < 5; page += 1) {
    const r = await client.call<{ payments?: Record<string, unknown>[]; next_page_token?: string }>('GET', '/finance/202309/payments', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '50', sort_field: 'create_time', sort_order: 'DESC', create_time_ge: String(Math.floor((now - 60 * 86400000) / 1000)), create_time_lt: String(Math.floor(now / 1000)), ...(token ? { page_token: token } : {}) } });
    out.push(...(r.payments ?? []).map(parsePayment));
    token = r.next_page_token ?? '';
    if (!token) break;
  }
  return out;
}

async function listStatements(client: TtsClient, creds: Creds, now: number): Promise<TtsStatementLite[]> {
  const out: TtsStatementLite[] = [];
  let token = '';
  for (let page = 0; page < 5; page += 1) {
    const r = await client.call<{ statements?: Record<string, unknown>[]; next_page_token?: string }>('GET', '/finance/202309/statements', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '50', sort_field: 'statement_time', sort_order: 'DESC', statement_time_ge: String(Math.floor((now - 45 * 86400000) / 1000)), statement_time_lt: String(Math.floor(now / 1000)), ...(token ? { page_token: token } : {}) } });
    out.push(...(r.statements ?? []).map(parseStatement));
    token = r.next_page_token ?? '';
    if (!token) break;
  }
  return out;
}
