import type { Queries } from '../db/queries.js';
import type { Incident, IncidentKind, IncidentsData, MonitorFlag } from '../sweep/types.js';
import { tts, type TtsClient } from '../tts/client.js';
import { shopCredentials } from '../tts/promotions.js';
import { slackBot, type SlackBot } from '../notify/slackbot.js';
import { draftWithClaude } from '../inbox/llm.js';
import { config } from '../config.js';
import { liveEvents } from '../live/events.js';
import { projectRows, stockSettings } from '../stock/index.js';
import { log } from '../logger.js';

/**
 * Instant issue alerts. Anything that needs a human today (negative balance, payout failure,
 * violation, overdue shipments, EPR / listing compliance, account health, expiring authorisation,
 * stock-outs, campaign or ad account problems reported from outside) becomes an incident and is
 * posted to the account's internal Slack channel with what happened, severity, the recommended
 * action and the owner. Repeats are deduped; a resolved incident gets a thread reply.
 */

export const INCIDENT_KINDS: IncidentKind[] = [
  { kind: 'negative_balance', title: 'Negative balance', severity: 'crit', source: 'tts', description: 'A finance statement settled negative (deductions exceed sales).', action: 'Open Seller Center > Finance > Statements, list the deductions (refunds, penalties, adjustments), and confirm with the client before the next payout cycle. Raise disputed adjustments with the TTS agency manager.' },
  { kind: 'payout_issue', title: 'Payout issue', severity: 'crit', source: 'tts', description: 'A payment failed or is still unpaid a week after it was created.', action: 'Check the bank account in Seller Center > Finance > Bank account. If rejected, ask the client to re-upload documents today; if unchanged after 48h, escalate to the TTS agency manager with the payment id.' },
  { kind: 'account_health', title: 'Account status changed', severity: 'crit', source: 'tts', description: 'The seller or shop status is no longer ACTIVE (pending, deactivated, rejected or restricted).', action: 'Open Seller Center > Account health, read the notice, file the appeal inside the window and tell the client today with the expected timeline.' },
  { kind: 'tax_form', title: 'Tax form rejected', severity: 'warn', source: 'tts', description: 'The seller tax form is rejected or under audit.', action: 'Ask the client for the corrected tax form or VAT documents and resubmit in Seller Center > Account > Tax information.' },
  { kind: 'violation', title: 'Products deactivated by the platform', severity: 'crit', source: 'monitor', description: 'Products are frozen or deactivated for a policy violation.', action: 'Open Seller Center > Products > Violations, read the reason, fix the listing (claims, images, category) and appeal. Tell the client which products are off and the revenue at risk.' },
  { kind: 'listing_failed', title: 'Listing failed review', severity: 'warn', source: 'tts', description: 'Products failed the listing audit.', action: 'Open the product in Seller Center, read the audit reasons, correct and resubmit. Keep the client informed if it is a compliance document they need to supply.' },
  { kind: 'epr_warning', title: 'EPR / compliance warning', severity: 'crit', source: 'tts', description: 'A listing audit failed on an EPR or compliance reason (packaging, WEEE, batteries, GPSR).', action: 'Get the EPR registration numbers from the client (LUCID / Citeo / Ecoembes / CONAI etc.), add them under Seller Center > Compliance and resubmit the products. Products stay unsellable until this is done.' },
  { kind: 'overdue_shipment', title: 'Orders overdue to ship', severity: 'crit', source: 'monitor', description: 'Orders waiting to ship for more than 48 hours (platform SLA at risk).', action: 'Chase the warehouse or 3PL now, ship or mark the orders, and check stock. Repeated late dispatch drops the shop score and can restrict the account.' },
  { kind: 'auth_expiring', title: 'TikTok authorisation expiring', severity: 'crit', source: 'monitor', description: 'The shop API authorisation is invalid or expires within 7 days.', action: 'Re-authorise the shop from the Settings page (TikTok Shop section) so promotions, monitoring and reports keep working.' },
  { kind: 'stock_out', title: 'Stock running out', severity: 'crit', source: 'stock', description: 'Active SKUs are out of stock or under the critical days-of-cover threshold.', action: 'Open Account management > Stock, download the replenishment CSV for the days of cover you need and send it to the client / 3PL today.' },
  { kind: 'gmv_drop', title: 'GMV down 30%+ week on week', severity: 'warn', source: 'monitor', description: 'Last 7 days of GMV is at least 30% below the week before.', action: 'Check live promotions, affiliate posting volume, GMV Max spend and product availability. Share a one-line diagnosis with the client before they ask.' },
  { kind: 'inbox_sla', title: 'Buyers or creators waiting over 24h', severity: 'warn', source: 'monitor', description: 'CS or affiliate conversations unanswered for more than 24 hours.', action: 'Clear the inbox from Account management > CS & affiliate inbox (auto-replies can be switched on per account).' },
  { kind: 'ad_account_disconnected', title: 'Ad account disconnected', severity: 'crit', source: 'ingest', description: 'The TikTok Ads account lost its link to the shop or the agency BC.', action: 'Reconnect the ad account in TikTok Ads Manager > Assets > Shop, confirm the agency partner access, and check that GMV Max campaigns resumed.' },
  { kind: 'campaign_issue', title: 'Campaign issue', severity: 'warn', source: 'ingest', description: 'A GMV Max or ads campaign was rejected, paused or stopped delivering.', action: 'Open the campaign in Ads Manager, read the rejection or delivery notice, fix the creative or product and relaunch. Note the change on the GMV Max page.' },
  { kind: 'auto_cancel_risk', title: 'Orders about to auto-cancel', severity: 'crit', source: 'monitor', description: 'Unshipped orders inside the platform auto-cancel window (Windsor).', action: 'Ship or mark the orders now; if stock is the problem, cancel them yourself with the right reason before the platform does, so the cancellation does not count against the shop.' },
  { kind: 'cancel_requests', title: 'Buyer cancellation requests waiting', severity: 'warn', source: 'monitor', description: 'Buyers asked to cancel and nobody has responded (Windsor).', action: 'Open Seller Center > Orders > Cancellations and approve or reject each request today; unanswered requests auto-approve and hurt the shop score.' },
  { kind: 'unsettled_backlog', title: 'Unsettled money ageing', severity: 'warn', source: 'monitor', description: 'Settlement outstanding on orders older than the threshold (Windsor).', action: 'Check the unsettled reasons in Seller Center > Finance > Unsettled; if they are delivery confirmations, chase the carrier; if they are disputes, answer them. Tell the client the amount and expected release.' },
  { kind: 'sps_restricted', title: 'Shop performance score restricts outreach', severity: 'crit', source: 'monitor', description: 'The shop performance score is under 3.5, so creator DMs are blocked (Cruva).', action: 'Read the score breakdown in Seller Center > Shop health, fix the driver (late dispatch, cancellations, negative reviews) and switch Cruva outreach to target invites until the score recovers.' },
  { kind: 'outreach_stopped', title: 'Creator outreach stopped', severity: 'warn', source: 'monitor', description: 'DMs sent collapsed week on week or are at zero with automations active (Cruva).', action: 'Open Cruva > Automations, check the status (throttled, outreach cap, sensitive text, bad product) and fix or restart the campaign. Confirm the target list still has creators left.' },
  { kind: 'account_at_risk', title: 'Daily review: account at risk', severity: 'crit', source: 'monitor', description: 'The AI review rated the account red for today.', action: 'Read the summary and the action on Monitor > Daily review and do the action today; reply in the Slack thread with what was done.' },
];

