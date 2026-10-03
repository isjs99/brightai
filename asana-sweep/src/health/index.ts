import type { Queries } from '../db/queries.js';
import type { Account, HealthAssessment, HealthSummary, HealthThresholds } from '../sweep/types.js';
import { windsor, type WindsorClient } from '../gmv/windsor.js';
import { draftWithClaude } from '../inbox/llm.js';
import { config } from '../config.js';
import { todayIn } from '../checklist/checker.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';
import { AI_RULES, CRUVA_METRIC_KEYS, DEFAULT_THRESHOLDS, evaluateWindsor, parseCruvaMetrics, parseThresholds, WINDSOR_RULES, type Found, type WindsorRows } from './rules.js';
import { ALL_TTS_RULES, emptyTtsRows, evaluateTargets, evaluateTts, lastDays, SCOPE_LABELS, SECTIONS, startOfWeek, targetValue, TARGET_RULES, type TtsRows } from './tts-rules.js';
import { BLOCK_SCOPES, pullShop } from './tts-pull.js';
import { tts, type TtsClient } from '../tts/client.js';
import { shopCredentials } from '../tts/promotions.js';
import { currencyForMarket } from '../tts/markets.js';
import { CHECKLIST_TEMPLATE } from '../checklist/template.js';
import type { AccountKpi, AccountOverview, AccountSection, MonitorAccountRow, MonitorRule, TtsScope, TtsScopeStatus } from '../sweep/types.js';

/**
 * Account health engine: the daily Windsor pull per linked shop (orders, products, payouts,
 * statements, unsettled money), the Cruva metrics the daily Claude routine posts, the rules over
 * both (thresholds editable on the Monitor page) and the AI review that reads everything the
 * dashboard knows about an account and writes a risk rating, a summary and one action for the day.
 */

const CUSTOM_CODE = 'c_custom';

export interface IngestPayload {
  source?: string;
  accounts: {
    account: string | number;
    shops?: { shop_id: string; shop_name?: string; metrics?: Record<string, unknown> }[];
    findings?: { message: string; detail?: string; severity?: string; shop_id?: string }[];
    assessment?: { risk: string; summary: string; action: string; watch?: string[] };
  }[];
}

export class HealthEngine {
  pulling = false;
  reviewing = false;

  constructor(private q: Queries, private deps: { windsor?: WindsorClient; tts?: TtsClient; llm?: ((system: string, user: string) => Promise<string>) | null } = {}) {}

  private get client(): WindsorClient { return this.deps.windsor ?? windsor; }
  private get ttsClient(): TtsClient { return this.deps.tts ?? tts; }

  private get llm(): ((system: string, user: string) => Promise<string>) | null {
    if (this.deps.llm !== undefined) return this.deps.llm;
    return config.anthropicApiKey ? (s, u) => draftWithClaude(s, u, { maxTokens: 900 }) : null;
  }

  thresholds(): HealthThresholds {
    let raw: unknown = null;
    try { raw = JSON.parse(this.q.getSetting('health_thresholds_json', '{}')); } catch { raw = null; }
    return parseThresholds(raw);
  }

  setThresholds(patch: Record<string, unknown>): HealthThresholds {
    const next = parseThresholds({ ...this.thresholds(), ...patch });
    this.q.setSetting('health_thresholds_json', JSON.stringify(next));
    liveEvents.emitUpdate({ kind: 'monitor' });
    return next;
  }

  resetThresholds(): HealthThresholds {
    this.q.setSetting('health_thresholds_json', JSON.stringify(DEFAULT_THRESHOLDS));
    liveEvents.emitUpdate({ kind: 'monitor' });
    return { ...DEFAULT_THRESHOLDS };
  }

  private today(): string { return todayIn(this.q.getSetting('check_timezone', 'Europe/Madrid')); }

  // ---- Windsor pull ----

  /** One pass over the connector: every table once, split per linked shop, one pull row per shop for today. */
  async pullWindsor(): Promise<{ shops: number; errors: string[] }> {
    if (this.pulling) return { shops: 0, errors: ['A pull is already running'] };
    const shops = this.q.listShops('windsor');
    if (!this.client.configured) return { shops: 0, errors: ['WINDSOR_API_KEY is not set'] };
    if (!shops.length) return { shops: 0, errors: ['No Windsor shops linked to accounts (Connections page)'] };
    this.pulling = true;
    const errors: string[] = [];
    const today = this.today();
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    try {
      const fetchTable = async <T,>(name: string, fn: () => Promise<T[]>): Promise<T[]> => { try { return await fn(); } catch (err) { errors.push(`${name}: ${(err as Error).message}`); return []; } };
      const [orders, products, payments, statements, unsettled] = await Promise.all([
        fetchTable('orders', () => this.client.ordersDetailed(iso(60), to)),
        fetchTable('products', () => this.client.productsDetailed()),
        fetchTable('payments', () => this.client.paymentsDetailed(iso(60), to)),
        fetchTable('statements', () => this.client.statements(iso(45), to)),
        fetchTable('unsettled', () => this.client.unsettled(iso(120), to)),
      ]);
      const ordersFailed = errors.some((e) => e.startsWith('orders:'));
      const t = this.thresholds();
      for (const s of shops) {
        const rows: WindsorRows = {
          orders: orders.filter((o) => o.account_id === s.shop_id),
          products: products.filter((p) => p.account_id === s.shop_id),
          payments: payments.filter((p) => p.account_id === s.shop_id),
          statements: statements.filter((x) => x.account_id === s.shop_id),
          unsettled: unsettled.filter((u) => u.account_id === s.shop_id),
        };
        const ok = !ordersFailed;
        const { metrics } = evaluateWindsor({ shop_id: s.shop_id, shop_name: s.shop_name, account_id: s.account_id, currency: s.currency }, rows, t, { pullOk: ok });
        this.q.upsertHealthPull({ shop_id: s.shop_id, account_id: s.account_id, source: 'windsor', pull_date: today, ok, error: ok ? null : errors.join('; ').slice(0, 500), metrics, rows: rows as unknown as Record<string, unknown> });
      }
      this.q.setSetting('health_last_pull_at', new Date().toISOString());
      this.q.setSetting('health_last_pull_error', errors.join('; ').slice(0, 800));
      log.info(`Health pull: ${orders.length} orders, ${products.length} product rows, ${payments.length} payments, ${statements.length} statements, ${unsettled.length} unsettled rows for ${shops.length} shop(s)${errors.length ? `; ${errors.length} table error(s)` : ''}`);
      liveEvents.emitUpdate({ kind: 'monitor' });
      return { shops: shops.length, errors };
    } catch (err) {
      const msg = (err as Error).message;
      this.q.setSetting('health_last_pull_error', msg);
      log.error(`Health pull failed: ${msg}`);
      return { shops: 0, errors: [msg] };
    } finally {
      this.pulling = false;
    }
  }

