import type { Queries } from '../db/queries.js';
import type { MonitorData, MonitorFlag, MonitorRule } from '../sweep/types.js';
import { tts, type TtsClient } from '../tts/client.js';
import { shopCredentials } from '../tts/promotions.js';
import { todayIn } from '../checklist/checker.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Account monitor: a rolling scan of every managed account for the flags the team keeps
 * catching by hand. Dashboard rules read what the app already knows (checklists, inbox,
 * promotions, GMV, authorisations); TikTok rules call the Shop OpenAPI per authorised shop
 * (orders waiting to ship, order volume drop, returns, deactivated products, low stock).
 * Rules are toggled from the Monitor page; each rule's code is stable so flags dedupe.
 */

type Found = { account_id: number | null; shop_id: string | null; code: string; severity: MonitorFlag['severity']; message: string; detail?: string | null };

export const RULES: Omit<MonitorRule, 'enabled'>[] = [
  { code: 'checklist_incomplete', title: 'Daily checklist not done', description: 'The AM checklist for today is not complete after 14:00 in the account timezone.', severity: 'warn', source: 'asana' },
  { code: 'checklist_error', title: 'Checklist check failed', description: 'The last checklist check errored (Asana project missing, token rejected).', severity: 'warn', source: 'asana' },
  { code: 'inbox_unanswered', title: 'Buyer or creator waiting over 24h', description: 'A CS or affiliate conversation needs a reply and the last message is older than 24 hours.', severity: 'crit', source: 'dashboard' },
  { code: 'no_live_promotion', title: 'No live promotion', description: 'The account has no promotion live or scheduled to start within 7 days.', severity: 'info', source: 'dashboard' },
  { code: 'gmv_drop_wow', title: 'GMV down 30%+ week on week', description: 'Last 7 days of GMV is at least 30% below the 7 days before (Cruva sync).', severity: 'warn', source: 'cruva' },
  { code: 'gmv_stale', title: 'GMV data stale', description: 'No GMV rows synced for the account in the last 3 days.', severity: 'info', source: 'cruva' },
  { code: 'tts_auth_expiring', title: 'TikTok authorisation expiring', description: 'The shop refresh token expires within 7 days or is already invalid.', severity: 'crit', source: 'tts' },
  { code: 'tts_unshipped', title: 'Orders waiting to ship over 48h', description: 'Orders in AWAITING_SHIPMENT created more than 48 hours ago (platform SLA risk).', severity: 'crit', source: 'tts' },
  { code: 'tts_order_drop', title: 'Orders down 40%+ week on week', description: 'Order count in the last 7 days is at least 40% below the previous 7 days.', severity: 'warn', source: 'tts' },
  { code: 'tts_cancellations', title: 'High cancellation rate', description: 'More than 15% of orders in the last 7 days were cancelled.', severity: 'warn', source: 'tts' },
  { code: 'tts_returns', title: 'High return rate', description: 'Returns or refunds in the last 7 days exceed 12% of orders.', severity: 'warn', source: 'tts' },
  { code: 'tts_product_deactivated', title: 'Products deactivated by the platform', description: 'Products in PLATFORM_DEACTIVATED or FREEZE status.', severity: 'crit', source: 'tts' },
  { code: 'tts_low_stock', title: 'Low stock on active products', description: 'An active SKU has fewer than 10 units across warehouses.', severity: 'warn', source: 'tts' },
  { code: 'no_deal_terms', title: 'No commission terms recorded', description: 'The account has no commission percentage on file, so GMV bonus and MoR figures are guesses.', severity: 'info', source: 'dashboard' },
];

export class AccountMonitor {
  private scanning = false;
  private timer: NodeJS.Timeout | null = null;
  /** Called after every scan (the incident engine turns flags into Slack alerts). */
  afterScan: (() => Promise<void>) | null = null;

  constructor(private q: Queries, private client: TtsClient = tts) {}

  rules(): MonitorRule[] {
    const off = new Set(this.q.getSetting('monitor_rules_off', '').split(',').filter(Boolean));
    return RULES.map((r) => ({ ...r, enabled: !off.has(r.code) }));
  }

  setRule(code: string, enabled: boolean): void {
    const off = new Set(this.q.getSetting('monitor_rules_off', '').split(',').filter(Boolean));
    if (enabled) off.delete(code); else off.add(code);
    this.q.setSetting('monitor_rules_off', [...off].join(','));
  }