export type Detected = { account_id: number | null; shop_id: string | null; kind: string; severity?: Incident['severity']; message: string; fingerprint?: string; source?: string; action?: string };

export interface IncidentSettings { enabled: boolean; post_to_slack: boolean; default_channel: string; cooldown_hours: number }

export function incidentSettings(q: Queries): IncidentSettings {
  const h = Number(q.getSetting('incidents_cooldown_hours', '24'));
  return { enabled: q.getSetting('incidents_enabled', '1') === '1', post_to_slack: q.getSetting('incidents_post_slack', '1') === '1', default_channel: q.getSetting('incidents_default_channel', ''), cooldown_hours: Number.isFinite(h) && h >= 0 ? h : 24 };
}

/** Map account monitor flags to incident kinds (low stock is handled by the stock module). */
export function incidentsFromFlags(flags: MonitorFlag[]): Detected[] {
  const map: Record<string, string> = {
    tts_unshipped: 'overdue_shipment', tts_product_deactivated: 'violation', tts_auth_expiring: 'auth_expiring', gmv_drop_wow: 'gmv_drop', inbox_unanswered: 'inbox_sla',
    w_ship_sla_breach: 'overdue_shipment', w_auto_cancel_risk: 'auto_cancel_risk', w_buyer_cancel_requests: 'cancel_requests', w_product_deactivated: 'violation', w_listing_failed: 'listing_failed', w_out_of_stock: 'stock_out',
    w_payout_failed: 'payout_issue', w_negative_statement: 'negative_balance', w_unsettled_backlog: 'unsettled_backlog', c_sps_low: 'sps_restricted', c_dms_stopped: 'outreach_stopped', ai_risk_red: 'account_at_risk',
  };
  return flags.filter((f) => !f.resolved_at && map[f.code]).map((f) => ({ account_id: f.account_id, shop_id: f.shop_id, kind: map[f.code], message: f.detail ? `${f.message}. ${f.detail}` : f.message, fingerprint: `flag:${f.code}`, source: 'monitor' }));
}

