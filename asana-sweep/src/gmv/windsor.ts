import { log } from '../logger.js';
import type { Queries } from '../db/queries.js';
import { currencyForMarket } from '../tts/markets.js';

/**
 * Windsor.ai connector API (connectors.windsor.ai). Windsor holds the TikTok Shop authorisations through
 * its own approved app, so the dashboard reads shops, orders, products and payouts without a Partner
 * Center app of its own. One GET per query: /{connector}?api_key=…&fields=a,b,c&date_from=…&date_to=…
 * Rows come back as { data: [...] } (older responses used { result: [...] }); both are accepted.
 */
export const WINDSOR_CONNECTOR = 'tiktok_shop';

export interface WindsorShop { account_id: string; account_name: string; shop_id: string; shop_name: string; shop_region: string; shop_seller_type: string }
export interface WindsorOrder { account_id: string; account_name: string; date: string; order_id: string; order_status: string; order_payment_total_amount: number; order_payment_currency: string }
export interface WindsorProduct { account_id: string; product_id: string; product_title: string; product_status: string; product_sku_id: string | null; product_sku_seller_sku: string | null; product_sku_inventory_quantity: number; product_sku_price_sale_price: number; product_sku_price_currency: string }
export interface WindsorPayment { account_id: string; account_name: string; payment_id: string; payment_status: string; payment_settlement_amount_value: number; payment_settlement_amount_currency: string; payment_paid_datetime: string | null }

export class WindsorClient {
  constructor(
    private apiKey: string = process.env.WINDSOR_API_KEY?.trim() ?? '',
    private baseUrl: string = (process.env.WINDSOR_BASE_URL?.trim() || 'https://connectors.windsor.ai').replace(/\/+$/, ''),
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  /** The last request and the head of its response, key masked, for the Connections page test. */
  lastCall: { url: string; status: number | null; body: string } | null = null;

  async query<T>(fields: string[], range: { from: string; to: string } | { preset: string }, connector = WINDSOR_CONNECTOR): Promise<T[]> {
    if (!this.apiKey) throw new Error('WINDSOR_API_KEY is not set. Add it to .env (Windsor.ai › API key) and restart.');
    const url = new URL(`${this.baseUrl}/${connector}`);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('fields', fields.join(','));
    if ('preset' in range) url.searchParams.set('date_preset', range.preset);
    else { url.searchParams.set('date_from', range.from); url.searchParams.set('date_to', range.to); }
    url.searchParams.set('_renderer', 'json');
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 429 && attempt < 4) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      break;
    }
    const text = await res.text();
    this.lastCall = { url: url.toString().replace(this.apiKey, '***'), status: res.status, body: text.slice(0, 600).replace(this.apiKey, '***') };
    if (!res.ok) throw new Error(`Windsor ${res.status}: ${text.slice(0, 300).replace(this.apiKey, '***')}`);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error(`Windsor returned non-JSON: ${text.slice(0, 120)}`); }
    const rows = Array.isArray(body) ? body : ((body as { data?: unknown[]; result?: unknown[] }).data ?? (body as { result?: unknown[] }).result);
    if (!Array.isArray(rows)) throw new Error(`Windsor returned an unexpected shape: ${text.slice(0, 160)}`);
    // Windsor signals plan limits inside the rows rather than with an error status.
    const first = rows[0] as Record<string, unknown> | undefined;
    const notice = first && Object.values(first).find((v) => typeof v === 'string' && /not your real numbers|reads are paused|upgrade at/i.test(v));
    if (notice) throw new Error(String(notice));
    return rows as T[];
  }

  shops(): Promise<WindsorShop[]> {
    return this.query<WindsorShop>(['account_id', 'account_name', 'shop_id', 'shop_name', 'shop_region', 'shop_seller_type'], { preset: 'last_7d' });
  }

  orders(from: string, to: string): Promise<WindsorOrder[]> {
    return this.query<WindsorOrder>(['account_id', 'account_name', 'date', 'order_id', 'order_status', 'order_payment_total_amount', 'order_payment_currency'], { from, to });
  }

  products(): Promise<WindsorProduct[]> {
    return this.query<WindsorProduct>(['account_id', 'product_id', 'product_title', 'product_status', 'product_sku_id', 'product_sku_seller_sku', 'product_sku_inventory_quantity', 'product_sku_price_sale_price', 'product_sku_price_currency'], { from: '2024-01-01', to: new Date().toISOString().slice(0, 10) });
  }

  payments(from: string, to: string): Promise<WindsorPayment[]> {
    return this.query<WindsorPayment>(['account_id', 'account_name', 'payment_id', 'payment_status', 'payment_settlement_amount_value', 'payment_settlement_amount_currency', 'payment_paid_datetime'], { from, to });
  }
}

export const windsor = new WindsorClient();

/** Region code from a Windsor shop, as the roster spells markets (IE stays IE, GB becomes UK). */
export function marketOfShop(s: Pick<WindsorShop, 'shop_region' | 'account_id'>): string {
  const r = (s.shop_region || s.account_id.slice(2, 4) || '').toUpperCase();
  return r === 'GB' ? 'UK' : r;
}