  // ---- Rules over the stored pulls ----

  windsorFlags(enabled: Set<string>, now = Date.now()): Found[] {
    const t = this.thresholds();
    const out: Found[] = [];
    const linked = new Map(this.q.listShops('windsor').map((s) => [s.shop_id, s]));
    for (const p of this.q.latestHealthPulls('windsor')) {
      const s = linked.get(p.shop_id);
      if (!s) continue;
      const rows = p.rows as unknown as Partial<WindsorRows>;
      const full: WindsorRows = { orders: rows.orders ?? [], products: rows.products ?? [], payments: rows.payments ?? [], statements: rows.statements ?? [], unsettled: rows.unsettled ?? [] };
      // A pull older than two days is itself a stale-data flag, whatever the rows say.
      const stale = p.pull_date < new Date(now - 2 * 86400000).toISOString().slice(0, 10);
      const r = evaluateWindsor({ shop_id: s.shop_id, shop_name: s.shop_name, account_id: s.account_id, currency: s.currency }, full, t, { now, enabled, pullOk: p.ok && !stale, pullError: stale ? `last pull was on ${p.pull_date}` : p.error });
      out.push(...r.flags);
    }
    return out;
  }

  // ---- TikTok Shop OpenAPI pull (every scan; daily blocks hourly) and the rules over it ----

  pullingTts = false;

  /** Pull every authorised shop linked to an account. Each block records whether its scope is live, denied or erroring. */
  async pullTikTok(opts: { now?: number; shopIds?: string[]; force?: boolean } = {}): Promise<{ shops: number; errors: string[] }> {
    if (this.pullingTts) return { shops: 0, errors: ['A TikTok pull is already running'] };
    if (!this.ttsClient.configured) return { shops: 0, errors: ['TTS_APP_KEY / TTS_APP_SECRET are not set'] };
    const now = opts.now ?? Date.now();
    const shops = this.q.listTtsShops().filter((sh) => sh.token_ok && sh.account_id !== null && (!opts.shopIds || opts.shopIds.includes(sh.id)));
    if (!shops.length) return { shops: 0, errors: ['No authorised TikTok shop is linked to an account (Promotions › Connection)'] };
    this.pullingTts = true;
    const errors: string[] = [];
    const today = this.today();
    const previous = new Map(this.q.latestHealthPulls('tts').map((p) => [p.shop_id, p]));
    try {
      for (const sh of shops) {
        try {
          const creds = await shopCredentials(this.q, sh.id, this.ttsClient);
          const prev = previous.get(sh.id);
          const rows = await pullShop(this.ttsClient, creds, { now, previous: prev ? (prev.rows as unknown as TtsRows) : null, refreshDailyAfterMinutes: opts.force ? 0 : 55 });
          const ref = { shop_id: sh.id, shop_name: sh.name, account_id: sh.account_id, currency: currencyForMarket(sh.market ?? ''), market: sh.market };
          const { metrics } = evaluateTts(ref, rows, this.thresholds(), { now, targets: this.sampleTargets(sh.account_id!, sh.market) });
          const failed = Object.entries(rows.scopes).filter(([, r]) => r && r.state === 'error').map(([k, r]) => `${k}: ${r!.message}`);
          this.q.upsertHealthPull({ shop_id: sh.id, account_id: sh.account_id, source: 'tts', pull_date: today, ok: Boolean(rows.scopes.analytics?.ok) || failed.length === 0, error: failed.length ? failed.join('; ').slice(0, 500) : null, metrics, rows: rows as unknown as Record<string, unknown> });
          // The product pull refreshes the current price of every SKU on the account's price list.
          if (rows.scopes.product?.ok) for (const p of rows.products) for (const sku of p.skus) if (sku.price !== null) this.q.setSkuCurrentPrice(sh.account_id!, sku.id, sku.price, sku.currency);
          if (failed.length) errors.push(`${sh.name}: ${failed.join('; ')}`);
        } catch (err) {
          errors.push(`${sh.name}: ${(err as Error).message}`);
          log.warn(`TikTok pull failed for ${sh.name}: ${(err as Error).message}`);
        }
      }
      this.q.setSetting('tts_last_pull_at', new Date(now).toISOString());
      this.q.setSetting('tts_last_pull_error', errors.join('; ').slice(0, 800));
      this.q.setSetting('tts_scopes_json', JSON.stringify(this.computeScopeStatus()));
      liveEvents.emitUpdate({ kind: 'monitor' });
      return { shops: shops.length, errors };
    } finally {
      this.pullingTts = false;
    }
  }