const sevIcon: Record<Incident['severity'], string> = { crit: ':rotating_light:', warn: ':warning:', info: ':information_source:' };
const sevLabel: Record<Incident['severity'], string> = { crit: 'CRITICAL', warn: 'WARNING', info: 'INFO' };

export function renderSlackIncident(i: Incident, opts: { dashboardUrl?: string } = {}): string {
  const owner = i.owner_slack_id ? `<@${i.owner_slack_id}>` : i.owner ?? 'unassigned';
  const lines = [
    `${sevIcon[i.severity]} *[${sevLabel[i.severity]}] ${i.account_name ?? 'Unassigned account'}: ${i.title}*`,
    `*What happened:* ${i.message}`,
    `*Recommended action:* ${i.recommended_action}`,
    `*Owner:* ${owner}`,
  ];
  if (opts.dashboardUrl) lines.push(`<${opts.dashboardUrl}|Open in the dashboard>`);
  return lines.join('\n');
}

export class IncidentEngine {
  constructor(private q: Queries, private slack: SlackBot = slackBot, private client: TtsClient = tts, private llm: ((system: string, user: string) => Promise<string>) | null = config.anthropicApiKey ? (s, u) => draftWithClaude(s, u, { maxTokens: 400 }) : null) {}

  kinds(): IncidentKind[] {
    return INCIDENT_KINDS;
  }

