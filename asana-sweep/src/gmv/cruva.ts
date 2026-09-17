import { log } from '../logger.js';

/**
 * Cruva REST client (api.cruva.com). Auth is x-api-key + x-shop-id headers per Cruva's docs.
 * The stats path and response shape are configurable because the docs were not reachable
 * when this was written: set CRUVA_STATS_PATH if the default is wrong. The parser accepts the
 * common shapes: { total_gmv: { series: {date: value} } }, { total_gmv: [{date, value}] },
 * or { data: [{ date, total_gmv, affiliate_gmv, total_units_sold }] }.
 */
export interface DailyGmv {
  date: string;
  total_gmv: number;
  affiliate_gmv: number;
  units: number;
}

export class CruvaClient {
  constructor(
    private apiKey: string = process.env.CRUVA_API_KEY?.trim() ?? '',
    private baseUrl: string = (process.env.CRUVA_BASE_URL?.trim() || 'https://api.cruva.com').replace(/\/+$/, ''),
    private statsPath: string = process.env.CRUVA_STATS_PATH?.trim() || '/v1/shop/stats',
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async shopStats(shopId: string, from: string, to: string): Promise<DailyGmv[]> {
    if (!this.apiKey) throw new Error('CRUVA_API_KEY is not set.');
    const url = new URL(this.baseUrl + this.statsPath);
    url.searchParams.set('date_from', from);
    url.searchParams.set('date_to', to);
    url.searchParams.set('stats', 'total_gmv,affiliate_gmv,total_units_sold');
    url.searchParams.set('include_charts', 'true');
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(url, { headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'x-shop-id': shopId } });
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      break;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Cruva ${res.status} for shop ${shopId}: ${text.slice(0, 200)}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Cruva returned non-JSON for shop ${shopId}`);
    }
    const rows = parseStats(body);
    if (!rows.length) log.warn(`Cruva returned no daily rows for shop ${shopId} (${from}..${to}). Check CRUVA_STATS_PATH / response shape.`);
    return rows;
  }
}

type Any = Record<string, unknown>;

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function seriesOf(stat: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!stat || typeof stat !== 'object') return out;
  const s = stat as Any;
  // Arrays first: Array.prototype.values would otherwise shadow the lookup below.
  const src = Array.isArray(stat) ? stat : ((s.series ?? s.chart ?? s.daily ?? s.values ?? s.data ?? s) as unknown);
  if (Array.isArray(src)) {
    for (const p of src as Any[]) {
      const date = String(p.date ?? p.day ?? p.x ?? '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.set(date, num(p.value ?? p.y ?? p.total ?? p.gmv));
    }
  } else if (src && typeof src === 'object') {
    for (const [k, v] of Object.entries(src as Any)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) out.set(k, num(typeof v === 'object' && v ? (v as Any).value : v));
    }
  }
  return out;
}

/** Normalise the various shapes a stats endpoint may return into daily rows. */
export function parseStats(body: unknown): DailyGmv[] {
  const root = ((body as Any)?.data && !Array.isArray((body as Any).data) ? (body as Any).data : body) as Any;
  if (!root || typeof root !== 'object') return [];

  // Shape C: array of day rows
  const arr = Array.isArray(root) ? root : Array.isArray((root as Any).data) ? ((root as Any).data as Any[]) : Array.isArray((root as Any).rows) ? ((root as Any).rows as Any[]) : null;
  if (arr && arr.length && (arr[0] as Any).date) {
    return arr
      .map((r) => ({
        date: String(r.date).slice(0, 10),
        total_gmv: num(r.total_gmv ?? r.gmv),
        affiliate_gmv: num(r.affiliate_gmv),
        units: Math.round(num(r.total_units_sold ?? r.units)),
      }))
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  }

  // Shapes A/B: per-stat series
  const total = seriesOf(root.total_gmv);
  const aff = seriesOf(root.affiliate_gmv);
  const units = seriesOf(root.total_units_sold ?? root.units);
  const dates = new Set([...total.keys(), ...aff.keys(), ...units.keys()]);
  return [...dates].sort().map((date) => ({
    date,
    total_gmv: total.get(date) ?? 0,
    affiliate_gmv: aff.get(date) ?? 0,
    units: Math.round(units.get(date) ?? 0),
  }));
}

/** Endpoint paths for the CRM objects; Cruva's public REST docs were not reachable, so they are overridable via CRUVA_ENDPOINTS (JSON) or the cruva_endpoints setting. */
export const DEFAULT_CRUVA_ENDPOINTS: Record<string, string> = { automation: '/v1/automations', workflow: '/v1/workflows', email_campaign: '/v1/email-campaigns', group: '/v1/groups', list: '/v1/lists' };

export function cruvaEndpoints(override?: string | null): Record<string, string> {
  const out = { ...DEFAULT_CRUVA_ENDPOINTS };
  for (const src of [process.env.CRUVA_ENDPOINTS, override]) {
    if (!src) continue;
    try {
      for (const [k, v] of Object.entries(JSON.parse(src) as Record<string, string>)) if (typeof v === 'string' && v.startsWith('/')) out[k] = v;
    } catch { /* ignore bad JSON */ }
  }
  return out;
}

export class CruvaCrmClient {
  constructor(private apiKey: string = process.env.CRUVA_API_KEY?.trim() ?? '', private baseUrl: string = (process.env.CRUVA_BASE_URL?.trim() || 'https://api.cruva.com').replace(/\/+$/, ''), private fetchFn: typeof fetch = fetch) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async request<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, shopId: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    if (!this.apiKey) throw new Error('CRUVA_API_KEY is not set.');
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      res = await this.fetchFn(url, { method, headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'x-shop-id': shopId }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
      break;
    }
    const text = await res.text();
    if (res.status === 404) throw new Error(`Cruva endpoint ${path} not found (404). Set CRUVA_ENDPOINTS to the right paths, or paste the MCP listing instead.`);
    if (!res.ok) throw new Error(`Cruva ${res.status} ${method} ${path}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text) as T; } catch { throw new Error(`Cruva returned non-JSON for ${path}`); }
  }

  /** List a CRM object type; accepts { data: [...] }, { items: [...] }, { automations: [...] } or a bare array. */
  async list(path: string, shopId: string): Promise<Record<string, unknown>[]> {
    const body = await this.request<unknown>('GET', path, shopId, undefined, { page_size: '100' });
    if (Array.isArray(body)) return body as Record<string, unknown>[];
    const o = (body ?? {}) as Record<string, unknown>;
    for (const k of ['data', 'items', 'results', 'automations', 'workflows', 'campaigns', 'groups', 'lists']) if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
    return [];
  }
}

export const cruva = new CruvaClient();
export const cruvaCrm = new CruvaCrmClient();
