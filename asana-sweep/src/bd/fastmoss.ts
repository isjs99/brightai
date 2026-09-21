import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import type { Queries } from '../db/queries.js';
import type { BdProspectInput, FastmossStatus } from '../sweep/types.js';
import { parseProspectInput, pullsDir, applyEnrichedSeed } from './import.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * FastMoss client. FastMoss exposes its data over MCP (https://mcp.fastmoss.com/mcp, Streamable
 * HTTP JSON-RPC) with an API key from developers.fastmoss.com > MCP&CLI > API Keys; the same key
 * drives their CLI (@fastmoss/cli). This client speaks the MCP protocol directly (initialize,
 * tools/call) so the server pulls the fast risers on its own schedule with no Claude session in
 * the loop. The key is sent as a bearer token and as X-API-Key (servers ignore the one they do not
 * use); if the HTTP transport is refused, the official CLI is used as a fallback when installed
 * (`npx -y @fastmoss/cli@latest call ...`).
 */

export const FASTMOSS_MCP_URL = 'https://mcp.fastmoss.com/mcp';

export class FastmossQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FastmossQuotaError';
  }
}
export const isQuotaError = (err: unknown): boolean => err instanceof FastmossQuotaError || /insufficient|quota|credits? (exhausted|used up|remaining)|balance|402|recharge/i.test((err as Error)?.message ?? '');

export interface FastmossShopRow extends Record<string, unknown> { shop_name?: string; seller_id?: string; region?: string; gmv_last_7d?: number; total_gmv?: number }

type Any = Record<string, unknown>;

/** Pull the shop list out of whatever envelope the tool result uses. */
export function unwrapShops(body: unknown): FastmossShopRow[] {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): FastmossShopRow[] | null => {
    if (!v || typeof v !== 'object' || depth > 5 || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.length && typeof v[0] === 'object' && v[0] && ('shop_name' in (v[0] as Any) || 'seller_id' in (v[0] as Any) || 'shop' in (v[0] as Any)) ? (v as FastmossShopRow[]) : null;
    const o = v as Any;
    for (const k of ['shops', 'list', 'items', 'rows', 'data', 'result', 'structuredContent']) { const r = walk(o[k], depth + 1); if (r) return r; }
    return null;
  };
  return walk(body, 0) ?? [];
}

/** The JSON payload of an MCP tool result: structuredContent, else the first text block parsed as JSON. */
export function toolResultJson(result: unknown): unknown {
  const r = (result ?? {}) as Any;
  if (r.structuredContent) return r.structuredContent;
  const content = (r.content as { type?: string; text?: string }[] | undefined) ?? [];
  const text = content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string).join('\n').trim();
  if (!text) return r;
  try { return JSON.parse(text); } catch { /* not JSON */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ } }
  return { text };
}

export type FastmossTransport = 'http' | 'cli';

export class FastmossClient {
  private sessionId: string | null = null;
  private initialised = false;
  private nextId = 1;

