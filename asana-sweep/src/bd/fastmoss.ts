import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Queries } from '../db/queries.js';
import type { BdProspectInput, FastmossStatus } from '../sweep/types.js';
import { parseProspectInput, pullsDir } from './import.js';
import { applyEnrichedSeed } from './import.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * FastMoss OpenAPI client (openapi.fastmoss.com). Auth is OAuth client credentials: client_id +
 * client_secret from developers.fastmoss.com, exchanged for a bearer access_token that is cached
 * and refreshed. The developer docs were not reachable from the build environment, so the token
 * path and the shop endpoints are configurable (Settings on the BD page or FASTMOSS_* env vars);
 * the defaults follow the documented REST naming (POST /shop/v1/rank/topSelling) and the request
 * body mirrors the MCP tool arguments (filter / orderby / page / pagesize), which the same API
 * serves. "Test FastMoss" tries the candidate token paths and reports which one worked.
 */

export const DEFAULT_FASTMOSS_PATHS = {
  token: '/oauth/token',
  shop_search: '/shop/v1/search',
  credits: '/user/v1/credit/summary',
};
export const TOKEN_PATH_CANDIDATES = ['/oauth/token', '/oauth/v1/token', '/api/oauth/token', '/auth/token', '/v1/oauth/token', '/openapi/oauth/token'];
export const SHOP_SEARCH_CANDIDATES = ['/shop/v1/search', '/shop/v1/list', '/shop/v1/shopSearch', '/api/shop/v1/search'];

export class FastmossQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FastmossQuotaError';
  }
}
export const isQuotaError = (err: unknown): boolean => err instanceof FastmossQuotaError || /insufficient|quota|credit|balance|402/i.test((err as Error)?.message ?? '');

export interface FastmossPaths { token: string; shop_search: string; credits: string }

export function fastmossPaths(q?: Queries | null): FastmossPaths {
  const out = { ...DEFAULT_FASTMOSS_PATHS };
  const env = process.env.FASTMOSS_PATHS?.trim();
  for (const src of [env, q?.getSetting('fastmoss_paths', '') || '']) {
    if (!src) continue;
    try { for (const [k, v] of Object.entries(JSON.parse(src) as Record<string, string>)) if (k in out && typeof v === 'string' && v.startsWith('/')) (out as Record<string, string>)[k] = v; } catch { /* ignore */ }
  }
  return out;
}

export interface FastmossShopRow extends Record<string, unknown> { shop_name?: string; seller_id?: string; region?: string; gmv_last_7d?: number; total_gmv?: number }

type Any = Record<string, unknown>;

/** Pull the shop list out of whatever envelope the API uses. */
export function unwrapShops(body: unknown): FastmossShopRow[] {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): FastmossShopRow[] | null => {
    if (!v || typeof v !== 'object' || depth > 4 || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.length && typeof v[0] === 'object' && v[0] && ('shop_name' in (v[0] as Any) || 'seller_id' in (v[0] as Any) || 'shop' in (v[0] as Any)) ? (v as FastmossShopRow[]) : v.length === 0 ? [] : null;
    const o = v as Any;
    for (const k of ['shops', 'list', 'items', 'rows', 'data', 'result']) { const r = walk(o[k], depth + 1); if (r) return r; }
    return null;
  };
  return walk(body, 0) ?? [];
}

export class FastmossClient {
  private token: { value: string; expires_at: number } | null = null;

  constructor(
    private clientId = process.env.FASTMOSS_CLIENT_ID?.trim() ?? '',
    private clientSecret = process.env.FASTMOSS_CLIENT_SECRET?.trim() ?? '',
    private baseUrl = (process.env.FASTMOSS_BASE_URL?.trim() || 'https://openapi.fastmoss.com').replace(/\/+$/, ''),
    private fetchFn: typeof fetch = fetch,
    private paths: FastmossPaths = fastmossPaths(null),
  ) {}

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  setPaths(p: FastmossPaths): void {
    this.paths = p;
    this.token = null;
  }