  data(): IncidentsData {
    const incidents = this.q.listIncidents({ limit: 300 });
    const accounts = this.q.listAccounts().filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, am_name: a.am_name, slack_channel: a.slack_channel, open: incidents.filter((i) => i.account_id === a.id && !i.resolved_at).length }));
    return { incidents, kinds: this.kinds(), accounts, settings: incidentSettings(this.q), slack_configured: this.slack.configured, llm_configured: Boolean(this.llm), last_scan_at: this.q.getSetting('incidents_last_scan_at', '') || null };
  }

  private ownerFor(accountId: number | null): { owner: string | null; owner_slack_id: string | null } {
    const a = accountId ? this.q.getAccount(accountId) : null;
    if (!a?.am_name) return { owner: null, owner_slack_id: null };
    const person = this.q.listPeople().find((p) => p.name.toLowerCase() === a.am_name!.toLowerCase());
    return { owner: a.am_name, owner_slack_id: person?.slack_user_id ?? null };
  }

  private channelFor(accountId: number | null, settings: IncidentSettings): string | null {
    const a = accountId ? this.q.getAccount(accountId) : null;
    return a?.slack_channel || settings.default_channel || null;
  }

  /** Claude tightens the "what happened" and the action for this specific case; the kind's template is the fallback. */
  private async describe(d: Detected, kind: IncidentKind, accountName: string | null): Promise<{ message: string; action: string }> {
    const fallback = { message: d.message, action: d.action ?? kind.action };
    if (!this.llm) return fallback;
    try {
      const text = await this.llm(
        'You write incident notes for a TikTok Shop agency team in Slack. British English, plain, no exclamation marks, no hype. Output JSON only: {"message": "...", "action": "..."}. "message" is one or two sentences saying exactly what happened with the numbers given; "action" is two or three concrete steps the account manager should take today, in order. Never invent facts beyond the input.',
        `Account: ${accountName ?? 'unknown'}\nIncident type: ${kind.title} (${kind.description})\nDetected: ${d.message}\nStandard playbook: ${d.action ?? kind.action}`,
      );
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      const j = JSON.parse(text.slice(start, end + 1)) as { message?: string; action?: string };
      return { message: (j.message ?? '').trim() || fallback.message, action: (j.action ?? '').trim() || fallback.action };
    } catch {
      return fallback;
    }
  }

  /** Upsert detected incidents from one source; new ones are posted, missing ones resolved. */
  async apply(source: string, found: Detected[]): Promise<{ opened: Incident[]; resolved: Incident[] }> {
    const settings = incidentSettings(this.q);
    const opened: Incident[] = [];
    const liveKeys = new Set<string>();
    for (const d of found) {
      const kind = INCIDENT_KINDS.find((k) => k.kind === d.kind);
      if (!kind) continue;
      const key = `${d.kind}:${d.account_id ?? '-'}:${d.shop_id ?? '-'}:${d.fingerprint ?? ''}`;
      liveKeys.add(key);
      if (this.q.findIncidentByKey(key, settings.cooldown_hours)) continue;
      const account = d.account_id ? this.q.getAccount(d.account_id) : null;
      const { message, action } = await this.describe(d, kind, account?.name ?? null);
      const inc = this.q.createIncident({ account_id: d.account_id, shop_id: d.shop_id, kind: d.kind, severity: d.severity ?? kind.severity, title: kind.title, message, recommended_action: action, ...this.ownerFor(d.account_id), source: d.source ?? source, dedupe_key: key, slack_channel: this.channelFor(d.account_id, settings) });
      opened.push(inc);
      if (settings.enabled && settings.post_to_slack) await this.post(inc);
    }
    const resolved = this.q.resolveMissingIncidents(source, liveKeys);
    for (const r of resolved) {
      if (r.slack_ts && r.slack_channel && this.slack.configured) {
        try { await this.slack.post(await this.slack.channelId(r.slack_channel), `:white_check_mark: Resolved: ${r.title} for ${r.account_name ?? 'the account'} is no longer showing.`, { thread_ts: r.slack_ts }); } catch (err) { log.warn(`Incident resolve note failed: ${(err as Error).message}`); }
      }
    }
    if (opened.length || resolved.length) {
      log.info(`Incidents (${source}): ${opened.length} new, ${resolved.length} resolved`);
      liveEvents.emitUpdate({ kind: 'incidents' });
    }
    return { opened, resolved };
  }

  async post(inc: Incident): Promise<Incident> {
    if (!this.slack.configured) return this.q.updateIncident(inc.id, { post_error: 'SLACK_BOT_TOKEN is not set' }) ?? inc;
    if (!inc.slack_channel) return this.q.updateIncident(inc.id, { post_error: 'No Slack channel: set one on the account or a default in Incidents > Settings' }) ?? inc;
    try {
      const r = await this.slack.post(await this.slack.channelId(inc.slack_channel), renderSlackIncident(inc, { dashboardUrl: `${config.publicUrl}/monitor?tab=incidents` }));
      return this.q.updateIncident(inc.id, { slack_ts: r.ts, posted_at: new Date().toISOString(), post_error: null }) ?? inc;
    } catch (err) {
      log.warn(`Incident post to ${inc.slack_channel} failed: ${(err as Error).message}`);
      return this.q.updateIncident(inc.id, { post_error: (err as Error).message }) ?? inc;
    }
  }

  /** Full pass: monitor flags, TikTok finance / status / listing checks, stock countdown. */
  async scan(): Promise<{ opened: number; resolved: number; errors: string[] }> {
    const errors: string[] = [];
    let opened = 0;
    let resolved = 0;
    const flags = incidentsFromFlags(this.q.listFlags(false));
    const r1 = await this.apply('monitor', flags);
    opened += r1.opened.length; resolved += r1.resolved.length;
    const { found, errors: e2 } = await this.ttsChecks();
    errors.push(...e2);
    const r2 = await this.apply('tts', found);
    opened += r2.opened.length; resolved += r2.resolved.length;
    const r3 = await this.apply('stock', this.stockChecks());
    opened += r3.opened.length; resolved += r3.resolved.length;
    this.q.setSetting('incidents_last_scan_at', new Date().toISOString());
    return { opened, resolved, errors };
  }

  stockChecks(): Detected[] {
    const s = stockSettings(this.q);
    const rows = projectRows(this.q.listStock(), { coverDays: s.default_cover_days, critDays: s.crit_days, warnDays: s.warn_days }).filter((r) => !r.exclude && /ACTIV/i.test(r.product_status ?? 'ACTIVATE') && (r.level === 'out' || r.level === 'crit'));
    const byShop = new Map<string, typeof rows>();
    for (const r of rows) byShop.set(r.shop_id, [...(byShop.get(r.shop_id) ?? []), r]);
    const shops = this.q.listTtsShops();
    return [...byShop.entries()].map(([shopId, list]) => {
      const shop = shops.find((x) => x.id === shopId);
      const out = list.filter((r) => r.level === 'out').length;
      return { account_id: shop?.account_id ?? null, shop_id: shopId, kind: 'stock_out', message: `${shop?.name ?? shopId}: ${out ? `${out} selling SKU(s) out of stock, ` : ''}${list.length - out} SKU(s) under ${s.crit_days} days of cover: ${list.slice(0, 6).map((r) => `${r.product_title}${r.sku_name ? ` (${r.sku_name})` : ''} ${r.on_hand} left${r.days_left !== null ? `, ${r.days_left}d` : ''}`).join(' · ')}`, fingerprint: `n${list.length}` };
    });
  }

  async ttsChecks(now = Date.now()): Promise<{ found: Detected[]; errors: string[] }> {
    const found: Detected[] = [];
    const errors: string[] = [];
    if (!this.client.configured) return { found, errors };
    const sec = (d: number) => Math.floor(d / 1000);
    const statusOk = (v: unknown) => { const s = String(v ?? '').toUpperCase(); return s === '2' || s === 'ACTIVE' || s === ''; };
    for (const shop of this.q.listTtsShops().filter((s) => s.token_ok)) {
      try {
        const creds = await shopCredentials(this.q, shop.id, this.client);
        const base = { accessToken: creds.accessToken, shopCipher: creds.cipher };
        // Seller / shop status and tax form.
        try {
          const st = await this.client.call<{ seller_status_data?: { seller_status?: string; shop_statuses?: { shop_id?: string; shop_status?: string }[]; tax_form_status?: string } }>('GET', '/seller/202508/status', base);
          const d = st.seller_status_data ?? {};
          const mine = d.shop_statuses?.find((x) => x.shop_id === shop.id) ?? d.shop_statuses?.[0];
          if (!statusOk(d.seller_status) || (mine && !statusOk(mine.shop_status))) found.push({ account_id: shop.account_id, shop_id: shop.id, kind: 'account_health', message: `${shop.name}: seller status ${d.seller_status ?? 'unknown'}, shop status ${mine?.shop_status ?? 'unknown'} (2 / ACTIVE is normal)`, fingerprint: `${d.seller_status}-${mine?.shop_status}` });
          if (String(d.tax_form_status ?? '') === '3' || /REJECT/i.test(String(d.tax_form_status ?? ''))) found.push({ account_id: shop.account_id, shop_id: shop.id, kind: 'tax_form', message: `${shop.name}: tax form rejected`, fingerprint: 'rejected' });
        } catch (err) { errors.push(`${shop.name} status: ${(err as Error).message}`); }
        // Statements: negative settlements and failed payments in the last 30 days.
        try {
          const st = await this.client.call<{ statements?: { id: string; settlement_amount?: string; payment_status?: string; currency?: string; statement_time?: number }[] }>('GET', '/finance/202309/statements', { ...base, query: { sort_field: 'statement_time', sort_order: 'DESC', page_size: '50', statement_time_ge: String(sec(now - 30 * 86400000)) } });
          const neg = (st.statements ?? []).filter((s) => Number(s.settlement_amount ?? 0) < 0);
          if (neg.length) found.push({ account_id: shop.account_id, shop_id: shop.id, kind: 'negative_balance', message: `${shop.name}: ${neg.length} statement(s) settled negative in the last 30 days (${neg.slice(0, 3).map((s) => `${s.settlement_amount} ${s.currency ?? ''} on ${s.statement_time ? new Date(s.statement_time * 1000).toISOString().slice(0, 10) : '?'}`).join(', ')})`, fingerprint: neg.map((s) => s.id).sort().join(',').slice(0, 80) });
          const failed = (st.statements ?? []).filter((s) => /FAIL/i.test(s.payment_status ?? ''));
          if (failed.length) found.push({ account_id: shop.account_id, shop_id: shop.id, kind: 'payout_issue', message: `${shop.name}: ${failed.length} statement payment(s) failed`, fingerprint: failed.map((s) => s.id).sort().join(',').slice(0, 80) });
        } catch (err) { errors.push(`${shop.name} statements: ${(err as Error).message}`); }
        try {
          const pm = await this.client.call<{ payments?: { id: string; status?: string; create_time?: number; paid_time?: number; amount?: { value?: string; currency?: string } }[] }>('GET', '/finance/202309/payments', { ...base, query: { sort_field: 'create_time', sort_order: 'DESC', page_size: '50', create_time_ge: String(sec(now - 45 * 86400000)) } });
          const bad = (pm.payments ?? []).filter((p) => /FAIL|REJECT/i.test(p.status ?? '') || (!/PAID|SUCCESS/i.test(p.status ?? '') && !p.paid_time && (p.create_time ?? 0) * 1000 < now - 7 * 86400000));
          if (bad.length) found.push({ account_id: shop.account_id, shop_id: shop.id, kind: 'payout_issue', message: `${shop.name}: ${bad.length} payment(s) failed or unpaid after 7 days (${bad.slice(0, 3).map((p) => `${p.amount?.value ?? '?'} ${p.amount?.currency ?? ''} ${p.status ?? ''}`).join(', ')})`, fingerprint: bad.map((p) => p.id).sort().join(',').slice(0, 80) });
        } catch (err) { errors.push(`${shop.name} payments: ${(err as Error).message}`); }
        // Listing audits: failed products, EPR / compliance reasons.
        try {
          type P = { id: string; title: string; status?: string; audit?: { status?: string; pre_approved_reasons?: string[]; failed_reasons?: string[]; suggestions?: { reason?: string }[] }; audit_failed_reasons?: { position?: string; reasons?: string[]; suggestions?: string[] }[] };
          const r = await this.client.call<{ products?: P[] }>('POST', '/product/202309/products/search', { ...base, query: { page_size: '100' }, body: { status: 'FAILED' } });
          const failed = (r.products ?? []).filter((p) => p.status === 'FAILED' || /FAIL/i.test(p.audit?.status ?? ''));
          const reasonsOf = (p: P) => [...(p.audit?.failed_reasons ?? []), ...(p.audit?.pre_approved_reasons ?? []), ...(p.audit?.suggestions ?? []).map((s) => s.reason ?? ''), ...(p.audit_failed_reasons ?? []).flatMap((x) => x.reasons ?? [])].filter(Boolean).join(' ');
          const epr = failed.filter((p) => /\bEPR\b|extended producer|packaging|WEEE|GPSR|compliance|responsible person/i.test(reasonsOf(p)));
          if (epr.length) found.push({ account_id: shop.account_id, shop_id: shop.id, kind: 'epr_warning', message: `${shop.name}: ${epr.length} product(s) failed review on an EPR / compliance reason: ${epr.slice(0, 5).map((p) => p.title).join(' · ')}`, fingerprint: epr.map((p) => p.id).sort().join(',').slice(0, 80) });
          const rest = failed.filter((p) => !epr.includes(p));
          if (rest.length) found.push({ account_id: shop.account_id, shop_id: shop.id, kind: 'listing_failed', message: `${shop.name}: ${rest.length} product(s) failed the listing review: ${rest.slice(0, 5).map((p) => `${p.title}${reasonsOf(p) ? ` (${reasonsOf(p).slice(0, 80)})` : ''}`).join(' · ')}`, fingerprint: rest.map((p) => p.id).sort().join(',').slice(0, 80) });
        } catch (err) { errors.push(`${shop.name} listings: ${(err as Error).message}`); }
      } catch (err) {
        errors.push(`${shop.name}: ${(err as Error).message}`);
      }
    }
    return { found, errors };
  }
}
