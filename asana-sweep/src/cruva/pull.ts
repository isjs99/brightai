import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { liveEvents } from '../live/events.js';
import { cruvaRest, type CruvaRest, type CruvaStat } from './rest.js';
import type { CruvaPullStatus } from '../sweep/types.js';
import type { CruvaMetrics } from '../health/rules.js';

/**
 * The Cruva pull: every linked Cruva shop, several times a day, through the REST API with the one
 * account key. It writes the same tables the TikTok pull feeds, so the Overview, the GMV page, the
 * Stock page and the monitor rules read Cruva wherever the TikTok app cannot (or is not) connected:
 *
 * - /shop/stats       daily GMV, affiliate GMV, units, videos, views, DMs, samples (60 days) → gmv_daily + health_pulls(cruva)
 * - /shop/sps         performance score                                                   → health_pulls(cruva).metrics.sps
 * - /affiliate/samples/funnel   requests waiting on review, content pending, ageing        → metrics
 * - /automations/list  active / total automations                                          → metrics
 * - /shop/skus + /timeseries/skus  stock on hand, units sold 7d / 30d                      → stock_snapshots (source cruva)
 *
 * About six calls per shop; 53 shops is ~320 calls, well inside Cruva's 50 requests a second.
 */

export const CRUVA_PULL_EVERY_HOURS = 4;