  private async raw(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<{ status: number; data: Any | null; text: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (auth) headers.authorization = `Bearer ${await this.accessToken()}`;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: Any | null = null;
    try { data = text ? (JSON.parse(text) as Any) : null; } catch { data = null; }
    return { status: res.status, data, text };
  }

  /** Try one token path with the two common client-credential encodings (JSON body, then form). */
  private async fetchToken(path: string): Promise<{ value: string; expires_in: number } | null> {
    const attempts: { headers: Record<string, string>; body: string }[] = [
      { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' }) },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' }).toString() },
    ];
    for (const a of attempts) {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, { method: 'POST', headers: { accept: 'application/json', ...a.headers }, body: a.body });
      const text = await res.text();
      let data: Any | null = null;
      try { data = text ? (JSON.parse(text) as Any) : null; } catch { data = null; }
      const inner = (data?.data as Any | undefined) ?? data;
      const value = String(inner?.access_token ?? inner?.token ?? '');
      if (res.ok && value) return { value, expires_in: Number(inner?.expires_in ?? inner?.expire_in ?? 7200) || 7200 };
      if (res.status === 404 || res.status === 405) return null; // wrong path, no point trying the other encoding
    }
    return null;
  }

  async accessToken(force = false): Promise<string> {
    if (!this.configured) throw new Error('FASTMOSS_CLIENT_ID / FASTMOSS_CLIENT_SECRET are not set.');
    if (!force && this.token && this.token.expires_at > Date.now() + 60000) return this.token.value;
    const t = await this.fetchToken(this.paths.token);
    if (!t) throw new Error(`FastMoss token request failed at ${this.paths.token}. Check the client id / secret, or set the token path from the developer docs in BD > FastMoss settings.`);
    this.token = { value: t.value, expires_at: Date.now() + t.expires_in * 1000 };
    return t.value;
  }

  /** Find which token path the API answers on (used by "Test FastMoss"). Returns the working path or null. */
  async discoverTokenPath(): Promise<string | null> {
    for (const p of [this.paths.token, ...TOKEN_PATH_CANDIDATES.filter((x) => x !== this.paths.token)]) {
      try { const t = await this.fetchToken(p); if (t) { this.paths.token = p; this.token = { value: t.value, expires_at: Date.now() + t.expires_in * 1000 }; return p; } } catch { /* next */ }
    }
    return null;
  }

  private async call(path: string, body: unknown, retry = true): Promise<Any | null> {
    const r = await this.raw('POST', path, body);
    if (r.status === 401 && retry) { await this.accessToken(true); return this.call(path, body, false); }
    const code = Number(r.data?.code ?? r.data?.errcode ?? (r.status >= 200 && r.status < 300 ? 0 : r.status));
    const msg = String(r.data?.message ?? r.data?.msg ?? r.data?.error ?? r.text.slice(0, 200));
    if (r.status === 402 || (code !== 0 && /quota|credit|balance|insufficient/i.test(msg))) throw new FastmossQuotaError(`FastMoss ${r.status}: ${msg}`);
    if (r.status === 404) throw new Error(`FastMoss endpoint ${path} not found (404): set the right path from the developer docs in BD > FastMoss settings.`);
    if (r.status >= 400 || (code !== 0 && code !== 200)) throw new Error(`FastMoss ${r.status}${code ? ` (code ${code})` : ''}: ${msg}`);
    return r.data;
  }

  /** Shops in a region ordered by 7-day GMV; same arguments as the MCP shop_search tool. */
  async shopSearch(opts: { region: string; page?: number; pagesize?: number; orderby?: { field: string; order: 'asc' | 'desc' }[]; keywords?: string }): Promise<FastmossShopRow[]> {
    const body = { filter: { region: opts.region }, orderby: opts.orderby ?? [{ field: 'day7_gmv', order: 'desc' }], page: opts.page ?? 1, pagesize: Math.min(opts.pagesize ?? 10, 10), ...(opts.keywords ? { keywords: opts.keywords } : {}) };
    return unwrapShops(await this.call(this.paths.shop_search, body));
  }

  /** Try the candidate shop-search paths until one answers (used by "Test FastMoss"). */
  async discoverShopSearchPath(region = 'DE'): Promise<{ path: string; rows: number } | null> {
    for (const p of [this.paths.shop_search, ...SHOP_SEARCH_CANDIDATES.filter((x) => x !== this.paths.shop_search)]) {
      try {
        const data = await this.call(p, { filter: { region }, orderby: [{ field: 'day7_gmv', order: 'desc' }], page: 1, pagesize: 1 });
        const rows = unwrapShops(data);
        this.paths.shop_search = p;
        return { path: p, rows: rows.length };
      } catch (err) {
        if (isQuotaError(err)) throw err;
        if (!/404/.test((err as Error).message)) { this.paths.shop_search = p; return { path: p, rows: 0 }; }
      }
    }
    return null;
  }

  /** Credit balance when the API exposes it (same shape as the MCP credit_usage_summary tool). Null when the path is unknown. */
  async credits(): Promise<{ available: number; granted: number; consumed: number; plan: string | null; expires_at: string | null } | null> {
    try {
      const r = await this.raw('GET', this.paths.credits);
      if (r.status === 404 || !r.data) return null;
      const d = ((r.data.data as Any | undefined) ?? r.data) as Any;
      const bal = (d.balance as Any | undefined) ?? d;
      const available = Number(bal.available_credits ?? bal.remaining_credits ?? bal.available ?? NaN);
      if (!Number.isFinite(available)) return null;
      const ent = (d.entitlements as Any | undefined) ?? {};
      return { available, granted: Number(bal.total_granted_credits ?? bal.granted ?? 0) || 0, consumed: Number(bal.total_consumed_credits ?? bal.consumed ?? 0) || 0, plan: ((d.subscriptions as Any[] | undefined)?.[0]?.package_name as string | undefined) ?? null, expires_at: (ent.plan_expire_at as string | undefined) ?? null };
    } catch {
      return null;
    }
  }
}