  constructor(
    private apiKey = process.env.FASTMOSS_API_KEY?.trim() ?? '',
    private url = process.env.FASTMOSS_MCP_URL?.trim() || FASTMOSS_MCP_URL,
    private fetchFn: typeof fetch = fetch,
    public transport: FastmossTransport = (process.env.FASTMOSS_TRANSPORT === 'cli' ? 'cli' : 'http'),
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.apiKey}`, 'x-api-key': this.apiKey, 'user-agent': 'brightform-am-ops/1.0 (fastmoss-mcp client)' };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  /** One JSON-RPC round trip; the server may answer with plain JSON or an SSE stream carrying the JSON message. */
  private async rpc<T>(method: string, params: Any, notification = false): Promise<T> {
    if (!this.apiKey) throw new Error('FASTMOSS_API_KEY is not set (developers.fastmoss.com > MCP&CLI > API Keys).');
    const id = notification ? undefined : this.nextId++;
    const res = await this.fetchFn(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error(`FastMoss MCP ${res.status}: ${text.slice(0, 160) || 'API key rejected'}`);
    if (res.status === 402) throw new FastmossQuotaError(`FastMoss 402: ${text.slice(0, 160) || 'insufficient credits'}`);
    if (res.status === 404 && this.sessionId) { this.sessionId = null; this.initialised = false; throw new Error('FastMoss MCP session expired'); }
    if (!res.ok && res.status !== 202) throw new Error(`FastMoss MCP ${res.status}: ${text.slice(0, 200)}`);
    if (notification) return undefined as T;
    // SSE: take the last "data:" JSON message with our id.
    let msg: Any | null = null;
    if (/^\s*(event:|data:)/m.test(text) && !text.trim().startsWith('{')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { const j = JSON.parse(line.slice(5).trim()) as Any; if (j.id === id || (j.result !== undefined || j.error !== undefined)) msg = j; } catch { /* skip */ }
      }
    } else {
      try { msg = JSON.parse(text) as Any; } catch { throw new Error(`FastMoss MCP returned non-JSON: ${text.slice(0, 120)}`); }
    }
    if (!msg) throw new Error('FastMoss MCP returned no message');
    if (msg.error) {
      const e = msg.error as { code?: number; message?: string };
      const m = `FastMoss MCP error${e.code !== undefined ? ` ${e.code}` : ''}: ${e.message ?? 'unknown'}`;
      if (isQuotaError(new Error(m))) throw new FastmossQuotaError(m);
      throw new Error(m);
    }
    return msg.result as T;
  }

  async initialise(force = false): Promise<{ name: string; version: string } | null> {
    if (this.initialised && !force) return null;
    this.sessionId = null;
    const r = await this.rpc<{ serverInfo?: { name: string; version: string } }>('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'brightform-am-ops', version: '1.0' } });
    try { await this.rpc('notifications/initialized', {}, true); } catch { /* some servers reject the notification; harmless */ }
    this.initialised = true;
    return r.serverInfo ?? null;
  }

  async listTools(): Promise<string[]> {
    await this.initialise();
    const r = await this.rpc<{ tools?: { name: string }[] }>('tools/list', {});
    return (r.tools ?? []).map((t) => t.name);
  }

  /** Call a FastMoss tool and return its JSON payload. */
  async callTool(name: string, args: Any): Promise<unknown> {
    if (this.transport === 'cli') return this.callViaCli(name, args);
    await this.initialise();
    let result: Any;
    try {
      result = await this.rpc<Any>('tools/call', { name, arguments: args });
    } catch (err) {
      if (/session expired/.test((err as Error).message)) { await this.initialise(true); result = await this.rpc<Any>('tools/call', { name, arguments: args }); } else throw err;
    }
    const payload = toolResultJson(result);
    if (result.isError) {
      const m = `FastMoss ${name}: ${typeof payload === 'object' && payload && 'text' in (payload as Any) ? String((payload as Any).text) : JSON.stringify(payload).slice(0, 200)}`;
      if (isQuotaError(new Error(m))) throw new FastmossQuotaError(m);
      throw new Error(m);
    }
    return payload;
  }

  /** Fallback through the official CLI (npx -y @fastmoss/cli@latest call ...), which handles the protocol itself. */
  private callViaCli(name: string, args: Any): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const bin = process.env.FASTMOSS_CLI?.trim() || 'npx';
      const argv = bin === 'npx' ? ['-y', '@fastmoss/cli@latest'] : [];
      execFile(bin, [...argv, 'call', '--tool', name, '--args', JSON.stringify(args), '--output', 'data'], { env: { ...process.env, FASTMOSS_API_KEY: this.apiKey }, timeout: 120000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = String(stdout ?? '').trim();
        if (err && !out) { const m = `FastMoss CLI: ${String(stderr || err.message).trim().slice(0, 300)}`; reject(isQuotaError(new Error(m)) ? new FastmossQuotaError(m) : new Error(m)); return; }
        try { resolve(JSON.parse(out)); } catch { const start = out.indexOf('{'); const end = out.lastIndexOf('}'); if (start >= 0 && end > start) { try { resolve(JSON.parse(out.slice(start, end + 1))); return; } catch { /* fall through */ } } reject(new Error(`FastMoss CLI returned non-JSON: ${out.slice(0, 160)}`)); }
      });
    });
  }

  /** Shops in a region ordered by 7-day GMV; the shop_search tool arguments. */
  async shopSearch(opts: { region: string; page?: number; pagesize?: number; orderby?: { field: string; order: 'asc' | 'desc' }[]; keywords?: string }): Promise<FastmossShopRow[]> {
    const args: Any = { filter: { region: opts.region }, orderby: opts.orderby ?? [{ field: 'day7_gmv', order: 'desc' }], page: opts.page ?? 1, pagesize: Math.min(opts.pagesize ?? 10, 10) };
    if (opts.keywords) args.keywords = opts.keywords;
    return unwrapShops(await this.callTool('shop_search', args));
  }

  /** Credit balance from the credit_usage_summary tool (free). */
  async credits(): Promise<{ available: number; granted: number; consumed: number; plan: string | null; expires_at: string | null; monthly: number | null } | null> {
    const d = (await this.callTool('credit_usage_summary', {})) as Any;
    const bal = (d.balance as Any | undefined) ?? d;
    const available = Number(bal.available_credits ?? bal.remaining_credits ?? NaN);
    if (!Number.isFinite(available)) return null;
    const ent = (d.entitlements as Any | undefined) ?? {};
    return { available, granted: Number(bal.total_granted_credits ?? 0) || 0, consumed: Number(bal.total_consumed_credits ?? 0) || 0, plan: ((d.subscriptions as Any[] | undefined)?.[0]?.package_name as string | undefined) ?? null, expires_at: (ent.plan_expire_at as string | undefined) ?? null, monthly: ent.monthly_credits !== undefined ? Number(ent.monthly_credits) : null };
  }

  /** Connection test: initialise, list tools, one-row shop search, balance. Falls back to the CLI transport on an auth refusal. */
  async test(): Promise<{ ok: boolean; transport: FastmossTransport; server: string | null; tools: number; rows: number; error: string | null }> {
    const out = { ok: false, transport: this.transport, server: null as string | null, tools: 0, rows: 0, error: null as string | null };
    const tryHttp = async () => {
      const info = await this.initialise(true);
      out.server = info ? `${info.name} ${info.version}` : 'mcp';
      out.tools = (await this.listTools()).length;
      out.rows = (await this.shopSearch({ region: 'DE', pagesize: 1 })).length;
      out.ok = true;
    };
    try {
      if (this.transport === 'cli') { out.rows = (await this.shopSearch({ region: 'DE', pagesize: 1 })).length; out.ok = true; return out; }
      await tryHttp();
      return out;
    } catch (err) {
      out.error = (err as Error).message;
      if (isQuotaError(err)) throw err;
      if (/401|403|rejected|unauthori/i.test(out.error)) {
        try {
          this.transport = 'cli';
          out.rows = (await this.shopSearch({ region: 'DE', pagesize: 1 })).length;
          out.ok = true; out.transport = 'cli'; out.error = null;
          return out;
        } catch (err2) {
          this.transport = 'http';
          out.error = `${out.error} (CLI fallback: ${(err2 as Error).message.slice(0, 160)})`;
        }
      }
      return out;
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
export async function pullFastMoss(q: Queries, client: FastmossClient = fastmoss, opts: { markets?: string[]; pages?: number; minRise?: number; date?: string; delayMs?: number } = {}): Promise<PullResult> {
  if (!client.configured) throw new Error('FastMoss is not configured: set FASTMOSS_API_KEY.');
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const pages = Math.min(Math.max(opts.pages ?? (Number(q.getSetting('fastmoss_pull_pages', '10')) || 10), 1), 30);
  const minRise = opts.minRise ?? 0.05;
  const configured = q.getSetting('fastmoss_pull_markets', '').split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);
  const markets = opts.markets ?? (configured.length ? configured : PULL_MARKETS);
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
      if (opts.delayMs !== 0) await new Promise((r) => setTimeout(r, opts.delayMs ?? 800)); // 80 calls a minute on the Pro plan
    }
  }
  if (kept.length) {
    const dir = pullsDir();
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = `${date}.json`;
      writeFileSync(join(dir, file), JSON.stringify({ pulled_at: date, source: 'fastmoss-mcp', shops: kept.map((r) => { const { linked_creator, ...rest } = r; const lc = linked_creator as Any | undefined; return lc ? { ...rest, linked_creator: { ...lc, avatar_url: undefined } } : rest; }) }, null, 1));
      result.file = file;
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
  try { const c = await client.credits(); if (c) q.setSetting('fastmoss_credits_json', JSON.stringify({ ...c, checked_at: new Date().toISOString() })); } catch { /* balance is optional */ }
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
    transport: client.transport,
    last_pull_at: q.getSetting('fastmoss_last_pull_at', '') || null,
    last_error: q.getSetting('fastmoss_last_error', '') || null,
    last_test: q.getSetting('fastmoss_last_test', '') || null,
    quota_hit_at: q.getSetting('fastmoss_quota_hit_at', '') || null,
    last_pull: last,
    credits,
    markets: q.getSetting('fastmoss_pull_markets', '') || PULL_MARKETS.join(','),
    pages: Number(q.getSetting('fastmoss_pull_pages', '10')) || 10,
    pull_hour: q.getSetting('fastmoss_pull_cron', '30 5 * * *'),
  };
}
