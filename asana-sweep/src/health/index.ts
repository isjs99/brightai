import type { Queries } from '../db/queries.js';
import type { Account, HealthAssessment, HealthSummary, HealthThresholds } from '../sweep/types.js';
import { windsor, type WindsorClient } from '../gmv/windsor.js';
import { draftWithClaude } from '../inbox/llm.js';
import { config } from '../config.js';
import { todayIn } from '../checklist/checker.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';
import { AI_RULES, CRUVA_METRIC_KEYS, CRUVA_RULES, DEFAULT_THRESHOLDS, evaluateCruva, evaluateWindsor, parseCruvaMetrics, parseThresholds, WINDSOR_RULES, type Found, type WindsorRows } from './rules.js';

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

  constructor(private q: Queries, private deps: { windsor?: WindsorClient; llm?: ((system: string, user: string) => Promise<string>) | null } = {}) {}

  private get client(): WindsorClient { return this.deps.windsor ?? windsor; }

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

  cruvaFlags(enabled: Set<string>, now = Date.now()): Found[] {
    const t = this.thresholds();
    const out: Found[] = [];
    const linked = new Map(this.q.listShops('cruva').map((s) => [s.shop_id, s]));
    const pulls = new Map(this.q.latestHealthPulls('cruva').map((p) => [p.shop_id, p]));
    const cutoff = new Date(now - 2 * 86400000).toISOString().slice(0, 10);
    for (const [id, s] of linked) {
      const p = pulls.get(id);
      const ref = { shop_id: s.shop_id, shop_name: s.shop_name, account_id: s.account_id };
      if (!p) continue; // never posted: nothing to say yet (the Connections page shows the routine status)
      if (p.pull_date < cutoff) { out.push(...evaluateCruva(ref, {}, t, { enabled, stale: true })); continue; }
      const history = this.q.healthMetricsHistory(id, 'cruva', 14).filter((h) => h.pull_date < p.pull_date);
      const previous = history.length ? parseCruvaMetrics(history[history.length - 1].metrics) : null;
      out.push(...evaluateCruva(ref, parseCruvaMetrics(p.metrics), t, { enabled, previous }));
    }
    return out;
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
    return [...WINDSOR_RULES, ...CRUVA_RULES, ...AI_RULES].map((r) => r.code);
  }

  // ---- What the AI (and the routine) sees per account ----

  accountContext(account: Account, now = Date.now()): Record<string, unknown> {
    const shops = this.q.listShops().filter((s) => s.account_id === account.id);
    const wPulls = new Map(this.q.latestHealthPulls('windsor').map((p) => [p.shop_id, p]));
    const cPulls = new Map(this.q.latestHealthPulls('cruva').map((p) => [p.shop_id, p]));
    const trend = (shopId: string, source: 'windsor' | 'cruva') => this.q.healthMetricsHistory(shopId, source, 14).map((h) => ({ date: h.pull_date, ...pick(h.metrics, source === 'windsor' ? ['orders_7d', 'gmv_7d', 'cancel_rate_7d', 'awaiting_shipment', 'ship_sla_breached', 'out_of_stock_skus', 'low_stock_skus', 'active_products', 'unsettled_old_amount'] : ['sps', 'affiliate_gmv_7d', 'total_gmv_7d', 'dms_sent_7d', 'samples_approved_7d', 'samples_pending_review', 'content_pending', 'automations_active']) }));
    const flags = this.q.listFlags(false).filter((f) => f.account_id === account.id).map((f) => ({ code: f.code, severity: f.severity, message: f.message, detail: f.detail, since: f.first_seen_at, acknowledged: Boolean(f.acknowledged_at) }));
    const recent = this.q.listFlagsBetween(new Date(now - 14 * 86400000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)).filter((f) => f.account_id === account.id && f.resolved_at).map((f) => ({ code: f.code, message: f.message, opened: f.first_seen_at.slice(0, 10), resolved: f.resolved_at!.slice(0, 10) }));
    const checks = this.q.listChecksBetween(new Date(now - 7 * 86400000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)).filter((c) => c.account_id === account.id);
    const conversations = this.q.listConversations({ accountId: account.id }).filter((c) => c.needs_reply);
    const gmv = this.q.listGmvBetween(new Date(now - 28 * 86400000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)).filter((r) => shops.some((s) => s.shop_id === r.shop_id));
    const sumBetween = (from: number, to: number) => gmv.filter((r) => { const d = Date.parse(r.date + 'T12:00:00Z'); return d >= now - from * 86400000 && d < now - to * 86400000; }).reduce((n, r) => n + r.total_gmv, 0);
    return {
      account: { id: account.id, name: account.name, markets: account.markets, am: account.am_name, aa: account.aa_name, notes: account.notes },
      shops: shops.map((s) => ({ shop_id: s.shop_id, shop_name: s.shop_name, source: s.source, currency: s.currency, latest: (s.source === 'windsor' ? wPulls : cPulls).get(s.shop_id)?.metrics ?? null, latest_date: (s.source === 'windsor' ? wPulls : cPulls).get(s.shop_id)?.pull_date ?? null, trend: trend(s.shop_id, s.source) })),
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
      pulls: [...this.q.latestHealthPulls('windsor'), ...this.q.latestHealthPulls('cruva')].map(summarise),
      assessments: this.q.latestAssessments(),
    };
  }
}

export const CUSTOM_RULE = { code: CUSTOM_CODE, title: 'Daily routine finding', description: 'Something the daily Claude routine noticed in Cruva that no fixed rule covers. Replaced on the next run.', severity: 'warn' as const, source: 'cruva' as const, section: 'Cruva' };

function pick(m: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

export const REVIEW_SYSTEM = [
  'You are the daily account reviewer for Brightform, a TikTok Shop Partner agency. You get everything the dashboard knows about one client account: shop metrics from Windsor.ai (orders, shipping SLAs, stock, payouts, statements), creator metrics from Cruva (shop performance score, DMs, samples, affiliate GMV), the open flags, what was resolved recently, checklist completion, inbox backlog and the last assessments.',
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