export const fastmoss = new FastmossClient();

export const PULL_MARKETS = ['DE', 'UK', 'FR', 'IT', 'ES'];

export interface PullResult { date: string; file: string | null; markets: { market: string; pages: number; fetched: number; kept: number; error: string | null }[]; added: number; updated: number; quota_hit: boolean }

/**
 * The daily pull done in-process: top shops per market by 7-day GMV, keep the risers (7-day share of
 * lifetime GMV at or above minRise) plus the first three pages for refreshed numbers, save the raw rows
 * to data/bd-pulls/<date>.json for the record, and upsert them into the pipeline.
 */
export async function pullFastMoss(q: Queries, client: FastmossClient = fastmoss, opts: { markets?: string[]; pages?: number; minRise?: number; date?: string } = {}): Promise<PullResult> {
  if (!client.configured) throw new Error('FastMoss is not configured: set FASTMOSS_CLIENT_ID and FASTMOSS_CLIENT_SECRET.');
  client.setPaths(fastmossPaths(q));
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const pages = Math.min(Math.max(opts.pages ?? (Number(q.getSetting('fastmoss_pull_pages', '10')) || 10), 1), 30);
  const minRise = opts.minRise ?? 0.05;
  const markets = opts.markets ?? (q.getSetting('fastmoss_pull_markets', '').split(',').map((m) => m.trim().toUpperCase()).filter(Boolean).length ? q.getSetting('fastmoss_pull_markets', '').split(',').map((m) => m.trim().toUpperCase()).filter(Boolean) : PULL_MARKETS);
  const result: PullResult = { date, file: null, markets: [], added: 0, updated: 0, quota_hit: false };
  const kept: FastmossShopRow[] = [];
  const seen = new Set<string>();
  outer: for (const market of markets) {
    const m = { market, pages: 0, fetched: 0, kept: 0, error: null as string | null };
    result.markets.push(m);
    for (let page = 1; page <= pages; page += 1) {
      let rows: FastmossShopRow[];
      try {
        rows = await client.shopSearch({ region: market, page, pagesize: 10 });
      } catch (err) {
        m.error = (err as Error).message;
        if (isQuotaError(err)) { result.quota_hit = true; q.setSetting('fastmoss_quota_hit_at', new Date().toISOString()); break outer; }
        break;
      }
      m.pages += 1;
      m.fetched += rows.length;
      for (const r of rows) {
        const name = String(r.shop_name ?? '').trim();
        if (!name) continue;
        const key = String(r.seller_id ?? `${market}:${name}`);
        if (seen.has(key)) continue;
        const rise = Number(r.total_gmv) > 0 ? Number(r.gmv_last_7d ?? 0) / Number(r.total_gmv) : 0;
        if (page <= 3 || rise >= minRise) { seen.add(key); kept.push({ ...r, region: r.region ?? market }); m.kept += 1; }
      }
      if (rows.length < 10) break;
      await new Promise((r) => setTimeout(r, 250)); // 80 calls a minute on the Pro plan
    }
  }
  if (kept.length) {
    const dir = pullsDir();
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = `${date}.json`;
      writeFileSync(join(dir, file), JSON.stringify({ pulled_at: date, source: 'fastmoss-api', shops: kept.map((r) => { const { linked_creator, ...rest } = r; const lc = linked_creator as Any | undefined; return lc ? { ...rest, linked_creator: { ...lc, avatar_url: undefined } } : rest; }) }, null, 1));
      result.file = file;
      // Mark the file as imported so the folder scan does not import it a second time.
      let done: string[] = [];
      try { done = JSON.parse(q.getSetting('bd_pulls_imported', '[]')) as string[]; } catch { done = []; }
      if (!done.includes(file)) q.setSetting('bd_pulls_imported', JSON.stringify([...done, file].slice(-365)));
    } catch (err) {
      log.warn(`FastMoss pull: could not write the pull file: ${(err as Error).message}`);
    }
    const parsed: BdProspectInput[] = [];
    for (const row of kept) { try { parsed.push(parseProspectInput({ pulled_at: date, source: 'fastmoss', ...row })); } catch { /* skip bad row */ } }
    const r = q.upsertProspects(parsed);
    result.added = r.added;
    result.updated = r.updated;
    applyEnrichedSeed(q);
  }
  q.setSetting('fastmoss_last_pull_at', new Date().toISOString());
  q.setSetting('fastmoss_last_pull_json', JSON.stringify(result));
  q.setSetting('fastmoss_last_error', result.markets.map((m) => m.error).filter(Boolean).join(' · ').slice(0, 500));
  log.info(`FastMoss pull ${date}: ${kept.length} shops kept across ${result.markets.length} market(s), +${result.added} new, ${result.updated} refreshed${result.quota_hit ? ' (quota hit)' : ''}`);
  liveEvents.emitUpdate({ kind: 'bd' });
  return result;
}

export function fastmossStatus(q: Queries, client: FastmossClient = fastmoss): FastmossStatus {
  let last: PullResult | null = null;
  try { last = JSON.parse(q.getSetting('fastmoss_last_pull_json', '') || 'null'); } catch { last = null; }
  let credits: FastmossStatus['credits'] = null;
  try { credits = JSON.parse(q.getSetting('fastmoss_credits_json', '') || 'null'); } catch { credits = null; }
  return {
    configured: client.configured,
    last_pull_at: q.getSetting('fastmoss_last_pull_at', '') || null,
    last_error: q.getSetting('fastmoss_last_error', '') || null,
    last_test: q.getSetting('fastmoss_last_test', '') || null,
    quota_hit_at: q.getSetting('fastmoss_quota_hit_at', '') || null,
    last_pull: last,
    credits,
    paths: fastmossPaths(q),
    markets: q.getSetting('fastmoss_pull_markets', '') || PULL_MARKETS.join(','),
    pages: Number(q.getSetting('fastmoss_pull_pages', '10')) || 10,
    pull_hour: q.getSetting('fastmoss_pull_cron', '30 5 * * *'),
  };
}
