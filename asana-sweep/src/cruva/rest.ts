import { log } from '../logger.js';

/**
 * Cruva REST (api.cruva.com) read-side for reply context: the creator as the CRM knows them, their
 * sample requests, which automations already messaged them, the product catalogue and the live
 * community campaigns. One API key covers every shop; x-shop-id picks the shop. Results are cached
 * for an hour per shop and handle so a busy inbox does not hammer the API.
 */
export interface CruvaCreator { handle: string; followers: number | null; gmv_for_us: number | null; videos: number | null; showcasing: boolean | null; tags: string[]; last_post: string | null; units: number | null; email: string | null }
export interface CruvaSample { product: string; status: string; requested: string | null; approved: string | null; received: string | null; source: string | null; expires: string | null }
export interface CruvaOutreachLog { when: string; campaign: string; channel: string; status: string }
export interface CruvaProduct { id: string; title: string; price: number | null; stock: number | null; units_sold: number | null; open_plan: boolean | null; status: string | null }
export interface CruvaCampaign { title: string; type: string; status: string; link: string | null; ends: string | null; metric: string | null }
export interface CruvaSku { sku_id: string; sku_name: string | null; product_id: string; product_name: string; price: number | null; cogs: number | null; stock: number }
export interface CruvaSkuPeriod { sku_id: string; units: number; gmv: number; orders: number }
export interface CruvaStatDay { date: string; count: number }
export interface CruvaStat { key: string; title: string; total: number; change_pct: number | null; days: CruvaStatDay[] }
export interface CruvaSampleFunnel { total: number; by_status: { status: string; count: number; is_open: boolean; avg_age_days: number | null; oldest_age_days: number | null }[]; funnel: { stage: string; count: number }[] }
export interface CruvaAutomation { id: string; name: string; status: string; message_type: string | null }

/** The stat keys /shop/stats accepts that the dashboard reads. */
export const CRUVA_STAT_KEYS = ['total_gmv', 'affiliate_gmv', 'total_units_sold', 'affiliate_units_sold', 'videos_posted', 'video_views', 'samples_approved', 'samples_shipped', 'dms_sent', 'aov'] as const;

type Fetch = typeof fetch;
const TTL = 60 * 60000;

export class CruvaRest {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(private apiKey = process.env.CRUVA_API_KEY?.trim() ?? '', private baseUrl = (process.env.CRUVA_BASE_URL?.trim() || 'https://api.cruva.com').replace(/\/+$/, ''), private fetchFn: Fetch = fetch) {}

  get configured(): boolean { return Boolean(this.apiKey); }

