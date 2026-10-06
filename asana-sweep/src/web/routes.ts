import { Router, type Request, type Response } from 'express';
import { Queries } from '../db/queries.js';
import { Scheduler } from '../scheduler/index.js';
import { CRON_PRESETS, describeSchedule, isValidTimezone, nextRun, validateCron } from '../scheduler/describe.js';
import type { Account, InboxChannel, AccountInput, AccountStatusRow, Analytics, AnalyticsAccount, AnalyticsAm, CheckSettings, ChecklistItemInput } from '../sweep/types.js';
import { checkAccount, deadlineLabel, isCheckRunning, refreshLive, runAllChecks, todayIn } from '../checklist/checker.js';
import { isDue } from '../checklist/evaluate.js';
import { DEFAULT_REMINDER_TEXT, incompleteByPerson, notifyAms, renderReminder } from '../checklist/reminders.js';
import { slackBot } from '../notify/slackbot.js';
import { liveEvents } from '../live/events.js';
import { buildAlertCalendar, buildCalendar, buildGmv, buildGmvExplore } from '../reports/index.js';
import { syncGmv } from '../gmv/sync.js';
import { cruva } from '../gmv/cruva.js';
import { discoverWindsorShops, syncWindsorGmv, windsor, windsorStatus } from '../gmv/windsor.js';
import type { WindsorStatus, InquiriesData, SiteInquiry, InquiryHistory, InquiryMail } from '../sweep/types.js';
import { currencyForShop } from '../gmv/currency.js';
import { authorizationUrl, tts, ttsAffiliate } from '../tts/client.js';
import { deactivatePromotion, pushPromotion, shopCredentials, syncPromotion } from '../tts/promotions.js';
import { currencyForMarket, marketFromRegion, marketsOf } from '../tts/markets.js';
import type { GmvMaxPatch, PromotionInput, TtsStatus } from '../sweep/types.js';
import type { LeadsData, PersonInput, ReminderSettings } from '../sweep/types.js';
import { importLeadsCsv, leadsSettings, leadsSyncStatus, syncLeads } from '../leads/sync.js';
import { amSummary } from '../leads/points.js';
import { apollo } from '../bd/apollo.js';
import { apolloStatus, enrichProspect, markApolloExhausted, refreshApolloCredits } from '../bd/enrich.js';
import { isCreditsError } from '../bd/apollo.js';
import { fastmoss, fastmossStatus, isQuotaError } from '../bd/fastmoss.js';
import { advanceLinkedin, LINKEDIN_STEPS, suggestTtsContact } from '../bd/sequence.js';
import { scanEnterpriseAlerts, syncWatchlistFromSheet } from '../bd/alerts.js';
import { mineTiktokContacts } from '../bd/tts-directory.js';
import { draftCallFollowups, tldv } from '../bd/tldv.js';
import type { BdContact, BdFollowup, TtsContact } from '../sweep/types.js';
import { inboxSettings, sendReply, syncInbox } from '../inbox/sync.js';
import { syncCruvaInbox } from '../inbox/cruva-inbox.js';
import { cruvaMcp } from '../cruva/mcp.js';
import { feedback as replyFeedback, repliesData, replyBlocker, sampleThread, savePolicy, summary as repliesSummary, waitingAll } from '../inbox/replies.js';
import { buildContext, renderPrompt } from '../inbox/context.js';
import { draftWithClaude } from '../inbox/llm.js';
import { LANGUAGE_NAMES } from '../inbox/language.js';
import type { ConversationDetail, ContextEntry, InboxData } from '../sweep/types.js';
import { normaliseDomain } from '../bd/score.js';
import { importPullFiles, isoDate, parseProspectInput } from '../bd/import.js';
import { GmailClient, gmailComposeUrl, normaliseAccount } from '../bd/gmail.js';
import { recordSent, saveSendSettings } from '../bd/sendqueue.js';
import { bodyToHtml, LANGUAGES as OUTREACH_LANGUAGES, outreachInputs } from '../bd/outreach.js';
import { generateDraft as generateOutreachDraft } from '../bd/draft.js';
import { bulkCandidates, pickBestLinkedin } from '../bd/bulk.js';
import { generateLarkMessage, pickLarkRecipient, spreadDates } from '../bd/lark.js';
import type { LarkMessage, PlaybookDraftStatus, TtsScope } from '../sweep/types.js';
import { BLOCK_SCOPES } from '../health/tts-pull.js';
import { projectionCsv } from '../stock/index.js';
import { columnsFromHeader, FBT_FIELDS, fbtManifestCsv, fbtPlan, fbtProfile, fbtSummary, fbtTemplateCsv } from '../stock/fbt.js';
import { currentMonth as pnlCurrentMonth, pnlCsv, pnlData, pnlSummary } from '../pnl/index.js';
import { syncStatus } from '../scheduler/sync-status.js';
import { inboxSettings as inboxSettingsOf } from '../inbox/sync.js';
import type { FbtField, FbtProfile, OnboardingTerms, PitchBrief, PitchDeck, PitchesData, PitchSlide, PitchStat, PnlForecastInputs, PnlInputs, ReportSchedule } from '../sweep/types.js';
import { researchPitch } from '../pitch/research.js';
import { buildDeck, deckHtml, DEFAULT_BRIEF, normaliseBrief } from '../pitch/deck.js';
import { periodBounds } from '../reports/client.js';
import type { IngestPayload } from '../health/index.js';
import { THRESHOLD_LABELS } from '../health/rules.js';
import type { PlaybookKind, PlaybookSetupCell } from '../sweep/types.js';
import type { BdEmailDraft, OutreachData, OutreachExample } from '../sweep/types.js';
import type { BdCountryRow, BdData, BdProspectInput, BdProspectPatch, BdStatus } from '../sweep/types.js';
import type { AuthProvider } from './auth.js';
import { requireAdminForWrites, requireAuth, SharedPasswordAuth } from './auth.js';
import { config } from '../config.js';
import { log } from '../logger.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const bool = (v: unknown, fallback: boolean) => (v === undefined || v === null ? fallback : Boolean(v));
const int = (v: unknown, fallback: number) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
};

const optText = (v: unknown): string | null => {
  const t = String(v ?? '').trim();
  return t || null;
};

const STARTED_AT = new Date().toISOString();

