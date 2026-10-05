import type { Queries } from '../db/queries.js';
import type { MonitorData, MonitorFlag, MonitorRule } from '../sweep/types.js';
import { tts, type TtsClient, ttsAffiliate } from '../tts/client.js';
import { PlaybookEngine } from '../playbook/index.js';
import { todayIn } from '../checklist/checker.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';
import { CUSTOM_RULE, HealthEngine } from '../health/index.js';
import { HEALTH_RULES } from '../health/rules.js';
import { ALL_TTS_RULES } from '../health/tts-rules.js';

/**
 * Account monitor: a rolling scan of every managed account for the flags the team keeps
 * catching by hand. Dashboard rules read what the app already knows (checklists, inbox,
 * promotions, GMV, authorisations); TikTok rules call the Shop OpenAPI per authorised shop
 * (orders waiting to ship, order volume drop, returns, deactivated products, low stock).
 * Rules are toggled from the Monitor page; each rule's code is stable so flags dedupe.
 */

type Found = { account_id: number | null; shop_id: string | null; code: string; severity: MonitorFlag['severity']; message: string; detail?: string | null };

export const RULES: Omit<MonitorRule, 'enabled'>[] = [
  { code: 'checklist_incomplete', title: 'Daily checklist not done', description: 'The AM checklist for today is not complete after 14:00 in the account timezone.', severity: 'warn', source: 'checklist', section: 'Account health' },
  { code: 'checklist_error', title: 'Checklist check failed', description: 'The last checklist check errored.', severity: 'warn', source: 'checklist', section: 'Account health' },
  { code: 'inbox_unanswered', title: 'Buyer or creator waiting over 24h', description: 'A CS or affiliate conversation needs a reply and the last message is older than 24 hours.', severity: 'crit', source: 'dashboard', section: 'CS / Returns / Aftercare' },
  { code: 'no_live_promotion', title: 'No live promotion', description: 'The account has no promotion live or scheduled to start within 7 days.', severity: 'info', source: 'dashboard', section: 'Marketing' },
  { code: 'gmv_drop_wow', title: 'GMV down 30%+ week on week', description: 'Last 7 days of GMV is at least 30% below the 7 days before (GMV sync; skipped for accounts with a TikTok shop, which the Analytics rule covers).', severity: 'warn', source: 'dashboard', section: 'Analytics' },
  { code: 'gmv_stale', title: 'GMV data stale', description: 'No GMV rows synced for the account in the last 3 days (skipped for accounts with a TikTok shop).', severity: 'info', source: 'dashboard', section: 'Analytics' },
  { code: 'tts_auth_expiring', title: 'TikTok authorisation expiring', description: 'The shop refresh token expires within 7 days or is already invalid.', severity: 'crit', source: 'tts', section: 'Account health' },
  { code: 'cruva_setup_gap', title: 'Cruva best practice gaps', description: 'A linked Cruva shop is missing one of the six lifecycle bots or has one paused (Accounts › Cruva).', severity: 'warn', source: 'cruva', section: 'Affiliate', scope: 'none' },
  { code: 'no_deal_terms', title: 'No commission terms recorded', description: 'The account has no commission percentage on file, so GMV bonus and MoR figures are guesses.', severity: 'info', source: 'dashboard', section: 'Finance' },
];

export class AccountMonitor {
  private scanning = false;
  private timer: NodeJS.Timeout | null = null;
  /** Called after every scan (the incident engine turns flags into Slack alerts). */
  afterScan: (() => Promise<void>) | null = null;
  /** The account health engine (Windsor pulls, Cruva metrics, AI review); its rules run inside every scan. */
  health: HealthEngine | null = null;

  constructor(private q: Queries, private client: TtsClient = tts) {}