export interface CruvaDayRow { date: string; total_gmv: number; affiliate_gmv: number; units: number; affiliate_units: number; videos: number; views: number; dms: number; samples_approved: number; samples_shipped: number; aov: number | null }

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Pivot the per-stat series into one row per day. */
export function daysFromStats(stats: CruvaStat[]): CruvaDayRow[] {
  const by = new Map<string, CruvaDayRow>();
  const row = (date: string) => { let r = by.get(date); if (!r) { r = { date, total_gmv: 0, affiliate_gmv: 0, units: 0, affiliate_units: 0, videos: 0, views: 0, dms: 0, samples_approved: 0, samples_shipped: 0, aov: null }; by.set(date, r); } return r; };
  const field: Record<string, keyof Omit<CruvaDayRow, 'date'>> = { total_gmv: 'total_gmv', affiliate_gmv: 'affiliate_gmv', total_units_sold: 'units', affiliate_units_sold: 'affiliate_units', videos_posted: 'videos', video_views: 'views', dms_sent: 'dms', samples_approved: 'samples_approved', samples_shipped: 'samples_shipped', aov: 'aov' };
  for (const s of stats) { const f = field[s.key]; if (!f) continue; for (const d of s.days) (row(d.date) as unknown as Record<string, number | null>)[f] = d.count; }
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The 7-day metrics the monitor rules read, from the daily rows (today excluded as incomplete). */
export function metricsFromDays(days: CruvaDayRow[], now = Date.now()): CruvaMetrics {
  const today = iso(now);
  const done = days.filter((d) => d.date < today);
  const last7 = done.filter((d) => d.date >= iso(now - 7 * 86400000));
  const prev7 = done.filter((d) => d.date >= iso(now - 14 * 86400000) && d.date < iso(now - 7 * 86400000));
  const sum = (rows: CruvaDayRow[], k: keyof CruvaDayRow) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  return {
    total_gmv_7d: sum(last7, 'total_gmv'), total_gmv_prev_7d: sum(prev7, 'total_gmv'),
    affiliate_gmv_7d: sum(last7, 'affiliate_gmv'), affiliate_gmv_prev_7d: sum(prev7, 'affiliate_gmv'),
    dms_sent_7d: sum(last7, 'dms'), dms_sent_prev_7d: sum(prev7, 'dms'),
    samples_approved_7d: sum(last7, 'samples_approved'), samples_approved_prev_7d: sum(prev7, 'samples_approved'),
    samples_shipped_7d: sum(last7, 'samples_shipped'), samples_shipped_prev_7d: sum(prev7, 'samples_shipped'),
    videos_posted_7d: sum(last7, 'videos'), video_views_7d: sum(last7, 'views'),
    dms_sent_28d: sum(done.filter((d) => d.date >= iso(now - 28 * 86400000)), 'dms'),
    // Days since the last day with a DM out (today counts when it already has one); the window's length when none.
    dms_silent_days: (() => { const withDm = days.filter((d) => d.dms > 0).map((d) => d.date).sort(); if (!withDm.length) return days.length ? Math.round((now - Date.parse(days[0].date)) / 86400000) : null; return Math.max(0, Math.round((now - Date.parse(withDm[withDm.length - 1])) / 86400000)); })(),
  };
}

export class CruvaPuller {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private q: Queries, private rest: CruvaRest = cruvaRest) {}

  get configured(): boolean { return this.rest.configured; }

  start(): void {
    this.stop();
    if (!this.configured) { log.info('Cruva pull is off (CRUVA_API_KEY not set)'); return; }
    this.timer = setInterval(() => void this.run(), CRUVA_PULL_EVERY_HOURS * 3600000);
    this.timer.unref?.();
    // Soon after boot when the last run is older than an interval, so the pages have data.
    const last = Date.parse(this.q.getSetting('cruva_pull_last_at', '') || '0');
    if (!(last > Date.now() - CRUVA_PULL_EVERY_HOURS * 3600000)) setTimeout(() => void this.run(), 90000);
    log.info(`Cruva pull every ${CRUVA_PULL_EVERY_HOURS}h`);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  status(): CruvaPullStatus {
    const last = this.q.getSetting('cruva_pull_last_at', '') || null;
    const shops = this.q.listShops('cruva');
    const pulls = this.q.latestHealthPulls('cruva');
    return { configured: this.configured, running: this.running, last_run_at: last, last_error: this.q.getSetting('cruva_pull_last_error', '') || null, shops: shops.length, shops_ok: pulls.filter((p) => p.ok && shops.some((s) => s.shop_id === p.shop_id)).length, next_run_at: last && this.timer ? new Date(Date.parse(last) + CRUVA_PULL_EVERY_HOURS * 3600000).toISOString() : null, every_hours: CRUVA_PULL_EVERY_HOURS };
  }

  /** Pull one shop or every linked shop. Each shop's failure is recorded on its pull row; the run carries on. */
  async run(shopId?: string, now = Date.now()): Promise<{ shops: number; errors: string[] }> {
    if (this.running) return { shops: 0, errors: ['A Cruva pull is already running'] };
    if (!this.configured) return { shops: 0, errors: ['CRUVA_API_KEY is not set'] };
    this.running = true;
    const errors: string[] = [];
    let shops = 0;
    try {
      liveEvents.emitUpdate({ kind: 'cruva' });
      for (const shop of this.q.listShops('cruva').filter((s) => !shopId || s.shop_id === shopId)) {
        try { await this.pullShop(shop.shop_id, shop.account_id, now); shops += 1; } catch (err) {
          const message = (err as Error).message;
          errors.push(`${shop.shop_name}: ${message}`);
          log.warn(`Cruva pull ${shop.shop_name}: ${message}`);
          this.q.upsertHealthPull({ shop_id: shop.shop_id, account_id: shop.account_id, source: 'cruva', pull_date: iso(now), ok: false, error: message.slice(0, 500), metrics: {}, rows: {} });
        }
      }
      this.q.setSetting('cruva_pull_last_at', new Date(now).toISOString());
      if (shops) this.q.setSetting('stock_last_scan_at', new Date(now).toISOString());
      this.q.setSetting('cruva_pull_last_error', errors.length ? `${errors.length} shop(s) failed: ${errors.slice(0, 3).join(' · ')}`.slice(0, 600) : '');
      if (shops) log.info(`Cruva pull: ${shops} shop(s)${errors.length ? `, ${errors.length} failed` : ''}`);
    } finally {
      this.running = false;
      liveEvents.emitUpdate({ kind: 'cruva' });
      liveEvents.emitUpdate({ kind: 'stock' });
      liveEvents.emitUpdate({ kind: 'monitor' });
    }
    return { shops, errors };
  }

  async pullShop(shopId: string, accountId: number | null, now = Date.now()): Promise<void> {
    const today = iso(now);
    // 60 days: the Performance page compares any range up to 28 days with the same length before it.
    const from60 = iso(now - 60 * 86400000);
    const stats = await this.rest.stats(shopId, from60, today);
    const days = daysFromStats(stats);
    // Daily GMV for the Performance page (today is written too; the page excludes it while the month runs).
    this.q.upsertGmv(days.map((d) => ({ shop_id: shopId, date: d.date, total_gmv: d.total_gmv, affiliate_gmv: d.affiliate_gmv, units: d.units, source: 'cruva' })));
    const metrics: CruvaMetrics = metricsFromDays(days, now);
    const notes: string[] = [];
    const safe = async <T,>(what: string, fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch (err) { notes.push(`${what}: ${(err as Error).message.slice(0, 160)}`); return null; } };
    metrics.sps = await safe('sps', () => this.rest.sps(shopId));
    const funnel = await safe('samples', () => this.rest.sampleFunnel(shopId, iso(now - 90 * 86400000), today));
    if (funnel) {
      const review = funnel.by_status.find((s) => /to review|pending review/i.test(s.status));
      metrics.samples_pending_review = review?.count ?? 0;
      metrics.samples_pending_review_oldest_hours = review?.oldest_age_days !== null && review?.oldest_age_days !== undefined ? Math.round(review.oldest_age_days * 24) : 0;
      metrics.content_pending = funnel.by_status.find((s) => /content pending/i.test(s.status))?.count ?? 0;
      metrics.samples_requested_7d = null;
    }
    const autos = await safe('automations', () => this.rest.automations(shopId));
    if (autos) { metrics.automations_total = autos.length; metrics.automations_active = autos.filter((a) => a.status === 'active').length; }
    // Stock: every SKU with on hand, plus units sold over 7 and 30 days for the velocity.
    const skus = await safe('skus', () => this.rest.skus(shopId));
    let stockRows = 0;
    if (skus) {
      const p30 = (await safe('sku sales 30d', () => this.rest.skuPeriod(shopId, iso(now - 30 * 86400000), today))) ?? [];
      const p7 = (await safe('sku sales 7d', () => this.rest.skuPeriod(shopId, iso(now - 7 * 86400000), today))) ?? [];
      const u30 = new Map(p30.map((x) => [x.sku_id, x.units]));
      const u7 = new Map(p7.map((x) => [x.sku_id, x.units]));
      stockRows = this.q.replaceStockSnapshot(shopId, accountId, skus.map((s) => ({ product_id: s.product_id, product_title: s.product_name, sku_id: s.sku_id, sku_name: s.sku_name, seller_sku: null, product_status: null, on_hand: s.stock, sold_7d: u7.get(s.sku_id) ?? 0, sold_30d: u30.get(s.sku_id) ?? 0 })), new Date(now).toISOString(), 'cruva');
      (metrics as Record<string, number | null>).out_of_stock_skus = skus.filter((s) => s.stock <= 0 && (u30.get(s.sku_id) ?? 0) > 0).length;
    }
    this.q.upsertHealthPull({ shop_id: shopId, account_id: accountId, source: 'cruva', pull_date: today, ok: true, error: notes.length ? notes.join('; ').slice(0, 500) : null, metrics: metrics as Record<string, unknown>, rows: { days, stock_rows: stockRows, fetched_at: new Date(now).toISOString() } });
  }
}