export function parseAccountInput(body: Record<string, unknown>): AccountInput {
  const name = String(body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Account name is required.');
  return {
    name,
    markets: optText(body.markets),
    am_name: optText(body.am_name),
    aa_name: optText(body.aa_name),
    enabled: bool(body.enabled, true),
    notes: optText(body.notes),
    slack_channel: optText(body.slack_channel),
    client_slack_channel: optText(body.client_slack_channel),
    client_domain: optText(body.client_domain)?.toLowerCase().replace(/^@/, '') ?? null,
    ...parseDeal(body),
  };
}

/** Commission deal fields shared by the account form and the GMV page. */
export function parseDeal(body: Record<string, unknown>): { commission_pct: number | null; commission_basis: 'gmv' | 'mor'; settlement_pct: number } {
  const pctRaw = body.commission_pct;
  const commission_pct = pctRaw === null || pctRaw === undefined || pctRaw === '' ? null : Number(pctRaw);
  if (commission_pct !== null && (!Number.isFinite(commission_pct) || commission_pct < 0 || commission_pct > 100)) throw new HttpError(400, 'Commission % must be between 0 and 100.');
  const commission_basis = body.commission_basis === 'mor' ? 'mor' : 'gmv';
  const settlement_pct = body.settlement_pct === undefined || body.settlement_pct === null || body.settlement_pct === '' ? 100 : Number(body.settlement_pct);
  if (!Number.isFinite(settlement_pct) || settlement_pct < 0 || settlement_pct > 200) throw new HttpError(400, 'Settlement % must be between 0 and 200.');
  return { commission_pct, commission_basis, settlement_pct };
}

/** Validate and normalise a rule payload from the dashboard. Throws HttpError(400) on bad input. */
export function buildRouter(q: Queries, scheduler: Scheduler, auth: AuthProvider): Router {
  const r = Router();

  const idParam = (req: Request): number => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Bad id');
    return id;
  };

  // ---- Public ----
  r.get('/health', (_req, res) => res.json({ ok: true }));

  // Brute-force guard for the shared password: 10 failed attempts per IP, then a 15 minute lockout.
  const attempts = new Map<string, { count: number; until: number }>();
  r.post('/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const a = attempts.get(ip);
    if (a && a.count >= 10 && a.until > now) {
      return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil((a.until - now) / 60000)} min.` });
    }
    if (auth.login(req, res)) {
      attempts.delete(ip);
      return res.json({ ok: true });
    }
    const next = a && a.until > now ? { count: a.count + 1, until: now + 15 * 60000 } : { count: 1, until: now + 15 * 60000 };
    attempts.set(ip, next);
    res.status(401).json({ error: 'Wrong password' });
  });

  r.post('/logout', (_req, res) => {
    auth.logout(res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    const role = auth instanceof SharedPasswordAuth ? auth.roleOf(req) : auth.isAuthenticated(req) ? 'admin' : null;
    res.json({ authenticated: role !== null, role, am_login_enabled: Boolean(config.amPassword) });
  });

  // ---- BD import: a scheduled job (or an admin session) posts fresh FastMoss pulls here ----
  r.post('/bd/import', (req, res) => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const viaToken = Boolean(config.ingestToken) && bearer === config.ingestToken;
    const viaAdmin = auth instanceof SharedPasswordAuth ? auth.roleOf(req) === 'admin' : auth.isAuthenticated(req);
    if (!viaToken && !viaAdmin) return res.status(401).json({ error: 'Send a valid INGEST_TOKEN bearer token or sign in as admin.' });
    const body = (req.body ?? {}) as { prospects?: Record<string, unknown>[]; shops?: Record<string, unknown>[]; pulled_at?: string };
    const rows = Array.isArray(body.prospects) ? body.prospects : Array.isArray(body.shops) ? body.shops : [];
    if (!rows.length) throw new HttpError(400, 'Send { prospects: [...] } (FastMoss shop_search rows work as-is).');
    const pulledAt = optText(body.pulled_at) ?? new Date().toISOString();
    let result: { added: number; updated: number };
    try {
      result = q.upsertProspects(rows.map((row) => parseProspectInput({ pulled_at: pulledAt, source: 'fastmoss', ...row })));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    liveEvents.emitUpdate({ kind: 'bd' });
    if (result.added) { scheduler.autoEnrich(); scanEnterpriseAlerts(q); }
    res.json({ result });
  });

  // ---- Account health: the daily Claude routine reads the context and posts Cruva metrics, findings and assessments ----
  const viaTokenOrAdmin = (req: Request): boolean => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const viaToken = Boolean(config.ingestToken) && bearer === config.ingestToken;
    const viaAdmin = auth instanceof SharedPasswordAuth ? auth.roleOf(req) === 'admin' : auth.isAuthenticated(req);
    return viaToken || viaAdmin;
  };
  r.get('/flags/context', (req, res) => {
    if (!viaTokenOrAdmin(req)) return res.status(401).json({ error: 'Send a valid INGEST_TOKEN bearer token or sign in as admin.' });
    res.json(scheduler.health.routineContext());
  });
  r.post('/flags/ingest', async (req, res) => {
    if (!viaTokenOrAdmin(req)) return res.status(401).json({ error: 'Send a valid INGEST_TOKEN bearer token or sign in as admin.' });
    const body = (req.body ?? {}) as Partial<IngestPayload>;
    if (!Array.isArray(body.accounts) || !body.accounts.length) throw new HttpError(400, 'Send { accounts: [{ account, shops: [{ shop_id, metrics }], findings: [...], assessment: {...} }] }.');
    const result = scheduler.health.ingest(body as IngestPayload);
    // The rules run straight away so the flags and Slack alerts follow the routine's numbers without waiting for the next scan.
    const scan = await scheduler.monitor.scan();
    res.json({ ...result, scan });
  });

  // ---- Website contact form: brightform.agency posts here; no session, CORS for the site's origins, rate limited ----
  const siteOrigins = (): string[] => (q.getSetting('site_origins', '') || 'https://brightform.agency,https://www.brightform.agency').split(',').map((o) => o.trim()).filter(Boolean);
  const contactCors = (req: Request, res: Response): boolean => {
    const origin = String(req.headers.origin ?? '');
    const allowed = siteOrigins();
    const ok = !origin || allowed.includes(origin) || /^https:\/\/[a-z0-9-]+\.(lovable\.app|lovableproject\.com|pages\.dev)$/.test(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
    if (origin && ok) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return ok;
  };
  const contactHits = new Map<string, { count: number; until: number }>();
  r.options('/site/contact', (req, res) => { contactCors(req, res); res.status(204).end(); });
  /** Default inbox for the email forward; an empty setting switches the forward off. */
  const FORWARD_DEFAULT = 'isaac@brightform.agency';
  const forwardTo = (): string => q.getSetting('site_inquiries_email', FORWARD_DEFAULT).trim();
  /** Emails the enquiry to the team's inbox from the connected Gmail account, with Reply-To set to the enquirer. */
  const forwardInquiry = async (inq: SiteInquiry, actor = 'dashboard'): Promise<SiteInquiry> => {
    const to = forwardTo();
    if (!to) throw new HttpError(400, 'No forwarding address set (Website enquiries › Settings).');
    if (!gmail.connected) throw new HttpError(400, 'Connect Gmail on the Outreach emails page first; the forward is sent from that account.');
    const isCall = inq.kind === 'call';
    const who = `${inq.name}${inq.brand ? ` (${inq.brand})` : ''}`;
    const lines = [
      isCall ? `${inq.name} asked for a call through brightform.agency.` : `${inq.name} sent a message through brightform.agency.`,
      '',
      `Name: ${inq.name}`,
      `Email: ${inq.email}`,
      ...(inq.brand ? [`Brand / company: ${inq.brand}`] : []),
      ...(inq.phone ? [`Phone: ${inq.phone}`] : []),
      ...(inq.preferred_time ? [`Preferred time: ${inq.preferred_time}`] : []),
      ...(inq.language ? [`Site language: ${inq.language.toUpperCase()}`] : []),
      ...(inq.page ? [`Page: ${inq.page}`] : []),
      '',
      isCall ? 'Their details:' : 'Message:',
      inq.message,
      '',
      `Reply to this email and it goes straight to ${inq.email}.`,
      `Dashboard: ${config.publicUrl}/inquiries`,
    ];
    await gmail.sendMessage({ to, replyTo: inq.email, replyToName: inq.name, subject: isCall ? `Call request: ${who}` : `Website enquiry: ${who}`, body: lines.join('\n') });
    q.addInquiryEvent(inq.id, { kind: 'forwarded', actor, detail: `Emailed to ${to} from ${gmail.email ?? 'the shared Gmail'}` });
    return q.updateInquiry(inq.id, { forwarded_at: new Date().toISOString() }) ?? inq;
  };
  r.post('/site/contact', async (req, res) => {
    if (!contactCors(req, res)) return res.status(403).json({ error: 'Origin not allowed' });
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const h = contactHits.get(ip);
    if (h && h.until > now && h.count >= 5) return res.status(429).json({ error: 'Too many messages from this network. Email us instead.' });
    contactHits.set(ip, h && h.until > now ? { count: h.count + 1, until: h.until } : { count: 1, until: now + 3600000 });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind: SiteInquiry['kind'] = b.kind === 'call' ? 'call' : 'contact';
    const name = String(b.name ?? '').trim().slice(0, 100);
    const email = String(b.email ?? '').trim().slice(0, 255);
    const brand = optText(b.brand)?.slice(0, 150) ?? null;
    const phone = optText(b.phone)?.slice(0, 40) ?? null;
    const preferred_time = optText(b.preferred_time)?.slice(0, 80) ?? null;
    const message = String(b.message ?? '').trim().slice(0, 2000);
    // Honeypot: real people leave the hidden field empty.
    if (optText(b.website)) return res.status(201).json({ ok: true });
    if (!name || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Name, a valid email and a message are required.' });
    if (q.recentInquiryFrom(email, 2)) return res.status(201).json({ ok: true, duplicate: true });
    const inquiry = q.createInquiry({ kind, name, email, brand, message, phone, preferred_time, language: optText(b.language)?.slice(0, 8) ?? null, page: optText(b.page)?.slice(0, 200) ?? null, gclid: optText(b.gclid)?.slice(0, 200) ?? null, ip });
    q.addInquiryEvent(inquiry.id, { kind: 'created', actor: 'website', detail: `${kind === 'call' ? 'Call request' : 'Message'} from ${name}${inquiry.page ? ` on ${inquiry.page}` : ''}${inquiry.gclid ? ', arrived from a Google Ads click' : ''}` });
    liveEvents.emitUpdate({ kind: 'inquiries' });
    // The visitor gets their answer now; Slack and the email forward follow without holding the form up.
    res.status(201).json({ ok: true });
    const channel = q.getSetting('site_inquiries_channel', '') || q.getSetting('incidents_default_channel', '');
    if (slackBot.configured && channel) {
      try {
        const head = kind === 'call' ? `:telephone_receiver: *Call request* from *${name}*` : `:incoming_envelope: *New website enquiry* from *${name}*`;
        const text = [`${head}${brand ? ` (${brand})` : ''}`, `*Email:* ${email}`, ...(phone ? [`*Phone:* ${phone}`] : []), ...(preferred_time ? [`*Preferred time:* ${preferred_time}`] : []), `*${kind === 'call' ? 'Details' : 'Message'}:*\n${message.slice(0, 1500)}`, `<${config.publicUrl}/inquiries|Open in the dashboard>`].join('\n');
        const posted = await slackBot.post(await slackBot.channelId(channel), text);
        q.updateInquiry(inquiry.id, { slack_ts: posted.ts });
        q.addInquiryEvent(inquiry.id, { kind: 'slack', actor: 'dashboard', detail: `Posted to ${channel}` });
      } catch (err) { log.warn(`Website enquiry Slack post failed: ${(err as Error).message}`); }
    }
    if (forwardTo() && gmail.connected) {
      try { await forwardInquiry(inquiry); liveEvents.emitUpdate({ kind: 'inquiries' }); } catch (err) { log.warn(`Website enquiry email forward failed: ${(err as Error).message}`); }
    } else if (forwardTo()) log.warn(`Website enquiry from ${email} not forwarded by email: Gmail is not connected`);
  });

  // ---- Everything below needs a session ----
  r.use(requireAuth(auth));
  if (auth instanceof SharedPasswordAuth) r.use(requireAdminForWrites(auth));

  r.get('/status', (_req, res) => {
    res.json({ public_url: config.publicUrl, retention_days: config.runRetentionDays, build: process.env.GIT_SHA?.trim() || 'dev', started_at: STARTED_AT });
  });

  r.get('/meta', (_req, res) => {
    res.json({ cron_presets: CRON_PRESETS, timezones: Intl.supportedValuesOf('timeZone') });
  });

  r.get('/cron/describe', (req, res) => {
    const expr = String(req.query.expr ?? '');
    const tz = String(req.query.tz ?? 'Europe/Madrid');
    const error = validateCron(expr) ?? (isValidTimezone(tz) ? null : `Unknown timezone "${tz}".`);
    res.json({
      error,
      text: error ? null : describeSchedule(expr, tz),
      next_run_at: error ? null : nextRun(expr, tz)?.toISOString() ?? null,
    });
  });

  const accountRows = (date: string): AccountStatusRow[] => {
    const checks = new Map(q.listChecksForDate(date).map((c) => [c.account_id, c]));
    const lives = new Map(q.listLive(date).map((c) => [c.account_id, c]));
    return q.listAccounts().map((account) => ({
      account,
      check: checks.get(account.id) ?? null,
      live: lives.get(account.id) ?? null,
      ...(() => { const c = q.checklistSource(account.id); return { checklist_source: c.source, checklist_items: c.items }; })(),
    }));
  };

  // ---- Live updates (server-sent events) ----
  r.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    const onUpdate = (e: unknown) => res.write(`event: update\ndata: ${JSON.stringify(e)}\n\n`);
    liveEvents.on('update', onUpdate);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      liveEvents.off('update', onUpdate);
      clearInterval(ping);
    });
  });

  r.get('/checks/:id/live', (req, res) => {
    const check = q.getLive(idParam(req));
    if (!check) throw new HttpError(404, 'No live status for this account yet');
    res.json({ check });
  });

  const checkTz = () => q.getSetting('check_timezone', 'Europe/Madrid');

  r.get('/accounts', (_req, res) => {
    res.json({ accounts: accountRows(todayIn(checkTz())) });
  });

  r.post('/accounts', (req, res) => {
    const account = q.createAccount(parseAccountInput(req.body ?? {}));
    checkAccount(q, account, { trigger: 'live', tz: checkTz() });
    res.status(201).json({ account });
  });

  r.put('/accounts/:id', (req, res) => {
    const id = idParam(req);
    const account = q.updateAccount(id, parseAccountInput(req.body ?? {}));
    if (!account) throw new HttpError(404, 'Account not found');
    checkAccount(q, account, { trigger: 'live', tz: checkTz() });
    res.json({ account });
  });

  r.patch('/accounts/:id', (req, res) => {
    const id = idParam(req);
    const existing = q.getAccount(id);
    if (!existing) throw new HttpError(404, 'Account not found');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing, ...body };
    res.json({ account: q.updateAccount(id, parseAccountInput(merged)) });
  });

  r.delete('/accounts/:id', (req, res) => {
    if (!q.deleteAccount(idParam(req))) throw new HttpError(404, 'Account not found');
    res.json({ ok: true });
  });

  r.post('/accounts/:id/check', (req, res) => {
    const account = q.getAccount(idParam(req));
    if (!account) throw new HttpError(404, 'Account not found');
    const check = checkAccount(q, account, { trigger: 'manual', tz: checkTz() });
    res.json({ check });
  });

  // ---- Checklist checks ----
  r.get('/checks', (req, res) => {
    const date = String(req.query.date ?? '') || todayIn(checkTz());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    res.json({ date, today: todayIn(checkTz()), rows: accountRows(date), dates: q.listCheckDates(60), is_running: isCheckRunning() });
  });

  r.post('/checks/run', async (_req, res) => {
    const results = await runAllChecks(q, { trigger: 'manual' });
    if (!results) return res.status(409).json({ error: 'A check is already running. Try again in a moment.' });
    res.json({ checked: results.length, rows: accountRows(todayIn(checkTz())) });
  });

  r.get('/checks/:id', (req, res) => {
    const check = q.getCheck(idParam(req));
    if (!check) throw new HttpError(404, 'Check not found');
    res.json({ check });
  });

  // ---- Check settings ----
  const settingsPayload = (): CheckSettings => {
    const cron = q.getSetting('check_cron', '0 16 * * 1-5');
    const tz = checkTz();
    return {
      check_cron: cron,
      check_timezone: tz,
      check_enabled: q.getSetting('check_enabled', '1') === '1',
      check_slack_webhook: q.getSetting('check_slack_webhook', ''),
      schedule_text: describeSchedule(cron, tz),
      next_run_at: scheduler.nextCheckAt()?.toISOString() ?? null,
      is_running: isCheckRunning(),
    };
  };

  r.get('/check-settings', (_req, res) => res.json({ settings: settingsPayload() }));

  r.put('/check-settings', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cron = String(body.check_cron ?? '').trim();
    const tz = String(body.check_timezone ?? 'Europe/Madrid').trim();
    const webhook = String(body.check_slack_webhook ?? '').trim();
    const cronError = validateCron(cron);
    if (cronError) throw new HttpError(400, cronError);
    if (!isValidTimezone(tz)) throw new HttpError(400, `Unknown timezone "${tz}".`);
    if (webhook && !/^https:\/\/hooks\.slack\.com\//.test(webhook)) throw new HttpError(400, 'Slack webhook must start with https://hooks.slack.com/');
    q.setSetting('check_cron', cron);
    q.setSetting('check_timezone', tz);
    q.setSetting('check_enabled', bool(body.check_enabled, true) ? '1' : '0');
    q.setSetting('check_slack_webhook', webhook);
    scheduler.reloadCheckSchedule();
    liveEvents.emitUpdate({ kind: 'settings' });
    res.json({ settings: settingsPayload() });
  });

  /** Re-evaluate today's live status for every account (after editing items, or just to be sure). */
  r.post('/checklists/refresh', (_req, res) => {
    const n = refreshLive(q);
    res.json({ ok: true, refreshed: n, rows: accountRows(todayIn(checkTz())) });
  });

  // ---- Native checklist: items (template or per account) and ticks ----
  const parseItem = (body: Record<string, unknown>): Partial<ChecklistItemInput> => {
    const out: Partial<ChecklistItemInput> = {};
    if (body.name !== undefined) { const name = String(body.name ?? '').trim(); if (!name) throw new HttpError(400, 'Name is required.'); out.name = name; }
    if (body.section !== undefined) out.section = String(body.section ?? '').trim();
    if (body.guidance !== undefined) out.guidance = optText(body.guidance);
    if (body.role !== undefined) out.role = body.role === 'aa' ? 'aa' : 'am';
    if (body.frequency !== undefined) out.frequency = body.frequency === 'weekly' ? 'weekly' : 'daily';
    if (body.weekday !== undefined) { const w = int(body.weekday, 1); if (w < 1 || w > 7) throw new HttpError(400, 'Weekday must be 1 (Monday) to 7 (Sunday).'); out.weekday = w; }
    if (body.position !== undefined) out.position = int(body.position, 0);
    if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
    if (body.parent_id !== undefined) out.parent_id = body.parent_id === null || body.parent_id === '' ? null : int(body.parent_id, 0) || null;
    if (body.account_id !== undefined) out.account_id = body.account_id === null || body.account_id === '' ? null : int(body.account_id, 0) || null;
    return out;
  };

  /** The template, or an account's effective list (with where it comes from). */
  r.get('/checklists/items', (req, res) => {
    const accountId = req.query.account_id ? Number(req.query.account_id) : null;
    if (accountId) {
      const account = q.getAccount(accountId);
      if (!account) throw new HttpError(404, 'Account not found');
      const src = q.checklistSource(accountId);
      res.json({ account, source: src.source, items: q.checklistItemsFor(accountId), template: q.listTemplateItems() });
    } else {
      res.json({ account: null, source: 'template', items: q.listTemplateItems(), template: q.listTemplateItems() });
    }
  });

  r.post('/checklists/items', (req, res) => {
    const b = parseItem((req.body ?? {}) as Record<string, unknown>);
    if (!b.name) throw new HttpError(400, 'Name is required.');
    if (b.parent_id) {
      const parent = q.getChecklistItem(b.parent_id);
      if (!parent) throw new HttpError(404, 'Parent item not found');
      b.account_id = parent.account_id;
      b.section = b.section ?? parent.section;
    }
    if (b.account_id) {
      // Adding to an account that still follows the template: give it its own copy first so the rest stays.
      if (!q.listAccountItems(b.account_id).length) q.customiseChecklist(b.account_id);
    }
    const item = q.createChecklistItem({ ...b, name: b.name });
    refreshLive(q);
    liveEvents.emitUpdate({ kind: 'settings' });
    res.status(201).json({ item });
  });

  r.put('/checklists/items/:id', (req, res) => {
    const item = q.updateChecklistItem(idParam(req), parseItem((req.body ?? {}) as Record<string, unknown>));
    if (!item) throw new HttpError(404, 'Item not found');
    refreshLive(q);
    liveEvents.emitUpdate({ kind: 'settings' });
    res.json({ item });
  });

  r.delete('/checklists/items/:id', (req, res) => {
    if (!q.deleteChecklistItem(idParam(req))) throw new HttpError(404, 'Item not found');
    refreshLive(q);
    liveEvents.emitUpdate({ kind: 'settings' });
    res.json({ ok: true });
  });

  /** Reorder siblings: ids in the new order. */
  r.put('/checklists/items/reorder', (req, res) => {
    const ids = ((req.body ?? {}) as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be an array');
    ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).forEach((id, i) => q.updateChecklistItem(id, { position: i }));
    liveEvents.emitUpdate({ kind: 'settings' });
    res.json({ ok: true });
  });

  /** Give an account its own editable copy of the template. */
  r.post('/checklists/accounts/:id/customise', (req, res) => {
    const account = q.getAccount(idParam(req));
    if (!account) throw new HttpError(404, 'Account not found');
    const items = q.customiseChecklist(account.id);
    checkAccount(q, account, { trigger: 'live', tz: checkTz() });
    res.json({ items, source: 'custom' });
  });

  /** Back to the template (drops the account's own list). */
  r.post('/checklists/accounts/:id/reset', (req, res) => {
    const account = q.getAccount(idParam(req));
    if (!account) throw new HttpError(404, 'Account not found');
    q.resetChecklist(account.id);
    checkAccount(q, account, { trigger: 'live', tz: checkTz() });
    res.json({ items: q.listTemplateItems(), source: 'template' });
  });

  /** Tick or untick one line for an account (today by default). Account managers can do this too. */
  r.post('/checklists/tick', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const accountId = int(b.account_id, 0);
    const itemId = int(b.item_id, 0);
    const account = q.getAccount(accountId);
    if (!account) throw new HttpError(404, 'Account not found');
    const item = q.getChecklistItem(itemId);
    if (!item) throw new HttpError(404, 'Checklist item not found');
    if (!q.checklistItemsFor(accountId).some((i) => i.id === itemId)) throw new HttpError(400, 'That item is not on this account\'s checklist.');
    const tz = checkTz();
    const date = String(b.date ?? '') || todayIn(tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    if (date > todayIn(tz)) throw new HttpError(400, 'Cannot tick a future day.');
    const done = bool(b.done, true);
    const tick = q.setTick(accountId, itemId, date, done, actorOf(req), optText(b.note));
    const check = checkAccount(q, account, { trigger: 'live', tz, date });
    res.json({ tick, check, due: isDue(item, date) });
  });

  /** Tick every line due today for an account in one go (or untick all). */
  r.post('/checklists/tick-all', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const account = q.getAccount(int(b.account_id, 0));
    if (!account) throw new HttpError(404, 'Account not found');
    const role = b.role === 'am' || b.role === 'aa' ? (b.role as 'am' | 'aa') : null;
    const tz = checkTz();
    const date = String(b.date ?? '') || todayIn(tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayIn(tz)) throw new HttpError(400, 'date must be today or earlier, YYYY-MM-DD');
    const done = bool(b.done, true);
    let n = 0;
    for (const item of q.checklistItemsFor(account.id).filter((i) => i.enabled && isDue(i, date) && (!role || i.role === role))) {
      q.setTick(account.id, item.id, date, done, actorOf(req));
      n += 1;
    }
    res.json({ changed: n, check: checkAccount(q, account, { trigger: 'live', tz, date }) });
  });

  // ---- People (AMs) and Slack reminders ----
  const parsePerson = (body: Record<string, unknown>): PersonInput => {
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Name is required.');
    const role = body.role === 'aa' ? 'aa' : 'am';
    const email = optText(body.email);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Email looks wrong.');
    const slack = optText(body.slack_user_id);
    if (slack && !/^[UW][A-Z0-9]{6,}$/.test(slack)) throw new HttpError(400, 'Slack user id should look like U0123ABCDEF.');
    return { name, role, email, slack_user_id: slack, notify: bool(body.notify, true) };
  };

  r.get('/people', (_req, res) => res.json({ people: q.listPeople() }));
  r.post('/people', (req, res) => res.status(201).json({ person: q.createPerson(parsePerson(req.body ?? {})) }));
  r.put('/people/:id', (req, res) => {
    const person = q.updatePerson(idParam(req), parsePerson(req.body ?? {}));
    if (!person) throw new HttpError(404, 'Person not found');
    res.json({ person });
  });
  r.delete('/people/:id', (req, res) => {
    if (!q.deletePerson(idParam(req))) throw new HttpError(404, 'Person not found');
    res.json({ ok: true });
  });

  /** Send a test DM to one person. */
  r.post('/people/:id/test-dm', async (req, res) => {
    const person = q.getPerson(idParam(req));
    if (!person) throw new HttpError(404, 'Person not found');
    if (!slackBot.configured) throw new HttpError(400, 'SLACK_BOT_TOKEN is not set. Add it to .env and restart.');
    const to = person.slack_user_id || person.email;
    if (!to) throw new HttpError(400, 'Add a Slack user id or email first.');
    const error = await slackBot.tryDm(to, `Test from the AM checklist dashboard. Reminders for ${person.name} will arrive here. <${config.publicUrl}/checklists|Open dashboard>`);
    if (error) throw new HttpError(502, error);
    res.json({ ok: true });
  });

  /** Send the reminder now to every AM whose checklist is not done, based on the latest checks. */
  r.post('/reminders/send', async (_req, res) => {
    const tz = checkTz();
    const checks = q.listChecksForDate(todayIn(tz));
    if (!checks.length) throw new HttpError(400, 'No checks recorded today yet. Run "Check all now" first.');
    if (!slackBot.configured) throw new HttpError(400, 'SLACK_BOT_TOKEN is not set. Add it to .env and restart.');
    const results = await notifyAms(q, checks, { deadline: deadlineLabel(q), force: true });
    res.json({ results });
  });

  /** Preview what each AM would receive right now. No DMs are sent. */
  r.get('/reminders/preview', (_req, res) => {
    const tz = checkTz();
    const checks = q.listChecksForDate(todayIn(tz));
    const template = q.getSetting('reminder_text', '') || DEFAULT_REMINDER_TEXT;
    const groups = incompleteByPerson(q.listPeople(), q.listAccounts(), checks);
    res.json({
      messages: [...groups.values()].map(({ person, accounts }) => ({
        person: person.name,
        to: person.slack_user_id || person.email || null,
        notify: person.notify,
        text: renderReminder(template, person, accounts, deadlineLabel(q)),
      })),
    });
  });

  const reminderSettings = (): ReminderSettings => ({
    notify_ams_enabled: q.getSetting('notify_ams_enabled', '0') === '1',
    reminder_cron: q.getSetting('reminder_cron', '0 14 * * 1-5'),
    reminder_text: q.getSetting('reminder_text', '') || DEFAULT_REMINDER_TEXT,
    next_reminder_at: scheduler.nextReminderAt()?.toISOString() ?? null,
    slack_bot_configured: slackBot.configured,
  });

  r.get('/reminder-settings', (_req, res) => res.json({ settings: reminderSettings() }));
  r.put('/reminder-settings', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cronExpr = String(body.reminder_cron ?? '').trim();
    const cronError = validateCron(cronExpr);
    if (cronError) throw new HttpError(400, cronError);
    q.setSetting('reminder_cron', cronExpr);
    q.setSetting('notify_ams_enabled', bool(body.notify_ams_enabled, false) ? '1' : '0');
    q.setSetting('reminder_text', String(body.reminder_text ?? '').trim());
    scheduler.reloadReminderSchedule();
    res.json({ settings: reminderSettings() });
  });

  // ---- Calendar ----
  const monthParam = (req: Request): string => {
    const m = String(req.query.month ?? '') || todayIn(checkTz()).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) throw new HttpError(400, 'month must be YYYY-MM');
    return m;
  };

  r.get('/calendar', (req, res) => res.json(buildCalendar(q, monthParam(req))));
  r.get('/calendar/alerts', (req, res) => res.json(buildAlertCalendar(q, monthParam(req))));

  // ---- GMV ----
  r.get('/gmv', (req, res) => res.json(buildGmv(q, monthParam(req))));
  r.get('/gmv/explore', (req, res) => {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const to = String(req.query.to ?? '').trim() || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const from = String(req.query.from ?? '').trim() || new Date(Date.parse(to + 'T12:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
    if (!iso.test(from) || !iso.test(to) || from > to) throw new HttpError(400, 'Give from and to as YYYY-MM-DD with from on or before to.');
    const accountId = req.query.account_id ? Number(req.query.account_id) : null;
    res.json(buildGmvExplore(q, from, to, { accountId: Number.isFinite(accountId) ? accountId : null }));
  });

  r.put('/gmv/targets', (req, res) => {
    const body = (req.body ?? {}) as { month?: string; targets?: Record<string, unknown> };
    const month = String(body.month ?? '');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
    for (const [id, v] of Object.entries(body.targets ?? {})) {
      const accountId = Number(id);
      if (!q.getAccount(accountId)) continue;
      const n = v === null || v === '' ? null : Number(v);
      if (n !== null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, `Bad target for account ${id}`);
      q.setTarget(accountId, month, n);
    }
    res.json(buildGmv(q, month));
  });

  r.post('/gmv/targets/copy', (req, res) => {
    const body = (req.body ?? {}) as { from?: string; to?: string };
    if (!/^\d{4}-\d{2}$/.test(String(body.from)) || !/^\d{4}-\d{2}$/.test(String(body.to))) throw new HttpError(400, 'from and to must be YYYY-MM');
    res.json({ copied: q.copyTargets(String(body.from), String(body.to)) });
  });

  r.post('/gmv/sync', async (_req, res) => {
    const sync = await syncGmv(q, { days: 40 });
    if (!sync) return res.status(409).json({ error: 'A sync is already running.' });
    res.json({ sync });
  });

  /** Manual import: rows of { shop_id, date, total_gmv, affiliate_gmv?, units? }. Used when the API key is not set. */
  r.post('/gmv/import', (req, res) => {
    const body = (req.body ?? {}) as { rows?: Record<string, unknown>[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const known = new Set(q.listShops().map((s) => s.shop_id));
    const clean = rows
      .map((r) => ({
        shop_id: String(r.shop_id ?? ''),
        date: String(r.date ?? '').slice(0, 10),
        total_gmv: Number(r.total_gmv ?? r.gmv ?? 0),
        affiliate_gmv: Number(r.affiliate_gmv ?? 0),
        units: Math.round(Number(r.units ?? r.total_units_sold ?? 0)),
        source: 'import',
      }))
      .filter((r) => known.has(r.shop_id) && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.total_gmv));
    res.json({ imported: q.upsertGmv(clean), skipped: rows.length - clean.length });
  });

  r.get('/gmv/shops', (_req, res) => res.json({ shops: q.listShops() }));
  r.post('/gmv/shops', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const accountId = Number(body.account_id);
    const shopId = String(body.shop_id ?? '').trim();
    const shopName = String(body.shop_name ?? '').trim() || shopId;
    if (!q.getAccount(accountId)) throw new HttpError(404, 'Account not found');
    if (!/^[a-f0-9]{24}$/i.test(shopId)) throw new HttpError(400, 'Cruva shop id should be 24 hex characters.');
    const currency = String(body.currency ?? '').trim().toUpperCase() || currencyForShop(shopName);
    res.status(201).json({ shop: q.addShop(accountId, shopId, shopName, currency) });
  });

  /** Commission deals per account plus the month's actual net settlement for MoR accounts. */
  r.put('/gmv/deals', (req, res) => {
    const body = (req.body ?? {}) as { month?: string; deals?: Record<string, Record<string, unknown>>; am_share_pct?: unknown };
    const month = String(body.month ?? '');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
    if (body.am_share_pct !== undefined) {
      const s = Number(body.am_share_pct);
      if (!Number.isFinite(s) || s < 0 || s > 100) throw new HttpError(400, 'AM share % must be between 0 and 100.');
      q.setSetting('am_share_pct', String(s));
    }
    for (const [id, d] of Object.entries(body.deals ?? {})) {
      const accountId = Number(id);
      if (!q.getAccount(accountId)) continue;
      q.setAccountDeal(accountId, parseDeal(d));
      if ('net_settlement' in d) {
        const v = d.net_settlement;
        const n = v === null || v === '' || v === undefined ? null : Number(v);
        if (n !== null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, `Bad net settlement for account ${id}`);
        q.setSettlement(accountId, month, n);
      }
    }
    res.json(buildGmv(q, month));
  });

  r.put('/gmv/settings', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fx: Record<string, number> = {};
    for (const [k, v] of Object.entries((body.fx_to_eur ?? {}) as Record<string, unknown>)) {
      const n = Number(v);
      if (!/^[A-Z]{3}$/i.test(k) || !Number.isFinite(n) || n <= 0) throw new HttpError(400, `Bad FX rate for ${k}`);
      fx[k.toUpperCase()] = n;
    }
    const threshold = Number(body.bonus_threshold ?? 30000);
    const below = Number(body.bonus_growth_below ?? 100);
    const above = Number(body.bonus_growth_above ?? 40);
    if (![threshold, below, above].every((n) => Number.isFinite(n) && n >= 0)) throw new HttpError(400, 'Bonus rule values must be numbers.');
    q.setSetting('fx_to_eur', JSON.stringify(fx));
    q.setSetting('bonus_threshold', String(threshold));
    q.setSetting('bonus_growth_below', String(below));
    q.setSetting('bonus_growth_above', String(above));
    res.json(buildGmv(q, String(body.month ?? '') || todayIn(checkTz()).slice(0, 7)));
  });
  // ---- Connections: one place to see every integration and whether it is live ----
  r.get('/connections', (_req, res) => {
    const w = windsorStatus(q);
    const wShops = q.listShops('windsor');
    const hs = scheduler.health.data();
    const ttsShops = q.listTtsShops();
    const ap = apolloStatus(q);
    const fm = fastmossStatus(q);
    const gm = q.lastGmvSync();
    const leads = leadsSyncStatus(q);
    const gmailClient = scheduler.gmail;
    res.json({
      connections: [
        { key: 'windsor', name: 'Windsor.ai (TikTok Shop data)', role: 'Shops, orders, stock and payouts for account management and GMV', configured: w.configured, ok: w.configured && !w.last_error, detail: !w.configured ? 'WINDSOR_API_KEY not set' : w.last_error ? `Last sync error: ${w.last_error}` : `${w.discovered.length} shop(s) discovered, ${wShops.length} linked to accounts${w.last_sync_at ? `, last sync ${w.last_sync_at}` : ', never synced'}`, link: '/gmv', testable: w.configured },
        { key: 'cruva_mcp', name: 'Cruva MCP (best practice rollout)', role: 'The portal reads every Cruva shop\'s automations, groups, lists, briefs and senders and rolls out the missing pieces through mcp.cruva.com', configured: scheduler.playbook.data().mcp_configured, ok: scheduler.playbook.data().mcp_configured && !scheduler.playbook.data().last_error && Boolean(scheduler.playbook.data().last_check_at), detail: !scheduler.playbook.data().mcp_configured ? 'CRUVA_API_KEY not set (Cruva › Dashboard › API › Generate API key)' : scheduler.playbook.data().last_check_at ? `${scheduler.playbook.data().shops.length} shop(s) linked, last check ${scheduler.playbook.data().last_check_at}${scheduler.playbook.data().last_error ? `; ${scheduler.playbook.data().last_error}` : ''}` : 'Key set, no check yet (Accounts › Cruva › Sync shops)', link: '/cruva', testable: scheduler.playbook.data().mcp_configured },
        { key: 'cruva', name: 'Cruva (REST API pull)', role: 'Every 4 hours: daily GMV, affiliate GMV, units, videos, DMs, samples, performance score and stock per SKU for every linked shop; fills the Overview, GMV and Stock pages wherever the TikTok app is not connected', configured: scheduler.cruvaPull.status().configured, ok: scheduler.cruvaPull.status().configured && Boolean(scheduler.cruvaPull.status().last_run_at) && !scheduler.cruvaPull.status().last_error, detail: !scheduler.cruvaPull.status().configured ? `CRUVA_API_KEY not set; ${q.listShops('cruva').length} Cruva shop(s) linked` : scheduler.cruvaPull.status().last_run_at ? `${scheduler.cruvaPull.status().shops_ok}/${scheduler.cruvaPull.status().shops} shop(s) pulled, last ${scheduler.cruvaPull.status().last_run_at}${scheduler.cruvaPull.status().last_error ? `; ${scheduler.cruvaPull.status().last_error}` : ''}` : 'Key set, first pull runs shortly after start', link: '/monitor', testable: scheduler.cruvaPull.status().configured },
        { key: 'tts', name: 'TikTok Shop Partner app', role: 'Promotions push and the CS / affiliate inbox (needs Partner Center approval)', configured: tts.configured, ok: tts.configured && ttsShops.length > 0 && ttsShops.every((s) => s.token_ok), detail: !tts.configured ? 'TTS_APP_KEY / TTS_APP_SECRET not set' : ttsShops.length ? `${ttsShops.length} shop(s) authorised${ttsShops.some((s) => !s.token_ok) ? ', some tokens expired' : ''}` : 'app configured, no shop authorised yet', link: '/promotions', testable: false },
        { key: 'apollo', name: 'Apollo.io', role: 'Decision makers for the BD pipeline', configured: ap.configured, ok: ap.configured && ap.ok && !ap.exhausted, detail: !ap.configured ? 'APOLLO_API_KEY not set' : ap.exhausted ? 'out of credits' : ap.error ? ap.error : `${ap.remaining ?? '?'} credits left`, link: '/bd', testable: true },
        { key: 'fastmoss', name: 'FastMoss', role: 'Daily pull of fast-rising shops', configured: fm.configured, ok: fm.configured && !fm.last_error, detail: !fm.configured ? 'FASTMOSS_API_KEY not set' : fm.last_error ? fm.last_error : fm.last_pull_at ? `last pull ${fm.last_pull_at}` : 'no pull yet', link: '/bd', testable: true },
        { key: 'gmail', name: 'Gmail', role: 'Outreach drafts and the TikTok Shop contact import', configured: gmailClient.configured, ok: gmailClient.connected, detail: !gmailClient.configured ? 'GOOGLE_CLIENT_ID / SECRET not set' : gmailClient.connected ? `connected as ${gmailClient.email ?? 'unknown'}` : 'not connected: Outreach emails › Settings › Connect Gmail', link: '/outreach?tab=settings', testable: false },
        { key: 'health', name: 'Account health (Windsor daily pull)', role: 'Orders, ship-by deadlines, stock, payouts, statements and unsettled money per shop, daily at 06:30, feeding the Monitor flags and the AI review', configured: w.configured && wShops.length > 0, ok: w.configured && wShops.length > 0 && Boolean(hs.last_pull_at) && !hs.last_pull_error, detail: !w.configured ? 'Needs Windsor.ai' : !wShops.length ? 'Link shops to accounts below' : hs.last_pull_at ? `${hs.pulls.filter((p) => p.source === 'windsor').length} shop(s) pulled, last ${hs.last_pull_at}${hs.last_pull_error ? `; ${hs.last_pull_error}` : ''}` : 'No pull yet (runs at 06:30, or press Run daily pass on the Monitor page)', link: '/monitor', testable: false },
        { key: 'tts_monitor', name: 'Account monitor (TikTok Shop API)', role: 'Every authorised shop linked to an account is pulled on each monitor scan (analytics, orders, products, returns, samples, CS, finance, as far as the app\'s scopes allow) and checked against the targets per account', configured: tts.configured, ok: tts.configured && Boolean(hs.tts_last_pull_at) && !hs.tts_last_pull_error, detail: !tts.configured ? 'Needs TTS_APP_KEY / TTS_APP_SECRET' : !q.listTtsShops().some((s) => s.account_id) ? 'Authorise shops under Promotions › Connection and link them to accounts' : hs.tts_last_pull_at ? `${hs.pulls.filter((p) => p.source === 'tts').length} shop(s) pulled, last ${hs.tts_last_pull_at}${hs.tts_last_pull_error ? `; ${hs.tts_last_pull_error}` : ''}` : 'No pull yet (runs on the next scan, or press Pull TikTok now on the Account monitor)', link: '/monitor', testable: false },
        { key: 'routine', name: 'Daily review routine (Claude)', role: 'An optional scheduled Claude routine can post findings and an assessment per account to /api/flags/ingest; the fixed rules no longer depend on it', configured: Boolean(config.ingestToken), ok: Boolean(config.ingestToken) && Boolean(hs.last_ingest_at) && Date.now() - Date.parse(hs.last_ingest_at ?? '') < 2 * 86400000, detail: !config.ingestToken ? 'INGEST_TOKEN not set in .env' : hs.last_ingest_at ? `Last post ${hs.last_ingest_at}` : 'Token set, nothing posted yet', link: '/monitor?tab=review', testable: false },
        { key: 'slack', name: 'Slack bot', role: 'AM reminders, incident alerts, client reports', configured: slackBot.configured, ok: slackBot.configured, detail: slackBot.configured ? 'SLACK_BOT_TOKEN set' : 'SLACK_BOT_TOKEN not set', link: '/people', testable: false },
        { key: 'tldv', name: 'tl;dv', role: 'Follow-up emails after calls', configured: tldv.configured, ok: tldv.configured, detail: tldv.configured ? 'TLDV_API_KEY set' : 'TLDV_API_KEY not set', link: '/outreach', testable: false },
        { key: 'anthropic', name: 'Anthropic API', role: 'Drafting replies, reports and the copilot', configured: Boolean(config.anthropicApiKey), ok: Boolean(config.anthropicApiKey), detail: config.anthropicApiKey ? `model ${config.replyModel}` : 'ANTHROPIC_API_KEY not set', link: '/inbox', testable: false },
        { key: 'leads', name: 'Lead sheet', role: 'Leads dashboard', configured: leads.status !== 'never', ok: leads.status === 'ok', detail: leads.error ? leads.error : leads.last_sync_at ? `${leads.rows} rows, last sync ${leads.last_sync_at}` : 'not synced yet', link: '/leads', testable: false },
      ],
    });
  });

  // ---- Windsor.ai (TikTok Shop data without our own Partner Center app) ----
  const windsorPayload = (): WindsorStatus => ({ ...windsorStatus(q), shops: q.listShops('windsor') });
  r.get('/windsor/status', (_req, res) => res.json(windsorPayload()));
  /** Read the shop list from the connector and auto-link the ones whose name matches a roster account. */
  r.post('/windsor/discover', async (_req, res) => {
    if (!windsor.configured) throw new HttpError(400, 'WINDSOR_API_KEY is not set. Add it to .env (Windsor.ai › API key) and restart.');
    const r2 = await discoverWindsorShops(q);
    res.json({ ...windsorPayload(), found: r2.shops.length, linked: r2.linked });
  });
  /** Link (or re-link) a discovered Windsor shop to a roster account. */
  r.post('/windsor/shops', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const accountId = Number(b.account_id);
    const shopId = String(b.shop_id ?? '').trim();
    if (!q.getAccount(accountId)) throw new HttpError(404, 'Account not found');
    if (!shopId) throw new HttpError(400, 'shop_id is required');
    const known = windsorStatus(q).discovered.find((d) => d.account_id === shopId);
    const name = String(b.shop_name ?? '').trim() || known?.shop_name || shopId;
    const currency = String(b.currency ?? '').trim().toUpperCase() || currencyForMarket(known?.market ?? '');
    q.addShop(accountId, shopId, name, currency, 'windsor');
    res.status(201).json(windsorPayload());
  });
  r.delete('/windsor/shops/:id', (req, res) => {
    if (!q.removeShop(idParam(req))) throw new HttpError(404, 'Shop not found');
    res.json(windsorPayload());
  });
  /** Pull the last N days of orders into daily GMV for every linked Windsor shop. */
  r.post('/windsor/sync', async (req, res) => {
    if (!windsor.configured) throw new HttpError(400, 'WINDSOR_API_KEY is not set.');
    const days = Math.min(120, Math.max(1, int((req.body ?? {}).days, 40)));
    const r2 = await syncWindsorGmv(q, { days });
    if (r2.error) throw new HttpError(502, r2.error);
    res.json({ ...windsorPayload(), synced_shops: r2.shops, rows: r2.rows, days });
  });
  /** Connectivity test: one small read, the error text if it fails. */
  r.post('/windsor/test', async (_req, res) => {
    if (!windsor.configured) throw new HttpError(400, 'WINDSOR_API_KEY is not set.');
    // The test is also the discovery: whatever comes back is stored and linked by name, so the page reflects it.
    const shops = (await discoverWindsorShops(q)).shops;
    const first = windsor.lastCall;
    // A second variant with an explicit date range, in case the connector ignores presets for the shop table.
    let alt = 0;
    let altCall: typeof first = null;
    if (!shops.length) {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      try { alt = (await windsor.query<Record<string, unknown>>(['account_id', 'account_name', 'date', 'order_id'], { from, to })).length; } catch (err) { alt = -1; altCall = { url: '', status: null, body: (err as Error).message }; }
      altCall = altCall ?? windsor.lastCall;
    }
    res.json({ ok: true, shops: shops.length, linked: q.listShops('windsor').length, sample: shops.slice(0, 3).map((s) => `${s.shop_name} (${s.shop_region})`), debug: { shops_call: first, orders_30d_rows: shops.length ? null : alt, orders_call: altCall } });
  });

  r.delete('/gmv/shops/:id', (req, res) => {
    if (!q.removeShop(idParam(req))) throw new HttpError(404, 'Shop not found');
    res.json({ ok: true });
  });

  // ---- TikTok Shop connection ----
  const ttsStatus = (): TtsStatus => {
    const serviceId = q.getSetting('tts_service_id', '');
    const affServiceId = q.getSetting('tts_affiliate_service_id', '');
    return {
      configured: tts.configured,
      service_id: serviceId,
      authorize_url: serviceId ? authorizationUrl(serviceId, 'am-ops') : null,
      callback_url: `${config.publicUrl}/api/tts/callback`,
      shops: q.listTtsShops(),
      affiliate: {
        configured: ttsAffiliate.configured,
        service_id: affServiceId,
        authorize_url: affServiceId ? authorizationUrl(affServiceId, 'am-ops-affiliate') : null,
        callback_url: `${config.publicUrl}/api/tts/affiliate/callback`, // /api/affiliate/callback works too
      },
    };
  };

  r.get('/tts/status', (_req, res) => res.json(ttsStatus()));

  r.put('/tts/settings', (req, res) => {
    const b = (req.body ?? {}) as { service_id?: unknown; affiliate_service_id?: unknown };
    if (b.service_id !== undefined) q.setSetting('tts_service_id', String(b.service_id ?? '').trim());
    if (b.affiliate_service_id !== undefined) q.setSetting('tts_affiliate_service_id', String(b.affiliate_service_id ?? '').trim());
    res.json(ttsStatus());
  });

  /** Seller lands here after authorising the affiliate app: its token is stored next to the main one for every shop it covers. */
  r.get(['/tts/affiliate/callback', '/affiliate/callback'], async (req, res) => {
    const code = String(req.query.code ?? req.query.auth_code ?? '');
    if (!code) throw new HttpError(400, 'Missing auth code in the callback.');
    if (!ttsAffiliate.configured) throw new HttpError(400, 'TTS_AFFILIATE_APP_KEY / TTS_AFFILIATE_APP_SECRET are not set.');
    const tokens = await ttsAffiliate.exchangeCode(code);
    const shops = await ttsAffiliate.authorizedShops(tokens.access_token);
    for (const s of shops) {
      // A shop that has not authorised the main app yet gets a placeholder row (expired main token) so it shows up under Connection.
      if (!q.getTtsShop(s.id)) q.upsertTtsShop({ id: s.id, name: s.name, region: s.region, seller_type: s.seller_type, cipher: s.cipher, seller_name: tokens.seller_name ?? null }, { access_token: '', refresh_token: '', access_token_expire_in: 1, refresh_token_expire_in: 1 });
      q.upsertTtsShopApp(s.id, 'affiliate', tokens);
    }
    res.redirect('/promotions?affiliate=' + shops.length);
  });

  r.delete('/tts/shops/:id/affiliate', (req, res) => {
    if (!q.deleteTtsShopApp(String(req.params.id), 'affiliate')) throw new HttpError(404, 'This shop has no affiliate app authorisation');
    res.json(ttsStatus());
  });

  /** Seller lands here after authorising the app. Exchange the code and store every shop it covers. */
  r.get(['/tts/callback', '/callback'], async (req, res) => {
    const code = String(req.query.code ?? req.query.auth_code ?? '');
    if (!code) throw new HttpError(400, 'Missing auth code in the callback.');
    if (!tts.configured) throw new HttpError(400, 'TTS_APP_KEY / TTS_APP_SECRET are not set.');
    const tokens = await tts.exchangeCode(code);
    const shops = await tts.authorizedShops(tokens.access_token);
    for (const s of shops) q.upsertTtsShop({ id: s.id, name: s.name, region: s.region, seller_type: s.seller_type, cipher: s.cipher, seller_name: tokens.seller_name ?? null }, tokens);
    // Auto-link by name when an account matches (e.g. "Kijimea UK" → Kijimea, UK).
    for (const s of shops) {
      const market = marketFromRegion(s.region);
      const acc = q.listAccounts().find((a) => s.name.toLowerCase().startsWith(a.name.toLowerCase()));
      if (acc && !q.getTtsShop(s.id)?.account_id) q.linkTtsShop(s.id, acc.id, market);
    }
    res.redirect('/promotions?authorised=' + shops.length);
  });

  r.put('/tts/shops/:id/link', (req, res) => {
    const shop = q.getTtsShop(String(req.params.id));
    if (!shop) throw new HttpError(404, 'Shop not found');
    const body = (req.body ?? {}) as { account_id?: unknown; market?: unknown };
    const accountId = body.account_id === null || body.account_id === '' ? null : Number(body.account_id);
    if (accountId !== null && !q.getAccount(accountId)) throw new HttpError(404, 'Account not found');
    const market = String(body.market ?? '').trim().toUpperCase() || null;
    q.linkTtsShop(shop.id, accountId, market);
    res.json(ttsStatus());
  });

  r.delete('/tts/shops/:id', (req, res) => {
    if (!q.deleteTtsShop(String(req.params.id))) throw new HttpError(404, 'Shop not found');
    res.json(ttsStatus());
  });

  /** Quick analytics test: last N days of shop performance straight from the Analytics API, flattened for display. */
  r.get('/tts/shops/:id/analytics', async (req, res) => {
    const shop = q.getTtsShop(String(req.params.id));
    if (!shop) throw new HttpError(404, 'Shop not found');
    const days = Math.min(90, Math.max(1, int(req.query.days, 7)));
    const creds = await shopCredentials(q, shop.id);
    // Yesterday is the last full day; the API takes [start, end).
    const end = new Date(); end.setUTCDate(end.getUTCDate());
    const endIso = end.toISOString().slice(0, 10);
    const startIso = new Date(end.getTime() - days * 86400000).toISOString().slice(0, 10);
    const data = await tts.shopPerformance(creds, startIso, endIso, days > 1 ? '1D' : 'ALL');
    const intervals = data.performance?.intervals ?? [];
    const flat: Record<string, string> = {};
    const walk = (v: unknown, prefix: string) => {
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${prefix}[${i}]`)); return; }
      if (typeof v === 'object') { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, prefix ? `${prefix}.${k}` : k); return; }
      flat[prefix] = String(v);
    };
    // Totals over the period from the daily intervals (GMV and order counts), plus the raw last interval for inspection.
    let gmv = 0; let currency = ''; let orders = 0; let units = 0;
    for (const iv of intervals) {
      const sales = (iv as { sales?: Record<string, unknown> }).sales ?? {};
      const g = (sales.gmv as { overall?: { amount?: string; currency?: string } } | undefined)?.overall;
      if (g?.amount) { gmv += Number(g.amount) || 0; currency = g.currency ?? currency; }
      orders += Number((sales as { orders_count?: unknown; sku_orders_count?: unknown }).orders_count ?? (sales as { sku_orders_count?: unknown }).sku_orders_count ?? 0) || 0;
      units += Number((sales as { items_sold?: unknown }).items_sold ?? 0) || 0;
    }
    if (intervals.length) walk(intervals[intervals.length - 1], '');
    res.json({ shop: { id: shop.id, name: shop.name, region: shop.region }, start: startIso, end: endIso, latest_available_date: data.latest_available_date ?? null, days: intervals.length, gmv: Math.round(gmv * 100) / 100, currency, orders, units, last_interval: flat, raw: data });
  });

  r.get('/tts/shops/:id/products', async (req, res) => {
    const creds = await shopCredentials(q, String(req.params.id));
    const out: { id: string; title: string; status: string }[] = [];
    let token = '';
    for (let i = 0; i < 5; i++) {
      const page = await tts.searchProducts(creds, token);
      out.push(...(page.products ?? []).map((p) => ({ id: p.id, title: p.title, status: p.status })));
      if (!page.next_page_token) break;
      token = page.next_page_token;
    }
    res.json({ products: out });
  });

  // ---- Promotions ----
  const parsePromotion = (body: Record<string, unknown>): PromotionInput => {
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Promotion name is required.');
    const activity_type = String(body.activity_type ?? 'DIRECT_DISCOUNT') as PromotionInput['activity_type'];
    if (!['DIRECT_DISCOUNT', 'FIXED_PRICE', 'FLASHSALE', 'SHIPPING_DISCOUNT'].includes(activity_type)) throw new HttpError(400, 'Unknown activity type.');
    const product_level = String(body.product_level ?? 'SHOP') as PromotionInput['product_level'];
    if (!['SHOP', 'PRODUCT', 'VARIATION'].includes(product_level)) throw new HttpError(400, 'Unknown product level.');
    const discount_type = String(body.discount_type ?? 'PERCENTAGE_OFF') as PromotionInput['discount_type'];
    const discount_value = body.discount_value === null || body.discount_value === '' || body.discount_value === undefined ? null : Number(body.discount_value);
    if (discount_value !== null && (!Number.isFinite(discount_value) || discount_value < 0)) throw new HttpError(400, 'Discount must be a positive number.');
    const begin_at = String(body.begin_at ?? '');
    const end_at = String(body.end_at ?? '');
    if (Number.isNaN(Date.parse(begin_at)) || Number.isNaN(Date.parse(end_at))) throw new HttpError(400, 'Start and end must be valid dates.');
    if (Date.parse(end_at) <= Date.parse(begin_at)) throw new HttpError(400, 'End must be after start.');
    const targets = Array.isArray(body.targets) ? (body.targets as { account_id: unknown; market: unknown }[]) : [];
    const cleanTargets = targets
      .map((t) => ({ account_id: Number(t.account_id), market: String(t.market ?? '').trim().toUpperCase() }))
      .filter((t) => Number.isInteger(t.account_id) && /^[A-Z]{2}$/.test(t.market));
    if (!cleanTargets.length) throw new HttpError(400, 'Pick at least one account and market.');
    const products = (body.products && typeof body.products === 'object' ? body.products : {}) as Record<string, unknown>;
    const cleanProducts: Record<string, string[]> = {};
    for (const [shop, ids] of Object.entries(products)) if (Array.isArray(ids)) cleanProducts[shop] = ids.map(String).filter(Boolean);
    return {
      name,
      activity_type,
      product_level,
      discount_type,
      discount_value,
      begin_at: new Date(begin_at).toISOString(),
      end_at: new Date(end_at).toISOString(),
      participation: body.participation === 'BUYER_LIMIT_ONLY_ONE' ? 'BUYER_LIMIT_ONLY_ONE' : 'BUYER_NO_LIMIT',
      products: cleanProducts,
      notes: optText(body.notes),
      targets: cleanTargets,
    };
  };

  r.get('/promotions', (_req, res) => res.json({ promotions: q.listPromotions(), tts: ttsStatus() }));
  r.post('/promotions', (req, res) => res.status(201).json({ promotion: q.createPromotion(parsePromotion(req.body ?? {}), 'admin') }));
  r.put('/promotions/:id', (req, res) => {
    const p = q.updatePromotion(idParam(req), parsePromotion(req.body ?? {}));
    if (!p) throw new HttpError(404, 'Promotion not found');
    res.json({ promotion: p });
  });
  r.delete('/promotions/:id', (req, res) => {
    if (!q.deletePromotion(idParam(req))) throw new HttpError(404, 'Promotion not found');
    res.json({ ok: true });
  });
  r.post('/promotions/:id/push', async (req, res) => {
    if (!tts.configured) throw new HttpError(400, 'TikTok Shop app is not configured (TTS_APP_KEY / TTS_APP_SECRET).');
    res.json({ promotion: await pushPromotion(q, idParam(req), undefined, actorOf(req)) });
  });
  r.post('/promotions/:id/deactivate', async (req, res) => res.json({ promotion: await deactivatePromotion(q, idParam(req), undefined, actorOf(req)) }));
  r.post('/promotions/:id/sync', async (req, res) => res.json({ promotion: await syncPromotion(q, idParam(req)) }));

  // ---- GMV Max settings ----
  r.get('/gmv-max', (_req, res) => res.json({ rows: q.listGmvMax() }));

  /** One row per account × market × campaign type, from the roster's markets. */
  r.post('/gmv-max/generate', (req, res) => {
    const types = ((req.body ?? {}).types as string[] | undefined) ?? ['PRODUCT'];
    let n = 0;
    for (const a of q.listAccounts().filter((x) => x.enabled)) {
      for (const m of marketsOf(a.markets)) {
        for (const t of types) {
          if (t !== 'PRODUCT' && t !== 'LIVE') continue;
          q.ensureGmvMaxRow(a.id, m, t, currencyForMarket(m));
          n += 1;
        }
      }
    }
    res.json({ rows: q.listGmvMax(), ensured: n });
  });

  r.post('/gmv-max', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const accountId = Number(body.account_id);
    const market = String(body.market ?? '').trim().toUpperCase();
    const type = body.campaign_type === 'LIVE' ? 'LIVE' : 'PRODUCT';
    if (!q.getAccount(accountId)) throw new HttpError(404, 'Account not found');
    if (!/^[A-Z]{2}$/.test(market)) throw new HttpError(400, 'Market must be a 2-letter code.');
    q.ensureGmvMaxRow(accountId, market, type, currencyForMarket(market));
    res.status(201).json({ rows: q.listGmvMax() });
  });

  r.put('/gmv-max/bulk', (req, res) => {
    const body = (req.body ?? {}) as { ids?: unknown; patch?: Record<string, unknown> };
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    const p = body.patch ?? {};
    const patch: GmvMaxPatch = {};
    if ('campaign_name' in p) patch.campaign_name = optText(p.campaign_name);
    if ('daily_budget' in p) {
      const n = p.daily_budget === null || p.daily_budget === '' ? null : Number(p.daily_budget);
      if (n !== null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, 'Daily budget must be a positive number.');
      patch.daily_budget = n;
    }
    if ('target_roi' in p) {
      const n = p.target_roi === null || p.target_roi === '' ? null : Number(p.target_roi);
      if (n !== null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, 'Target ROI must be a positive number.');
      patch.target_roi = n;
    }
    if ('bid_strategy' in p) patch.bid_strategy = p.bid_strategy === 'TARGET_ROI' ? 'TARGET_ROI' : 'MAX_GMV';
    if ('status' in p) {
      if (!['planned', 'active', 'paused'].includes(String(p.status))) throw new HttpError(400, 'Bad status.');
      patch.status = String(p.status) as GmvMaxPatch['status'];
    }
    if ('product_scope' in p) patch.product_scope = String(p.product_scope ?? 'ALL').trim() || 'ALL';
    if ('notes' in p) patch.notes = optText(p.notes);
    const changed = q.patchGmvMax(ids, patch);
    res.json({ changed, rows: q.listGmvMax() });
  });

  r.delete('/gmv-max/:id', (req, res) => {
    if (!q.deleteGmvMax(idParam(req))) throw new HttpError(404, 'Row not found');
    res.json({ rows: q.listGmvMax() });
  });


  // ---- Analytics ----
  r.get('/analytics', (req, res) => {
    const days = Math.min(90, Math.max(5, int(req.query.days, 30)));
    const tz = checkTz();
    const to = todayIn(tz);
    const from = new Date(Date.parse(to + 'T12:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
    const checks = q.listChecksBetween(from, to);
    const dates = [...new Set(checks.map((c) => c.check_date))].sort();
    const accounts = q.listAccounts();
    const countable = (s: string) => s === 'complete' || s === 'partial' || s === 'none';

    const rate = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);

    const byAccount = new Map<number, typeof checks>();
    for (const c of checks) byAccount.set(c.account_id, [...(byAccount.get(c.account_id) ?? []), c]);

    const accountRows: AnalyticsAccount[] = accounts.map((account) => {
      const list = byAccount.get(account.id) ?? [];
      const byDate = new Map(list.map((c) => [c.check_date, c]));
      const scored = list.filter((c) => countable(c.status));
      return {
        account,
        days: dates.map((date) => {
          const c = byDate.get(date);
          return {
            date,
            status: c?.status ?? null,
            am_complete: c?.am_complete ?? false,
            aa_complete: c?.aa_complete ?? false,
            combined_complete: c?.combined_complete ?? false,
            am_done: c?.am_done ?? 0,
            am_total: c?.am_total ?? 0,
            aa_done: c?.aa_done ?? 0,
            aa_total: c?.aa_total ?? 0,
          };
        }),
        checks: scored.length,
        rate_am: rate(scored.filter((c) => c.am_complete).length, scored.length),
        rate_aa: rate(scored.filter((c) => c.aa_complete).length, scored.length),
        rate_combined: rate(scored.filter((c) => c.combined_complete).length, scored.length),
      };
    });

    const amMap = new Map<string, { accounts: Set<number>; scored: typeof checks }>();
    for (const account of accounts) {
      const key = account.am_name ?? 'Unassigned';
      const entry = amMap.get(key) ?? { accounts: new Set<number>(), scored: [] };
      entry.accounts.add(account.id);
      entry.scored.push(...(byAccount.get(account.id) ?? []).filter((c) => countable(c.status)));
      amMap.set(key, entry);
    }
    const ams: AnalyticsAm[] = [...amMap.entries()]
      .map(([am_name, e]) => ({
        am_name,
        accounts: e.accounts.size,
        checks: e.scored.length,
        rate_am: rate(e.scored.filter((c) => c.am_complete).length, e.scored.length),
        rate_aa: rate(e.scored.filter((c) => c.aa_complete).length, e.scored.length),
        rate_combined: rate(e.scored.filter((c) => c.combined_complete).length, e.scored.length),
      }))
      .sort((a, b) => a.am_name.localeCompare(b.am_name));

    const dayRows = dates.map((date) => {
      const list = checks.filter((c) => c.check_date === date && countable(c.status));
      return {
        date,
        accounts_checked: list.length,
        combined_complete: list.filter((c) => c.combined_complete).length,
        am_complete: list.filter((c) => c.am_complete).length,
        aa_complete: list.filter((c) => c.aa_complete).length,
      };
    });

    const payload: Analytics = { from, to, dates, days: dayRows, accounts: accountRows, ams };
    res.json(payload);
  });

  // ---- Errors ----

  // ---- Leads (lead sheet sync, sourced-by / onboarding, AM points) ----

  const leadsData = (): LeadsData => {
    const settings = leadsSettings(q);
    const people = q.listPeople();
    const leads = q.listLeads(false);
    const signed = leads.filter((l) => l.signed);
    const staged = leads.filter((l) => l.stage);
    return {
      leads,
      ams: amSummary(leads, people, settings),
      people,
      settings,
      sync: leadsSyncStatus(q),
      stages: [...new Set(leads.map((l) => l.stage).filter((s): s is string => Boolean(s)))].sort(),
      countries: [...new Set(leads.map((l) => l.country).filter((s): s is string => Boolean(s)))].sort(),
      totals: {
        leads: leads.length,
        signed: signed.length,
        open: leads.length - signed.length,
        pipeline_value: leads.filter((l) => !l.signed).reduce((s, l) => s + (l.est_value ?? 0), 0),
        signed_value: signed.reduce((s, l) => s + (l.est_value ?? 0), 0),
        close_rate: staged.length ? signed.length / staged.length : null,
      },
    };
  };

  r.get('/leads', (_req, res) => res.json(leadsData()));

  r.patch('/leads/:id', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const person = (v: unknown): number | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null || v === '' || v === 0) return null;
      const id = Number(v);
      if (!Number.isInteger(id) || !q.getPerson(id)) throw new HttpError(400, 'Unknown team member');
      return id;
    };
    const addedOn = body.added_on === undefined ? undefined : body.added_on === null || body.added_on === '' ? null : isoDate(body.added_on);
    if (body.added_on !== undefined && body.added_on !== null && body.added_on !== '' && !addedOn) throw new HttpError(400, 'Date must be YYYY-MM-DD');
    const lead = q.patchLead(idParam(req), { sourced_by_id: person(body.sourced_by_id), onboarding_id: person(body.onboarding_id), added_on: addedOn });
    if (!lead) throw new HttpError(404, 'Lead not found');
    liveEvents.emitUpdate({ kind: 'leads' });
    res.json({ lead, ...leadsData() });
  });

  r.post('/leads/sync', async (_req, res) => {
    const result = await syncLeads(q);
    if (!result.ok) return res.status(502).json({ error: result.error, ...leadsData() });
    res.json({ result, ...leadsData() });
  });

  /** Manual fallback: paste the CSV export of the sheet. */
  r.post('/leads/import', (req, res) => {
    const csv = String((req.body ?? {}).csv ?? '');
    if (!csv.trim()) throw new HttpError(400, 'Paste the CSV first.');
    try {
      const result = importLeadsCsv(q, csv, 'import');
      res.json({ result, ...leadsData() });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  r.put('/leads/settings', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.sheet_id !== undefined) {
      // Accept a pasted URL or a bare id.
      const raw = String(body.sheet_id).trim();
      const m = raw.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
      q.setSetting('leads_sheet_id', m ? m[1] : raw);
    }
    if (body.sheet_tab !== undefined) q.setSetting('leads_sheet_tab', String(body.sheet_tab).trim() || 'Core Lead List');
    if (body.sync_enabled !== undefined) q.setSetting('leads_sync_enabled', body.sync_enabled ? '1' : '0');
    if (body.sync_seconds !== undefined) q.setSetting('leads_sync_seconds', String(Math.max(30, int(body.sync_seconds, 180))));
    if (body.points_signed !== undefined) q.setSetting('leads_points_signed', String(Math.max(0, Number(body.points_signed) || 0)));
    if (body.points_sourced !== undefined) q.setSetting('leads_points_sourced', String(Math.max(0, Number(body.points_sourced) || 0)));
    if (body.currency !== undefined) q.setSetting('leads_currency', String(body.currency).trim().toUpperCase() || 'GBP');
    scheduler.leads.start();
    liveEvents.emitUpdate({ kind: 'settings' });
    res.json(leadsData());
  });

  // ---- BD pipeline ----

  const BD_STATUSES: BdStatus[] = ['new', 'researching', 'contacted', 'replied', 'meeting', 'won', 'lost'];

  const gmail = scheduler.gmail;
  const enrichJob = scheduler.enrich;
  const monitor = scheduler.monitor;

  const bdData = (): BdData => {
    const prospects = q.listProspects(false);
    const byMarket = new Map<string, BdCountryRow>();
    for (const p of prospects) {
      const row = byMarket.get(p.market) ?? { market: p.market, prospects: 0, new: 0, in_progress: 0, contacted_any: 0, complete: 0, won: 0, lost: 0, gmv_7d: 0, currency: p.currency };
      row.prospects += 1;
      if (p.status === 'new') row.new += 1;
      else if (p.status === 'won') row.won += 1;
      else if (p.status === 'lost') row.lost += 1;
      else row.in_progress += 1;
      if (p.outreach_tts_am || p.outreach_gmail || p.outreach_linkedin) row.contacted_any += 1;
      if (p.outreach_complete) row.complete += 1;
      row.gmv_7d += p.gmv_7d ?? 0;
      byMarket.set(p.market, row);
    }
    return {
      prospects,
      countries: [...byMarket.values()].sort((a, b) => b.prospects - a.prospects || a.market.localeCompare(b.market)),
      people: q.listPeople(),
      markets: [...byMarket.keys()].sort(),
      categories: [...new Set(prospects.map((p) => p.category).filter((c): c is string => Boolean(c)))].sort(),
      apollo_configured: apollo.configured,
      gmail_connected: gmail.connected,
      llm_configured: Boolean(config.anthropicApiKey),
      ingest_configured: Boolean(config.ingestToken),
      last_pull_at: q.lastProspectPull(),
      totals: {
        prospects: prospects.length,
        complete: prospects.filter((p) => p.outreach_complete).length,
        won: prospects.filter((p) => p.status === 'won').length,
        with_contacts: prospects.filter((p) => p.contacts.length > 0).length,
        new_30d: prospects.filter((p) => p.new_shop_30d).length,
        gmv_started_30d: prospects.filter((p) => p.gmv_started_30d).length,
        found_7d: prospects.filter((p) => !p.is_client && p.created_at >= new Date(Date.now() - 7 * 86400000).toISOString()).length,
        surging_found_7d: prospects.filter((p) => !p.is_client && p.created_at >= new Date(Date.now() - 7 * 86400000).toISOString() && (p.rise_score ?? 0) >= 0.15).length,
        found_today: prospects.filter((p) => !p.is_client && p.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
      },
      enrich: enrichJob.state,
      apollo: apolloStatus(q),
      fastmoss: fastmossStatus(q),
      bulk_draft: scheduler.bulkDrafts.state,
      draft_state: (() => {
        const rank = { draft: 1, gmail: 2, sent: 3 } as const;
        const out: Record<number, 'draft' | 'gmail' | 'sent'> = {};
        for (const d of q.listDrafts({})) {
          if (d.kind !== 'cold' || !(d.status in rank)) continue;
          const st = d.status as keyof typeof rank;
          if (!out[d.prospect_id] || rank[st] > rank[out[d.prospect_id]]) out[d.prospect_id] = st;
        }
        return out;
      })(),
      lark_job: scheduler.larkJob.state,
      tts_contacts: q.listTtsContacts(),
      lark_state: (() => {
        const rank = { draft: 1, scheduled: 2, sent: 3, discarded: 0 } as const;
        const out: Record<number, LarkMessage['status']> = {};
        for (const m of q.listLarkMessages()) if (!out[m.prospect_id] || rank[m.status] > rank[out[m.prospect_id]]) out[m.prospect_id] = m.status;
        return out;
      })(),
      auto_enrich: q.getSetting('apollo_auto_enrich', '1') === '1',
    };
  };

  r.get('/bd', (_req, res) => res.json(bdData()));

  r.post('/bd/pulls/import', (_req, res) => { const r = importPullFiles(q); if (r.added) { scheduler.autoEnrich(); scanEnterpriseAlerts(q); } res.json(r); });

  r.post('/bd/prospects', (req, res) => {
    const input = parseProspectInput({ source: 'manual', ...((req.body ?? {}) as Record<string, unknown>) });
    const prospect = q.createProspect(input);
    liveEvents.emitUpdate({ kind: 'bd' });
    res.status(201).json({ prospect, ...bdData() });
  });

  r.patch('/bd/prospects/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: BdProspectPatch = {};
    if (b.status !== undefined) {
      if (!BD_STATUSES.includes(b.status as BdStatus)) throw new HttpError(400, 'Unknown status');
      patch.status = b.status as BdStatus;
    }
    if (b.owner_id !== undefined) {
      const id = b.owner_id === null || b.owner_id === '' ? null : Number(b.owner_id);
      if (id !== null && !q.getPerson(id)) throw new HttpError(400, 'Unknown team member');
      patch.owner_id = id;
    }
    if (b.notes !== undefined) patch.notes = optText(b.notes);
    if (b.tts_am_contact_id !== undefined) {
      const id = b.tts_am_contact_id === null || b.tts_am_contact_id === '' ? null : Number(b.tts_am_contact_id);
      if (id !== null && !q.listTtsContacts().some((c) => c.id === id)) throw new HttpError(400, 'Unknown TikTok Shop contact');
      patch.tts_am_contact_id = id;
    }
    if (b.website !== undefined) {
      patch.website = optText(b.website);
      patch.domain = normaliseDomain(patch.website);
    }
    if (b.domain !== undefined) patch.domain = normaliseDomain(optText(b.domain));
    for (const ch of ['tts_am', 'gmail', 'linkedin'] as const) if (b[`outreach_${ch}`] !== undefined) patch[`outreach_${ch}`] = Boolean(b[`outreach_${ch}`]);
    if (b.archived !== undefined) patch.archived = Boolean(b.archived);
    for (const k of ['launched_at', 'gmv_started_at'] as const) {
      if (b[k] === undefined) continue;
      const d = isoDate(b[k]);
      if (optText(b[k]) && !d) throw new HttpError(400, `${k === 'launched_at' ? 'Shop created' : 'First sales'} must be a date (YYYY-MM-DD).`);
      patch[k] = d;
    }
    if (b.outreach_note !== undefined) patch.outreach_note = optText(b.outreach_note);
    if (b.outreach_contact !== undefined) patch.outreach_contact = optText(b.outreach_contact);
    const prospect = q.patchProspect(idParam(req), patch, auth instanceof SharedPasswordAuth ? auth.roleOf(req) : 'admin');
    if (!prospect) throw new HttpError(404, 'Prospect not found');
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ prospect, ...bdData() });
  });

  r.post('/bd/prospects/:id/log', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!q.getProspect(idParam(req))) throw new HttpError(404, 'Prospect not found');
    const note = optText(b.note);
    if (!note) throw new HttpError(400, 'Write a note first.');
    const channel = ['tts_am', 'gmail', 'linkedin'].includes(String(b.channel)) ? (String(b.channel) as 'tts_am') : null;
    q.logOutreach(idParam(req), { channel, action: channel ? 'contacted' : 'note', note, contact_name: optText(b.contact_name), actor: auth instanceof SharedPasswordAuth ? auth.roleOf(req) : 'admin' });
    liveEvents.emitUpdate({ kind: 'bd' });
    res.status(201).json({ prospect: q.getProspect(idParam(req)), ...bdData() });
  });

  r.delete('/bd/outreach-log/:id', (req, res) => {
    if (!q.deleteOutreachEvent(idParam(req))) throw new HttpError(404, 'Event not found');
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json(bdData());
  });

  r.delete('/bd/prospects/:id', (req, res) => {
    if (!q.deleteProspect(idParam(req))) throw new HttpError(404, 'Prospect not found');
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json(bdData());
  });

  r.post('/bd/prospects/:id/contacts', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Contact name is required.');
    if (!q.getProspect(idParam(req))) throw new HttpError(404, 'Prospect not found');
    q.addContact(idParam(req), { name, title: optText(b.title), email: optText(b.email), linkedin_url: optText(b.linkedin_url), phone: optText(b.phone), notes: optText(b.notes), source: 'manual', enriched: true });
    liveEvents.emitUpdate({ kind: 'bd' });
    res.status(201).json({ prospect: q.getProspect(idParam(req)), ...bdData() });
  });

  r.delete('/bd/contacts/:id', (req, res) => {
    if (!q.deleteContact(idParam(req))) throw new HttpError(404, 'Contact not found');
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json(bdData());
  });

  /** Apollo people search for the prospect's company. Free (no credits). */
  /** Resolve the company in Apollo, pull its decision makers, keep the best-ranked and reveal the top few (credits, authorised). */
  r.post('/bd/prospects/:id/find-contacts', async (req, res) => {
    const prospect = q.getProspect(idParam(req));
    if (!prospect) throw new HttpError(404, 'Prospect not found');
    const body = (req.body ?? {}) as { domain?: string; reveal?: number };
    if (apolloStatus(q).exhausted) throw new HttpError(402, 'Apollo has run out of credits for this cycle. Enrichment resumes when the balance is back.');
    try {
      const r = await enrichProspect(q, prospect.id, { domain: optText(body.domain), reveal: Number.isFinite(Number(body.reveal)) ? Number(body.reveal) : undefined });
      liveEvents.emitUpdate({ kind: 'bd' });
      void refreshApolloCredits(q);
      res.json({ ...r, prospect: q.getProspect(prospect.id), ...bdData() });
    } catch (err) {
      if (isCreditsError(err)) { markApolloExhausted(q); liveEvents.emitUpdate({ kind: 'bd' }); throw new HttpError(402, `Apollo ran out of credits: ${(err as Error).message}`); }
      throw new HttpError(502, (err as Error).message);
    }
  });

  /** Background job: decision makers for every prospect that has none yet. */
  r.post('/bd/enrich-all', (req, res) => {
    if (!apollo.configured) throw new HttpError(400, 'Set APOLLO_API_KEY in .env first.');
    const body = (req.body ?? {}) as { reveal?: number; ids?: number[]; mode?: string };
    if (apolloStatus(q).exhausted) throw new HttpError(402, 'Apollo has run out of credits for this cycle. Enrichment resumes when the balance is back.');
    const mode = body.mode === 'no_email' || body.mode === 'all' ? body.mode : 'new';
    const state = enrichJob.start({ reveal: Number.isFinite(Number(body.reveal)) ? Number(body.reveal) : undefined, ids: Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : undefined, mode });
    res.status(202).json({ ...bdData(), enrich: state, candidates: enrichJob.candidates(mode).length });
  });

  r.put('/bd/settings', (req, res) => {
    const b = (req.body ?? {}) as { auto_enrich?: unknown; reveal_per_prospect?: unknown; keep_per_prospect?: unknown };
    if (typeof b.auto_enrich === 'boolean') {
      q.setSetting('apollo_auto_enrich', b.auto_enrich ? '1' : '0');
      if (b.auto_enrich) scheduler.autoEnrich();
    }
    if (b.reveal_per_prospect !== undefined) { const n = Number(b.reveal_per_prospect); if (!Number.isInteger(n) || n < 0 || n > 20) throw new HttpError(400, 'Reveal per prospect must be 0 to 20.'); q.setSetting('apollo_reveal_per_prospect', String(n)); }
    if (b.keep_per_prospect !== undefined) { const n = Number(b.keep_per_prospect); if (!Number.isInteger(n) || n < 1 || n > 30) throw new HttpError(400, 'Keep per prospect must be 1 to 30.'); q.setSetting('apollo_keep_per_prospect', String(n)); }
    res.json(bdData());
  });

  /** Check the Apollo key and refresh the credit balance (both free calls). */
  r.post('/bd/apollo/test', async (_req, res) => {
    if (!apollo.configured) throw new HttpError(400, 'APOLLO_API_KEY is not set in .env.');
    let healthy = false;
    let healthError: string | null = null;
    try { healthy = await apollo.health(); } catch (err) { healthError = (err as Error).message; }
    const status = await refreshApolloCredits(q);
    res.json({ healthy, health_error: healthError, ...bdData(), apollo: status });
  });

  /** Check the FastMoss key: initialise the MCP session, list tools, one-row shop search, balance. */
  r.post('/bd/fastmoss/test', async (_req, res) => {
    if (!fastmoss.configured) throw new HttpError(400, 'Set FASTMOSS_API_KEY in .env first (developers.fastmoss.com > MCP&CLI > API Keys).');
    let out: Awaited<ReturnType<typeof fastmoss.test>>;
    try {
      out = await fastmoss.test();
    } catch (err) {
      out = { ok: false, transport: fastmoss.transport, server: null, tools: 0, rows: 0, error: (err as Error).message };
      if (isQuotaError(err)) q.setSetting('fastmoss_quota_hit_at', new Date().toISOString());
    }
    if (out.ok) {
      try { const c = await fastmoss.credits(); if (c) q.setSetting('fastmoss_credits_json', JSON.stringify({ ...c, checked_at: new Date().toISOString() })); } catch { /* optional */ }
      q.setSetting('fastmoss_last_test', `ok ${new Date().toISOString()}: ${out.transport}${out.server ? `, ${out.server}` : ''}, ${out.tools} tools, ${out.rows} row`);
      q.setSetting('fastmoss_last_error', '');
    } else {
      q.setSetting('fastmoss_last_test', `failed ${new Date().toISOString()}: ${out.error}`);
    }
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ ...out, ...bdData() });
  });

  /** Pull the fast risers from FastMoss now (in-process), then import, enrich and scan. */
  r.post('/bd/fastmoss/pull', async (_req, res) => {
    if (!fastmoss.configured) throw new HttpError(400, 'Set FASTMOSS_API_KEY in .env first.');
    const r2 = await scheduler.dailyPull({ fastmoss: true });
    res.json({ ...r2, ...bdData() });
  });

  r.put('/bd/fastmoss/settings', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.sorts !== undefined) { const v = String(b.sorts ?? '').split(/[,\s]+/).filter((x) => ['day7_gmv', 'day7_units_sold', 'total_gmv', 'total_units_sold'].includes(x)); q.setSetting('fastmoss_pull_sorts', v.join(',')); }
    if (b.min_gmv_7d !== undefined) { const n = Number(b.min_gmv_7d); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Minimum 7-day GMV must be a number.'); q.setSetting('fastmoss_min_gmv_7d', String(n)); }
    if (b.min_rise !== undefined) { const n = Number(b.min_rise); if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, 'Minimum rise must be between 0 and 1 (0.05 = 5%).'); q.setSetting('fastmoss_min_rise', String(n)); }
    if (b.markets !== undefined) q.setSetting('fastmoss_pull_markets', String(b.markets ?? '').toUpperCase().split(/[,\s]+/).filter(Boolean).join(','));
    if (b.pages !== undefined) { const n = Number(b.pages); if (!Number.isInteger(n) || n < 1 || n > 30) throw new HttpError(400, 'Pages must be 1 to 30.'); q.setSetting('fastmoss_pull_pages', String(n)); }
    if (b.enabled !== undefined) q.setSetting('fastmoss_pull_enabled', bool(b.enabled, true) ? '1' : '0');
    if (b.cron !== undefined) { const c = String(b.cron ?? '').trim(); const cronErr = validateCron(c); if (cronErr) throw new HttpError(400, cronErr); q.setSetting('fastmoss_pull_cron', c); scheduler.reloadFastmossSchedule(); }
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json(bdData());
  });

  /** Run the daily sweep now: git pull, import new pull files, enrich, alerts. */
  r.post('/bd/sweep', async (_req, res) => {
    const r2 = await scheduler.dailyPull({ fastmoss: false });
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ ...r2, ...bdData() });
  });

  r.post('/bd/apollo/refresh', async (_req, res) => {
    const status = await refreshApolloCredits(q);
    res.json({ ...bdData(), apollo: status });
  });

  r.post('/bd/enrich-all/stop', (_req, res) => {
    enrichJob.stop();
    res.json(bdData());
  });

  /** Apollo enrichment: full name, work email, LinkedIn. Costs one credit; no confirmation (standing authorisation). */
  r.post('/bd/contacts/:id/reveal', async (req, res) => {
    const contact = q.getContact(idParam(req));
    if (!contact) throw new HttpError(404, 'Contact not found');
    const prospect = q.getProspect(contact.prospect_id)!;
    try {
      const p = await apollo.matchPerson({ id: contact.apollo_id, name: contact.apollo_id ? null : contact.name, domain: prospect.domain, company: prospect.brand ?? prospect.shop_name });
      if (!p) return res.status(404).json({ error: 'Apollo has no match for this person.' });
      q.updateContact(contact.id, { name: p.name, title: p.title, email: p.email, linkedin_url: p.linkedin_url, phone: p.phone, apollo_id: p.id, enriched: true, notes: p.email_status ? `Email status: ${p.email_status}` : null });
      liveEvents.emitUpdate({ kind: 'bd' });
      void refreshApolloCredits(q);
      res.json({ contact: q.getContact(contact.id), prospect: q.getProspect(prospect.id), ...bdData() });
    } catch (err) {
      if (isCreditsError(err)) { markApolloExhausted(q); liveEvents.emitUpdate({ kind: 'bd' }); throw new HttpError(402, `Apollo ran out of credits: ${(err as Error).message}`); }
      throw new HttpError(502, (err as Error).message);
    }
  });


  // ---- BD outreach emails: draft in Isaac's voice, review in the inbox, hand off to Gmail ----

  /** Who is acting: the "You are" pick sent by the client (x-actor header), else the login role. */
  const actorOf = (req: Request): string => {
    const named = String(req.headers['x-actor'] ?? '').trim().slice(0, 60);
    if (named) return named;
    return auth instanceof SharedPasswordAuth ? auth.roleOf(req) ?? 'admin' : 'admin';
  };
  const isAdminReq = (req: Request): boolean => (auth instanceof SharedPasswordAuth ? auth.roleOf(req) === 'admin' : auth.isAuthenticated(req));

  const outreachData = (): OutreachData => ({
    send_queue: scheduler.sendQueue.state(),
    lark_messages: q.listLarkMessages(),
    lark_job: scheduler.larkJob.state,
    bulk_draft: scheduler.bulkDrafts.state,
    drafts: q.listDrafts(),
    examples: q.listExamples(),
    settings: {
      gmail_configured: gmail.configured,
      gmail_connected: gmail.connected,
      gmail_email: gmail.email,
      gmail_accounts: gmail.accounts(),
      llm_configured: Boolean(config.anthropicApiKey),
      sender_name: q.getSetting('outreach_sender_name', ''),
      sender_title: q.getSetting('outreach_sender_title', ''),
      booking_url: q.getSetting('outreach_booking_url', ''),
      pitch: q.getSetting('outreach_pitch', ''),
      sent_query: q.getSetting('outreach_sent_query', ''),
      last_pull_at: q.getSetting('outreach_last_pull_at', '') || null,
      last_pull_error: q.getSetting('outreach_last_pull_error', '') || null,
      watchlist_sheet_tab: q.getSetting('watchlist_sheet_tab', ''),
      linkedin_check_days: Number(q.getSetting('linkedin_check_days', '3')) || 3,
    },
    followups: q.listFollowups(),
    alerts: q.listAlerts(),
    watchlist: q.listWatchlist(),
    tts_contacts: q.listTtsContacts(),
    activity: q.bdActivity(30),
    people: q.listPeople(),
    tldv: { configured: tldv.configured, last_check_at: q.getSetting('tldv_last_check_at', '') || null, last_error: q.getSetting('tldv_last_error', '') || null, auto_draft: q.getSetting('tldv_auto_draft', '1') === '1' },
  });

  /** Generate subject + body for one contact, with Claude when configured, else the template. */
  const generateDraft = async (prospectId: number, contact: { name: string; title: string | null; email: string | null }, opts: { language: string; style: 'short' | 'intro'; instructions: string | null }): Promise<{ subject: string; body: string; generator: BdEmailDraft['generator'] }> => {
    if (!q.getProspect(prospectId)) throw new HttpError(404, 'Prospect not found');
    try {
      return await generateOutreachDraft(q, prospectId, contact, opts);
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  };

  const draftOpts = (b: Record<string, unknown>, fallback?: BdEmailDraft) => ({
    language: OUTREACH_LANGUAGES[String(b.language ?? '')] ? String(b.language) : fallback?.language ?? 'en',
    style: (b.style === 'intro' || b.style === 'short' ? b.style : fallback?.style ?? 'short') as 'short' | 'intro',
    instructions: optText(b.instructions),
  });

  r.get('/outreach', (_req, res) => res.json(outreachData()));

  /** Draft an email to one decision maker (needs an email address). */
  r.post('/bd/contacts/:id/draft', async (req, res) => {
    const contact = q.getContact(idParam(req));
    if (!contact) throw new HttpError(404, 'Contact not found');
    if (!contact.email) throw new HttpError(400, 'This contact has no email address yet. Reveal them first or add the email by hand.');
    const opts = draftOpts((req.body ?? {}) as Record<string, unknown>);
    const g = await generateDraft(contact.prospect_id, contact, opts);
    const draft = q.createDraft({ prospect_id: contact.prospect_id, contact_id: contact.id, to_name: contact.name, to_email: contact.email, subject: g.subject, body: g.body, language: opts.language, style: opts.style, generator: g.generator, created_by: actorOf(req) });
    q.logOutreach(contact.prospect_id, { channel: 'gmail', action: 'note', note: `Email drafted: "${g.subject}"`, contact_name: contact.name, actor: actorOf(req) });
    liveEvents.emitUpdate({ kind: 'bd' });
    res.status(201).json({ draft, ...outreachData() });
  });

  /** Bulk: one email per prospect to its most senior relevant contact, optionally saved straight into Gmail drafts. */
  r.get('/bd/drafts/bulk/preview', (req, res) => {
    const market = optText(req.query.market);
    const ids = String(req.query.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const items = bulkCandidates(q, { market, ids: ids.length ? ids : undefined, include_drafted: req.query.include_drafted === '1' });
    res.json({ count: items.length, items: items.slice(0, 200).map((i) => ({ prospect_id: i.prospect.id, shop_name: i.prospect.shop_name, brand: i.prospect.brand, market: i.prospect.market, contact_id: i.contact.id, contact_name: i.contact.name, contact_title: i.contact.title, contact_email: i.contact.email })) });
  });

  r.post('/bd/drafts/bulk', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const opts = draftOpts(b);
    const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : undefined;
    const limit = Math.min(Math.max(Number(b.limit) || 25, 1), 500);
    if (scheduler.bulkDrafts.state.running) throw new HttpError(409, 'A bulk draft run is already going. Wait for it to finish or stop it.');
    const autoSend = bool(b.auto_send, false);
    if (autoSend && !gmail.forActor(actorOf(req)).connected) throw new HttpError(400, 'Connect Gmail first (Outreach emails › Settings) to send automatically.');
    // Auto-send: shops that already have an open draft get that draft queued instead of being skipped as "already drafted".
    let pre_queued = 0;
    const pre_skipped: { id: number; reason: string }[] = [];
    if (autoSend && ids?.length) {
      const open = q.listDrafts({}).filter((d) => ids.includes(d.prospect_id) && d.kind === 'cold' && (d.status === 'draft' || d.status === 'gmail'));
      if (open.length) { const r = scheduler.sendQueue.queue(open.map((d) => d.id), actorOf(req), { force: bool(b.include_drafted, false) }); pre_queued = r.queued.length; pre_skipped.push(...r.skipped); }
    }
    const state = scheduler.bulkDrafts.start({ ids, market: optText(b.market), limit, include_drafted: bool(b.include_drafted, false) }, { ...opts, to_gmail: bool(b.to_gmail, true), auto_send: autoSend, actor: actorOf(req) });
    if (bool(b.to_gmail, true) && !gmail.connected) log.warn('Bulk drafts: Gmail is not connected, drafts stay in the dashboard');
    res.status(202).json({ state, pre_queued, pre_skipped, ...bdData() });
  });

  /** Bulk LinkedIn: the best profile per selected prospect; with log=true each is logged as "connection requested" (reminder to check back). */
  r.post('/bd/linkedin/bulk', async (req, res) => {
    const b = (req.body ?? {}) as { ids?: unknown; log?: unknown; include_started?: unknown };
    const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) throw new HttpError(400, 'Select at least one prospect.');
    const includeStarted = bool(b.include_started, false);
    const items: { prospect_id: number; shop_name: string; brand: string | null; contact_id: number; contact_name: string; contact_title: string | null; linkedin_url: string; status: BdContact['linkedin_status'] }[] = [];
    const skipped: { prospect_id: number; shop_name: string; reason: string }[] = [];
    for (const id of ids) {
      const p = q.getProspect(id);
      if (!p) continue;
      const c = pickBestLinkedin(p);
      if (!c) { skipped.push({ prospect_id: p.id, shop_name: p.shop_name, reason: 'no LinkedIn profile on any contact' }); continue; }
      if (c.linkedin_status !== 'none' && !includeStarted) { skipped.push({ prospect_id: p.id, shop_name: p.shop_name, reason: `${c.name} already ${c.linkedin_status}` }); continue; }
      items.push({ prospect_id: p.id, shop_name: p.shop_name, brand: p.brand, contact_id: c.id, contact_name: c.name, contact_title: c.title, linkedin_url: c.linkedin_url!, status: c.linkedin_status });
    }
    let logged = 0;
    if (bool(b.log, false)) {
      for (const it of items) {
        if (it.status !== 'none') continue;
        try { await advanceLinkedin(q, it.contact_id, 'requested', { actor: actorOf(req), note: 'bulk' }); logged += 1; } catch (err) { log.warn(`Bulk LinkedIn log for ${it.contact_name}: ${(err as Error).message}`); }
      }
      liveEvents.emitUpdate({ kind: 'bd' });
    }
    res.json({ items, skipped, logged, ...bdData() });
  });

  r.post('/bd/drafts/bulk/stop', (_req, res) => {
    scheduler.bulkDrafts.stop();
    res.json(bdData());
  });

  /** Push every open dashboard draft into Gmail in one go. */
  r.post('/outreach/drafts/gmail-all', async (req, res) => {
    const mine = gmail.forActor(actorOf(req));
    if (!mine.connected) throw new HttpError(400, 'Connect Gmail in Settings first.');
    const open = q.listDrafts({}).filter((d) => d.status === 'draft');
    let saved = 0;
    const errors: string[] = [];
    for (const d of open) {
      try {
        const g = await mine.createDraft({ to: d.to_email, toName: d.to_name, subject: d.subject, body: d.body, html: bodyToHtml(d.body) });
        q.updateDraft(d.id, { status: 'gmail', gmail_draft_id: g.draft_id, gmail_message_id: g.message_id, gmail_url: g.url });
        q.logOutreach(d.prospect_id, { channel: 'gmail', action: 'note', note: `Draft "${d.subject}" saved to Gmail (${mine.email})`, contact_name: d.to_name, actor: actorOf(req) });
        saved += 1;
      } catch (err) {
        errors.push(`${d.shop_name}: ${(err as Error).message}`);
      }
    }
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ saved, errors, ...outreachData() });
  });

  r.post('/outreach/drafts/:id/regenerate', async (req, res) => {
    const d = q.getDraft(idParam(req));
    if (!d) throw new HttpError(404, 'Draft not found');
    const opts = draftOpts((req.body ?? {}) as Record<string, unknown>, d);
    const contact = d.contact_id ? q.getContact(d.contact_id) : null;
    const g = await generateDraft(d.prospect_id, contact ?? { name: d.to_name, title: null, email: d.to_email }, opts);
    const draft = q.updateDraft(d.id, { subject: g.subject, body: g.body, language: opts.language, style: opts.style, generator: g.generator, status: d.status === 'sent' ? d.status : 'draft' });
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ draft, ...outreachData() });
  });

  r.put('/outreach/drafts/:id', (req, res) => {
    const d = q.getDraft(idParam(req));
    if (!d) throw new HttpError(404, 'Draft not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<Queries['updateDraft']>[1] = {};
    if (b.subject !== undefined) { const v = optText(b.subject); if (!v) throw new HttpError(400, 'Subject cannot be empty.'); patch.subject = v; }
    if (b.body !== undefined) { const v = String(b.body ?? '').replace(/\r\n/g, '\n').trim(); if (!v) throw new HttpError(400, 'Body cannot be empty.'); patch.body = v; }
    if (b.to_email !== undefined) { const v = optText(b.to_email); if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, 'Enter a valid email address.'); patch.to_email = v; }
    if (b.to_name !== undefined) { const v = optText(b.to_name); if (v) patch.to_name = v; }
    const draft = q.updateDraft(d.id, patch);
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ draft, ...outreachData() });
  });

  /** Put the draft into Gmail (a real draft in the connected account) or, without OAuth, hand back a prefilled compose link. */
  r.post('/outreach/drafts/:id/gmail', async (req, res) => {
    const d = q.getDraft(idParam(req));
    if (!d) throw new HttpError(404, 'Draft not found');
    const mine = gmail.forActor(actorOf(req));
    if (mine.connected) {
      try {
        const g = await mine.createDraft({ to: d.to_email, toName: d.to_name, subject: d.subject, body: d.body, html: bodyToHtml(d.body) });
        const draft = q.updateDraft(d.id, { status: d.status === 'sent' ? 'sent' : 'gmail', gmail_draft_id: g.draft_id, gmail_message_id: g.message_id, gmail_url: g.url });
        q.logOutreach(d.prospect_id, { channel: 'gmail', action: 'note', note: `Draft "${d.subject}" saved to Gmail (${mine.email})`, contact_name: d.to_name, actor: actorOf(req) });
        liveEvents.emitUpdate({ kind: 'bd' });
        return res.json({ mode: 'gmail', url: g.url, draft, ...outreachData() });
      } catch (err) {
        throw new HttpError(502, (err as Error).message);
      }
    }
    const url = gmailComposeUrl({ to: d.to_email, subject: d.subject, body: d.body, account: gmail.email });
    const draft = q.updateDraft(d.id, { status: d.status === 'sent' ? 'sent' : 'gmail', gmail_url: url });
    q.logOutreach(d.prospect_id, { channel: 'gmail', action: 'note', note: `Draft "${d.subject}" opened in Gmail compose`, contact_name: d.to_name, actor: actorOf(req) });
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ mode: 'compose', url, draft, ...outreachData() });
  });

  /** Isaac confirms he sent it from Gmail: tick the Gmail channel and log the contact. */
  r.post('/outreach/drafts/:id/sent', (req, res) => {
    const d = q.getDraft(idParam(req));
    if (!d) throw new HttpError(404, 'Draft not found');
    const out = q.updateDraft(d.id, { status: 'sent', sent_at: new Date().toISOString() })!;
    recordSent(q, out, actorOf(req), '');
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ draft: q.getDraft(d.id), ...outreachData() });
  });

  // ---- Send queue: reviewed drafts go out through Gmail on a drip, no clicking in Gmail ----
  r.post('/outreach/drafts/queue', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n)) : [];
    if (!ids.length) throw new HttpError(400, 'No drafts given.');
    let result: { queued: unknown[]; skipped: { id: number; reason: string }[]; unqueued: number };
    try { result = scheduler.sendQueue.queue(ids, actorOf(req), { force: bool(b.force, false), only: bool(b.only, false) }); } catch (err) { throw new HttpError(400, (err as Error).message); }
    res.json({ queued: result.queued.length, skipped: result.skipped, unqueued: result.unqueued, ...outreachData() });
  });
  /** Take drafts out of the queue: the given ids, or every queued draft with `all`. */
  r.post('/outreach/drafts/unqueue', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = bool(b.all, false) ? q.listDrafts({}).filter((d) => d.status === 'queued').map((d) => d.id) : Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n)) : [];
    const unqueued = scheduler.sendQueue.unqueueMany(ids);
    res.json({ unqueued, ...outreachData() });
  });
  r.post('/outreach/drafts/:id/unqueue', (req, res) => {
    const d = scheduler.sendQueue.unqueue(idParam(req));
    if (!d) throw new HttpError(404, 'Draft not found');
    res.json({ draft: d, ...outreachData() });
  });
  /** Send one queued draft right now, ignoring the gap (still inside the window and cap). */
  r.post('/outreach/send-queue/tick', async (_req, res) => {
    const sent = await scheduler.sendQueue.tick();
    res.json({ sent, ...outreachData() });
  });

  r.delete('/outreach/drafts/:id', (req, res) => {
    if (!q.deleteDraft(idParam(req))) throw new HttpError(404, 'Draft not found');
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json(outreachData());
  });

  r.put('/outreach/settings', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const keys: Record<string, string> = { sender_name: 'outreach_sender_name', sender_title: 'outreach_sender_title', booking_url: 'outreach_booking_url', pitch: 'outreach_pitch', sent_query: 'outreach_sent_query', watchlist_sheet_tab: 'watchlist_sheet_tab', linkedin_check_days: 'linkedin_check_days' };
    for (const [k, setting] of Object.entries(keys)) if (typeof b[k] === 'string' || typeof b[k] === 'number') q.setSetting(setting, String(b[k]).trim());
    saveSendSettings(q, b);
    if (typeof b.tldv_auto_draft === 'boolean') q.setSetting('tldv_auto_draft', b.tldv_auto_draft ? '1' : '0');
    res.json(outreachData());
  });

  r.post('/outreach/examples', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const subject = optText(b.subject);
    const body = optText(b.body);
    if (!subject || !body) throw new HttpError(400, 'Subject and body are required.');
    const kind = (['cold', 'intro', 'reply', 'followup'] as const).find((k) => k === b.kind) ?? 'cold';
    q.addExample({ subject, body, kind, source: 'manual' });
    res.status(201).json(outreachData());
  });

  r.put('/outreach/examples/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.enabled === 'boolean' && !q.setExampleEnabled(idParam(req), b.enabled)) throw new HttpError(404, 'Example not found');
    res.json(outreachData());
  });

  r.delete('/outreach/examples/:id', (req, res) => {
    if (!q.deleteExample(idParam(req))) throw new HttpError(404, 'Example not found');
    res.json(outreachData());
  });

  /** Pull recent sent outreach from the connected Gmail as fresh voice samples. */
  r.post('/outreach/examples/pull', async (_req, res) => {
    if (!gmail.connected) throw new HttpError(400, 'Connect Gmail first.');
    const query = q.getSetting('outreach_sent_query', 'in:sent TikTok Shop');
    try {
      const sent = await gmail.listSent(query, 25);
      let added = 0;
      for (const m of sent) {
        const kind: OutreachExample['kind'] = /^re:/i.test(m.subject) ? 'reply' : /introduc/i.test(m.body) ? 'intro' : 'cold';
        const domain = m.to?.match(/@([a-z0-9.-]+)/i)?.[1]?.toLowerCase() ?? null;
        if (q.addExample({ subject: m.subject.replace(/^(re|fwd?):\s*/i, ''), body: m.body, kind, to_domain: domain, sent_at: m.sent_at, source: 'gmail', gmail_id: m.id })) added += 1;
      }
      q.setSetting('outreach_last_pull_at', new Date().toISOString());
      q.setSetting('outreach_last_pull_error', '');
      res.json({ pulled: sent.length, added, ...outreachData() });
    } catch (err) {
      q.setSetting('outreach_last_pull_error', (err as Error).message);
      throw new HttpError(502, (err as Error).message);
    }
  });

  // Gmail OAuth: admin clicks Connect, Google sends them back to /api/gmail/callback, we keep the refresh token.
  // The shared account (no ?as=) needs admin; anyone signed in can connect their own Gmail for the name they act as.
  r.get('/gmail/connect', (req, res) => {
    const person = normaliseAccount(req.query.as);
    if (!person && !isAdminReq(req)) return res.status(403).send('Admin only for the shared account. Pick your name top right and connect "my Gmail" instead.');
    if (!gmail.configured) return res.status(400).send('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
    res.redirect(gmail.forAccount(person).authUrl());
  });

  r.get('/gmail/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const back = (msg: string, ok: boolean) => res.redirect(`/outreach?tab=settings&${ok ? 'notice' : 'error'}=${encodeURIComponent(msg)}`);
    if (!auth.isAuthenticated(req)) return back('Sign in, then connect Gmail again.', false);
    if (error) return back(`Google said: ${error}`, false);
    const person = GmailClient.accountOfState(state);
    if (person === null) return back('Gmail connect failed: bad state. Try again.', false);
    if (!person && !isAdminReq(req)) return back('Only an admin can connect the shared account.', false);
    const client = gmail.forAccount(person);
    if (!code || !client.validState(state)) return back('Gmail connect failed: bad state. Try again.', false);
    try {
      const { email } = await client.exchangeCode(code);
      liveEvents.emitUpdate({ kind: 'settings' });
      back(`Gmail connected as ${email}${person ? ` for ${person}` : ' (shared account)'}.`, true);
    } catch (err) {
      back((err as Error).message, false);
    }
  });

  r.post('/gmail/disconnect', (req, res) => {
    const person = normaliseAccount((req.body as Record<string, unknown> | undefined)?.person);
    if (!person && !isAdminReq(req)) throw new HttpError(403, 'Admin only for the shared account.');
    gmail.forAccount(person).disconnect();
    liveEvents.emitUpdate({ kind: 'settings' });
    res.json(outreachData());
  });

  // ---- LinkedIn sequence, follow-ups, TikTok Shop contacts, alerts, call follow-ups ----

  r.post('/bd/contacts/:id/linkedin', async (req, res) => {
    const b = (req.body ?? {}) as { step?: string; note?: string };
    const step = LINKEDIN_STEPS.find((x) => x === b.step);
    if (!step) throw new HttpError(400, 'step must be requested, connected or messaged');
    try {
      const r = await advanceLinkedin(q, idParam(req), step, { actor: actorOf(req), note: optText(b.note) });
      liveEvents.emitUpdate({ kind: 'bd' });
      res.json({ ...r, ...outreachData() });
    } catch (err) {
      throw new HttpError(err instanceof Error && /not found/i.test(err.message) ? 404 : 502, (err as Error).message);
    }
  });

  r.post('/bd/followups', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const prospect = q.getProspect(Number(b.prospect_id));
    if (!prospect) throw new HttpError(404, 'Prospect not found');
    const title = optText(b.title);
    if (!title) throw new HttpError(400, 'Title is required.');
    const due = isoDate(b.due_at) ?? new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const f = q.addFollowup({ prospect_id: prospect.id, contact_id: b.contact_id ? Number(b.contact_id) : null, kind: 'custom', title, due_at: `${due}T09:00:00.000Z`, note: optText(b.note), created_by: actorOf(req) });
    liveEvents.emitUpdate({ kind: 'bd' });
    res.status(201).json({ followup: f, ...outreachData() });
  });

  r.post('/bd/followups/:id/done', (req, res) => {
    const f = q.completeFollowup(idParam(req), optText((req.body as { note?: unknown } | undefined)?.note));
    if (!f) throw new HttpError(404, 'Follow-up not found');
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ followup: f, ...outreachData() });
  });

  r.post('/bd/followups/:id/snooze', (req, res) => {
    const days = Math.min(30, Math.max(1, Number((req.body as { days?: unknown } | undefined)?.days) || 2));
    const f = q.snoozeFollowup(idParam(req), new Date(Date.now() + days * 86400000).toISOString());
    if (!f) throw new HttpError(404, 'Follow-up not found');
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ followup: f, ...outreachData() });
  });

  r.get('/bd/prospects/:id/tts-contact', (req, res) => {
    const p = q.getProspect(idParam(req));
    if (!p) throw new HttpError(404, 'Prospect not found');
    res.json(suggestTtsContact(q.listTtsContacts(), p));
  });

  // ---- Lark messages to TikTok Shop AMs / TSP managers (drafted here, pasted into Lark by hand) ----
  const larkOr404 = (req: Request): LarkMessage => {
    const m = q.getLarkMessage(idParam(req));
    if (!m) throw new HttpError(404, 'Lark message not found');
    return m;
  };
  const isoDay = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);

  /** Draft a Lark message for each prospect (background job, one Claude call each). */
  r.post('/outreach/lark/draft', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n)) : [];
    if (!ids.length) throw new HttpError(400, 'Tick some shops first.');
    if (scheduler.larkJob.state.running) throw new HttpError(409, 'A Lark drafting run is already going. Wait for it to finish or stop it.');
    const status = scheduler.larkJob.start(ids, { actor: actorOf(req), instructions: optText(b.instructions), redo: bool(b.redo, false) });
    res.status(202).json({ ...outreachData(), lark_job: status });
  });
  r.post('/outreach/lark/stop', (_req, res) => { scheduler.larkJob.stop(); res.json(outreachData()); });

  /** Edit the text or change who it goes to. Picking the AM recorded on the prospect makes it "known"; anyone else is a manual pick. */
  r.put('/outreach/lark/:id', (req, res) => {
    const m = larkOr404(req);
    if (m.status === 'sent') throw new HttpError(400, 'That message has already been sent.');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<Queries['updateLarkMessage']>[1] = {};
    if (b.body !== undefined) {
      const body = optText(b.body);
      if (!body) throw new HttpError(400, 'The message cannot be empty.');
      patch.body = body;
    }
    if (b.contact_id !== undefined) {
      const id = b.contact_id === null || b.contact_id === '' ? null : Number(b.contact_id);
      const contact = id === null ? null : q.listTtsContacts().find((c) => c.id === id);
      if (id !== null && !contact) throw new HttpError(400, 'Unknown TikTok Shop contact');
      const p = q.getProspect(m.prospect_id);
      patch.contact_id = id;
      if (contact && p?.tts_am_contact_id === contact.id) { patch.confidence = 'known'; patch.reason = `Recorded as the TikTok AM on ${p.brand ?? p.shop_name}`; }
      else if (contact) { patch.confidence = contact.is_agency_manager ? 'tsp' : 'known'; patch.reason = `Picked by ${actorOf(req) ?? 'the sender'}: ${contact.name}${contact.role ? `, ${contact.role}` : ''}`; }
    }
    if (b.scheduled_for !== undefined) {
      const day = b.scheduled_for === null || b.scheduled_for === '' ? null : isoDay(b.scheduled_for);
      if (b.scheduled_for && !day) throw new HttpError(400, 'Send date must be YYYY-MM-DD.');
      patch.scheduled_for = day;
      patch.status = day ? 'scheduled' : 'draft';
    }
    const saved = q.updateLarkMessage(m.id, patch);
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ message: saved, ...outreachData() });
  });

  /** Redraft one message from the prospect's current facts (keeps the recipient). */
  r.post('/outreach/lark/:id/regenerate', async (req, res) => {
    const m = larkOr404(req);
    if (m.status === 'sent') throw new HttpError(400, 'That message has already been sent.');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const p = q.getProspect(m.prospect_id);
    if (!p) throw new HttpError(404, 'Prospect not found');
    const picked = pickLarkRecipient(q, p);
    const contact = m.contact_id ? q.listTtsContacts().find((c) => c.id === m.contact_id) ?? null : picked.contact;
    const recipient = contact && contact.id === picked.contact?.id ? picked : { contact, confidence: m.confidence, reason: m.reason ?? picked.reason };
    const g = await generateLarkMessage(q, p, recipient, { instructions: optText(b.instructions) });
    const saved = q.updateLarkMessage(m.id, { body: g.body, facts: g.facts, generator: g.generator, contact_id: contact?.id ?? null, confidence: recipient.confidence, reason: recipient.reason });
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ message: saved, ...outreachData() });
  });

  /** Spread messages over days: `per_day` a day from `start`, weekdays only when asked. */
  r.post('/outreach/lark/schedule', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n)) : [];
    if (!ids.length) throw new HttpError(400, 'No messages given.');
    const perDay = Math.max(1, Math.min(50, Number(b.per_day) || 5));
    const start = isoDay(b.start) ?? new Date().toISOString().slice(0, 10);
    const weekdaysOnly = bool(b.weekdays_only, true);
    const msgs = ids.map((id) => q.getLarkMessage(id)).filter((m): m is LarkMessage => Boolean(m) && m!.status !== 'sent' && m!.status !== 'discarded');
    const days = spreadDates(msgs.length, perDay, start, weekdaysOnly);
    msgs.forEach((m, i) => q.updateLarkMessage(m.id, { status: 'scheduled', scheduled_for: days[i] }));
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ scheduled: msgs.length, last_day: days[days.length - 1] ?? null, ...outreachData() });
  });

  /** The sender pasted it into Lark: log it on the prospect's TikTok AM channel. */
  r.post('/outreach/lark/:id/sent', (req, res) => {
    const m = larkOr404(req);
    if (m.status === 'sent') return res.json({ message: m, ...outreachData() });
    const actor = actorOf(req);
    const saved = q.updateLarkMessage(m.id, { status: 'sent', sent_at: new Date().toISOString(), sent_by: actor });
    const who = m.contact_name ?? 'TikTok Shop';
    const p = q.getProspect(m.prospect_id);
    if (p) {
      if (!p.outreach_tts_am) q.patchProspect(p.id, { outreach_tts_am: true, outreach_note: `Lark message to ${who}${m.contact_role ? ` (${m.contact_role})` : ''}`, outreach_contact: who }, actor);
      else q.logOutreach(p.id, { channel: 'tts_am', action: 'contacted', note: `Lark message to ${who}${m.contact_role ? ` (${m.contact_role})` : ''}`, contact_name: who, actor });
      if (p.status === 'new') q.patchProspect(p.id, { status: 'contacted' }, actor);
    }
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ message: saved, ...outreachData() });
  });

  r.delete('/outreach/lark/:id', (req, res) => {
    const m = larkOr404(req);
    if (m.status === 'sent') q.updateLarkMessage(m.id, { status: 'discarded' });
    else q.deleteLarkMessage(m.id);
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json(outreachData());
  });

  r.put('/bd/tts-contacts', (req, res) => {
    const b = (req.body ?? {}) as Partial<TtsContact>;
    const market = optText(b.market)?.toUpperCase();
    const name = optText(b.name);
    if (!market || !name) throw new HttpError(400, 'Market and name are required.');
    const saved = q.saveTtsContact({ id: b.id ? Number(b.id) : undefined, market, name, category: optText(b.category), role: optText(b.role), lark: optText(b.lark), email: optText(b.email), notes: optText(b.notes), is_agency_manager: Boolean(b.is_agency_manager) });
    res.json({ contact: saved, ...outreachData() });
  });

  /** Build the TikTok Shop directory from Gmail signatures and invites (needs Gmail connected). */
  r.post('/bd/tts-contacts/import-gmail', async (_req, res) => {
    try {
      const r2 = await mineTiktokContacts(q, gmail);
      liveEvents.emitUpdate({ kind: 'bd' });
      res.json({ found: r2.found, added: r2.added, updated: r2.updated, ...outreachData() });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });

  r.delete('/bd/tts-contacts/:id', (req, res) => {
    if (!q.deleteTtsContact(idParam(req))) throw new HttpError(404, 'Contact not found');
    res.json(outreachData());
  });

  r.post('/bd/watchlist', (req, res) => {
    const names = String((req.body as { names?: unknown } | undefined)?.names ?? (req.body as { name?: unknown } | undefined)?.name ?? '').split(/[\n,;]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
    if (!names.length) throw new HttpError(400, 'Give at least one name.');
    let added = 0;
    for (const n of names) if (q.addWatchlist(n, 'manual')) added += 1;
    const scan = scanEnterpriseAlerts(q);
    res.status(201).json({ added, ...scan, ...outreachData() });
  });

  r.put('/bd/watchlist/:id', (req, res) => {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean' || !q.setWatchlist(idParam(req), enabled)) throw new HttpError(400, 'Send { enabled: true|false }');
    res.json(outreachData());
  });

  r.delete('/bd/watchlist/:id', (req, res) => {
    if (!q.deleteWatchlist(idParam(req))) throw new HttpError(404, 'Not found');
    res.json(outreachData());
  });

  r.post('/bd/watchlist/sync', async (_req, res) => {
    try {
      const r = await syncWatchlistFromSheet(q);
      const scan = scanEnterpriseAlerts(q);
      res.json({ ...r, ...scan, ...outreachData() });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  r.post('/bd/alerts/scan', (_req, res) => {
    const r = scanEnterpriseAlerts(q);
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ ...r, ...outreachData() });
  });

  r.post('/bd/alerts/:id/dismiss', (req, res) => {
    if (!q.dismissAlert(idParam(req))) throw new HttpError(404, 'Alert not found');
    res.json(outreachData());
  });

  r.get('/bd/activity', (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    res.json(q.bdActivity(days));
  });

  /** Check tl;dv for calls since the last run and draft follow-ups (Claude + Gmail draft when connected). */
  r.post('/outreach/calls/check', async (_req, res) => {
    if (!tldv.configured) throw new HttpError(400, 'Set TLDV_API_KEY in .env first.');
    if (!config.anthropicApiKey) throw new HttpError(400, 'Set ANTHROPIC_API_KEY in .env first; call follow-ups are written by Claude.');
    const r = await draftCallFollowups(q, { gmail });
    res.json({ ...r, ...outreachData() });
  });

  // ---- Website enquiries ----
  const inquiriesData = (): InquiriesData => ({ inquiries: q.listInquiries(), people: q.listPeople(), gmail_accounts: gmail.accounts(), slack_channel: q.getSetting('site_inquiries_channel', '') || q.getSetting('incidents_default_channel', ''), slack_configured: slackBot.configured, gmail_connected: gmail.connected, gmail_email: gmail.email, forward_to: forwardTo(), origins: siteOrigins() });
  r.get('/inquiries', (_req, res) => res.json(inquiriesData()));
  r.put('/inquiries/settings', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.slack_channel !== undefined) q.setSetting('site_inquiries_channel', String(b.slack_channel ?? '').trim());
    if (b.origins !== undefined) q.setSetting('site_origins', String(b.origins ?? '').split(',').map((o) => o.trim()).filter(Boolean).join(','));
    if (b.forward_to !== undefined) {
      const to = String(b.forward_to ?? '').trim();
      if (to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new HttpError(400, 'Forwarding address must be an email (or empty to switch the forward off).');
      q.setSetting('site_inquiries_email', to);
    }
    res.json(inquiriesData());
  });
  /** Send (or resend) the email forward for one enquiry, e.g. after connecting Gmail. */
  r.post('/inquiries/:id/forward', async (req, res) => {
    const inq = q.getInquiry(idParam(req));
    if (!inq) throw new HttpError(404, 'Enquiry not found');
    await forwardInquiry(inq, actorOf(req));
    liveEvents.emitUpdate({ kind: 'inquiries' });
    res.json(inquiriesData());
  });
  r.put('/inquiries/:id', (req, res) => {
    const inq = q.getInquiry(idParam(req));
    if (!inq) throw new HttpError(404, 'Enquiry not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<Pick<SiteInquiry, 'status' | 'assigned_to' | 'note' | 'replied_at'>> = {};
    if (b.status !== undefined) {
      const st = String(b.status);
      if (!['new', 'replied', 'qualified', 'closed'].includes(st)) throw new HttpError(400, 'Bad status');
      patch.status = st as SiteInquiry['status'];
      if (st === 'replied' && !inq.replied_at) patch.replied_at = new Date().toISOString();
    }
    if (b.assigned_to !== undefined) patch.assigned_to = optText(b.assigned_to);
    if (b.note !== undefined) patch.note = optText(b.note);
    q.updateInquiry(inq.id, patch);
    const actor = actorOf(req);
    if (patch.status && patch.status !== inq.status) q.addInquiryEvent(inq.id, { kind: 'status', actor, detail: `Marked ${patch.status}` });
    if (b.assigned_to !== undefined && (patch.assigned_to ?? null) !== inq.assigned_to) q.addInquiryEvent(inq.id, { kind: 'assigned', actor, detail: patch.assigned_to ? `Assigned to ${patch.assigned_to}` : 'Unassigned' });
    if (b.note !== undefined && (patch.note ?? null) !== inq.note) q.addInquiryEvent(inq.id, { kind: 'note', actor, detail: patch.note ? `Note: ${patch.note}` : 'Note removed' });
    liveEvents.emitUpdate({ kind: 'inquiries' });
    res.json(inquiriesData());
  });
  /** Everything that happened with one enquiry, plus any email to or from them in the connected Gmail. */
  r.get('/inquiries/:id/history', async (req, res) => {
    const inq = q.getInquiry(idParam(req));
    if (!inq) throw new HttpError(404, 'Enquiry not found');
    const events = q.listInquiryEvents(inq.id);
    // Enquiries from before the history existed get their known milestones filled in from the row itself.
    if (!events.some((e) => e.kind === 'created')) events.unshift({ id: 0, inquiry_id: inq.id, at: inq.created_at, kind: 'created', actor: 'website', detail: `${inq.kind === 'call' ? 'Call request' : 'Message'} from ${inq.name}`, url: null });
    if (inq.forwarded_at && !events.some((e) => e.kind === 'forwarded')) events.push({ id: -1, inquiry_id: inq.id, at: inq.forwarded_at, kind: 'forwarded', actor: 'dashboard', detail: `Emailed to ${forwardTo() || 'the team'}`, url: null });
    if (inq.replied_at && !events.some((e) => e.kind === 'status' && e.detail === 'Marked replied')) events.push({ id: -2, inquiry_id: inq.id, at: inq.replied_at, kind: 'status', actor: null, detail: 'Marked replied', url: null });
    events.sort((a, b) => a.at.localeCompare(b.at));
    const mail: InquiryMail[] = [];
    let mail_account: string | null = null;
    let mail_error: string | null = null;
    const mine = gmail.forActor(actorOf(req));
    if (mine.connected) {
      mail_account = mine.email;
      try {
        const own = (mine.email ?? '').toLowerCase();
        for (const m of await mine.searchMessages(`(from:${inq.email} OR to:${inq.email})`, 20)) {
          const sent = (m.from_email ?? '') === own || (m.from_email ?? '') !== inq.email.toLowerCase();
          mail.push({ id: m.id, direction: sent ? 'sent' : 'received', from: m.from_email, to: m.to, subject: m.subject, snippet: m.body.replace(/\s+/g, ' ').trim().slice(0, 200), date: m.date, url: `https://mail.google.com/mail/${mine.email ? `?authuser=${encodeURIComponent(mine.email)}` : 'u/0/'}#all/${m.id}` });
        }
        mail.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
      } catch (err) { mail_error = (err as Error).message; }
    }
    const out: InquiryHistory = { inquiry: inq, events, mail, mail_account, mail_error };
    res.json(out);
  });
  /** A Gmail draft replying to the enquiry, in the site's voice, ready to edit and send. */
  r.post('/inquiries/:id/draft', async (req, res) => {
    const inq = q.getInquiry(idParam(req));
    if (!inq) throw new HttpError(404, 'Enquiry not found');
    const mine = gmail.forActor(actorOf(req));
    if (!mine.connected) throw new HttpError(400, 'Connect Gmail first (Growth › Outreach emails › Settings): your own, or the shared account.');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const actor = optText(b.actor) ?? 'the Brightform team';
    const first = inq.name.split(/\s+/)[0];
    const isCall = inq.kind === 'call';
    let body = isCall
      ? `Hi ${first},\n\nThanks for asking for a call${inq.brand ? ` about ${inq.brand}` : ''}. ${inq.preferred_time ? `You said ${inq.preferred_time.replace(/^[a-z]+:\s*/, '').toLowerCase()} works best. ` : ''}Would [day, time CET] or [day, time CET] suit? Reply with whichever is easier and I'll send an invite.\n\nBest,\n${actor}\nBrightform`
      : `Hi ${first},\n\nThanks for getting in touch${inq.brand ? ` about ${inq.brand}` : ''}. \n\n[Reply here]\n\nThe quickest next step is a short call: https://calendly.com/isaacsinclair/brightform-2026-website-call\n\nBest,\n${actor}\nBrightform`;
    if (config.anthropicApiKey) {
      try {
        body = await draftWithClaude(
          isCall
            ? 'You write short replies to people who asked for a call through the website of Brightform, a TikTok Shop Partner agency in the EU. British English, warm but plain, no hype, no exclamation marks, under 110 words. Acknowledge their brand and situation specifically from the details given (category, markets, whether they already sell on TikTok Shop), say one relevant thing Brightform does for brands like theirs, and propose two concrete slots that match their preferred time, written as placeholders like [Tue 10:00 CET] for the sender to fill in. No booking links. Sign off with the sender name given. Output the email body only, no subject.'
            : 'You write short replies to inbound enquiries for Brightform, a TikTok Shop Partner agency in the EU. British English, warm but plain, no hype, no exclamation marks, under 120 words. Acknowledge what they wrote specifically, say one relevant thing Brightform does for brands like theirs, and propose a short call with this link: https://calendly.com/isaacsinclair/brightform-2026-website-call. Sign off with the sender name given. Output the email body only, no subject.',
          `${isCall ? 'Call request' : 'Enquiry'} from ${inq.name}${inq.brand ? ` at ${inq.brand}` : ''} (${inq.email})${inq.language ? `, site language ${inq.language}` : ''}${inq.preferred_time ? `, preferred time: ${inq.preferred_time}` : ''}:\n\n${inq.message}\n\nSender name: ${actor}`,
          { maxTokens: 400 },
        );
      } catch (err) { log.warn(`Enquiry draft via Claude failed, using the template: ${(err as Error).message}`); }
    }
    const draft = await mine.createDraft({ to: inq.email, toName: inq.name, subject: isCall ? `Your call with Brightform${inq.brand ? ` (${inq.brand})` : ''}` : `Re: your message to Brightform${inq.brand ? ` (${inq.brand})` : ''}`, body });
    q.addInquiryEvent(inq.id, { kind: 'draft', actor: actorOf(req), detail: `Reply drafted in Gmail (${mine.email})`, url: draft.url });
    res.json({ draft, ...inquiriesData() });
  });

  // ---- Account monitor ----

  r.get('/monitor', (_req, res) => res.json(monitor.data()));

  r.post('/monitor/scan', async (_req, res) => {
    const r = await monitor.scan();
    res.json({ ...r, ...monitor.data() });
  });

  r.put('/monitor/rules/:code', (req, res) => {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'Send { enabled: true|false }');
    monitor.setRule(String(req.params.code), enabled);
    res.json(monitor.data());
  });

  r.put('/monitor/settings', (req, res) => {
    const b = (req.body ?? {}) as { interval_minutes?: unknown; enabled?: unknown };
    if (b.interval_minutes !== undefined) q.setSetting('monitor_interval_minutes', String(Math.max(5, Number(b.interval_minutes) || 15)));
    if (typeof b.enabled === 'boolean') q.setSetting('monitor_enabled', b.enabled ? '1' : '0');
    monitor.start();
    res.json(monitor.data());
  });

  r.get('/flags', (_req, res) => res.json(scheduler.health.data()));
  r.post('/flags/pull', async (_req, res) => {
    const r2 = await scheduler.health.pullWindsor();
    const scan = await monitor.scan();
    res.json({ ...r2, scan, ...monitor.data() });
  });
  r.post('/flags/review', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const accountId = b.account_id === undefined || b.account_id === null || b.account_id === '' ? undefined : Number(b.account_id);
    const r2 = await scheduler.health.review(accountId);
    if (r2.reviewed) await monitor.scan();
    res.json({ ...r2, ...monitor.data() });
  });
  r.post('/flags/daily', async (_req, res) => {
    const r2 = await scheduler.dailyHealth();
    res.json({ ...r2, ...monitor.data() });
  });
  r.get('/flags/thresholds', (_req, res) => res.json({ thresholds: scheduler.health.thresholds(), labels: THRESHOLD_LABELS }));
  r.put('/flags/thresholds', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const thresholds = b.reset ? scheduler.health.resetThresholds() : scheduler.health.setThresholds(b);
    res.json({ thresholds, labels: THRESHOLD_LABELS });
  });
  r.get('/flags/accounts/:id/context', (req, res) => {
    const a = q.getAccount(idParam(req));
    if (!a) throw new HttpError(404, 'Account not found');
    res.json(scheduler.health.accountContext(a));
  });
  r.post('/monitor/flags/:id/ack', (req, res) => {
    if (!q.acknowledgeFlag(idParam(req))) throw new HttpError(404, 'Flag not found');
    res.json(monitor.data());
  });

  // ---- Account monitor: per-account overview, targets, SKU price list, campaigns, TikTok pull ----
  const overviewOr404 = (id: number) => {
    const o = scheduler.health.accountOverview(id, monitor.rules());
    if (!o) throw new HttpError(404, 'Account not found');
    return o;
  };
  r.get('/monitor/accounts/:id', (req, res) => res.json(overviewOr404(idParam(req))));

  /** Daily analytics for a chosen range (inclusive dates, up to a year), live from the Analytics API with the period before it. */
  r.get('/monitor/accounts/:id/series', async (req, res) => {
    const from = String(req.query.from ?? ''); const to = String(req.query.to ?? '');
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!iso.test(from) || !iso.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new HttpError(400, 'from and to must be YYYY-MM-DD');
    if (from > to) throw new HttpError(400, 'from must be on or before to');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new HttpError(400, 'A range can cover a year at most');
    const out = await scheduler.health.accountSeries(idParam(req), from, to);
    if (!out) throw new HttpError(404, 'Account not found');
    res.json(out);
  });

  /** Mark a scope as not offered on the app (or offered again), so the UI reads it as manual rather than missing. */
  r.put('/monitor/scopes/:scope', (req, res) => {
    const scope = String(req.params.scope) as TtsScope;
    if (!BLOCK_SCOPES.includes(scope)) throw new HttpError(400, 'Unknown scope');
    const b = (req.body ?? {}) as { unavailable?: unknown };
    scheduler.health.setScopeUnavailable(scope, Boolean(b.unavailable));
    res.json(monitor.data());
  });

  /** Pull every authorised shop now (all blocks, ignoring the hourly cache for the daily ones) and re-run the rules. */
  r.post('/monitor/pull', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r2 = await scheduler.health.pullTikTok({ force: true, shopIds: Array.isArray(b.shop_ids) ? b.shop_ids.map(String) : undefined });
    const scan = await monitor.scan();
    res.json({ ...r2, scan, ...monitor.data() });
  });

  const TARGET_KEYS = new Set(['samples_per_week', 'samples_min_per_week', 'gmv_target_month', 'gmv_max_weekly_spend', 'gmv_max_min_roi', 'gmv_max_gmv_target_week', 'gmv_max_spend_actual_week', 'gmv_max_gmv_actual_week', 'promo_max_discount_pct', 'campaign_full_participation', 'campaign_max_discount_pct']);
  /** Set one or many targets: { targets: [{ market, key, value|null }] }. */
  r.put('/monitor/accounts/:id/targets', async (req, res) => {
    const id = idParam(req);
    if (!q.getAccount(id)) throw new HttpError(404, 'Account not found');
    const b = (req.body ?? {}) as { targets?: { market?: unknown; key?: unknown; value?: unknown }[] };
    if (!Array.isArray(b.targets) || !b.targets.length) throw new HttpError(400, 'Send { targets: [{ market, key, value }] }');
    for (const t of b.targets) {
      const key = String(t.key ?? '');
      if (!TARGET_KEYS.has(key)) throw new HttpError(400, `Unknown target "${key}"`);
      const value = t.value === null || t.value === '' || t.value === undefined ? null : Number(t.value);
      if (value !== null && !Number.isFinite(value)) throw new HttpError(400, `${key}: not a number`);
      q.setAccountTarget(id, String(t.market ?? ''), key as Parameters<Queries['setAccountTarget']>[2], value, actorOf(req));
    }
    await monitor.scan();
    res.json(overviewOr404(id));
  });

  r.put('/monitor/accounts/:id/sku-prices', async (req, res) => {
    const id = idParam(req);
    if (!q.getAccount(id)) throw new HttpError(404, 'Account not found');
    const b = (req.body ?? {}) as { rows?: Record<string, unknown>[] };
    if (!Array.isArray(b.rows)) throw new HttpError(400, 'Send { rows: [...] }');
    const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
    for (const row of b.rows) {
      const name = optText(row.name);
      if (!name) continue;
      q.saveSkuPrice({ id: row.id ? Number(row.id) : undefined, account_id: id, market: String(row.market ?? '').toUpperCase(), tts_shop_id: optText(row.tts_shop_id), product_id: optText(row.product_id), sku_id: optText(row.sku_id), seller_sku: optText(row.seller_sku), name, list_price: numOrNull(row.list_price), floor_price: numOrNull(row.floor_price), promo_price: numOrNull(row.promo_price), current_price: numOrNull(row.current_price), currency: optText(row.currency) ?? 'EUR' });
    }
    await monitor.scan();
    res.json(overviewOr404(id));
  });
  /** Fill the price list from the last product pull of the account's shops (adds missing SKUs, refreshes current prices). */
  r.post('/monitor/accounts/:id/sku-prices/import', async (req, res) => {
    const id = idParam(req);
    if (!q.getAccount(id)) throw new HttpError(404, 'Account not found');
    const shops = q.listTtsShops().filter((sh) => sh.account_id === id);
    let added = 0;
    for (const p of q.latestHealthPulls('tts').filter((x) => shops.some((sh) => sh.id === x.shop_id))) {
      const sh = shops.find((x) => x.id === p.shop_id)!;
      const rows = p.rows as { products?: { id: string; title: string; status: string; skus: { id: string; seller_sku: string | null; price: number | null; currency: string | null }[] }[]; scopes?: Record<string, { ok: boolean }> };
      if (!rows.scopes?.product?.ok) continue;
      for (const prod of rows.products ?? []) for (const sku of prod.skus) {
        q.saveSkuPrice({ account_id: id, market: sh.market ?? '', tts_shop_id: sh.id, product_id: prod.id, sku_id: sku.id, seller_sku: sku.seller_sku, name: `${prod.title}${sku.seller_sku ? ` (${sku.seller_sku})` : ''}`, list_price: sku.price, current_price: sku.price, currency: sku.currency ?? 'EUR' });
        added += 1;
      }
    }
    if (!added) throw new HttpError(400, shops.length ? 'No product pull yet for this account: the Product management scope must be live on the app.' : 'No TikTok shop is linked to this account.');
    res.json({ imported: added, ...overviewOr404(id) });
  });
  r.delete('/monitor/sku-prices/:id', (req, res) => {
    const row = q.listSkuPrices().find((x) => x.id === idParam(req));
    if (!row || !q.deleteSkuPrice(row.id)) throw new HttpError(404, 'Row not found');
    res.json(overviewOr404(row.account_id));
  });

  r.put('/monitor/accounts/:id/campaigns', async (req, res) => {
    const id = idParam(req);
    if (!q.getAccount(id)) throw new HttpError(404, 'Account not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = optText(b.name); const begin = optText(b.begin_at); const end = optText(b.end_at);
    if (!name || !begin || !end) throw new HttpError(400, 'Name, start and end are required.');
    if (Number.isNaN(Date.parse(begin)) || Number.isNaN(Date.parse(end)) || begin >= end) throw new HttpError(400, 'Start must be before end (YYYY-MM-DD).');
    const participation = (['full', 'partial', 'none'] as const).find((x) => x === b.participation) ?? 'full';
    q.saveAccountCampaign({ id: b.id ? Number(b.id) : undefined, account_id: id, market: String(b.market ?? '').toUpperCase(), name, begin_at: begin, end_at: end, participation, discount_pct: b.discount_pct === null || b.discount_pct === '' || b.discount_pct === undefined ? null : Number(b.discount_pct), sku_scope: optText(b.sku_scope), notes: optText(b.notes) });
    await monitor.scan();
    res.json(overviewOr404(id));
  });
  r.delete('/monitor/campaigns/:id', async (req, res) => {
    const c = q.listAccountCampaigns().find((x) => x.id === idParam(req));
    if (!c || !q.deleteAccountCampaign(c.id)) throw new HttpError(404, 'Campaign not found');
    await monitor.scan();
    res.json(overviewOr404(c.account_id));
  });

  r.post('/bd/followups/remind', async (_req, res) => res.json({ ...(await scheduler.remindFollowups()), ...outreachData() }));

  // ---- CS & affiliate inbox, context library, auto-reply ----

  const inboxData = (): InboxData => {
    const conversations = q.listConversations();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return {
      conversations,
      accounts: q.listAccountReplySettings(),
      settings: inboxSettings(q),
      counts: {
        open: conversations.filter((c) => c.status !== 'closed').length,
        needs_reply: conversations.filter((c) => c.needs_reply).length,
        auto_replied_today: q.countAutoRepliesSince(today.toISOString()),
        cs: conversations.filter((c) => c.channel === 'cs').length,
        affiliate: conversations.filter((c) => c.channel === 'affiliate').length,
      },
    };
  };

  r.get('/inbox', (_req, res) => res.json({ ...inboxData(), languages: LANGUAGE_NAMES }));

  r.post('/inbox/sync', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // TikTok first (when the app is configured), then the creator inbox through Cruva for every linked shop.
    const result = tts.configured ? await syncInbox(q) : { ok: true, conversations: 0, new_messages: 0, auto_replies: 0, error: undefined as string | undefined };
    const cr = await syncCruvaInbox(q, { accountId: b.account_id !== undefined ? Number(b.account_id) || undefined : undefined });
    const merged = { ok: result.ok || cr.ok, error: [result.error, ...cr.errors].filter(Boolean).join(' | ') || undefined, conversations: result.conversations + cr.conversations, new_messages: result.new_messages + cr.new_messages, auto_replies: result.auto_replies + cr.auto_replies, cruva: cr };
    if (!merged.ok) return res.status(502).json({ error: merged.error, result: merged, ...inboxData() });
    res.json({ result: merged, ...inboxData() });
  });
  r.post('/inbox/cruva-sync', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cr = await syncCruvaInbox(q, { shopId: optText(b.shop_id) ?? undefined, accountId: b.account_id !== undefined ? Number(b.account_id) || undefined : undefined });
    res.json({ result: cr, ...inboxData() });
  });

  r.put('/inbox/settings', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.auto_reply_master !== undefined) q.setSetting('auto_reply_master', b.auto_reply_master ? '1' : '0');
    if (b.inbox_enabled !== undefined) q.setSetting('inbox_enabled', b.inbox_enabled ? '1' : '0');
    if (b.poll_seconds !== undefined) q.setSetting('inbox_poll_seconds', String(Math.max(30, int(b.poll_seconds, 120))));
    if (b.max_age_hours !== undefined) q.setSetting('auto_reply_max_age_hours', String(Math.max(1, int(b.max_age_hours, 48))));
    scheduler.inbox.start();
    liveEvents.emitUpdate({ kind: 'settings' });
    res.json(inboxData());
  });

  r.put('/inbox/accounts/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!q.getAccount(idParam(req))) throw new HttpError(404, 'Account not found');
    q.setAccountReply(idParam(req), {
      auto_reply_cs: b.auto_reply_cs === undefined ? undefined : Boolean(b.auto_reply_cs),
      auto_reply_affiliate: b.auto_reply_affiliate === undefined ? undefined : Boolean(b.auto_reply_affiliate),
      reply_language: b.reply_language === undefined ? undefined : optText(b.reply_language),
    });
    liveEvents.emitUpdate({ kind: 'inbox' });
    res.json(inboxData());
  });

  const conversationDetail = async (id: number, language?: string | null): Promise<ConversationDetail> => {
    const conversation = q.getConversation(id);
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    const messages = q.listMessages(id);
    return { conversation, messages, replies: q.listReplies(id), context: await buildContext(q, conversation, messages, language) };
  };

  r.get('/inbox/conversations/:id', async (req, res) => {
    const d = await conversationDetail(idParam(req));
    res.json({ ...d, auto_reply_blocker: replyBlocker(q, d.conversation), events: q.listReplyEvents({ conversationRef: d.conversation.id, limit: 20 }) });
  });

  /** Pause or resume automatic replies on one thread. */
  r.post('/inbox/conversations/:id/pause', async (req, res) => {
    const c = q.getConversation(idParam(req));
    if (!c) throw new HttpError(404, 'Conversation not found');
    const paused = Boolean((req.body ?? {}).paused ?? true);
    q.setSetting(`reply_pause:${c.id}`, paused ? '1' : '');
    liveEvents.emitUpdate({ kind: 'inbox' });
    res.json({ paused, ...(await conversationDetail(c.id)) });
  });

  r.put('/inbox/conversations/:id', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!q.getConversation(idParam(req))) throw new HttpError(404, 'Conversation not found');
    if (b.status !== undefined) {
      if (!['open', 'replied', 'auto_replied', 'closed'].includes(String(b.status))) throw new HttpError(400, 'Bad status');
      q.setConversationStatus(idParam(req), b.status as 'open');
    }
    if (b.language !== undefined) q.setConversationLanguage(idParam(req), optText(b.language));
    liveEvents.emitUpdate({ kind: 'inbox' });
    res.json(await conversationDetail(idParam(req)));
  });

  /** Draft a reply with Claude using the full context. Nothing is sent. */
  r.post('/inbox/conversations/:id/draft', async (req, res) => {
    const b = (req.body ?? {}) as { language?: string; instructions?: string };
    const d = await conversationDetail(idParam(req), optText(b.language));
    const { system, user } = renderPrompt(d.conversation, d.messages, d.context);
    const extra = optText(b.instructions);
    try {
      const text = await draftWithClaude(system, extra ? `${user}\n\nExtra instruction from the team: ${extra}` : user);
      const reply = q.addReply({ conversation_ref: d.conversation.id, text, mode: 'draft', created_by: actorOf(req) ?? 'dashboard', in_reply_to: d.conversation.last_message_id });
      res.json({ reply, ...(await conversationDetail(d.conversation.id, optText(b.language))) });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });

  /** Send a reply (typed or drafted) through TikTok. */
  r.post('/inbox/conversations/:id/send', async (req, res) => {
    const b = (req.body ?? {}) as { text?: string };
    const text = String(b.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Reply text is empty.');
    if (text.length > 2000) throw new HttpError(400, 'TikTok limits messages to 2000 characters.');
    const c = q.getConversation(idParam(req));
    if (!c) throw new HttpError(404, 'Conversation not found');
    if (!c.can_send) throw new HttpError(409, 'TikTok does not allow the shop to message this buyer right now (no recent order or conversation).');
    const reply = q.addReply({ conversation_ref: c.id, text, mode: 'manual', created_by: actorOf(req) ?? 'dashboard', in_reply_to: c.last_message_id });
    try {
      await sendReply(q, c, reply.id, text);
      q.setSetting(`reply_pause:${c.id}`, '');
      res.json(await conversationDetail(c.id));
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });

  // Context library
  const parseContext = (b: Record<string, unknown>, partial = false) => {
    const out: Partial<{ language: string; scope: ContextEntry['scope']; account_id: number | null; title: string; body: string; enabled: boolean }> = {};
    if (b.language !== undefined || !partial) {
      const lang = String(b.language ?? '*').trim().toLowerCase();
      if (!/^(\*|[a-z]{2})$/.test(lang)) throw new HttpError(400, 'Language must be a two-letter code or *');
      out.language = lang;
    }
    if (b.scope !== undefined || !partial) {
      const scope = String(b.scope ?? 'both');
      if (!['cs', 'affiliate', 'both'].includes(scope)) throw new HttpError(400, 'Scope must be cs, affiliate or both');
      out.scope = scope as ContextEntry['scope'];
    }
    if (b.account_id !== undefined || !partial) {
      const id = b.account_id === null || b.account_id === '' || b.account_id === undefined ? null : Number(b.account_id);
      if (id !== null && !q.getAccount(id)) throw new HttpError(400, 'Unknown account');
      out.account_id = id;
    }
    if (b.title !== undefined || !partial) {
      out.title = String(b.title ?? '').trim();
      if (!out.title) throw new HttpError(400, 'Title is required');
    }
    if (b.body !== undefined || !partial) {
      out.body = String(b.body ?? '').trim();
      if (!out.body) throw new HttpError(400, 'Body is required');
    }
    if (b.enabled !== undefined) out.enabled = Boolean(b.enabled);
    return out;
  };
  r.get('/inbox/context', (_req, res) => res.json({ entries: q.listContext(), languages: LANGUAGE_NAMES }));
  r.post('/inbox/context', (req, res) => {
    const e = parseContext((req.body ?? {}) as Record<string, unknown>);
    res.status(201).json({ entry: q.createContext(e as Required<typeof e>), entries: q.listContext() });
  });
  r.put('/inbox/context/:id', (req, res) => {
    const entry = q.updateContext(idParam(req), parseContext((req.body ?? {}) as Record<string, unknown>, true));
    if (!entry) throw new HttpError(404, 'Entry not found');
    res.json({ entry, entries: q.listContext() });
  });
  r.delete('/inbox/context/:id', (req, res) => {
    if (!q.deleteContext(idParam(req))) throw new HttpError(404, 'Entry not found');
    res.json({ entries: q.listContext() });
  });

  // ---- Replies per account (Creators / Customer service tabs) ----
  const scopeLive = (scope: 'customer_service' | 'affiliate_seller') => scheduler.health.scopeLive(scope);
  const channelParam = (req: Request): InboxChannel => {
    const ch = String(req.params.channel ?? '');
    if (ch === 'creators' || ch === 'affiliate') return 'affiliate';
    if (ch === 'cs' || ch === 'customer-service' || ch === 'buyers') return 'cs';
    throw new HttpError(400, 'channel must be creators or cs');
  };
  const accountParam = (req: Request): Account => {
    const a = q.getAccount(Number(req.params.accountId));
    if (!a) throw new HttpError(404, 'Account not found');
    return a;
  };
  r.get('/replies/summary', (_req, res) => res.json({ rows: repliesSummary(q, scopeLive), waiting: waitingAll(q), master_on: inboxSettings(q).auto_reply_master, llm_configured: inboxSettings(q).llm_configured }));
  r.get('/replies/:accountId/:channel', (req, res) => res.json(repliesData(q, accountParam(req), channelParam(req), scopeLive)));
  r.put('/replies/:accountId/:channel/policy', (req, res) => {
    const a = accountParam(req);
    const channel = channelParam(req);
    try { savePolicy(q, a.id, channel, (req.body ?? {}) as Record<string, unknown>); } catch (err) { throw new HttpError(400, (err as Error).message); }
    res.json(repliesData(q, a, channel, scopeLive));
  });
  r.post('/replies/:accountId/:channel/sample', async (req, res) => {
    const a = accountParam(req);
    const channel = channelParam(req);
    const b = (req.body ?? {}) as { text?: string; language?: string };
    const text = String(b.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Write the message the buyer or creator would send.');
    try {
      const out = await sampleThread(q, a, channel, text, optText(b.language));
      res.json({ ...out, data: repliesData(q, a, channel, scopeLive) });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });
  r.post('/replies/events/:id/feedback', (req, res) => {
    const b = (req.body ?? {}) as { feedback?: 'right' | 'wrong' | null; note?: string; teach?: { title?: string; body?: string } | null };
    if (b.feedback !== undefined && b.feedback !== null && !['right', 'wrong'].includes(String(b.feedback))) throw new HttpError(400, 'feedback must be right, wrong or null');
    try {
      const ev = replyFeedback(q, idParam(req), b.feedback === undefined ? null : b.feedback, optText(b.note), b.teach ?? null, actorOf(req));
      res.json({ event: ev });
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
  });
  /** Approve a pending draft: send it as the team. */
  r.post('/replies/drafts/:id/send', async (req, res) => {
    const draft = q.getReply(idParam(req));
    if (!draft) throw new HttpError(404, 'Draft not found');
    if (draft.sent_at) throw new HttpError(409, 'Already sent');
    const c = q.getConversation(draft.conversation_ref);
    if (!c) throw new HttpError(404, 'Conversation not found');
    if (c.conversation_id.startsWith('sample-')) throw new HttpError(409, 'Sample threads are never sent.');
    const text = String((req.body ?? {}).text ?? draft.text).trim();
    if (!text) throw new HttpError(400, 'Reply text is empty.');
    const reply = text === draft.text ? draft : q.addReply({ conversation_ref: c.id, text, mode: 'manual', created_by: actorOf(req) ?? 'dashboard', in_reply_to: c.last_message_id });
    try {
      await sendReply(q, c, reply.id, text);
      res.json(await conversationDetail(c.id));
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });

  /** Cruva outreach memory: rows of { creator_handle, summary, occurred_at?, account_id? } (e.g. exported from Cruva outreach logs). */
  r.post('/inbox/cruva-outreach/import', (req, res) => {
    const b = (req.body ?? {}) as { rows?: Record<string, unknown>[]; account_id?: number | null };
    const rows = (Array.isArray(b.rows) ? b.rows : [])
      .map((r) => ({
        account_id: r.account_id === undefined || r.account_id === null || r.account_id === '' ? (b.account_id ?? null) : Number(r.account_id),
        creator_handle: String(r.creator_handle ?? r.handle ?? r.username ?? r.creator ?? '').trim(),
        summary: String(r.summary ?? r.message ?? r.note ?? r.status ?? '').trim(),
        occurred_at: optText(r.occurred_at ?? r.date ?? r.sent_at),
        source: 'cruva',
      }))
      .filter((r) => r.creator_handle && r.summary);
    if (!rows.length) throw new HttpError(400, 'Send { rows: [{ creator_handle, summary, occurred_at? }] }');
    res.json({ imported: q.upsertCruvaOutreach(rows), total: q.countCruvaOutreach() });
  });

  // Error handler last, so every route above (including the ones appended later) returns JSON.
  r.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = (err as Error)?.message ?? 'Unknown error';
    if (status === 500) console.error(err);
    res.status(status).json({ error: message });
  });


  // ---- Stock countdown and replenishment ----
  const stock = scheduler.stock;
  r.get('/stock', (_req, res) => res.json(stock.data()));
  r.post('/stock/scan', async (req, res) => {
    const shopId = optText((req.body ?? {}).shop_id);
    const result = await stock.scan(shopId ?? undefined);
    res.json({ ...result, ...stock.data() });
  });
  r.put('/stock/settings', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const [k, key] of [['crit_days', 'stock_crit_days'], ['warn_days', 'stock_warn_days'], ['default_cover_days', 'stock_cover_days'], ['default_lead_days', 'stock_lead_days']] as const) {
      if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${k} must be a number.`); q.setSetting(key, String(n)); }
    }
    liveEvents.emitUpdate({ kind: 'stock' });
    res.json(stock.data());
  });
  r.get('/stock/:shopId/projection', (req, res) => {
    const days = req.query.days !== undefined ? Number(req.query.days) : undefined;
    const lead = req.query.lead !== undefined ? Number(req.query.lead) : undefined;
    res.json(stock.projection(String(req.params.shopId), days, lead));
  });
  r.get('/stock/:shopId/projection.csv', (req, res) => {
    const days = req.query.days !== undefined ? Number(req.query.days) : undefined;
    const lead = req.query.lead !== undefined ? Number(req.query.lead) : undefined;
    const p = stock.projection(String(req.params.shopId), days, lead);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${p.shop_name.replace(/[^A-Za-z0-9_-]+/g, '_')}_replenish_${p.cover_days}d_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(projectionCsv(p, { onlyNeeded: req.query.all !== '1' }));
  });
  r.put('/stock/:shopId/skus/:skuId', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const velocity = b.velocity === undefined ? undefined : b.velocity === null || b.velocity === '' ? null : Number(b.velocity);
    if (velocity !== undefined && velocity !== null && (!Number.isFinite(velocity) || velocity < 0)) throw new HttpError(400, 'Units per day must be a positive number.');
    q.setStockOverride(String(req.params.shopId), String(req.params.skuId), { velocity, exclude: b.exclude === undefined ? undefined : bool(b.exclude, false), note: b.note === undefined ? undefined : optText(b.note) });
    liveEvents.emitUpdate({ kind: 'stock' });
    const days = req.query.days !== undefined ? Number(req.query.days) : undefined;
    res.json(stock.projection(String(req.params.shopId), days));
  });

  // ---- FBT (Fulfilled by TikTok) inbound paperwork ----
  const fbtRequested = (raw: unknown): Record<string, { units?: number; cartons?: number; pallets?: number }> => {
    if (!raw) return {};
    let obj: unknown = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { throw new HttpError(400, 'req must be JSON.'); } }
    if (!obj || typeof obj !== 'object') return {};
    const out: Record<string, { units?: number; cartons?: number; pallets?: number }> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      const n = (x: unknown) => (x === undefined || x === null || x === '' ? undefined : Number(x));
      const units = n(e.units), cartons = n(e.cartons), pallets = n(e.pallets);
      for (const [name, val] of [['units', units], ['cartons', cartons], ['pallets', pallets]] as const) if (val !== undefined && (!Number.isFinite(val) || val < 0)) throw new HttpError(400, `${name} for ${k} must be a positive number.`);
      out[k] = { units, cartons, pallets };
    }
    return out;
  };
  const fbtPlanFor = (req: Request) => {
    const days = req.query.days !== undefined ? Number(req.query.days) : undefined;
    const lead = req.query.lead !== undefined ? Number(req.query.lead) : undefined;
    const proj = stock.projection(String(req.params.shopId), days, lead);
    return fbtPlan(q, proj, fbtRequested(req.query.req ?? (req.body ?? {}).requested));
  };
  const fbtFile = (res: Response, plan: { shop_name: string }, kind: string, ext: string) => {
    res.setHeader('Content-Type', ext === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${plan.shop_name.replace(/[^A-Za-z0-9_-]+/g, '_')}_FBT_${kind}_${new Date().toISOString().slice(0, 10)}.${ext}"`);
  };
  r.get('/stock/:shopId/fbt', (req, res) => res.json({ ...fbtPlanFor(req), fields: FBT_FIELDS }));
  r.get('/stock/:shopId/fbt/template.csv', (req, res) => { const plan = fbtPlanFor(req); fbtFile(res, plan, 'inbound_template', 'csv'); res.send(fbtTemplateCsv(plan)); });
  r.get('/stock/:shopId/fbt/manifest.csv', (req, res) => { const plan = fbtPlanFor(req); fbtFile(res, plan, 'carton_manifest', 'csv'); res.send(fbtManifestCsv(plan)); });
  r.get('/stock/:shopId/fbt/summary.txt', (req, res) => { const plan = fbtPlanFor(req); fbtFile(res, plan, 'booking_summary', 'txt'); res.send(fbtSummary(plan)); });
  r.put('/stock/:shopId/fbt/profile', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const proj = stock.projection(String(req.params.shopId));
    if (!proj.account_id) throw new HttpError(400, 'Link this shop to an account first (Settings → Accounts).');
    const market = optText(b.market) ?? fbtPlan(q, proj).market ?? '';
    const cur = fbtProfile(q, proj.account_id, market);
    const fields = new Set<string>(FBT_FIELDS.map((f) => f.key));
    let columns: FbtProfile['columns'] | undefined;
    if (typeof b.header === 'string') columns = columnsFromHeader(b.header);
    else if (Array.isArray(b.columns)) {
      columns = (b.columns as unknown[]).map((c) => {
        const o = (c ?? {}) as Record<string, unknown>;
        const header = String(o.header ?? '').trim();
        const field = fields.has(String(o.field)) ? (String(o.field) as FbtField) : 'blank';
        return { header, field };
      }).filter((c) => c.header);
      if (!columns.length) throw new HttpError(400, 'The template needs at least one column.');
    }
    const next: Partial<FbtProfile> = {
      ...cur,
      warehouse_name: b.warehouse_name === undefined ? cur.warehouse_name : optText(b.warehouse_name) ?? '',
      warehouse_id: b.warehouse_id === undefined ? cur.warehouse_id : optText(b.warehouse_id) ?? '',
      ship_from: b.ship_from === undefined ? cur.ship_from : optText(b.ship_from) ?? '',
      contact: b.contact === undefined ? cur.contact : optText(b.contact) ?? '',
      delimiter: b.delimiter === ';' ? ';' : b.delimiter === ',' ? ',' : cur.delimiter,
      ...(columns ? { columns } : {}),
    };
    if (b.reset_columns === true) delete next.columns;
    q.saveFbtProfile(proj.account_id, market, next);
    liveEvents.emitUpdate({ kind: 'stock' });
    res.json({ ...fbtPlanFor(req), fields: FBT_FIELDS });
  });
  r.put('/stock/:shopId/fbt/skus/:skuId', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const numOrNull = (k: string) => { const v = b[k]; if (v === undefined) return undefined; if (v === null || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${k} must be a positive number.`); return n; };
    const textOrNull = (k: string) => (b[k] === undefined ? undefined : optText(b[k]));
    const spec: Record<string, unknown> = {};
    for (const k of ['units_per_carton', 'carton_length_cm', 'carton_width_cm', 'carton_height_cm', 'carton_weight_kg', 'cartons_per_pallet']) { const v = numOrNull(k); if (v !== undefined) spec[k] = v; }
    for (const k of ['goods_id', 'barcode', 'expiry', 'lot']) { const v = textOrNull(k); if (v !== undefined) spec[k] = v; }
    q.saveFbtSkuSpec(String(req.params.shopId), String(req.params.skuId), spec);
    liveEvents.emitUpdate({ kind: 'stock' });
    res.json({ ...fbtPlanFor(req), fields: FBT_FIELDS });
  });

  // ---- P&L per account ----
  const pnlMonth = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) ? v : pnlCurrentMonth(q));
  r.get('/pnl/summary', (req, res) => {
    const month = pnlMonth(req.query.month);
    res.json({ month, current_month: pnlCurrentMonth(q), rows: pnlSummary(q, month) });
  });
  r.get('/pnl/:accountId', (req, res) => res.json(pnlData(q, accountParam(req), pnlMonth(req.query.month))));
  r.get('/pnl/:accountId/pnl.csv', (req, res) => {
    const d = pnlData(q, accountParam(req), pnlMonth(req.query.month));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Brightform_PnL_${d.account.name.replace(/[^A-Za-z0-9_-]+/g, '_')}_${d.month}.csv"`);
    res.send(pnlCsv(d));
  });
  r.put('/pnl/:accountId/inputs', (req, res) => {
    const account = accountParam(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const month = pnlMonth(req.query.month ?? b.month);
    const numKeys: (keyof PnlInputs)[] = ['platform_fee_pct', 'creator_commission_pct', 'agency_fee', 'agency_commission_pct', 'cogs_pct', 'shipping_pct', 'ad_spend', 'samples_sent', 'sample_unit_cost', 'other_costs'];
    const patch: Partial<PnlInputs> = {};
    for (const k of numKeys) if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${k} must be a positive number.`); (patch as Record<string, unknown>)[k] = n; }
    if (b.cogs_mode !== undefined) { if (b.cogs_mode !== 'sku' && b.cogs_mode !== 'blended') throw new HttpError(400, 'cogs_mode must be sku or blended.'); patch.cogs_mode = b.cogs_mode; }
    if (b.notes !== undefined) patch.notes = optText(b.notes) ?? '';
    const cur = q.getPnlInputs(account.id, month) ?? q.latestPnlInputs(account.id, month) ?? {};
    q.savePnlInputs(account.id, month, { ...cur, ...patch });
    liveEvents.emitUpdate({ kind: 'reports' });
    res.json(pnlData(q, account, month));
  });
  r.put('/pnl/:accountId/sku-cogs', (req, res) => {
    const account = accountParam(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const key = optText(b.key);
    if (!key) throw new HttpError(400, 'key is required.');
    const cogs = b.cogs === null || b.cogs === '' || b.cogs === undefined ? null : Number(b.cogs);
    if (cogs !== null && (!Number.isFinite(cogs) || cogs < 0)) throw new HttpError(400, 'cogs must be a positive number.');
    q.savePnlSkuCogs(account.id, key, optText(b.label) ?? key, cogs, (optText(b.currency) ?? q.getSetting('report_currency', 'EUR')).toUpperCase().slice(0, 3));
    res.json(pnlData(q, account, pnlMonth(req.query.month ?? b.month)));
  });
  r.put('/pnl/:accountId/forecast', (req, res) => {
    const account = accountParam(req);
    const b = (req.body ?? {}) as Partial<PnlForecastInputs> & { month?: string };
    const d = pnlData(q, account, pnlMonth(req.query.month ?? b.month), b);
    q.setSetting(`pnl_forecast:${account.id}`, JSON.stringify(d.forecast_inputs));
    res.json(d);
  });

  // ---- What scans when (every Accounts tab) ----
  r.get('/sync/status', (_req, res) => {
    const m = scheduler.monitor.data();
    const h = scheduler.health.data();
    const cp = scheduler.cruvaPull.status();
    const st = scheduler.stock.data();
    const pb = scheduler.playbook.data();
    const ib = inboxSettingsOf(q);
    const co = scheduler.copilot.data();
    const w = windsorStatus(q);
    res.json(syncStatus(q, {
      monitor: { last_scan_at: m.last_scan_at, last_scan_error: m.last_scan_error, scanning: m.scanning, interval_minutes: m.interval_minutes },
      health: { configured: h.windsor_configured, last_pull_at: h.last_pull_at, last_pull_error: h.last_pull_error, pulling: h.pulling, tts_last_pull_at: h.tts_last_pull_at, tts_last_pull_error: h.tts_last_pull_error, pulling_tts: h.pulling_tts, tts_configured: m.tts_configured },
      cruvaPull: { configured: cp.configured, running: cp.running, last_run_at: cp.last_run_at, last_error: cp.last_error },
      stock: { last_scan_at: st.last_scan_at, last_scan_error: st.last_scan_error, scanning: st.scanning, configured: st.tts_configured || st.cruva_configured },
      playbook: { configured: pb.mcp_configured || pb.cruva_configured, last_check_at: pb.last_check_at, last_error: pb.last_error, checking: pb.checking },
      inbox: { configured: ib.inbox_enabled, last_sync_at: ib.last_sync_at, last_sync_error: ib.last_sync_error, poll_seconds: ib.poll_seconds },
      copilot: { configured: co.slack_configured || co.gmail_connected || co.tldv_configured, last_index_at: co.last_index_at, last_index_error: co.last_index_error },
      clientTasks: scheduler.clientTasks.status(),
      cruvaInbox: scheduler.cruvaInbox.status(),
      reportsQueue: { last_tick_at: q.getSetting('reports_queue_last_tick_at', '') || null },
      windsor: { configured: w.configured, last_sync_at: w.last_sync_at, last_error: w.last_error },
      tldv: { configured: co.tldv_configured, last_check_at: q.getSetting('tldv_last_check_at', '') || null },
    }));
  });

  // ---- Ad hoc client tasks ----
  const clientTasks = scheduler.clientTasks;
  const dateParam = (v: unknown, name: string): string | undefined => { if (v === undefined || v === '') return undefined; const t = String(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new HttpError(400, `${name} must be YYYY-MM-DD.`); return t; };
  r.get('/client-tasks', (req, res) => {
    const from = dateParam(req.query.from, 'from'), to = dateParam(req.query.to, 'to');
    const accountId = req.query.account_id ? Number(req.query.account_id) : null;
    res.json(clientTasks.data({ from: from ?? to, to: to ?? from, accountId }));
  });
  r.post('/client-tasks/scan', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r2 = await clientTasks.scan({ sinceDays: b.since_days !== undefined ? Number(b.since_days) || undefined : undefined, accountId: b.account_id !== undefined ? Number(b.account_id) || undefined : undefined });
    res.json({ ...r2, ...clientTasks.data({ from: dateParam(b.from, 'from'), to: dateParam(b.to, 'to') }) });
  });
  r.post('/client-tasks', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const accountId = Number(b.account_id);
    if (!q.getAccount(accountId)) throw new HttpError(404, 'Account not found');
    const title = optText(b.title);
    if (!title) throw new HttpError(400, 'Give the task a title.');
    const due = dateParam(b.due_date, 'due_date') ?? null;
    const task = q.createClientTask({ account_id: accountId, title, detail: optText(b.detail) ?? '', source: 'manual', due_date: due, due_source: 'am', created_by: actorOf(req) });
    liveEvents.emitUpdate({ kind: 'check' });
    res.status(201).json({ task, ...clientTasks.data({ from: dateParam(b.from, 'from'), to: dateParam(b.to, 'to') }) });
  });
  r.put('/client-tasks/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cur = q.getClientTask(idParam(req));
    if (!cur) throw new HttpError(404, 'Task not found');
    const patch: Parameters<Queries['updateClientTask']>[1] = {};
    if (b.title !== undefined) { const v = optText(b.title); if (!v) throw new HttpError(400, 'Title cannot be empty.'); patch.title = v; }
    if (b.detail !== undefined) patch.detail = String(b.detail ?? '').trim();
    if (b.due_date !== undefined) { patch.due_date = dateParam(b.due_date, 'due_date') ?? null; patch.due_source = 'am'; }
    if (b.status !== undefined) {
      const st = String(b.status);
      if (!['open', 'done', 'dismissed'].includes(st)) throw new HttpError(400, 'status must be open, done or dismissed.');
      patch.status = st as 'open' | 'done' | 'dismissed';
      const now = new Date().toISOString();
      patch.completed_at = st === 'done' ? now : null;
      patch.completed_by = st === 'done' ? actorOf(req) : null;
      patch.dismissed_at = st === 'dismissed' ? now : null;
    }
    const task = q.updateClientTask(cur.id, patch);
    liveEvents.emitUpdate({ kind: 'check' });
    res.json({ task, ...clientTasks.data({ from: dateParam(b.from, 'from'), to: dateParam(b.to, 'to') }) });
  });
  r.delete('/client-tasks/:id', (req, res) => {
    if (!q.deleteClientTask(idParam(req))) throw new HttpError(404, 'Task not found');
    liveEvents.emitUpdate({ kind: 'check' });
    res.json(clientTasks.data({ from: dateParam(req.query.from, 'from'), to: dateParam(req.query.to, 'to') }));
  });

  // ---- Onboarding: targets and onboarding steps ----
  const targets = scheduler.targets;
  const onboardings = scheduler.onboardings;
  const leadParam = (req: Request) => { const l = q.listLeads(true).find((x) => x.id === Number(req.params.leadId)); if (!l) throw new HttpError(404, 'Lead not found'); return l; };
  r.get('/targets', (req, res) => {
    const month = optText(req.query.month);
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM.');
    res.json(targets.data(month, actorOf(req)));
  });
  r.post('/targets/seen', (req, res) => { targets.markSeen(actorOf(req)); res.json(targets.data(optText(req.body?.month), actorOf(req))); });
  r.post('/targets/refresh', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r2 = await targets.refresh({ leadId: b.lead_id !== undefined ? Number(b.lead_id) : undefined, useLlm: b.use_llm === undefined ? undefined : bool(b.use_llm, true) });
    res.json({ ...r2, ...targets.data(optText(b.month), actorOf(req)) });
  });
  r.post('/targets/:leadId/analyse', async (req, res) => {
    const lead = leadParam(req);
    const analysis = await targets.analyse(lead);
    res.json({ analysis, ...targets.data(optText(req.body?.month), actorOf(req)) });
  });
  r.put('/targets/:leadId', (req, res) => {
    const lead = leadParam(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<Queries['saveTargetState']>[1] = {};
    if (b.am_person_id !== undefined) { const id = b.am_person_id === null || b.am_person_id === '' ? null : Number(b.am_person_id); if (id !== null && !q.getPerson(id)) throw new HttpError(400, 'Unknown team member'); patch.am_person_id = id; q.patchLead(lead.id, { onboarding_id: id }); }
    if (b.status !== undefined) {
      const st = String(b.status);
      if (!['open', 'lost'].includes(st)) throw new HttpError(400, 'status must be open or lost (use /ready to mark ready to sign).');
      patch.status = st as 'open' | 'lost';
      patch.lost_at = st === 'lost' ? new Date().toISOString() : null;
    }
    q.saveTargetState(lead.id, patch);
    liveEvents.emitUpdate({ kind: 'leads' });
    res.json(targets.data(optText(b.month), actorOf(req)));
  });
  r.post('/targets/:leadId/ready', (req, res) => {
    const lead = leadParam(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const st = q.getTargetState(lead.id);
    q.saveTargetState(lead.id, { status: 'ready', ready_at: new Date().toISOString(), ready_by: actorOf(req) });
    const onboarding = onboardings.start({ lead, am_person_id: st?.am_person_id ?? lead.onboarding_id ?? null, actor: actorOf(req) });
    res.status(201).json({ onboarding, ...targets.data(optText(b.month), actorOf(req)) });
  });
  r.post('/targets/:leadId/reopen', (req, res) => {
    const lead = leadParam(req);
    q.saveTargetState(lead.id, { status: 'open', ready_at: null, ready_by: null, lost_at: null });
    liveEvents.emitUpdate({ kind: 'leads' });
    res.json(targets.data(optText(req.body?.month), actorOf(req)));
  });

  r.get('/onboarding', (_req, res) => res.json(onboardings.data()));
  r.post('/onboarding', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const lead = b.lead_id ? q.listLeads(true).find((x) => x.id === Number(b.lead_id)) ?? null : null;
      const o = onboardings.start({ lead, account_id: b.account_id ? Number(b.account_id) : null, name: optText(b.name), am_person_id: b.am_person_id ? Number(b.am_person_id) : null, actor: actorOf(req) });
      res.status(201).json({ onboarding: o, ...onboardings.data() });
    } catch (err) { throw new HttpError(400, (err as Error).message); }
  });
  r.put('/onboarding/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<Queries['updateOnboarding']>[1] = {};
    if (b.name !== undefined) { const v = optText(b.name); if (!v) throw new HttpError(400, 'Name cannot be empty.'); patch.name = v; }
    if (b.markets !== undefined) patch.markets = optText(b.markets);
    if (b.notes !== undefined) patch.notes = optText(b.notes);
    if (b.am_person_id !== undefined) { const id = b.am_person_id === null || b.am_person_id === '' ? null : Number(b.am_person_id); if (id !== null && !q.getPerson(id)) throw new HttpError(400, 'Unknown team member'); patch.am_person_id = id; }
    if (b.account_id !== undefined) { const id = b.account_id === null || b.account_id === '' ? null : Number(b.account_id); if (id !== null && !q.getAccount(id)) throw new HttpError(400, 'Unknown account'); patch.account_id = id; }
    const o = q.updateOnboarding(idParam(req), patch);
    if (!o) throw new HttpError(404, 'Onboarding not found');
    liveEvents.emitUpdate({ kind: 'leads' });
    res.json({ onboarding: o, ...onboardings.data() });
  });
  r.put('/onboarding/:id/steps/:key', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try { const o = onboardings.tick(idParam(req), String(req.params.key), bool(b.done, true), actorOf(req), b.note === undefined ? undefined : optText(b.note)); res.json({ onboarding: o, ...onboardings.data() }); } catch (err) { throw new HttpError(400, (err as Error).message); }
  });
  r.post('/onboarding/:id/steps', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = optText(b.title);
    if (!title) throw new HttpError(400, 'Give the step a title.');
    try { const o = onboardings.addStep(idParam(req), optText(b.group) ?? '6. Launch', title, optText(b.help)); liveEvents.emitUpdate({ kind: 'leads' }); res.status(201).json({ onboarding: o, ...onboardings.data() }); } catch (err) { throw new HttpError(400, (err as Error).message); }
  });
  r.delete('/onboarding/:id/steps/:key', (req, res) => {
    try { const o = onboardings.removeStep(idParam(req), String(req.params.key)); liveEvents.emitUpdate({ kind: 'leads' }); res.json({ onboarding: o, ...onboardings.data() }); } catch (err) { throw new HttpError(400, (err as Error).message); }
  });
  r.put('/onboarding/:id/terms', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t: Partial<OnboardingTerms> = {};
    const numOrNull = (k: string) => { const v = b[k]; if (v === undefined) return undefined; if (v === null || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${k} must be a positive number.`); return n; };
    for (const k of ['retainer', 'commission_pct', 'term_months', 'notice_months'] as const) { const v = numOrNull(k); if (v !== undefined) (t as Record<string, unknown>)[k] = v; }
    if (b.settlement_pct !== undefined) { const v = numOrNull('settlement_pct'); t.settlement_pct = v ?? 100; }
    if (b.currency !== undefined) t.currency = (optText(b.currency) ?? 'EUR').toUpperCase().slice(0, 3);
    if (b.commission_basis !== undefined) t.commission_basis = b.commission_basis === 'mor' ? 'mor' : 'gmv';
    if (b.start_date !== undefined) { const v = optText(b.start_date); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'start_date must be YYYY-MM-DD.'); t.start_date = v; }
    for (const k of ['markets', 'billing_entity', 'notes'] as const) if (b[k] !== undefined) t[k] = optText(b[k]) ?? '';
    try { const o = onboardings.setTerms(idParam(req), t); liveEvents.emitUpdate({ kind: 'leads' }); res.json({ onboarding: o, ...onboardings.data() }); } catch (err) { throw new HttpError(400, (err as Error).message); }
  });
  r.post('/onboarding/:id/complete', (req, res) => {
    try { const o = onboardings.complete(idParam(req), actorOf(req)); res.json({ onboarding: o, ...onboardings.data() }); } catch (err) { throw new HttpError(400, (err as Error).message); }
  });
  r.delete('/onboarding/:id', (req, res) => {
    if (!q.deleteOnboarding(idParam(req))) throw new HttpError(404, 'Onboarding not found');
    liveEvents.emitUpdate({ kind: 'leads' });
    res.json(onboardings.data());
  });

  // ---- Pitch designer ----
  const pitchesData = (): PitchesData => ({
    pitches: q.listPitches(), leads: q.listLeads(false).filter((l) => !l.signed).map((l) => ({ id: l.id, name: l.name, country: l.country, poc: l.poc })), accounts: q.listAccounts().filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, markets: a.markets })),
    fastmoss_configured: fastmoss.configured, cruva_configured: cruvaMcp.configured, llm_configured: Boolean(config.anthropicApiKey),
  });
  const pitchParam = (req: Request) => { const p = q.getPitch(idParam(req)); if (!p) throw new HttpError(404, 'Pitch not found'); return p; };
  r.get('/pitch', (_req, res) => res.json(pitchesData()));
  r.get('/pitch/:id', (req, res) => res.json({ pitch: pitchParam(req), ...pitchesData() }));
  r.post('/pitch', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const lead = b.lead_id ? q.listLeads(true).find((l) => l.id === Number(b.lead_id)) ?? null : null;
    const client = optText(b.client) ?? lead?.name ?? '';
    if (!client) throw new HttpError(400, 'Who is the pitch for?');
    const brief = normaliseBrief({ ...(b.brief as Partial<PitchBrief> | undefined ?? {}), client, markets: lead?.country ? [lead.country.toUpperCase()] : (b.brief as Partial<PitchBrief> | undefined)?.markets ?? DEFAULT_BRIEF.markets, website: optText(b.website) ?? (b.brief as Partial<PitchBrief> | undefined)?.website ?? '' });
    const pitch = q.createPitch({ lead_id: lead?.id ?? null, name: optText(b.name) ?? `${client} x Brightform`, client, brief, created_by: actorOf(req) });
    res.status(201).json({ pitch, ...pitchesData() });
  });
  r.put('/pitch/:id', (req, res) => {
    const p = pitchParam(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<Queries['updatePitch']>[1] = {};
    if (b.name !== undefined) { const v = optText(b.name); if (!v) throw new HttpError(400, 'Name cannot be empty.'); patch.name = v; }
    if (b.brief !== undefined) { patch.brief = normaliseBrief(b.brief as Partial<PitchBrief>, p.brief); patch.client = patch.brief.client || p.client; }
    if (b.status !== undefined) patch.status = b.status === 'ready' ? 'ready' : 'draft';
    if (b.lead_id !== undefined) patch.lead_id = b.lead_id === null || b.lead_id === '' ? null : Number(b.lead_id);
    res.json({ pitch: q.updatePitch(p.id, patch)!, ...pitchesData() });
  });
  r.post('/pitch/:id/research', async (req, res) => {
    const p = pitchParam(req);
    const lead = p.lead_id ? q.listLeads(true).find((l) => l.id === p.lead_id) ?? null : null;
    const research = await researchPitch(q, p.brief, lead);
    // The site's theme colour becomes the primary when the brief still has the default.
    const brief = { ...p.brief };
    if (research.site?.theme_colour && /^#[0-9a-f]{6}$/i.test(research.site.theme_colour) && brief.colours.primary === DEFAULT_BRIEF.colours.primary) brief.colours = { ...brief.colours, primary: research.site.theme_colour.toLowerCase() };
    if (!brief.pdp_images.length && research.products.some((x) => x.image)) brief.pdp_images = research.products.map((x) => x.image).filter((x): x is string => Boolean(x)).slice(0, 12);
    res.json({ pitch: q.updatePitch(p.id, { research, brief })!, ...pitchesData() });
  });
  r.post('/pitch/:id/build', async (req, res) => {
    const p = pitchParam(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const deck = await buildDeck(q, p.brief, p.research, p.deck, b.use_llm === false ? null : undefined);
    res.json({ pitch: q.updatePitch(p.id, { deck, status: 'ready' })!, ...pitchesData() });
  });
  r.put('/pitch/:id/deck', (req, res) => {
    const p = pitchParam(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!p.deck) throw new HttpError(400, 'Build the deck first.');
    const deck: PitchDeck = { ...p.deck };
    if (b.palette && typeof b.palette === 'object') { const pal = b.palette as Record<string, unknown>; for (const k of ['primary', 'secondary', 'accent', 'ink', 'paper'] as const) if (typeof pal[k] === 'string' && /^#[0-9a-f]{6}$/i.test(pal[k] as string)) deck.palette = { ...deck.palette, [k]: (pal[k] as string).toLowerCase() }; }
    if (Array.isArray(b.slides)) {
      const kinds = new Set(['cover', 'agenda', 'about', 'market', 'presence', 'products', 'opportunity', 'forecast', 'creators', 'content', 'livestream', 'case_studies', 'pricing', 'roadmap', 'next', 'custom']);
      deck.slides = (b.slides as Partial<PitchSlide>[]).filter((s) => s && typeof s.key === 'string' && typeof s.title === 'string').map((s): PitchSlide => ({ key: String(s.key), kind: kinds.has(String(s.kind)) ? (s.kind as PitchSlide['kind']) : 'custom', enabled: s.enabled !== false, title: String(s.title).slice(0, 160), subtitle: typeof s.subtitle === 'string' ? s.subtitle.slice(0, 200) : null, bullets: Array.isArray(s.bullets) ? s.bullets.map(String).slice(0, 10) : [], stats: Array.isArray(s.stats) ? s.stats.filter((x) => x && typeof x === 'object').map((x) => ({ label: String((x as PitchStat).label ?? ''), value: String((x as PitchStat).value ?? ''), note: (x as PitchStat).note ? String((x as PitchStat).note) : null })).slice(0, 6) : [], images: Array.isArray(s.images) ? s.images.map(String).filter((u) => /^https?:\/\//i.test(u)).slice(0, 6) : [], body: typeof s.body === 'string' ? s.body.slice(0, 1000) : null, notes: typeof s.notes === 'string' ? s.notes.slice(0, 600) : null })).slice(0, 40);
      if (!deck.slides.length) throw new HttpError(400, 'A deck needs at least one slide.');
    }
    res.json({ pitch: q.updatePitch(p.id, { deck })!, ...pitchesData() });
  });
  r.get('/pitch/:id/deck.html', (req, res) => {
    const p = pitchParam(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${p.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.html"`);
    res.send(deckHtml(p));
  });
  r.get('/pitch/:id/export.json', (req, res) => {
    const p = pitchParam(req);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${p.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.json"`);
    res.send(JSON.stringify({ name: p.name, client: p.client, brief: p.brief, research: p.research, deck: p.deck, design_system: { fonts: { display: 'Archivo Black', body: 'Manrope' }, template: 'Brightform pitch: black cover, accent bar left, big-number stat tiles, uppercase display titles, 16:9' } }, null, 2));
  });
  r.delete('/pitch/:id', (req, res) => { if (!q.deletePitch(idParam(req))) throw new HttpError(404, 'Pitch not found'); res.json(pitchesData()); });

  // ---- Incidents (instant issue alerts to Slack) ----
  const incidents = scheduler.incidents;
  r.get('/incidents', (_req, res) => res.json(incidents.data()));
  r.post('/incidents/scan', async (_req, res) => {
    const result = await incidents.scan();
    res.json({ ...result, ...incidents.data() });
  });
  r.put('/incidents/settings', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.enabled !== undefined) q.setSetting('incidents_enabled', bool(b.enabled, true) ? '1' : '0');
    if (b.post_to_slack !== undefined) q.setSetting('incidents_post_slack', bool(b.post_to_slack, true) ? '1' : '0');
    if (b.default_channel !== undefined) q.setSetting('incidents_default_channel', String(b.default_channel ?? '').trim());
    if (b.cooldown_hours !== undefined) { const n = Number(b.cooldown_hours); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Cooldown must be a number of hours.'); q.setSetting('incidents_cooldown_hours', String(n)); }
    liveEvents.emitUpdate({ kind: 'incidents' });
    res.json(incidents.data());
  });
  r.put('/incidents/accounts/:id/channel', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!q.setAccountChannels(idParam(req), { slack_channel: optText(b.slack_channel) })) throw new HttpError(404, 'Account not found');
    liveEvents.emitUpdate({ kind: 'incidents' });
    res.json(incidents.data());
  });
  /** Anything outside the API can raise an incident (ad account disconnected, campaign rejected, a Zap from TikTok Ads): body { account_id | account, kind, message, severity? }. Same token as the ingest endpoints, or a dashboard session. */
  const ingestIncident = async (b: Record<string, unknown>) => {
    const kind = String(b.kind ?? '').trim();
    if (!incidents.kinds().some((k) => k.kind === kind)) throw new HttpError(400, `Unknown incident kind "${kind}". Known: ${incidents.kinds().map((k) => k.kind).join(', ')}`);
    const message = String(b.message ?? '').trim();
    if (!message) throw new HttpError(400, 'message is required.');
    let accountId = b.account_id !== undefined && b.account_id !== null ? Number(b.account_id) : null;
    if (accountId === null && b.account) { const name = String(b.account).toLowerCase(); accountId = q.listAccounts().find((a) => a.name.toLowerCase() === name)?.id ?? null; }
    const sev = b.severity === 'crit' || b.severity === 'warn' || b.severity === 'info' ? b.severity : undefined;
    return incidents.apply('ingest', [{ account_id: accountId, shop_id: optText(b.shop_id), kind, message, severity: sev, fingerprint: optText(b.fingerprint) ?? message.slice(0, 40), source: 'ingest' }]);
  };
  r.post('/incidents/ingest', async (req, res) => {
    const result = await ingestIncident((req.body ?? {}) as Record<string, unknown>);
    res.status(201).json({ opened: result.opened.length, ...incidents.data() });
  });
  r.post('/incidents/:id/resolve', async (req, res) => {
    const inc = q.getIncident(idParam(req));
    if (!inc) throw new HttpError(404, 'Incident not found');
    q.updateIncident(inc.id, { resolved_at: new Date().toISOString() });
    liveEvents.emitUpdate({ kind: 'incidents' });
    res.json(incidents.data());
  });
  r.post('/incidents/:id/repost', async (req, res) => {
    const inc = q.getIncident(idParam(req));
    if (!inc) throw new HttpError(404, 'Incident not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.slack_channel !== undefined) q.updateIncident(inc.id, { slack_channel: optText(b.slack_channel) });
    const out = await incidents.post(q.getIncident(inc.id)!);
    if (out.post_error) throw new HttpError(502, out.post_error);
    liveEvents.emitUpdate({ kind: 'incidents' });
    res.json(incidents.data());
  });

  // ---- Client reports ----
  const reports = scheduler.reports;
  r.get('/reports', (_req, res) => res.json(reports.data()));
  r.get('/reports/period', (req, res) => {
    const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
    res.json(periodBounds(period, optText(req.query.end)));
  });
  r.post('/reports/generate', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const accountId = Number(b.account_id);
    if (!Number.isInteger(accountId)) throw new HttpError(400, 'account_id is required.');
    const period = b.period === 'monthly' ? 'monthly' : 'weekly';
    const end = optText(b.end);
    if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new HttpError(400, 'End date must be YYYY-MM-DD.');
    try {
      const report = await reports.generate(accountId, period, { endDate: end, instructions: optText(b.instructions), notes: Array.isArray(b.notes) ? (b.notes as unknown[]).map(String).filter(Boolean) : optText(b.notes) ? String(b.notes).split('\n').map((x) => x.trim()).filter(Boolean) : [], actor: actorOf(req), kind: b.kind === 'cruva' ? 'cruva' : 'standard' });
      res.status(201).json({ report, ...reports.data() });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });
  r.post('/reports/:id/regenerate', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const report = await reports.regenerate(idParam(req), { instructions: optText(b.instructions), notes: optText(b.notes) ? String(b.notes).split('\n').map((x) => x.trim()).filter(Boolean) : undefined, refresh: b.refresh === undefined ? true : bool(b.refresh, true) });
      res.json({ report, ...reports.data() });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });
  r.put('/reports/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<Queries['updateReport']>[1] = {};
    if (b.title !== undefined) { const v = optText(b.title); if (!v) throw new HttpError(400, 'Title cannot be empty.'); patch.title = v; }
    if (b.body !== undefined) { const v = String(b.body ?? '').replace(/\r\n/g, '\n').trim(); if (!v) throw new HttpError(400, 'Body cannot be empty.'); patch.body = v; }
    if (b.slack_channel !== undefined) patch.slack_channel = optText(b.slack_channel);
    if (b.slack_draft !== undefined) patch.slack_draft = String(b.slack_draft ?? '').replace(/\r\n/g, '\n').trim() || null;
    const report = q.updateReport(idParam(req), patch);
    if (!report) throw new HttpError(404, 'Report not found');
    liveEvents.emitUpdate({ kind: 'reports' });
    res.json({ report, ...reports.data() });
  });
  r.post('/reports/:id/send', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const report = await reports.send(idParam(req), optText(b.slack_channel), { pdf: b.pdf === undefined ? true : bool(b.pdf, true), text: b.slack_draft === undefined ? undefined : String(b.slack_draft ?? '') });
      res.json({ report, ...reports.data() });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });
  r.post('/reports/:id/approve', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sendAt = optText(b.send_at);
    if (sendAt && Number.isNaN(Date.parse(sendAt))) throw new HttpError(400, 'send_at must be a date-time.');
    try {
      const report = reports.approve(idParam(req), actorOf(req), sendAt ? new Date(sendAt).toISOString() : null);
      res.json({ report, ...reports.data() });
    } catch (err) { throw new HttpError(400, (err as Error).message); }
  });
  r.post('/reports/:id/unapprove', (req, res) => {
    try { res.json({ report: reports.unapprove(idParam(req)), ...reports.data() }); } catch (err) { throw new HttpError(404, (err as Error).message); }
  });
  r.get('/reports/:id/report.pdf', (req, res) => {
    try {
      const f = reports.pdf(idParam(req));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${f.filename}"`);
      res.send(f.content);
    } catch (err) { throw new HttpError(404, (err as Error).message); }
  });
  r.put('/reports/schedules/:accountId', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const accountId = Number(req.params.accountId);
    if (!q.getAccount(accountId)) throw new HttpError(404, 'Account not found');
    const patch: Partial<ReportSchedule> = {};
    if (b.enabled !== undefined) patch.enabled = bool(b.enabled, false);
    if (b.autosend !== undefined) patch.autosend = bool(b.autosend, false);
    if (b.pdf !== undefined) patch.pdf = bool(b.pdf, true);
    if (b.weekday !== undefined) { const n = Number(b.weekday); if (!Number.isInteger(n) || n < 1 || n > 7) throw new HttpError(400, 'weekday must be 1 (Monday) to 7 (Sunday).'); patch.weekday = n; }
    if (b.hour !== undefined) { const n = Number(b.hour); if (!Number.isInteger(n) || n < 0 || n > 23) throw new HttpError(400, 'hour must be 0 to 23.'); patch.hour = n; }
    if (b.minute !== undefined) { const n = Number(b.minute); if (!Number.isInteger(n) || n < 0 || n > 59) throw new HttpError(400, 'minute must be 0 to 59.'); patch.minute = n; }
    if (b.period !== undefined) patch.period = b.period === 'monthly' ? 'monthly' : 'weekly';
    if (b.kind !== undefined) patch.kind = b.kind === 'cruva' ? 'cruva' : 'standard';
    q.saveReportSchedule(accountId, patch);
    liveEvents.emitUpdate({ kind: 'reports' });
    res.json(reports.data());
  });
  r.post('/reports/queue/tick', async (_req, res) => {
    const r2 = await reports.tick();
    res.json({ ...r2, ...reports.data() });
  });
  r.get('/reports/:id/export.md', (req, res) => {
    const rep = q.getReport(idParam(req));
    if (!rep) throw new HttpError(404, 'Report not found');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${rep.title.replace(/[^A-Za-z0-9_-]+/g, '_')}.md"`);
    res.send(`# ${rep.title}\n\n${rep.body}\n`);
  });
  r.delete('/reports/:id', (req, res) => {
    if (!q.deleteReport(idParam(req))) throw new HttpError(404, 'Report not found');
    liveEvents.emitUpdate({ kind: 'reports' });
    res.json(reports.data());
  });
  r.put('/reports/accounts/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!q.setAccountChannels(idParam(req), { client_slack_channel: b.client_slack_channel === undefined ? undefined : optText(b.client_slack_channel), client_domain: b.client_domain === undefined ? undefined : optText(b.client_domain)?.toLowerCase().replace(/^@/, '') ?? null })) throw new HttpError(404, 'Account not found');
    liveEvents.emitUpdate({ kind: 'reports' });
    res.json(reports.data());
  });

  // ---- Cruva playbook: best practice per shop, bulk prepare, review, roll out ----
  const playbook = scheduler.playbook;
  const KINDS: PlaybookKind[] = ['automation', 'workflow', 'email_campaign', 'group', 'list', 'brief', 'sender', 'tag', 'manual'];
  const bad = (err: unknown): never => { throw new HttpError(400, (err as Error).message); };
  r.get('/playbook', (_req, res) => res.json(playbook.data()));
  r.get('/playbook/test', async (_req, res) => res.json(await cruvaMcp.test()));
  // Cruva pull (REST): stats, score, samples and stock for every linked shop.
  r.get('/cruva/pull', (_req, res) => res.json(scheduler.cruvaPull.status()));
  r.post('/cruva/pull', async (req, res) => {
    const shopId = optText((req.body ?? {}).shop_id) ?? undefined;
    const result = await scheduler.cruvaPull.run(shopId);
    res.json({ ...result, ...scheduler.cruvaPull.status() });
  });
  // Slack channels for the pickers.
  r.get('/slack/channels', async (_req, res) => {
    if (!slackBot.configured) return res.json({ configured: false, channels: [] });
    try { res.json({ configured: true, channels: await slackBot.listChannels() }); } catch (err) { throw new HttpError(502, (err as Error).message); }
  });
  r.post('/playbook/shops/sync', async (_req, res) => {
    try { const result = await playbook.syncShops(); res.json({ ...result, ...playbook.data() }); } catch (err) { bad(err); }
  });
  r.post('/playbook/shops/link', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const accountId = Number(b.account_id);
    if (!q.getAccount(accountId)) throw new HttpError(404, 'Account not found');
    playbook.linkShop(String(b.shop_id ?? ''), String(b.shop_name ?? b.shop_id ?? ''), accountId);
    res.json(playbook.data());
  });
  /** One shop: checked now. Every shop: started in the background (hundreds of MCP calls), the matrix fills live. */
  r.post('/playbook/check', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const shopId = optText(b.shop_id) ?? undefined;
    const deep = b.deep === undefined ? true : bool(b.deep, true);
    try {
      if (shopId) { const result = await playbook.check(shopId, deep); return res.json({ ...playbook.data(), checked: result.shops, errors: result.errors, started: false }); }
      if (!playbook.data().mcp_configured) throw new HttpError(409, 'CRUVA_API_KEY is not set: generate one under Cruva › Dashboard › API and add it to the server secrets.');
      if (playbook.data().checking) return res.json({ ...playbook.data(), checked: 0, errors: ['A check is already running'], started: false });
      const p = playbook.check(undefined, deep).catch((err) => log.warn(`Cruva check: ${(err as Error).message}`));
      await Promise.race([p, new Promise((r) => setTimeout(r, 300))]);
      res.json({ ...playbook.data(), checked: playbook.shops().length, errors: [], started: true });
    } catch (err) { bad(err); }
  });
  r.post('/playbook/shops/:shopId/import', (req, res) => {
    try { const result = playbook.importListing(String(req.params.shopId), String((req.body ?? {}).text ?? '')); res.json({ ...result, ...playbook.data() }); } catch (err) { bad(err); }
  });
  r.put('/playbook/shops/:shopId', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.language !== undefined) q.setSetting(`playbook_lang_${String(req.params.shopId)}`, String(b.language ?? '').trim());
    liveEvents.emitUpdate({ kind: 'playbook' });
    res.json(playbook.data());
  });
  /** Draft the missing pieces for the ticked shops into a rollout; nothing goes to Cruva yet. */
  r.post('/playbook/prepare', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const shopIds = Array.isArray(b.shop_ids) ? (b.shop_ids as unknown[]).map(String) : [];
    const keys = Array.isArray(b.keys) ? (b.keys as unknown[]).map(String) : [];
    try { res.status(201).json(playbook.prepare({ shop_ids: shopIds, keys, created_by: actorOf(req) })); } catch (err) { bad(err); }
  });
  r.get('/playbook/rollouts/:id', (req, res) => { try { res.json(playbook.drafts(idParam(req))); } catch (err) { throw new HttpError(404, (err as Error).message); } });
  r.delete('/playbook/rollouts/:id', (req, res) => { playbook.deleteRollout(idParam(req)); res.json(playbook.data()); });
  r.put('/playbook/drafts/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    let payload: Record<string, unknown> | undefined;
    if (b.payload !== undefined) { try { payload = typeof b.payload === 'string' ? (JSON.parse(b.payload) as Record<string, unknown>) : (b.payload as Record<string, unknown>); } catch { throw new HttpError(400, 'Payload must be valid JSON.'); } }
    try { res.json(playbook.updateDraft(idParam(req), { copy: b.copy === undefined ? undefined : (b.copy === null ? null : String(b.copy)), payload, status: b.status === undefined ? undefined : (String(b.status) as PlaybookDraftStatus), start_after: b.start_after === undefined ? undefined : bool(b.start_after, false), save_override: b.save_override === undefined ? undefined : bool(b.save_override, false), name: optText(b.name) ?? undefined })); } catch (err) { bad(err); }
  });
  r.post('/playbook/drafts/:id/rewrite', async (req, res) => {
    try { res.json(await playbook.rewriteDraft(idParam(req), optText((req.body ?? {}).instruction))); } catch (err) { bad(err); }
  });
  /** Approve or skip many drafts at once: { ids: [], status: 'approved' | 'skipped' | 'ready' }. */
  r.post('/playbook/rollouts/:id/drafts', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(Number) : [];
    const status = String(b.status ?? '') as PlaybookDraftStatus;
    if (!['approved', 'skipped', 'ready'].includes(status)) throw new HttpError(400, 'Bad status.');
    const errors: string[] = [];
    for (const id of ids) { try { playbook.updateDraft(id, { status }); } catch (err) { errors.push(`#${id}: ${(err as Error).message}`); } }
    res.json({ errors, ...playbook.drafts(idParam(req)) });
  });
  r.post('/playbook/rollouts/:id/run', async (req, res) => {
    try { const result = await playbook.runRollout(idParam(req), actorOf(req)); res.json({ ...result, ...playbook.drafts(idParam(req)) }); } catch (err) { bad(err); }
  });
  r.post('/playbook/rollouts/:id/undo', async (req, res) => {
    try { const result = await playbook.undoRollout(idParam(req)); res.json({ ...result, ...playbook.drafts(idParam(req)) }); } catch (err) { bad(err); }
  });
  r.post('/playbook/cells', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = String(b.kind ?? '') as PlaybookKind;
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Bad kind.');
    const status = String(b.status ?? '') as PlaybookSetupCell['status'];
    if (!['set', 'missing', 'unknown', 'manual'].includes(status)) throw new HttpError(400, 'Bad status.');
    playbook.mark(String(b.shop_id ?? ''), kind, String(b.key ?? ''), status, optText(b.note));
    res.json(playbook.data());
  });
  r.put('/playbook/settings', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.endpoints !== undefined) { const t = String(b.endpoints ?? '').trim(); if (t) { try { JSON.parse(t); } catch { throw new HttpError(400, 'Endpoints must be JSON like {"automation": "/v1/automations"}.'); } } q.setSetting('cruva_endpoints', t); }
    res.json(playbook.data());
  });
  r.post('/playbook/items', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = String(b.kind ?? '') as PlaybookKind;
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Bad kind.');
    const key = String(b.key ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    const name = optText(b.name);
    if (!key || !name) throw new HttpError(400, 'Key and name are required.');
    let cfg: Record<string, unknown> = {};
    if (b.config !== undefined) { try { cfg = typeof b.config === 'string' ? (JSON.parse(b.config) as Record<string, unknown>) : (b.config as Record<string, unknown>); } catch { throw new HttpError(400, 'Config must be valid JSON.'); } }
    q.upsertPlaybookItem({ kind, key, language: optText(b.language) ?? '*', name, description: optText(b.description), config: cfg, enabled: b.enabled === undefined ? true : bool(b.enabled, true), source: 'manual' });
    liveEvents.emitUpdate({ kind: 'playbook' });
    res.status(201).json(playbook.data());
  });
  r.put('/playbook/items/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<Queries['updatePlaybookItem']>[1] = {};
    if (b.name !== undefined) { const v = optText(b.name); if (!v) throw new HttpError(400, 'Name cannot be empty.'); patch.name = v; }
    if (b.description !== undefined) patch.description = optText(b.description);
    if (b.enabled !== undefined) patch.enabled = bool(b.enabled, true);
    if (b.language !== undefined) patch.language = optText(b.language) ?? '*';
    if (b.config !== undefined) { try { patch.config = typeof b.config === 'string' ? (JSON.parse(b.config) as Record<string, unknown>) : (b.config as Record<string, unknown>); } catch { throw new HttpError(400, 'Config must be valid JSON.'); } }
    if (!q.updatePlaybookItem(idParam(req), patch)) throw new HttpError(404, 'Item not found');
    liveEvents.emitUpdate({ kind: 'playbook' });
    res.json(playbook.data());
  });
  r.delete('/playbook/items/:id', (req, res) => {
    if (!q.deletePlaybookItem(idParam(req))) throw new HttpError(404, 'Item not found');
    liveEvents.emitUpdate({ kind: 'playbook' });
    res.json(playbook.data());
  });

  // ---- Client question copilot ----
  const copilot = scheduler.copilot;
  r.get('/copilot', (_req, res) => res.json(copilot.data()));
  r.post('/copilot/index', async (_req, res) => {
    const result = await copilot.index();
    res.json({ ...result, ...copilot.data() });
  });
  r.post('/copilot/poll', async (_req, res) => {
    const result = await copilot.poll();
    res.json({ ...result, ...copilot.data() });
  });
  r.put('/copilot/settings', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.watch_slack !== undefined) q.setSetting('copilot_watch_slack', bool(b.watch_slack, true) ? '1' : '0');
    if (b.watch_email !== undefined) q.setSetting('copilot_watch_email', bool(b.watch_email, true) ? '1' : '0');
    if (b.notify_am !== undefined) q.setSetting('copilot_notify_am', bool(b.notify_am, true) ? '1' : '0');
    res.json(copilot.data());
  });
  r.post('/copilot/questions', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const question = optText(b.question);
    if (!question) throw new HttpError(400, 'Type the question first.');
    const accountId = b.account_id === undefined || b.account_id === null || b.account_id === '' ? null : Number(b.account_id);
    try {
      const asOf = optText(b.as_of);
      if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new HttpError(400, 'as_of must be YYYY-MM-DD.');
      const created = await copilot.ask({ account_id: accountId, question, source: 'manual', asked_by: optText(b.asked_by), created_by: actorOf(req), audience: b.audience === 'client' ? 'client' : 'internal', as_of: asOf });
      res.status(201).json({ question: created, ...copilot.data() });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });
  r.post('/copilot/questions/:id/answer', async (req, res) => {
    try {
      const question = await copilot.answer(idParam(req));
      res.json({ question, ...copilot.data() });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });
  r.put('/copilot/questions/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<Queries['updateQuestion']>[1] = {};
    if (b.answer !== undefined) patch.answer = optText(b.answer);
    if (b.status !== undefined && ['open', 'drafted', 'answered', 'dismissed'].includes(String(b.status))) patch.status = String(b.status) as 'open';
    if (b.account_id !== undefined) patch.account_id = b.account_id === null || b.account_id === '' ? null : Number(b.account_id);
    const question = q.updateQuestion(idParam(req), patch);
    if (!question) throw new HttpError(404, 'Question not found');
    liveEvents.emitUpdate({ kind: 'copilot' });
    res.json({ question, ...copilot.data() });
  });
  r.post('/copilot/questions/:id/send', async (req, res) => {
    try {
      const result = await copilot.send(idParam(req), optText((req.body ?? {}).answer));
      res.json({ ...result, ...copilot.data() });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });
  r.delete('/copilot/questions/:id', (req, res) => {
    if (!q.deleteQuestion(idParam(req))) throw new HttpError(404, 'Question not found');
    liveEvents.emitUpdate({ kind: 'copilot' });
    res.json(copilot.data());
  });

  return r;
}