  rules(): MonitorRule[] {
    const off = new Set(this.q.getSetting('monitor_rules_off', '').split(',').filter(Boolean));
    return [...RULES.map((r) => ({ ...r, scope: 'none' as const })), ...ALL_TTS_RULES, ...HEALTH_RULES.map((r) => ({ ...r, scope: 'none' as const })), CUSTOM_RULE].map((r) => ({ ...r, enabled: !off.has(r.code) }));
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
    const health = this.health ?? new HealthEngine(this.q);
    return { flags, rules: this.rules(), health: health.data(), accounts: health.accountRows(flags), scopes: health.scopeStatus(), targets: this.q.listAccountTargets(), last_scan_at: this.q.getSetting('monitor_last_scan_at', '') || null, last_scan_error: this.q.getSetting('monitor_last_scan_error', '') || null, scanning: this.scanning, interval_minutes: this.intervalMinutes, tts_configured: this.client.configured, tts_shops: this.q.listTtsShops().filter((s) => s.token_ok && s.account_id !== null).length, tts_affiliate_configured: ttsAffiliate.configured, tts_affiliate_shops: this.q.listTtsShops().filter((s) => s.account_id !== null && s.affiliate_token_ok).length };
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
      if (this.health) {
        // The TikTok pull runs inside every scan so the flags are never older than one interval.
        if (this.client.configured) await this.health.pullTikTok().catch((err) => log.warn(`TikTok pull: ${(err as Error).message}`));
        found.push(...this.health.ttsFlags(enabled));
        found.push(...this.health.targetFlags(enabled));
        found.push(...this.health.windsorFlags(enabled));
        found.push(...this.health.aiFlags(enabled));
      }
      // Findings posted by the daily routine are not re-evaluated here, so they are left out of the resolve pass.
      const r = this.q.applyScan(found, { codes: [...RULES.map((x) => x.code), ...(this.health ? this.health.ownedCodes() : [])] });
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
    const coverage = new PlaybookEngine(this.q).coverageByAccount();

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
      // Accounts with a TikTok shop get GMV from the Analytics rule; the synced-GMV rules would only duplicate or contradict it.
      const onTikTok = ttsShops.some((s) => s.account_id === a.id && s.token_ok);
      if (myShops.length && !onTikTok) {
        const mine = gmvRows.filter((r) => myShops.includes(r.shop_id));
        const cut = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
        const prevCut = new Date(now - 14 * 86400000).toISOString().slice(0, 10);
        const last7 = mine.filter((r) => r.date >= cut).reduce((s, r) => s + r.total_gmv, 0);
        const prev7 = mine.filter((r) => r.date >= prevCut && r.date < cut).reduce((s, r) => s + r.total_gmv, 0);
        if (enabled.has('gmv_drop_wow') && prev7 > 0 && last7 < prev7 * 0.7) out.push({ account_id: a.id, shop_id: null, code: 'gmv_drop_wow', severity: 'warn', message: `${a.name}: GMV ${Math.round(last7).toLocaleString('en-GB')} last 7 days vs ${Math.round(prev7).toLocaleString('en-GB')} the week before (${Math.round((1 - last7 / prev7) * 100)}% down)` });
        const latest = mine.map((r) => r.date).sort().pop();
        if (enabled.has('gmv_stale') && (!latest || latest < new Date(now - 3 * 86400000).toISOString().slice(0, 10))) out.push({ account_id: a.id, shop_id: null, code: 'gmv_stale', severity: 'info', message: `${a.name}: no GMV rows synced since ${latest ?? 'ever'}` });
      }
      if (enabled.has('cruva_setup_gap')) {
        const cov = coverage.get(a.id);
        if (cov && (cov.missing_core.length || cov.paused_core.length)) out.push({ account_id: a.id, shop_id: null, code: 'cruva_setup_gap', severity: 'warn', message: `${a.name}: ${cov.missing_core.length} core Cruva bot(s) missing, ${cov.paused_core.length} paused (${cov.set}/${cov.total} set up)`, detail: [...cov.missing_core.map((m) => `missing ${m}`), ...cov.paused_core.map((m) => `paused ${m}`)].slice(0, 8).join(' · ') });
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
}