  private sampleTargets(accountId: number, market: string | null): { samples_per_week: number | null; samples_min_per_week: number | null } {
    const targets = this.q.listAccountTargets(accountId);
    return { samples_per_week: targetValue(targets, 'samples_per_week', market ?? ''), samples_min_per_week: targetValue(targets, 'samples_min_per_week', market ?? '') };
  }

  /** Per scope: live on every pulled shop, denied (approval missing), erroring, or not tried yet. */
  computeScopeStatus(): TtsScopeStatus[] {
    const pulls = this.q.latestHealthPulls('tts');
    return BLOCK_SCOPES.map((scope) => {
      const results = pulls.map((p) => (p.rows as unknown as TtsRows).scopes?.[scope]).filter((r): r is NonNullable<typeof r> => Boolean(r));
      const ok = results.filter((r) => r.ok).length;
      const denied = results.find((r) => r.state === 'denied');
      const error = results.find((r) => r.state === 'error');
      const state: TtsScopeStatus['state'] = !results.length ? 'unknown' : ok === results.length ? 'ok' : denied && !ok ? 'denied' : error && !ok ? 'error' : ok ? 'ok' : 'unknown';
      return { scope, state, message: denied?.message ?? error?.message ?? null, checked_at: results.map((r) => r.at).sort().pop() ?? null, shops_ok: ok, shops_total: results.length };
    });
  }

  scopeStatus(): TtsScopeStatus[] {
    try { const v = JSON.parse(this.q.getSetting('tts_scopes_json', '[]')) as TtsScopeStatus[]; if (Array.isArray(v) && v.length) return v; } catch { /* fall through */ }
    return BLOCK_SCOPES.map((scope) => ({ scope, state: 'unknown' as const, message: null, checked_at: null, shops_ok: 0, shops_total: 0 }));
  }

  scopeLive(scope: TtsScope): boolean {
    if (scope === 'none') return true;
    return this.scopeStatus().some((s) => s.scope === scope && s.state === 'ok');
  }

  ttsFlags(enabled: Set<string>, now = Date.now()): Found[] {
    const t = this.thresholds();
    const out: Found[] = [];
    const shops = new Map(this.q.listTtsShops().map((sh) => [sh.id, sh]));
    for (const p of this.q.latestHealthPulls('tts')) {
      const sh = shops.get(p.shop_id);
      if (!sh || sh.account_id === null) continue;
      const rows = { ...emptyTtsRows(), ...(p.rows as unknown as Partial<TtsRows>) } as TtsRows;
      const stale = Date.parse(rows.fetched_at || p.pulled_at) < now - 2 * 86400000;
      if (stale) { for (const k of Object.keys(rows.scopes) as TtsScope[]) rows.scopes[k] = { ...rows.scopes[k]!, ok: false, state: 'error', message: `last pull ${p.pull_date}` }; }
      const ref = { shop_id: sh.id, shop_name: sh.name, account_id: sh.account_id, currency: currencyForMarket(sh.market ?? ''), market: sh.market };
      out.push(...evaluateTts(ref, rows, t, { now, enabled, targets: this.sampleTargets(sh.account_id, sh.market) }).flags);
    }
    return out;
  }

  /** Month-to-date GMV per account from the analytics pulls (sum over its shops). */
  private gmvMonthToDate(accountId: number, now: number): number | null {
    const monthStart = new Date(now).toISOString().slice(0, 8) + '01';
    const shops = this.q.listTtsShops().filter((sh) => sh.account_id === accountId);
    let total = 0; let any = false;
    for (const p of this.q.latestHealthPulls('tts')) {
      if (!shops.some((sh) => sh.id === p.shop_id)) continue;
      const rows = p.rows as unknown as Partial<TtsRows>;
      if (!rows.scopes?.analytics?.ok) continue;
      any = true;
      total += (rows.analytics ?? []).filter((d) => d.date >= monthStart).reduce((n, d) => n + d.gmv, 0);
    }
    return any ? Math.round(total) : null;
  }

  targetFlags(enabled: Set<string>, now = Date.now()): Found[] {
    const t = this.thresholds();
    const out: Found[] = [];
    const promotions = this.q.listPromotions();
    const gmvMax = this.q.listGmvMax();
    const ttsShops = this.q.listTtsShops();
    for (const a of this.q.listAccounts().filter((x) => x.enabled)) {
      const shopIdsByMarket: Record<string, string[]> = {};
      for (const sh of ttsShops.filter((x) => x.account_id === a.id && x.market)) shopIdsByMarket[sh.market!] = [...(shopIdsByMarket[sh.market!] ?? []), sh.id];
      const markets = (a.markets ?? '').toUpperCase().split(/[\/,\s]+/).filter((m) => /^[A-Z]{2}$/.test(m));
      out.push(...evaluateTargets({
        account: { id: a.id, name: a.name, markets: a.markets },
        targets: this.q.listAccountTargets(a.id),
        promotions,
        campaigns: this.q.listAccountCampaigns(a.id),
        skuPrices: this.q.listSkuPrices(a.id),
        gmvMax: gmvMax.filter((g) => g.account_id === a.id).map((g) => ({ market: g.market, daily_budget: g.daily_budget, target_roi: g.target_roi, status: g.status })),
        gmv_month_to_date: this.gmvMonthToDate(a.id, now),
        currency: currencyForMarket(markets[0] ?? ''),
        shopIdsByMarket,
      }, t, { now, enabled }));
    }
    return out;
  }

  // ---- What one account looks like on the monitor ----