  get intervalMinutes(): number {
    return Math.max(5, Number(this.q.getSetting('monitor_interval_minutes', '15')) || 15);
  }

  data(): MonitorData {
    const flags = this.q.listFlags(false);
    const accounts = this.q.listAccounts().map((a) => {
      const mine = flags.filter((f) => f.account_id === a.id);
      return { id: a.id, name: a.name, open: mine.length, crit: mine.filter((f) => f.severity === 'crit').length, warn: mine.filter((f) => f.severity === 'warn').length };
    });
    return { flags, rules: this.rules(), accounts, last_scan_at: this.q.getSetting('monitor_last_scan_at', '') || null, last_scan_error: this.q.getSetting('monitor_last_scan_error', '') || null, scanning: this.scanning, interval_minutes: this.intervalMinutes, tts_configured: this.client.configured };
  }

  start(): void {
    this.stop();
    if (this.q.getSetting('monitor_enabled', '1') !== '1') return;
    this.timer = setInterval(() => void this.scan(), this.intervalMinutes * 60000);
    setTimeout(() => void this.scan(), 20000);
    log.info(`Account monitor: scanning every ${this.intervalMinutes} min`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scan(): Promise<{ opened: number; resolved: number; found: number }> {
    if (this.scanning) return { opened: 0, resolved: 0, found: 0 };
    this.scanning = true;
    const found: Found[] = [];
    const enabled = new Set(this.rules().filter((r) => r.enabled).map((r) => r.code));
    try {
      found.push(...this.dashboardRules(enabled));
      found.push(...(await this.ttsRules(enabled)));
      const r = this.q.applyScan(found);
      this.q.setSetting('monitor_last_scan_at', new Date().toISOString());
      this.q.setSetting('monitor_last_scan_error', '');
      if (r.opened || r.resolved) log.info(`Account monitor: ${found.length} flag(s), ${r.opened} new, ${r.resolved} resolved`);
      liveEvents.emitUpdate({ kind: 'monitor' });
      if (this.afterScan) await this.afterScan().catch((err) => log.warn(`Incident pass failed: ${(err as Error).message}`));
      return { ...r, found: found.length };
    } catch (err) {
      this.q.setSetting('monitor_last_scan_error', (err as Error).message);
      log.error(`Account monitor scan failed: ${(err as Error).message}`);
      return { opened: 0, resolved: 0, found: found.length };
    } finally {
      this.scanning = false;
    }
  }

  /** Rules that only need what the dashboard already stores. */
  dashboardRules(enabled: Set<string>, now = Date.now()): Found[] {
    const out: Found[] = [];
    const accounts = this.q.listAccounts().filter((a) => a.enabled);
    const tz = this.q.getSetting('check_timezone', 'Europe/Madrid');
    const today = todayIn(tz);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date(now)));
    const checks = this.q.listChecksForDate(today);
    const conversations = this.q.listConversations({});
    const promotions = this.q.listPromotions();
    const shops = this.q.listShops();
    const gmvRows = this.q.listGmvBetween(new Date(now - 15 * 86400000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10));
    const ttsShops = this.q.listTtsShops();

    for (const a of accounts) {
      const check = checks.filter((c) => c.account_id === a.id).sort((x, y) => y.checked_at.localeCompare(x.checked_at))[0];
      if (enabled.has('checklist_incomplete') && hour >= 14 && check && !check.combined_complete && check.status !== 'error') out.push({ account_id: a.id, shop_id: null, code: 'checklist_incomplete', severity: 'warn', message: `${a.name}: checklist ${check.am_done}/${check.am_total} AM and ${check.aa_done}/${check.aa_total} AA items done today` });
      if (enabled.has('checklist_error') && check?.status === 'error') out.push({ account_id: a.id, shop_id: null, code: 'checklist_error', severity: 'warn', message: `${a.name}: checklist check failed`, detail: check.error_message });
      if (enabled.has('inbox_unanswered')) {
        const stale = conversations.filter((c) => c.account_id === a.id && c.needs_reply && c.last_message_at && now - Date.parse(c.last_message_at) > 24 * 3600000);
        if (stale.length) out.push({ account_id: a.id, shop_id: null, code: 'inbox_unanswered', severity: 'crit', message: `${a.name}: ${stale.length} conversation(s) waiting over 24h (${stale.filter((c) => c.channel === 'cs').length} CS, ${stale.filter((c) => c.channel === 'affiliate').length} affiliate)` });
      }
      if (enabled.has('no_live_promotion')) {
        const live = promotions.some((p) => p.targets.some((t) => t.account_id === a.id && t.status !== 'error') && Date.parse(p.end_at) > now && Date.parse(p.begin_at) < now + 7 * 86400000);
        if (!live) out.push({ account_id: a.id, shop_id: null, code: 'no_live_promotion', severity: 'info', message: `${a.name}: no promotion live or starting within 7 days` });
      }
      const myShops = shops.filter((s) => s.account_id === a.id).map((s) => s.shop_id);
      if (myShops.length) {
        const mine = gmvRows.filter((r) => myShops.includes(r.shop_id));
        const cut = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
        const prevCut = new Date(now - 14 * 86400000).toISOString().slice(0, 10);
        const last7 = mine.filter((r) => r.date >= cut).reduce((s, r) => s + r.total_gmv, 0);
        const prev7 = mine.filter((r) => r.date >= prevCut && r.date < cut).reduce((s, r) => s + r.total_gmv, 0);
        if (enabled.has('gmv_drop_wow') && prev7 > 0 && last7 < prev7 * 0.7) out.push({ account_id: a.id, shop_id: null, code: 'gmv_drop_wow', severity: 'warn', message: `${a.name}: GMV ${Math.round(last7).toLocaleString('en-GB')} last 7 days vs ${Math.round(prev7).toLocaleString('en-GB')} the week before (${Math.round((1 - last7 / prev7) * 100)}% down)` });
        const latest = mine.map((r) => r.date).sort().pop();
        if (enabled.has('gmv_stale') && (!latest || latest < new Date(now - 3 * 86400000).toISOString().slice(0, 10))) out.push({ account_id: a.id, shop_id: null, code: 'gmv_stale', severity: 'info', message: `${a.name}: no GMV rows synced since ${latest ?? 'ever'}` });
      }
      if (enabled.has('no_deal_terms') && a.commission_pct === null) out.push({ account_id: a.id, shop_id: null, code: 'no_deal_terms', severity: 'info', message: `${a.name}: no commission terms recorded` });
      if (enabled.has('tts_auth_expiring')) {
        for (const s of ttsShops.filter((x) => x.account_id === a.id)) {
          const daysLeft = s.refresh_expires_at ? (s.refresh_expires_at * 1000 - now) / 86400000 : null;
          if (!s.token_ok || (daysLeft !== null && daysLeft < 7)) out.push({ account_id: a.id, shop_id: s.id, code: 'tts_auth_expiring', severity: 'crit', message: `${a.name}: TikTok authorisation for ${s.name} ${!s.token_ok ? 'is invalid' : `expires in ${Math.max(0, Math.round(daysLeft ?? 0))} day(s)`}` });
        }
      }
    }
    return out;
  }