  async post<T = unknown>(path: string, shopId: string | null, body: Record<string, unknown> = {}, method: 'POST' | 'GET' = 'POST'): Promise<T> {
    if (!this.apiKey) throw new Error('CRUVA_API_KEY is not set.');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-api-key': this.apiKey };
    if (shopId) headers['x-shop-id'] = shopId;
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      res = await this.fetchFn(this.baseUrl + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body) });
      if (res.status === 429 && attempt < 4) { await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); continue; }
      break;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Cruva ${res.status} ${path}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text) as T; } catch { throw new Error(`Cruva returned non-JSON for ${path}`); }
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  forget(prefix?: string): void { for (const k of [...this.cache.keys()]) if (!prefix || k.startsWith(prefix)) this.cache.delete(k); }

  async creator(shopId: string, handle: string): Promise<CruvaCreator | null> {
    return this.cached(`creator:${shopId}:${handle.toLowerCase()}`, async () => {
      const r = await this.post<{ results?: Record<string, unknown>[]; data?: { results?: Record<string, unknown>[] } }>('/affiliate/crm/list', shopId, { handle: handle.replace(/^@/, ''), page_size: 5 });
      const rows = r.results ?? r.data?.results ?? [];
      const row = rows.find((x) => String(x.handle ?? '').toLowerCase() === handle.replace(/^@/, '').toLowerCase()) ?? rows[0];
      if (!row) return null;
      return { handle: String(row.handle ?? handle), followers: num(row.follower_cnt), gmv_for_us: num(row.gmv), videos: num(row.video_count), showcasing: typeof row.showcasing === 'boolean' ? row.showcasing : null, tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map(String) : [], last_post: str(row.last_post), units: num(row.units_sold), email: str(row.email) };
    });
  }

  async samples(shopId: string, handle: string): Promise<CruvaSample[]> {
    return this.cached(`samples:${shopId}:${handle.toLowerCase()}`, async () => {
      const r = await this.post<{ data?: { results?: Record<string, unknown>[] }; results?: Record<string, unknown>[] }>('/affiliate/samples/list', shopId, { handle: handle.replace(/^@/, ''), page_size: 10, sort_by: 'timestamp', sort_direction: 'desc' });
      const rows = r.data?.results ?? r.results ?? [];
      return rows.filter((x) => String(x.handle ?? '').toLowerCase() === handle.replace(/^@/, '').toLowerCase() || !x.handle).map((x) => ({ product: str(x.product_name) ?? str(x.sampled_product) ?? 'sample', status: String(x.status ?? ''), requested: str(x.timestamp), approved: str(x.sample_approved), received: str(x.sample_received), source: str(x.source), expires: str(x.expire_date) }));
    });
  }

  async outreachLogs(shopId: string, handle: string): Promise<CruvaOutreachLog[]> {
    return this.cached(`logs:${shopId}:${handle.toLowerCase()}`, async () => {
      const r = await this.post<{ data?: { results?: Record<string, unknown>[] }; results?: Record<string, unknown>[] }>('/outreach/logs/list', shopId, { handle_search: handle.replace(/^@/, ''), page_size: 10 });
      const rows = r.data?.results ?? r.results ?? [];
      return rows.map((x) => ({ when: String(x.timestamp ?? ''), campaign: String(x.campaign_name ?? x.campaign_id ?? ''), channel: String(x.message_type ?? ''), status: String(x.status ?? '') }));
    });
  }

  async products(shopId: string): Promise<CruvaProduct[]> {
    return this.cached(`products:${shopId}`, async () => {
      const r = await this.post<{ data?: Record<string, unknown>[] | { results?: Record<string, unknown>[] } }>('/shop/products', shopId, { page_size: 100, sort_by: 'units_sold', sort_direction: 'desc' });
      const rows = Array.isArray(r.data) ? r.data : (r.data?.results ?? []);
      return rows.map((x) => ({ id: String(x.product_id ?? ''), title: String(x.product_name ?? ''), price: num(x.price), stock: num(x.stock), units_sold: num(x.units_sold), open_plan: typeof x.is_open_plan === 'boolean' ? x.is_open_plan : null, status: x.status === undefined ? null : String(x.status) }));
    });
  }

  async campaigns(shopId: string): Promise<CruvaCampaign[]> {
    return this.cached(`campaigns:${shopId}`, async () => {
      const r = await this.post<{ data?: { results?: Record<string, unknown>[] }; results?: Record<string, unknown>[] }>('/community/campaigns/list', shopId, { status: 'active', page_size: 10 });
      const rows = r.data?.results ?? r.results ?? [];
      return rows.map((x) => ({ title: String(x.title ?? ''), type: String(x.campaign_type ?? ''), status: String(x.status ?? ''), link: str(x.share_link), ends: str(x.end_date), metric: str(x.progress_metric) }));
    });
  }

  /** Daily stats for a date range (inclusive), one series per key; not cached (the pull engine stores them). */
  async stats(shopId: string, from: string, to: string, keys: readonly string[] = CRUVA_STAT_KEYS, timezone?: string | null): Promise<CruvaStat[]> {
    const r = await this.post<{ data?: { stats?: Record<string, unknown>[] } }>('/shop/stats', shopId, { date_range: { from, to }, include_charts: true, stats: [...keys], ...(timezone ? { timezone } : {}) });
    return (r.data?.stats ?? []).map((x) => ({ key: String(x.key ?? ''), title: String(x.title ?? x.key ?? ''), total: num(x.total_count) ?? 0, change_pct: num(x.percent_change), days: ((x.daily_counts as Record<string, unknown>[] | undefined) ?? []).map((d) => ({ date: String(d.date ?? '').slice(0, 10), count: num(d.count) ?? 0 })).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)) }));
  }

  /** Shop performance score (0-5) or null when TikTok has not assigned one yet. */
  async sps(shopId: string): Promise<number | null> {
    const r = await this.post<{ data?: { sps?: unknown } }>('/shop/sps', shopId, {}, 'GET');
    return num(r.data?.sps);
  }

  /** Sample requests by current status (To Review, Content Pending…) with ageing, over the last `days` days of requests. */
  async sampleFunnel(shopId: string, from: string, to: string): Promise<CruvaSampleFunnel> {
    const r = await this.post<{ data?: { total_count?: unknown; by_status?: Record<string, unknown>[]; funnel?: Record<string, unknown>[] } }>('/affiliate/samples/funnel', shopId, { time_field: 'timestamp', time_from: from, time_to: to, include_ignored: false });
    const d = r.data ?? {};
    return { total: num(d.total_count) ?? 0, by_status: (d.by_status ?? []).map((x) => ({ status: String(x.status ?? ''), count: num(x.count) ?? 0, is_open: Boolean(x.is_open), avg_age_days: num(x.avg_age_days), oldest_age_days: num(x.oldest_age_days) })), funnel: (d.funnel ?? []).map((x) => ({ stage: String(x.stage ?? ''), count: num(x.count) ?? 0 })) };
  }

  /** Every SKU with its current stock, price and custom COGS. */
  async skus(shopId: string): Promise<CruvaSku[]> {
    const r = await this.post<{ data?: Record<string, unknown>[] | { results?: Record<string, unknown>[] } }>('/shop/skus', shopId, { search: '', product_id: null, sort_by: 'stock', sort_direction: 'desc', page_size: 500 });
    const rows = Array.isArray(r.data) ? r.data : (r.data?.results ?? []);
    return rows.map((x) => ({ sku_id: String(x.sku_id ?? ''), sku_name: str(x.sku_name), product_id: String(x.product_id ?? ''), product_name: String(x.product_name ?? ''), price: num(x.price), cogs: num(x.custom_cogs), stock: num(x.stock) ?? 0 })).filter((x) => x.sku_id);
  }

  /** Units, GMV and orders per SKU over a date range (inclusive), every page. */
  async skuPeriod(shopId: string, from: string, to: string): Promise<CruvaSkuPeriod[]> {
    const out: CruvaSkuPeriod[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const r = await this.post<{ data?: Record<string, unknown>[]; has_more?: boolean }>('/timeseries/skus', shopId, { page_size: 100, page_number: page, search_params: { date_range: { from, to }, sort_by: 'units_sold', sort_direction: 'DESC' } });
      for (const x of r.data ?? []) out.push({ sku_id: String(x.sku_id ?? ''), units: num(x.units_sold) ?? 0, gmv: num(x.gmv) ?? 0, orders: num(x.orders) ?? 0 });
      if (!r.has_more || !(r.data ?? []).length) break;
    }
    return out.filter((x) => x.sku_id);
  }

  /** Automations with their status, first 100 by GMV. */
  async automations(shopId: string): Promise<CruvaAutomation[]> {
    const r = await this.post<{ data?: { results?: Record<string, unknown>[] } }>('/automations/list', shopId, { page: 1, page_size: 100, sort_by: 'affiliate_gmv', sort_direction: 'desc' });
    return (r.data?.results ?? []).map((x) => ({ id: String(x.campaign_id ?? ''), name: String(x.campaign_name ?? ''), status: String(x.status ?? ''), message_type: str(x.message_type) }));
  }

  /** Everything the reply model may want about one creator on one shop; failures become notes, never throws. */
  async creatorContext(shopId: string, handle: string | null): Promise<{ creator: CruvaCreator | null; samples: CruvaSample[]; logs: CruvaOutreachLog[]; products: CruvaProduct[]; campaigns: CruvaCampaign[]; notes: string[] }> {
    const notes: string[] = [];
    const safe = async <T,>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => { try { return await fn(); } catch (err) { notes.push(`Cruva ${what}: ${(err as Error).message.slice(0, 120)}`); log.warn(`Cruva ${what} for ${shopId}/${handle ?? '-'}: ${(err as Error).message}`); return fallback; } };
    const [creator, samples, logs, products, campaigns] = await Promise.all([
      handle ? safe('creator', () => this.creator(shopId, handle), null) : Promise.resolve(null),
      handle ? safe('samples', () => this.samples(shopId, handle), []) : Promise.resolve([]),
      handle ? safe('outreach logs', () => this.outreachLogs(shopId, handle), []) : Promise.resolve([]),
      safe('products', () => this.products(shopId), []),
      safe('campaigns', () => this.campaigns(shopId), []),
    ]);
    return { creator, samples, logs, products, campaigns, notes };
  }
}

const num = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : null; };
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export const cruvaRest = new CruvaRest();