  accountRows(flags: ReturnType<Queries['listFlags']>, now = Date.now()): MonitorAccountRow[] {
    const pulls = this.q.latestHealthPulls('tts');
    const ttsShops = this.q.listTtsShops();
    const assessments = new Map(this.q.latestAssessments().map((a) => [a.account_id, a]));
    const t = this.thresholds();
    return this.q.listAccounts().filter((a) => a.enabled).map((a) => {
      const mine = flags.filter((f) => f.account_id === a.id);
      const shops = ttsShops.filter((sh) => sh.account_id === a.id);
      const myPulls = pulls.filter((p) => shops.some((sh) => sh.id === p.shop_id));
      const sumMetric = (k: string) => { let any = false; let n = 0; for (const p of myPulls) { const v = p.metrics[k]; if (typeof v === 'number') { any = true; n += v; } } return any ? n : null; };
      const markets = (a.markets ?? '').toUpperCase().split(/[\/,\s]+/).filter((m) => /^[A-Z]{2}$/.test(m));
      const targets = this.q.listAccountTargets(a.id);
      const gmvTarget = targetValue(targets, 'gmv_target_month');
      const mtd = this.gmvMonthToDate(a.id, now);
      const d = new Date(now); const day = d.getUTCDate(); const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      const samplesTarget = targetValue(targets, 'samples_per_week'); const samplesWeek = sumMetric('samples_week');
      const elapsed = Math.max(1, Math.min(7, Math.ceil((now - startOfWeek(now)) / 86400000)));
      const spend = targetValue(targets, 'gmv_max_spend_actual_week'); const gmvMaxGmv = targetValue(targets, 'gmv_max_gmv_actual_week'); const minRoi = targetValue(targets, 'gmv_max_min_roi');
      const sev = (x: 'crit' | 'warn' | 'info') => mine.filter((f) => f.severity === x).length;
      return {
        id: a.id, name: a.name, markets: a.markets, am_name: a.am_name,
        open: mine.length, crit: sev('crit'), warn: sev('warn'), info: sev('info'),
        risk: assessments.get(a.id)?.risk ?? null,
        shops: shops.length,
        gmv_7d: sumMetric('gmv_7d'), gmv_prev_7d: sumMetric('gmv_prev_7d'), currency: currencyForMarket(shops[0]?.market ?? markets[0] ?? ''),
        gmv_pace: gmvTarget && mtd !== null ? mtd / ((gmvTarget * day) / days) : null,
        samples_pace: samplesTarget && samplesWeek !== null ? samplesWeek / ((samplesTarget * elapsed) / 7) : null,
        roi_pace: minRoi && spend && gmvMaxGmv !== null ? (gmvMaxGmv / spend) / minRoi : null,
        last_pull_at: myPulls.map((p) => p.pulled_at).sort().pop() ?? null,
      } satisfies MonitorAccountRow & { _t?: typeof t };
    });
  }