  /** Rules that call the TikTok Shop OpenAPI, one authorised shop at a time. Failures per shop are logged, not fatal. */
  async ttsRules(enabled: Set<string>, now = Date.now()): Promise<Found[]> {
    const out: Found[] = [];
    const wanted = ['tts_unshipped', 'tts_order_drop', 'tts_cancellations', 'tts_returns', 'tts_product_deactivated', 'tts_low_stock'].filter((c) => enabled.has(c));
    if (!wanted.length || !this.client.configured) return out;
    for (const shop of this.q.listTtsShops().filter((s) => s.token_ok)) {
      const label = shop.name;
      try {
        const creds = await shopCredentials(this.q, shop.id, this.client);
        const sec = (d: number) => Math.floor(d / 1000);
        const orders = async (ge: number, lt: number, status?: string) => {
          const all: Record<string, unknown>[] = [];
          let token = '';
          for (let page = 0; page < 4; page += 1) {
            const body: Record<string, unknown> = { create_time_ge: sec(ge), create_time_lt: sec(lt) };
            if (status) body.order_status = status;
            const r = await this.client.call<{ orders?: Record<string, unknown>[]; next_page_token?: string }>('POST', '/order/202309/orders/search', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '50', sort_field: 'create_time', sort_order: 'DESC', ...(token ? { page_token: token } : {}) }, body });
            all.push(...(r.orders ?? []));
            token = r.next_page_token ?? '';
            if (!token) break;
          }
          return all;
        };
        const needOrders = wanted.some((c) => ['tts_order_drop', 'tts_cancellations', 'tts_returns'].includes(c));
        const last7 = needOrders ? await orders(now - 7 * 86400000, now) : [];
        if (enabled.has('tts_unshipped')) {
          const waiting = await orders(now - 30 * 86400000, now - 48 * 3600000, 'AWAITING_SHIPMENT');
          if (waiting.length) out.push({ account_id: shop.account_id, shop_id: shop.id, code: 'tts_unshipped', severity: 'crit', message: `${label}: ${waiting.length} order(s) waiting to ship for over 48h`, detail: waiting.slice(0, 10).map((o) => String(o.id ?? '')).join(', ') });
        }
        if (enabled.has('tts_order_drop')) {
          const prev7 = await orders(now - 14 * 86400000, now - 7 * 86400000);
          if (prev7.length >= 20 && last7.length < prev7.length * 0.6) out.push({ account_id: shop.account_id, shop_id: shop.id, code: 'tts_order_drop', severity: 'warn', message: `${label}: ${last7.length} orders in the last 7 days vs ${prev7.length} the week before` });
        }
        if (enabled.has('tts_cancellations') && last7.length >= 20) {
          const cancelled = last7.filter((o) => String(o.status ?? '').toUpperCase() === 'CANCELLED').length;
          if (cancelled / last7.length > 0.15) out.push({ account_id: shop.account_id, shop_id: shop.id, code: 'tts_cancellations', severity: 'warn', message: `${label}: ${cancelled} of ${last7.length} orders cancelled in the last 7 days (${Math.round((cancelled / last7.length) * 100)}%)` });
        }
        if (enabled.has('tts_returns') && last7.length >= 20) {
          const r = await this.client.call<{ return_orders?: unknown[]; total_count?: number }>('POST', '/return_refund/202309/returns/search', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '50' }, body: { create_time_ge: sec(now - 7 * 86400000), create_time_lt: sec(now) } });
          const returns = r.total_count ?? r.return_orders?.length ?? 0;
          if (returns / last7.length > 0.12) out.push({ account_id: shop.account_id, shop_id: shop.id, code: 'tts_returns', severity: 'warn', message: `${label}: ${returns} return(s) against ${last7.length} orders in the last 7 days (${Math.round((returns / last7.length) * 100)}%)` });
        }
        if (enabled.has('tts_product_deactivated') || enabled.has('tts_low_stock')) {
          const products: { id: string; title: string; status: string; skus?: { id: string; seller_sku?: string; inventory?: { quantity?: number }[] }[] }[] = [];
          let token = '';
          for (let page = 0; page < 4; page += 1) {
            const r = await this.client.call<{ products?: typeof products; next_page_token?: string }>('POST', '/product/202309/products/search', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { page_size: '100', ...(token ? { page_token: token } : {}) }, body: {} });
            products.push(...(r.products ?? []));
            token = r.next_page_token ?? '';
            if (!token) break;
          }
          if (enabled.has('tts_product_deactivated')) {
            const bad = products.filter((p) => /PLATFORM_DEACTIVATED|FREEZE/.test(p.status ?? ''));
            if (bad.length) out.push({ account_id: shop.account_id, shop_id: shop.id, code: 'tts_product_deactivated', severity: 'crit', message: `${label}: ${bad.length} product(s) deactivated or frozen by the platform`, detail: bad.slice(0, 8).map((p) => p.title).join(' · ') });
          }
          if (enabled.has('tts_low_stock')) {
            const low = products.filter((p) => p.status === 'ACTIVATE' || p.status === 'ACTIVATED').flatMap((p) => (p.skus ?? []).map((s) => ({ p, s, qty: (s.inventory ?? []).reduce((n, i) => n + (i.quantity ?? 0), 0) }))).filter((x) => x.qty < 10);
            if (low.length) out.push({ account_id: shop.account_id, shop_id: shop.id, code: 'tts_low_stock', severity: 'warn', message: `${label}: ${low.length} active SKU(s) under 10 units`, detail: low.slice(0, 8).map((x) => `${x.p.title}${x.s.seller_sku ? ` (${x.s.seller_sku})` : ''}: ${x.qty}`).join(' · ') });
          }
        }
      } catch (err) {
        log.warn(`Account monitor: ${label}: ${(err as Error).message}`);
      }
    }
    return out;
  }
}