/** Daily GMV per shop from the order list: every paid order that was not cancelled, on the day it was placed. */
export function ordersToDailyGmv(orders: WindsorOrder[]): { shop_id: string; date: string; total_gmv: number; affiliate_gmv: number; units: number; source: string }[] {
  const byKey = new Map<string, { shop_id: string; date: string; total_gmv: number; affiliate_gmv: number; units: number; source: string }>();
  for (const o of orders) {
    if (!o.account_id || !o.date) continue;
    if (/CANCEL/i.test(o.order_status ?? '')) continue;
    const key = `${o.account_id}:${o.date}`;
    const row = byKey.get(key) ?? { shop_id: o.account_id, date: o.date, total_gmv: 0, affiliate_gmv: 0, units: 0, source: 'windsor' };
    row.total_gmv += Number(o.order_payment_total_amount) || 0;
    row.units += 1;
    byKey.set(key, row);
  }
  return [...byKey.values()].map((r) => ({ ...r, total_gmv: Math.round(r.total_gmv * 100) / 100 }));
}

/** Match a Windsor shop to a roster account by name: "Clearly_Spain" → Clearly, "Nutori España" → Nutori. */
export function matchAccount<T extends { id: number; name: string }>(shop: Pick<WindsorShop, 'shop_name' | 'account_name'>, accounts: T[]): T | null {
  const norm = (s: string) => s.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const name = norm(shop.shop_name || shop.account_name);
  const hits = accounts.filter((a) => { const n = norm(a.name); return n && (name === n || name.startsWith(n + ' ') || name.startsWith(n)); }).sort((a, b) => b.name.length - a.name.length);
  return hits[0] ?? null;
}

/** Pull the last `days` days of orders for every linked Windsor shop and write daily GMV. */
export async function syncWindsorGmv(q: Queries, opts: { days?: number; client?: WindsorClient } = {}): Promise<{ shops: number; rows: number; error: string | null }> {
  const client = opts.client ?? windsor;
  const shops = q.listShops('windsor');
  if (!shops.length) return { shops: 0, rows: 0, error: null };
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (opts.days ?? 10) * 86400000).toISOString().slice(0, 10);
  try {
    const linked = new Set(shops.map((s) => s.shop_id));
    const orders = (await client.orders(from, to)).filter((o) => linked.has(o.account_id));
    // Days with no orders still get a zero row so the GMV page does not show stale numbers.
    const rows = ordersToDailyGmv(orders);
    const have = new Set(rows.map((r) => `${r.shop_id}:${r.date}`));
    for (const s of shops) for (let d = new Date(from + 'T12:00:00Z'); d.toISOString().slice(0, 10) < to; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      if (!have.has(`${s.shop_id}:${date}`)) rows.push({ shop_id: s.shop_id, date, total_gmv: 0, affiliate_gmv: 0, units: 0, source: 'windsor' });
    }
    const n = q.upsertGmv(rows);
    q.setSetting('windsor_last_sync_at', new Date().toISOString());
    q.setSetting('windsor_last_error', '');
    log.info(`Windsor GMV sync: ${orders.length} orders → ${n} daily rows for ${shops.length} shop(s)`);
    return { shops: shops.length, rows: n, error: null };
  } catch (err) {
    const msg = (err as Error).message;
    q.setSetting('windsor_last_error', msg);
    log.error(`Windsor GMV sync failed: ${msg}`);
    return { shops: shops.length, rows: 0, error: msg };
  }
}

/** Discover the shops on the Windsor connector and link the ones whose name matches a roster account. */
export async function discoverWindsorShops(q: Queries, client: WindsorClient = windsor): Promise<{ shops: (WindsorShop & { market: string; account_id_linked: number | null; account_name_linked: string | null })[]; linked: number }> {
  const found = await client.shops();
  const accounts = q.listAccounts();
  const existing = new Map(q.listShops('windsor').map((s) => [s.shop_id, s]));
  let linked = 0;
  const shops = found.map((s) => {
    const market = marketOfShop(s);
    const already = existing.get(s.account_id);
    let account = already ? accounts.find((a) => a.id === already.account_id) ?? null : matchAccount(s, accounts);
    if (!already && account) { q.addShop(account.id, s.account_id, s.shop_name || s.account_name, currencyForMarket(market), 'windsor'); linked += 1; }
    if (already && !account) account = null;
    return { ...s, market, account_id_linked: account?.id ?? null, account_name_linked: account?.name ?? null };
  });
  q.setSetting('windsor_shops_json', JSON.stringify(shops));
  return { shops, linked };
}

export function windsorStatus(q: Queries): { configured: boolean; last_sync_at: string | null; last_error: string | null; discovered: (WindsorShop & { market: string })[] } {
  let discovered: (WindsorShop & { market: string })[] = [];
  try { discovered = JSON.parse(q.getSetting('windsor_shops_json', '[]')); } catch { discovered = []; }
  return { configured: windsor.configured, last_sync_at: q.getSetting('windsor_last_sync_at', '') || null, last_error: q.getSetting('windsor_last_error', '') || null, discovered };
}