  accountOverview(accountId: number, rules: MonitorRule[], now = Date.now()): AccountOverview | null {
    const account = this.q.getAccount(accountId);
    if (!account) return null;
    const t = this.thresholds();
    const shops = this.q.listTtsShops().filter((sh) => sh.account_id === accountId);
    const pulls = this.q.latestHealthPulls('tts').filter((p) => shops.some((sh) => sh.id === p.shop_id));
    const markets = (account.markets ?? '').toUpperCase().split(/[\/,\s]+/).filter((m) => /^[A-Z]{2}$/.test(m));
    const currency = currencyForMarket(shops[0]?.market ?? markets[0] ?? '');
    const scopes = this.scopeStatus();
    const live = (scope: TtsScope) => scope === 'none' || pulls.some((p) => (p.rows as unknown as Partial<TtsRows>).scopes?.[scope]?.ok);
    const flags = this.q.listFlags(false).filter((f) => f.account_id === accountId);
    const resolved = this.q.listFlagsBetween(new Date(now - 14 * 86400000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)).filter((f) => f.account_id === accountId && f.resolved_at);
    const targets = this.q.listAccountTargets(accountId);
    const tv = (k: Parameters<typeof targetValue>[1]) => targetValue(targets, k);

    // Daily series summed over the account's shops.
    const byDate = new Map<string, AccountOverview['series'][number]>();
    for (const p of pulls) {
      const rows = p.rows as unknown as Partial<TtsRows>;
      if (!rows.scopes?.analytics?.ok) continue;
      for (const d of rows.analytics ?? []) {
        const cur = byDate.get(d.date) ?? { date: d.date, gmv: 0, orders: 0, visitors: 0, video_gmv: 0, live_gmv: 0, card_gmv: 0, ads_gmv: null };
        cur.gmv += d.gmv; cur.orders += d.orders; cur.visitors += d.visitors; cur.video_gmv += d.video_gmv; cur.live_gmv += d.live_gmv; cur.card_gmv += d.card_gmv;
        if (d.ads_gmv !== null) cur.ads_gmv = (cur.ads_gmv ?? 0) + d.ads_gmv;
        byDate.set(d.date, cur);
      }
    }
    const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const sumM = (k: string) => { let any = false; let n = 0; for (const p of pulls) { const v = p.metrics[k]; if (typeof v === 'number') { any = true; n += v; } } return any ? n : null; };
    const avgM = (k: string) => { const vals = pulls.map((p) => p.metrics[k]).filter((v): v is number => typeof v === 'number'); return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; };
    const missing = (scope: TtsScope) => { const st = scopes.find((s) => s.scope === scope); return st?.state === 'denied' ? `Needs the ${SCOPE_LABELS[scope]} scope on the app` : st?.state === 'error' ? `${SCOPE_LABELS[scope]} pull failed (see Rules & API coverage)` : shops.length ? `Not pulled yet (${SCOPE_LABELS[scope]})` : 'No TikTok shop authorised for this account'; };
    const state = (value: number | null, target: number | null, direction: 'higher' | 'lower'): AccountKpi['state'] => {
      if (value === null || target === null) return null;
      const behind = direction === 'higher' ? (target > 0 ? 1 - value / target : 0) : (target > 0 ? value / target - 1 : value > target ? 1 : 0);
      return behind <= 0 ? 'good' : behind * 100 <= t.target_behind_pct ? 'warn' : 'crit';
    };
    const kpi = (key: string, label: string, value: number | null, target: number | null, previous: number | null, unit: AccountKpi['unit'], direction: AccountKpi['direction'], scope: TtsScope, note: string | null = null): AccountKpi => ({ key, label, value, target, previous, unit, direction, state: state(value, target, direction), note: value === null ? (note ?? (scope === 'none' ? null : missing(scope))) : note });

    const d = new Date(now); const day = d.getUTCDate(); const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const mtd = this.gmvMonthToDate(accountId, now);
    const gmvTarget = tv('gmv_target_month');
    const elapsed = Math.max(1, Math.min(7, Math.ceil((now - startOfWeek(now)) / 86400000)));
    const samplesTarget = tv('samples_per_week');
    const spend = tv('gmv_max_spend_actual_week'); const gmvMaxGmv = tv('gmv_max_gmv_actual_week');
    const roi = spend && gmvMaxGmv !== null ? gmvMaxGmv / spend : null;
    const ana = live('analytics');
    const kpis: AccountKpi[] = [
      kpi('gmv_7d', 'GMV last 7 days', ana ? sumM('gmv_7d') : null, null, sumM('gmv_prev_7d'), 'money', 'higher', 'analytics'),
      kpi('gmv_mtd', 'GMV month to date', mtd, gmvTarget !== null ? Math.round((gmvTarget * day) / daysInMonth) : null, null, 'money', 'higher', 'analytics', gmvTarget === null && mtd !== null ? 'No monthly GMV target set' : null),
      kpi('orders_7d', 'Orders last 7 days', ana ? sumM('orders_7d_analytics') : null, null, ana ? sumM('orders_prev_7d_analytics') : null, 'count', 'higher', 'analytics'),
      kpi('visitors', 'Visitors a day', ana ? avgM('visitors_7d') : null, null, avgM('visitors_prev_7d'), 'count', 'higher', 'analytics'),
      kpi('conversion', 'Conversion rate', ana ? avgM('conversion_7d') : null, null, avgM('conversion_prev_7d'), 'pct', 'higher', 'analytics'),
      kpi('samples_week', 'Samples approved this week', live('affiliate_seller') ? sumM('samples_week') : null, samplesTarget !== null ? Math.round((samplesTarget * elapsed) / 7) : null, null, 'count', 'higher', 'affiliate_seller', samplesTarget === null && live('affiliate_seller') ? 'No weekly samples target set' : null),
      kpi('samples_pending', 'Sample requests waiting', live('affiliate_seller') ? sumM('samples_pending') : null, 0, null, 'count', 'lower', 'affiliate_seller'),
      kpi('gmv_max_spend', 'GMV Max spend this week', spend, tv('gmv_max_weekly_spend'), null, 'money', 'lower', 'none', spend === null ? 'Typed in weekly on the Targets tab until the TikTok Ads API is connected' : null),
      kpi('gmv_max_roi', 'GMV Max ROI this week', roi, tv('gmv_max_min_roi'), null, 'ratio', 'higher', 'none', roi === null ? 'Needs this week\'s spend and GMV on the Targets tab' : null),
      kpi('ship_late', 'Orders past ship-by', live('order') ? sumM('ship_sla_breached') : null, 0, null, 'count', 'lower', 'order'),
      kpi('returns_waiting', 'Returns waiting on us', live('return_refund') ? sumM('returns_waiting') : null, 0, null, 'count', 'lower', 'return_refund'),
      kpi('oos', 'Live SKUs out of stock', live('product') ? sumM('out_of_stock_skus') : null, 0, null, 'count', 'lower', 'product'),
      kpi('cs_response', 'CS answered within 24h', live('customer_service') ? avgM('cs_response_pct') : null, t.cs_response_pct_min, null, 'pct', 'higher', 'customer_service'),
      kpi('shop_score', 'Shop performance score', null, null, null, 'ratio', 'higher', 'none', 'Not available through the API: Seller Center only'),
    ];

    // Checklist walk-through: every section of the AM checklist, with the rules that cover it and what they found.
    const sections: AccountSection[] = [];
    const sectionRules = rules.filter((r) => r.section && r.source !== 'windsor' && r.source !== 'cruva');
    const seen = new Set<string>();
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z]/g, '');
    const manualNotes: Record<string, string[]> = {
      [SECTIONS.homepage]: ['The to-do tiles come from the Orders, Products and CS rules below; the health banner is Seller Center only'],
      [SECTIONS.growth]: ['Missions and incentives are Seller Center only (no API)'],
      [SECTIONS.live]: ['Scheduled lives and removed videos are Seller Center only; LIVE and video GMV come from Analytics'],
      [SECTIONS.marketing]: ['GMV Max spend and ROI are typed in weekly until the TikTok Ads API is connected', 'Platform campaign registrations are typed in under Campaigns (no API)'],
      [SECTIONS.health]: ['Shop score, violations, points and security alerts are Seller Center only (no API)'],
      [SECTIONS.affiliate]: ['Videos posted per creator and creator GMV need the Affiliate (seller) scope; open-collaboration plans are Seller Center only'],
    };
    for (const item of CHECKLIST_TEMPLATE) {
      if (seen.has(item.section) || item.section === 'Cruva') continue;
      seen.add(item.section);
      const covering = sectionRules.filter((r) => norm(r.section ?? '') === norm(item.section)).map((r) => ({ code: r.code, title: r.title, scope: r.scope ?? 'none', available: live(r.scope ?? 'none'), enabled: r.enabled }));
      const myFlags = flags.filter((f) => covering.some((r) => r.code === f.code));
      const miss = [...new Set(covering.filter((r) => !r.available).map((r) => missing(r.scope)))];
      const notes = manualNotes[item.section] ?? [];
      const st: AccountSection['state'] = myFlags.some((f) => f.severity === 'crit') ? 'crit' : myFlags.some((f) => f.severity === 'warn') ? 'warn' : covering.some((r) => r.available && r.enabled) ? 'good' : covering.length ? 'nodata' : 'manual';
      sections.push({ section: item.section, guidance: item.guidance, state: st, flags: myFlags, rules: covering, missing: [...miss, ...notes] });
    }
    const covered = new Set(sections.flatMap((s) => s.flags.map((f) => f.id)));
    const other = flags.filter((f) => !covered.has(f.id));
    if (other.length) sections.push({ section: 'Other', guidance: null, state: other.some((f) => f.severity === 'crit') ? 'crit' : other.some((f) => f.severity === 'warn') ? 'warn' : 'good', flags: other, rules: [], missing: [] });

    return {
      account,
      shops: shops.map((sh) => { const p = pulls.find((x) => x.shop_id === sh.id); return { id: sh.id, name: sh.name, region: sh.region, market: sh.market, token_ok: sh.token_ok, last_pull_at: p?.pulled_at ?? null, pull_ok: p?.ok ?? false, pull_error: p?.error ?? null }; }),
      currency,
      kpis,
      series,
      sections,
      flags,
      resolved_14d: resolved,
      targets,
      sku_prices: this.q.listSkuPrices(accountId),
      campaigns: this.q.listAccountCampaigns(accountId),
      assessment: this.q.latestAssessments().find((a) => a.account_id === accountId) ?? null,
    };
  }

  aiFlags(enabled: Set<string>, now = Date.now()): Found[] {
    const out: Found[] = [];
    const cutoff = new Date(now - 2 * 86400000).toISOString().slice(0, 10);
    for (const a of this.q.latestAssessments()) {
      if (a.assess_date < cutoff || a.risk === 'green') continue;
      const code = a.risk === 'red' ? 'ai_risk_red' : 'ai_risk_amber';
      if (!enabled.has(code)) continue;
      out.push({ account_id: a.account_id, shop_id: null, code, severity: a.risk === 'red' ? 'crit' : 'warn', message: `${a.account_name ?? 'Account'}: ${a.summary}`, detail: `Action: ${a.action}${a.watch.length ? ` · Watch: ${a.watch.join(', ')}` : ''}` });
    }
    return out;
  }

  /** Every rule code the in-process scan owns (so the scan may resolve them); routine findings are left to the next ingest. */
  ownedCodes(): string[] {
    return [...WINDSOR_RULES, ...ALL_TTS_RULES, ...AI_RULES].map((r) => r.code);
  }

  // ---- What the AI (and the routine) sees per account ----

  accountContext(account: Account, now = Date.now()): Record<string, unknown> {
    const shops = this.q.listShops().filter((s) => s.account_id === account.id);
    const wPulls = new Map(this.q.latestHealthPulls('windsor').map((p) => [p.shop_id, p]));
    const cPulls = new Map(this.q.latestHealthPulls('cruva').map((p) => [p.shop_id, p]));
    const trend = (shopId: string, source: 'windsor' | 'cruva') => this.q.healthMetricsHistory(shopId, source, 14).map((h) => ({ date: h.pull_date, ...pick(h.metrics, source === 'windsor' ? ['orders_7d', 'gmv_7d', 'cancel_rate_7d', 'awaiting_shipment', 'ship_sla_breached', 'out_of_stock_skus', 'low_stock_skus', 'active_products', 'unsettled_old_amount'] : ['sps', 'affiliate_gmv_7d', 'total_gmv_7d', 'dms_sent_7d', 'samples_approved_7d', 'samples_pending_review', 'content_pending', 'automations_active']) }));
    const ttsShops = this.q.listTtsShops().filter((sh) => sh.account_id === account.id);
    const tPulls = new Map(this.q.latestHealthPulls('tts').map((p) => [p.shop_id, p]));
    const flags = this.q.listFlags(false).filter((f) => f.account_id === account.id).map((f) => ({ code: f.code, severity: f.severity, message: f.message, detail: f.detail, since: f.first_seen_at, acknowledged: Boolean(f.acknowledged_at) }));
    const recent = this.q.listFlagsBetween(new Date(now - 14 * 86400000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)).filter((f) => f.account_id === account.id && f.resolved_at).map((f) => ({ code: f.code, message: f.message, opened: f.first_seen_at.slice(0, 10), resolved: f.resolved_at!.slice(0, 10) }));
    const checks = this.q.listChecksBetween(new Date(now - 7 * 86400000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)).filter((c) => c.account_id === account.id);
    const conversations = this.q.listConversations({ accountId: account.id }).filter((c) => c.needs_reply);
    const gmv = this.q.listGmvBetween(new Date(now - 28 * 86400000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)).filter((r) => shops.some((s) => s.shop_id === r.shop_id));
    const sumBetween = (from: number, to: number) => gmv.filter((r) => { const d = Date.parse(r.date + 'T12:00:00Z'); return d >= now - from * 86400000 && d < now - to * 86400000; }).reduce((n, r) => n + r.total_gmv, 0);
    return {
      account: { id: account.id, name: account.name, markets: account.markets, am: account.am_name, aa: account.aa_name, notes: account.notes },
      shops: shops.map((s) => ({ shop_id: s.shop_id, shop_name: s.shop_name, source: s.source, currency: s.currency, latest: (s.source === 'windsor' ? wPulls : cPulls).get(s.shop_id)?.metrics ?? null, latest_date: (s.source === 'windsor' ? wPulls : cPulls).get(s.shop_id)?.pull_date ?? null, trend: trend(s.shop_id, s.source) })),
      tiktok_shops: ttsShops.map((sh) => ({ shop_id: sh.id, shop_name: sh.name, market: sh.market, latest: tPulls.get(sh.id)?.metrics ?? null, latest_date: tPulls.get(sh.id)?.pull_date ?? null, scopes: (tPulls.get(sh.id)?.rows as unknown as Partial<TtsRows> | undefined)?.scopes ?? {}, trend: this.q.healthMetricsHistory(sh.id, 'tts', 14).map((h) => ({ date: h.pull_date, ...pick(h.metrics, ['gmv_7d', 'orders_7d', 'visitors_7d', 'conversion_7d', 'awaiting_shipment', 'ship_sla_breached', 'out_of_stock_skus', 'returns_waiting', 'samples_week', 'samples_pending', 'cs_response_pct']) })) })),
      targets: this.q.listAccountTargets(account.id),
      gmv: { last_7d: Math.round(sumBetween(7, 0)), prev_7d: Math.round(sumBetween(14, 7)), last_28d: Math.round(sumBetween(28, 0)) },
      open_flags: flags,
      resolved_last_14d: recent,
      checklist_last_7d: { days: checks.length, complete: checks.filter((c) => c.combined_complete).length },
      inbox_waiting: conversations.length,
      assessments: this.q.listAssessments(account.id, 7).map((a) => ({ date: a.assess_date, risk: a.risk, summary: a.summary, action: a.action })),
    };
  }

  /** The routine's context: every enabled account with its shops and what the dashboard already knows. */
  routineContext(): Record<string, unknown> {
    const accounts = this.q.listAccounts().filter((a) => a.enabled);
    return {
      today: this.today(),
      timezone: this.q.getSetting('check_timezone', 'Europe/Madrid'),
      thresholds: this.thresholds(),
      metric_keys: [...CRUVA_METRIC_KEYS],
      accounts: accounts.map((a) => this.accountContext(a)),
    };
  }

  // ---- AI review ----

  async review(accountId?: number): Promise<{ reviewed: number; errors: string[] }> {
    const llm = this.llm;
    if (!llm) return { reviewed: 0, errors: ['ANTHROPIC_API_KEY is not set; the daily routine can post assessments instead'] };
    if (this.reviewing) return { reviewed: 0, errors: ['A review is already running'] };
    this.reviewing = true;
    const errors: string[] = [];
    let reviewed = 0;
    const today = this.today();
    try {
      const accounts = this.q.listAccounts().filter((a) => a.enabled && (accountId === undefined || a.id === accountId));
      for (const a of accounts) {
        const ctx = this.accountContext(a);
        const hasData = (ctx.shops as { latest: unknown }[]).some((s) => s.latest) || (ctx.open_flags as unknown[]).length > 0;
        if (!hasData) continue;
        try {
          const text = await llm(REVIEW_SYSTEM, `Today: ${today}\n\n${JSON.stringify(ctx, null, 1).slice(0, 60000)}\n\nWrite the JSON now.`);
          const parsed = parseAssessment(text);
          this.q.upsertAssessment({ account_id: a.id, assess_date: today, source: 'ai', ...parsed });
          reviewed += 1;
        } catch (err) {
          errors.push(`${a.name}: ${(err as Error).message}`);
        }
      }
      this.q.setSetting('health_last_review_at', new Date().toISOString());
      this.q.setSetting('health_last_review_error', errors.join('; ').slice(0, 800));
      liveEvents.emitUpdate({ kind: 'monitor' });
      return { reviewed, errors };
    } finally {
      this.reviewing = false;
    }
  }

  // ---- Ingest from the daily routine ----

  ingest(payload: IngestPayload): { accounts: number; shops: number; findings: number; assessments: number; errors: string[]; account_ids: number[] } {
    const errors: string[] = [];
    const all = this.q.listAccounts();
    const cruvaShops = this.q.listShops('cruva');
    const today = this.today();
    const source = payload.source === 'manual' ? 'manual' : 'routine';
    let shops = 0; let findings = 0; let assessments = 0;
    const accountIds: number[] = [];
    const found: Found[] = [];
    for (const entry of payload.accounts ?? []) {
      const key = entry.account;
      const account = typeof key === 'number' ? all.find((a) => a.id === key) : all.find((a) => a.name.toLowerCase() === String(key ?? '').trim().toLowerCase());
      if (!account) { errors.push(`Unknown account "${String(key)}"`); continue; }
      accountIds.push(account.id);
      for (const s of entry.shops ?? []) {
        const shopId = String(s.shop_id ?? '').trim();
        if (!shopId) { errors.push(`${account.name}: a shop without shop_id`); continue; }
        const known = cruvaShops.find((x) => x.shop_id === shopId);
        if (known && known.account_id !== account.id) { errors.push(`${account.name}: Cruva shop ${shopId} is linked to another account`); continue; }
        if (!known) this.q.addShop(account.id, shopId, s.shop_name?.trim() || shopId, 'EUR', 'cruva');
        const metrics = parseCruvaMetrics(s.metrics ?? {});
        this.q.upsertHealthPull({ shop_id: shopId, account_id: account.id, source: 'cruva', pull_date: today, ok: true, metrics: metrics as Record<string, unknown> });
        shops += 1;
      }
      for (const f of entry.findings ?? []) {
        const message = String(f.message ?? '').trim();
        if (!message) continue;
        const sev = f.severity === 'crit' || f.severity === 'warn' || f.severity === 'info' ? f.severity : 'warn';
        found.push({ account_id: account.id, shop_id: f.shop_id ? String(f.shop_id) : null, code: CUSTOM_CODE, severity: sev, message: `${account.name}: ${message}`, detail: f.detail ? String(f.detail).slice(0, 600) : null });
        findings += 1;
      }
      if (entry.assessment) {
        try {
          const parsed = parseAssessment(JSON.stringify(entry.assessment));
          this.q.upsertAssessment({ account_id: account.id, assess_date: today, source, ...parsed });
          assessments += 1;
        } catch (err) { errors.push(`${account.name}: assessment rejected: ${(err as Error).message}`); }
      }
    }
    // Routine findings replace the previous ones for the accounts in this payload; other accounts keep theirs.
    if (accountIds.length) this.q.applyScan(found, { account_ids: accountIds, codes: [CUSTOM_CODE] });
    this.q.setSetting('health_last_ingest_at', new Date().toISOString());
    liveEvents.emitUpdate({ kind: 'monitor' });
    return { accounts: accountIds.length, shops, findings, assessments, errors, account_ids: accountIds };
  }

  data(): HealthSummary {
    const accounts = new Map(this.q.listAccounts().map((a) => [a.id, a.name]));
    const shopNames = new Map(this.q.listShops().map((s) => [s.shop_id, s.shop_name]));
    const summarise = (p: ReturnType<Queries['latestHealthPulls']>[number]) => ({ shop_id: p.shop_id, shop_name: shopNames.get(p.shop_id) ?? p.shop_id, account_id: p.account_id, account_name: p.account_id ? accounts.get(p.account_id) ?? null : null, source: p.source, pull_date: p.pull_date, pulled_at: p.pulled_at, ok: p.ok, error: p.error, metrics: p.metrics as Record<string, number | string | null> });
    return {
      windsor_configured: this.client.configured,
      llm_configured: Boolean(this.llm),
      ingest_configured: Boolean(config.ingestToken),
      last_pull_at: this.q.getSetting('health_last_pull_at', '') || null,
      last_pull_error: this.q.getSetting('health_last_pull_error', '') || null,
      last_review_at: this.q.getSetting('health_last_review_at', '') || null,
      last_review_error: this.q.getSetting('health_last_review_error', '') || null,
      last_ingest_at: this.q.getSetting('health_last_ingest_at', '') || null,
      pulling: this.pulling,
      reviewing: this.reviewing,
      thresholds: this.thresholds(),
      tts_last_pull_at: this.q.getSetting('tts_last_pull_at', '') || null,
      tts_last_pull_error: this.q.getSetting('tts_last_pull_error', '') || null,
      pulling_tts: this.pullingTts,
      pulls: [...this.q.latestHealthPulls('tts'), ...this.q.latestHealthPulls('windsor')].map(summarise),
      assessments: this.q.latestAssessments(),
    };
  }
}

