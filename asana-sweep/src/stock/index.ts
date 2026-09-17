import type { Queries } from '../db/queries.js';
import type { StockData, StockProjection, StockProjectionRow, StockSku } from '../sweep/types.js';
import { tts, type TtsClient } from '../tts/client.js';
import { shopCredentials } from '../tts/promotions.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Stock countdown and replenishment projection per TikTok shop. A snapshot per SKU (on hand from
 * the product search, units sold in the last 7 and 30 days from the orders search) gives a daily
 * velocity, a days-left countdown, and how much to send in to cover a chosen number of days.
 */

export interface StockSettings { crit_days: number; warn_days: number; default_cover_days: number; default_lead_days: number }

export function stockSettings(q: Queries): StockSettings {
  const n = (k: string, d: number) => { const v = Number(q.getSetting(k, '')); return Number.isFinite(v) && v > 0 ? v : d; };
  return { crit_days: n('stock_crit_days', 7), warn_days: n('stock_warn_days', 14), default_cover_days: n('stock_cover_days', 30), default_lead_days: n('stock_lead_days', 0) };
}

/** Units per day: the manual override, else a blend of the last week (weighted) and the last month. */
export function velocityOf(s: Pick<StockSku, 'sold_7d' | 'sold_30d' | 'velocity_override'>): number {
  if (s.velocity_override !== null && s.velocity_override !== undefined) return Math.max(0, s.velocity_override);
  const week = s.sold_7d / 7;
  const month = s.sold_30d / 30;
  if (s.sold_7d > 0) return Math.round((week * 0.6 + month * 0.4) * 100) / 100;
  return Math.round(month * 100) / 100;
}

export function projectRows(skus: StockSku[], opts: { coverDays: number; leadDays?: number; critDays?: number; warnDays?: number; now?: number }): StockProjectionRow[] {
  const now = opts.now ?? Date.now();
  const crit = opts.critDays ?? 7;
  const warn = opts.warnDays ?? 14;
  const lead = Math.max(0, opts.leadDays ?? 0);
  return skus.map((s) => {
    const velocity = velocityOf(s);
    const days_left = velocity > 0 ? Math.round((Math.max(0, s.on_hand) / velocity) * 10) / 10 : null;
    const stockout_at = days_left !== null ? new Date(now + days_left * 86400000).toISOString().slice(0, 10) : null;
    const needed = Math.ceil(velocity * (opts.coverDays + lead));
    const send_in = s.exclude ? 0 : Math.max(0, needed - Math.max(0, s.on_hand));
    let level: StockProjectionRow['level'] = 'ok';
    if (velocity <= 0) level = 'idle';
    else if (s.on_hand <= 0) level = 'out';
    else if ((days_left ?? Infinity) < crit) level = 'crit';
    else if ((days_left ?? Infinity) < warn) level = 'warn';
    return { ...s, velocity, days_left, stockout_at, send_in, level };
  });
}

const csvCell = (v: unknown): string => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** The replenishment CSV: one line per SKU that needs sending in (plus the rest, flagged), ready for the 3PL or the client. */
export function projectionCsv(p: StockProjection, opts: { onlyNeeded?: boolean } = {}): string {
  const head = ['Shop', 'Product', 'SKU name', 'Seller SKU', 'TikTok SKU id', 'Status', 'On hand', 'Sold 7d', 'Sold 30d', 'Units per day', 'Days left', 'Stock-out date', `Send in (${p.cover_days} days cover${p.lead_days ? ` + ${p.lead_days} lead` : ''})`, 'Level', 'Note'];
  const rows = (opts.onlyNeeded ? p.rows.filter((r) => r.send_in > 0) : p.rows).map((r) => [p.shop_name, r.product_title, r.sku_name ?? '', r.seller_sku ?? '', r.sku_id, r.product_status ?? '', r.on_hand, r.sold_7d, r.sold_30d, r.velocity, r.days_left ?? '', r.stockout_at ?? '', r.send_in, r.level, r.note ?? ''].map(csvCell).join(','));
  return [head.map(csvCell).join(','), ...rows].join('\n') + '\n';
}