export const CUSTOM_RULE = { code: CUSTOM_CODE, title: 'Daily routine finding', description: 'Something a scheduled Claude routine posted to /api/flags/ingest that no fixed rule covers. Replaced on the next run.', severity: 'warn' as const, source: 'ai' as const, section: 'Account health', scope: 'none' as const };

function pick(m: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

export const REVIEW_SYSTEM = [
  'You are the daily account reviewer for Brightform, a TikTok Shop Partner agency. You get everything the dashboard knows about one client account: shop metrics from the TikTok Shop API (GMV by channel, traffic, orders and shipping SLAs, stock, returns, samples, CS, payouts), the targets the team set (samples a week, GMV, GMV Max spend and ROI, pricing), the open flags, what was resolved recently, checklist completion, inbox backlog and the last assessments.',
  'Judge the account like a careful senior account manager. Look for what the fixed rules cannot: combinations (stock out on the best seller while a promotion runs), trends over the 14-day history, a flag that has been open for days without being acknowledged, a metric that is fine today but heading somewhere. Do not repeat every flag; name the one or two things that matter most and why.',
  'Rating: "red" means someone must act today or the account loses money or standing; "amber" means watch it and act this week; "green" means nothing needs a person today.',
  'British English, plain, no hype, no exclamation marks, never invent numbers that are not in the input. Keep the summary to two or three sentences and the action to one concrete thing the AM does today, with the number that justifies it.',
  'Output JSON only: {"risk": "red" | "amber" | "green", "summary": "...", "action": "...", "watch": ["short item", "..."]} where watch lists up to three things to keep an eye on (may be empty).',
].join('\n');

export function parseAssessment(text: string): { risk: HealthAssessment['risk']; summary: string; action: string; watch: string[] } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON in the reply');
  const j = JSON.parse(text.slice(start, end + 1)) as { risk?: string; summary?: string; action?: string; watch?: unknown };
  const risk = j.risk === 'red' || j.risk === 'amber' || j.risk === 'green' ? j.risk : null;
  const summary = String(j.summary ?? '').trim();
  const action = String(j.action ?? '').trim();
  if (!risk || !summary) throw new Error('reply is missing risk or summary');
  const watch = Array.isArray(j.watch) ? j.watch.map((w) => String(w).trim()).filter(Boolean).slice(0, 5) : [];
  return { risk, summary: summary.slice(0, 900), action: (action || 'Nothing today.').slice(0, 600), watch };
}