export class StockTracker {
  private scanning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private q: Queries, private client: TtsClient = tts) {}

  start(): void {
    this.stop();
    // Refresh every 6 hours; the first pass runs shortly after boot so the page has data.
    this.timer = setInterval(() => void this.scan(), 6 * 3600000);
    setTimeout(() => void this.scan(), 45000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  projection(shopId: string, coverDays?: number, leadDays?: number): StockProjection {
    const s = stockSettings(this.q);
    const cover = Math.min(Math.max(Math.round(coverDays ?? s.default_cover_days), 1), 365);
    const lead = Math.min(Math.max(Math.round(leadDays ?? s.default_lead_days), 0), 120);
    const shop = this.q.listTtsShops().find((x) => x.id === shopId);
    const account = shop?.account_id ? this.q.getAccount(shop.account_id) : null;
    const rows = projectRows(this.q.listStock(shopId), { coverDays: cover, leadDays: lead, critDays: s.crit_days, warnDays: s.warn_days });
    const order: Record<StockProjectionRow['level'], number> = { out: 0, crit: 1, warn: 2, ok: 3, idle: 4 };
    rows.sort((a, b) => order[a.level] - order[b.level] || (a.days_left ?? Infinity) - (b.days_left ?? Infinity) || a.product_title.localeCompare(b.product_title));
    return {
      shop_id: shopId, shop_name: shop?.name ?? shopId, account_id: shop?.account_id ?? null, account_name: account?.name ?? null, cover_days: cover, lead_days: lead,
      captured_at: rows[0]?.captured_at ?? null, rows,
      totals: { skus: rows.length, send_in_units: rows.reduce((n, r) => n + r.send_in, 0), send_in_skus: rows.filter((r) => r.send_in > 0).length, out: rows.filter((r) => r.level === 'out').length, crit: rows.filter((r) => r.level === 'crit').length, warn: rows.filter((r) => r.level === 'warn').length },
    };
  }

  data(): StockData {
    const s = stockSettings(this.q);
    const all = projectRows(this.q.listStock(), { coverDays: s.default_cover_days, leadDays: s.default_lead_days, critDays: s.crit_days, warnDays: s.warn_days });
    const accounts = new Map(this.q.listAccounts().map((a) => [a.id, a.name]));
    const shops = this.q.listTtsShops().map((shop) => {
      const mine = all.filter((r) => r.shop_id === shop.id);
      const soonest = mine.filter((r) => r.days_left !== null && !r.exclude).map((r) => r.days_left as number).sort((a, b) => a - b)[0];
      return { shop_id: shop.id, shop_name: shop.name, account_id: shop.account_id, account_name: shop.account_id ? accounts.get(shop.account_id) ?? null : null, market: shop.market, token_ok: shop.token_ok, skus: mine.length, captured_at: mine[0]?.captured_at ?? null, out: mine.filter((r) => r.level === 'out').length, crit: mine.filter((r) => r.level === 'crit').length, warn: mine.filter((r) => r.level === 'warn').length, next_stockout_days: soonest ?? null };
    });
    const names = new Map(shops.map((x) => [x.shop_id, x]));
    const alerts = all.filter((r) => !r.exclude && (r.level === 'out' || r.level === 'crit' || r.level === 'warn')).sort((a, b) => (a.days_left ?? -1) - (b.days_left ?? -1)).slice(0, 100).map((r) => ({ ...r, shop_name: names.get(r.shop_id)?.shop_name ?? r.shop_id, account_name: names.get(r.shop_id)?.account_name ?? null }));
    return { shops, alerts, settings: s, last_scan_at: this.q.getSetting('stock_last_scan_at', '') || null, last_scan_error: this.q.getSetting('stock_last_scan_error', '') || null, scanning: this.scanning, tts_configured: this.client.configured };
  }

  /** Pull products (stock on hand) and the last 30 days of orders (velocity) for one shop or every authorised shop. */
  async scan(shopId?: string): Promise<{ shops: number; skus: number; errors: string[] }> {
    if (this.scanning) return { shops: 0, skus: 0, errors: ['A scan is already running'] };
    this.scanning = true;
    const errors: string[] = [];
    let shops = 0;
    let skus = 0;
    try {
      if (!this.client.configured) throw new Error('TikTok Shop app is not configured (TTS_APP_KEY / TTS_APP_SECRET).');
      for (const shop of this.q.listTtsShops().filter((s) => s.token_ok && (!shopId || s.id === shopId))) {
        try {
          const n = await this.scanShop(shop.id, shop.account_id);
          shops += 1;
          skus += n;
        } catch (err) {
          errors.push(`${shop.name}: ${(err as Error).message}`);
          log.warn(`Stock scan: ${shop.name}: ${(err as Error).message}`);
        }
      }
      this.q.setSetting('stock_last_scan_at', new Date().toISOString());
      this.q.setSetting('stock_last_scan_error', errors.length ? errors.join(' · ').slice(0, 500) : '');
    } catch (err) {
      this.q.setSetting('stock_last_scan_error', (err as Error).message);
      errors.push((err as Error).message);
    } finally {
      this.scanning = false;
      liveEvents.emitUpdate({ kind: 'stock' });
    }
    return { shops, skus, errors };
  }

  async scanShop(shopId: string, accountId: number | null, now = Date.now()): Promise<number> {
    const creds = await shopCredentials(this.q, shopId, this.client);
    const sec = (d: number) => Math.floor(d / 1000);
    type Product = { id: string; title: string; status?: string; skus?: { id: string; seller_sku?: string; sales_attributes?: { name?: string; value_name?: string }[]; inventory?: { quantity?: number }[] }[] };
    const products: Product[] = [];
    let token = '';
    for (let page = 0; page < 10; page += 1) {
      const r = await this.client.call<{ products?: Product[]; next_page_token?: string }>('POST', '/product/202309/products/search', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '100', ...(token ? { page_token: token } : {}) }, body: {} });
      products.push(...(r.products ?? []));
      token = r.next_page_token ?? '';
      if (!token) break;
    }
    const sold7 = new Map<string, number>();
    const sold30 = new Map<string, number>();
    token = '';
    for (let page = 0; page < 40; page += 1) {
      const r = await this.client.call<{ orders?: { create_time?: number; status?: string; line_items?: { sku_id?: string; quantity?: number }[] }[]; next_page_token?: string }>('POST', '/order/202309/orders/search', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '50', sort_field: 'create_time', sort_order: 'DESC', ...(token ? { page_token: token } : {}) }, body: { create_time_ge: sec(now - 30 * 86400000), create_time_lt: sec(now) } });
      for (const o of r.orders ?? []) {
        if (/CANCEL/i.test(o.status ?? '')) continue;
        const recent = (o.create_time ?? 0) * 1000 >= now - 7 * 86400000;
        for (const li of o.line_items ?? []) {
          if (!li.sku_id) continue;
          const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
          sold30.set(li.sku_id, (sold30.get(li.sku_id) ?? 0) + qty);
          if (recent) sold7.set(li.sku_id, (sold7.get(li.sku_id) ?? 0) + qty);
        }
      }
      token = r.next_page_token ?? '';
      if (!token) break;
    }
    const rows = products.flatMap((p) => (p.skus ?? []).map((s) => ({
      product_id: p.id, product_title: p.title, sku_id: s.id, seller_sku: s.seller_sku ?? null, product_status: p.status ?? null,
      sku_name: (s.sales_attributes ?? []).map((a) => a.value_name).filter(Boolean).join(' / ') || null,
      on_hand: (s.inventory ?? []).reduce((n, i) => n + (i.quantity ?? 0), 0), sold_7d: sold7.get(s.id) ?? 0, sold_30d: sold30.get(s.id) ?? 0,
    })));
    return this.q.replaceStockSnapshot(shopId, accountId, rows);
  }
}
