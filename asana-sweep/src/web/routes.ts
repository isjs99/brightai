import { Router, type Request, type Response } from 'express';
import { asana, AsanaError } from '../asana/client.js';
import { Queries } from '../db/queries.js';
import { Scheduler } from '../scheduler/index.js';
import { CRON_PRESETS, describeSchedule, isValidTimezone, nextRun, validateCron } from '../scheduler/describe.js';
import { isRuleRunning, previewRule, runAllRules, runRule } from '../sweep/runner.js';
import type { AccountInput, AccountStatusRow, Analytics, AnalyticsAccount, AnalyticsAm, CheckSettings, RuleInput, RuleSummary } from '../sweep/types.js';
import { checkAccount, deadlineLabel, isCheckRunning, runAllChecks, todayIn } from '../checklist/checker.js';
import { DEFAULT_REMINDER_TEXT, incompleteByPerson, notifyAms, renderReminder } from '../checklist/reminders.js';
import { slackBot } from '../notify/slackbot.js';
import { liveEvents } from '../live/events.js';
import type { LiveWatcher } from '../live/index.js';
import { buildCalendar, buildGmv, buildGrades } from '../reports/index.js';
import { syncGmv } from '../gmv/sync.js';
import { currencyForShop } from '../gmv/currency.js';
import { authorizationUrl, tts } from '../tts/client.js';
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
import { autoReplyBlocker, inboxSettings, sendReply, syncInbox } from '../inbox/sync.js';
import { buildContext, renderPrompt } from '../inbox/context.js';
import { draftWithClaude } from '../inbox/llm.js';
import { LANGUAGE_NAMES } from '../inbox/language.js';
import type { ConversationDetail, ContextEntry, InboxData } from '../sweep/types.js';
import { normaliseDomain } from '../bd/score.js';
import { importPullFiles, isoDate, parseProspectInput } from '../bd/import.js';
import { GmailClient, gmailComposeUrl } from '../bd/gmail.js';
import { bodyToHtml, LANGUAGES as OUTREACH_LANGUAGES, outreachInputs } from '../bd/outreach.js';
import { generateDraft as generateOutreachDraft } from '../bd/draft.js';
import { bulkCandidates, pickBestLinkedin } from '../bd/bulk.js';
import { projectionCsv } from '../stock/index.js';
import { periodBounds } from '../reports/client.js';
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

export function parseAccountInput(body: Record<string, unknown>): AccountInput {
  const name = String(body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Account name is required.');
  const gid = optText(body.asana_project_gid);
  if (gid && !/^\d+$/.test(gid)) throw new HttpError(400, 'Asana project GID must be numeric.');
  return {
    name,
    markets: optText(body.markets),
    am_name: optText(body.am_name),
    aa_name: optText(body.aa_name),
    asana_project_gid: gid,
    asana_project_name: String(body.asana_project_name ?? '').trim(),
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
export function parseRuleInput(body: Record<string, unknown>): RuleInput {
  const name = String(body.name ?? '').trim();
  const gid = String(body.asana_project_gid ?? '').trim();
  const cron = String(body.cron ?? '').trim();
  const timezone = String(body.timezone ?? 'Europe/Madrid').trim() || 'Europe/Madrid';
  const minAge = int(body.min_age_hours, 12);
  const maxDeletes = int(body.max_deletes_per_run, 50);
  const webhook = String(body.notify_slack_webhook ?? '').trim();

  if (!name) throw new HttpError(400, 'Name is required.');
  if (!/^\d+$/.test(gid)) throw new HttpError(400, 'Pick an Asana project (the project GID must be numeric).');
  const cronError = validateCron(cron);
  if (cronError) throw new HttpError(400, cronError);
  if (!isValidTimezone(timezone)) throw new HttpError(400, `Unknown timezone "${timezone}".`);
  if (!Number.isFinite(minAge) || minAge < 0) throw new HttpError(400, 'min_age_hours must be 0 or more.');
  if (!Number.isFinite(maxDeletes) || maxDeletes < 1) throw new HttpError(400, 'max_deletes_per_run must be at least 1.');
  if (webhook && !/^https:\/\/hooks\.slack\.com\//.test(webhook)) throw new HttpError(400, 'Slack webhook must start with https://hooks.slack.com/');

  return {
    name,
    asana_project_gid: gid,
    asana_project_name: String(body.asana_project_name ?? '').trim(),
    enabled: bool(body.enabled, true),
    cron,
    timezone,
    dry_run: bool(body.dry_run, true),
    min_age_hours: minAge,
    require_section_match: bool(body.require_section_match, true),
    max_deletes_per_run: maxDeletes,
    notify_slack_webhook: webhook || null,
  };
}

export function buildRouter(q: Queries, scheduler: Scheduler, auth: AuthProvider, live: LiveWatcher): Router {
  const r = Router();

  const summarise = (ruleId: number): RuleSummary => {
    const rule = q.getRule(ruleId);
    if (!rule) throw new HttpError(404, 'Rule not found');
    const last = q.lastRun(rule.id);
    return {
      ...rule,
      schedule_text: describeSchedule(rule.cron, rule.timezone),
      next_run_at: scheduler.nextRunAt(rule)?.toISOString() ?? null,
      last_run: last
        ? {
            id: last.id,
            status: last.status,
            started_at: last.started_at,
            finished_at: last.finished_at,
            scanned_count: last.scanned_count,
            matched_count: last.matched_count,
            deleted_count: last.deleted_count,
            error_message: last.error_message,
          }
        : null,
      is_running: isRuleRunning(rule.id),
    };
  };

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

  // ---- Everything below needs a session ----
  r.use(requireAuth(auth));
  if (auth instanceof SharedPasswordAuth) r.use(requireAdminForWrites(auth));

  r.get('/status', async (_req, res) => {
    let asanaUser: { gid: string; name: string } | null = null;
    let asanaError: string | null = null;
    if (!config.asanaPat) asanaError = 'ASANA_PAT is not set.';
    else {
      try {
        asanaUser = await asana.me();
      } catch (err) {
        asanaError = (err as Error).message;
      }
    }
    res.json({ asana_user: asanaUser, asana_error: asanaError, public_url: config.publicUrl, retention_days: config.runRetentionDays });
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

  r.get('/asana/projects', async (req, res) => {
    const qs = String(req.query.q ?? '').trim();
    if (qs.length < 2) return res.json({ projects: [] });
    const projects = await asana.searchProjects(qs);
    res.json({ projects });
  });

  // ---- Rules ----
  r.get('/rules', (_req, res) => {
    res.json({ rules: q.listRules().map((rule) => summarise(rule.id)) });
  });

  r.post('/rules', (req, res) => {
    const input = parseRuleInput(req.body ?? {});
    const rule = q.createRule(input);
    scheduler.reloadRule(rule.id);
    res.status(201).json({ rule: summarise(rule.id) });
  });

  r.get('/rules/:id', (req, res) => {
    res.json({ rule: summarise(idParam(req)) });
  });

  r.put('/rules/:id', (req, res) => {
    const id = idParam(req);
    const input = parseRuleInput(req.body ?? {});
    const rule = q.updateRule(id, input);
    if (!rule) throw new HttpError(404, 'Rule not found');
    scheduler.reloadRule(id);
    res.json({ rule: summarise(id) });
  });

  /** Partial update used by the list's enabled / dry run toggles. */
  r.patch('/rules/:id', (req, res) => {
    const id = idParam(req);
    const existing = q.getRule(id);
    if (!existing) throw new HttpError(404, 'Rule not found');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    for (const key of ['enabled', 'dry_run'] as const) if (key in body) merged[key] = Boolean(body[key]);
    q.updateRule(id, parseRuleInput(merged));
    scheduler.reloadRule(id);
    res.json({ rule: summarise(id) });
  });

  r.delete('/rules/:id', (req, res) => {
    const id = idParam(req);
    if (!q.deleteRule(id)) throw new HttpError(404, 'Rule not found');
    scheduler.reloadRule(id);
    res.json({ ok: true });
  });

  r.post('/rules/:id/duplicate', (req, res) => {
    const id = idParam(req);
    const existing = q.getRule(id);
    if (!existing) throw new HttpError(404, 'Rule not found');
    const copy = q.createRule({
      ...existing,
      name: `${existing.name} (copy)`,
      enabled: false,
      dry_run: true, // copies always start in dry run
    });
    scheduler.reloadRule(copy.id);
    res.status(201).json({ rule: summarise(copy.id) });
  });

  r.post('/rules/:id/run', async (req, res) => {
    const id = idParam(req);
    const rule = q.getRule(id);
    if (!rule) throw new HttpError(404, 'Rule not found');
    // Run now deletes immediately: ignores dry run and the minimum age.
    const run = await runRule(q, rule, { trigger: 'manual', force: true });
    if (!run) return res.status(409).json({ error: 'This rule is already running. Try again in a moment.' });
    res.json({ run, rule: summarise(id) });
  });

  r.post('/rules/run-all', async (_req, res) => {
    const runs = await runAllRules(q, { force: true });
    res.json({ runs, rules: q.listRules().map((rule) => summarise(rule.id)) });
  });

  r.get('/rules/:id/runs', (req, res) => {
    const id = idParam(req);
    if (!q.getRule(id)) throw new HttpError(404, 'Rule not found');
    res.json({ runs: q.listRuns(id, 200) });
  });

  r.get('/runs/:id', (req, res) => {
    const id = idParam(req);
    const run = q.getRun(id);
    if (!run) throw new HttpError(404, 'Run not found');
    res.json({ run, items: q.listRunItems(id) });
  });

  // ---- Preview (live matching, no writes) ----
  r.post('/preview', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gid = String(body.asana_project_gid ?? '').trim();
    if (!/^\d+$/.test(gid)) throw new HttpError(400, 'Pick an Asana project first.');
    const minAge = int(body.min_age_hours, 12);
    const maxDeletes = int(body.max_deletes_per_run, 50);
    if (!Number.isFinite(minAge) || minAge < 0) throw new HttpError(400, 'min_age_hours must be 0 or more.');
    if (!Number.isFinite(maxDeletes) || maxDeletes < 1) throw new HttpError(400, 'max_deletes_per_run must be at least 1.');
    const result = await previewRule({
      asana_project_gid: gid,
      min_age_hours: minAge,
      require_section_match: bool(body.require_section_match, true),
      max_deletes_per_run: maxDeletes,
    });
    res.json(result);
  });

  // ---- Accounts ----
  const accountRows = (date: string): AccountStatusRow[] => {
    const checks = new Map(q.listChecksForDate(date).map((c) => [c.account_id, c]));
    const lives = new Map(q.listLive(date).map((c) => [c.account_id, c]));
    return q.listAccounts().map((account) => ({
      account,
      check: checks.get(account.id) ?? null,
      live: lives.get(account.id) ?? null,
      has_sweep_rule: account.asana_project_gid ? q.ruleExistsForProject(account.asana_project_gid) : false,
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

  /** Every linked checklist board gets its own sweep rule (live, weekdays 06:30). */
  const ensureSweepRule = (account: { name: string; asana_project_gid: string | null; asana_project_name: string }) => {
    if (!account.asana_project_gid || q.ruleExistsForProject(account.asana_project_gid)) return null;
    const rule = q.createRule({
      name: `${account.name} AM Daily Checklist`,
      asana_project_gid: account.asana_project_gid,
      asana_project_name: account.asana_project_name,
      enabled: true,
      cron: '30 6 * * 1-5',
      timezone: checkTz(),
      dry_run: false,
      min_age_hours: 12,
      require_section_match: true,
      max_deletes_per_run: 50,
      notify_slack_webhook: null,
    });
    scheduler.reloadRule(rule.id);
    return rule;
  };

  r.post('/accounts', (req, res) => {
    const account = q.createAccount(parseAccountInput(req.body ?? {}));
    ensureSweepRule(account);
    res.status(201).json({ account });
  });

  r.put('/accounts/:id', (req, res) => {
    const id = idParam(req);
    const account = q.updateAccount(id, parseAccountInput(req.body ?? {}));
    if (!account) throw new HttpError(404, 'Account not found');
    ensureSweepRule(account);
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

  /** Create the sweep rule for the account's checklist project if it is missing. */
  r.post('/accounts/:id/sweep-rule', (req, res) => {
    const account = q.getAccount(idParam(req));
    if (!account) throw new HttpError(404, 'Account not found');
    if (!account.asana_project_gid) throw new HttpError(400, 'Link an Asana project first.');
    const rule = ensureSweepRule(account);
    if (!rule) throw new HttpError(409, 'A sweep rule already exists for this project.');
    res.status(201).json({ rule: summarise(rule.id) });
  });

  r.post('/accounts/:id/check', async (req, res) => {
    const account = q.getAccount(idParam(req));
    if (!account) throw new HttpError(404, 'Account not found');
    const check = await checkAccount(q, account, { trigger: 'manual', tz: checkTz() });
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
      live_enabled: q.getSetting('live_enabled', '1') === '1',
      live_interval_seconds: Number(q.getSetting('live_interval_seconds', '60')) || 60,
      live_sweep_enabled: q.getSetting('live_sweep_enabled', '1') === '1',
      live_last_tick_at: live.lastTickAt,
      live_watching: live.watching,
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
    const interval = int(body.live_interval_seconds, 60);
    if (!Number.isFinite(interval) || interval < 15 || interval > 3600) throw new HttpError(400, 'Live interval must be between 15 and 3600 seconds.');
    q.setSetting('live_enabled', bool(body.live_enabled, true) ? '1' : '0');
    q.setSetting('live_interval_seconds', String(interval));
    q.setSetting('live_sweep_enabled', bool(body.live_sweep_enabled, true) ? '1' : '0');
    scheduler.reloadCheckSchedule();
    live.start();
    liveEvents.emitUpdate({ kind: 'settings' });
    res.json({ settings: settingsPayload() });
  });

  /** Re-evaluate every board on the next tick (and run it now). */
  r.post('/live/refresh', async (_req, res) => {
    live.reset();
    await live.tick();
    res.json({ ok: true, rows: accountRows(todayIn(checkTz())) });
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

  // ---- GMV ----
  r.get('/gmv', (req, res) => res.json(buildGmv(q, monthParam(req))));

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
  r.delete('/gmv/shops/:id', (req, res) => {
    if (!q.removeShop(idParam(req))) throw new HttpError(404, 'Shop not found');
    res.json({ ok: true });
  });

  // ---- TikTok Shop connection ----
  const ttsStatus = (): TtsStatus => {
    const serviceId = q.getSetting('tts_service_id', '');
    return {
      configured: tts.configured,
      service_id: serviceId,
      authorize_url: serviceId ? authorizationUrl(serviceId, 'am-ops') : null,
      callback_url: `${config.publicUrl}/api/tts/callback`,
      shops: q.listTtsShops(),
    };
  };

  r.get('/tts/status', (_req, res) => res.json(ttsStatus()));

  r.put('/tts/settings', (req, res) => {
    q.setSetting('tts_service_id', String((req.body ?? {}).service_id ?? '').trim());
    res.json(ttsStatus());
  });

  /** Seller lands here after authorising the app. Exchange the code and store every shop it covers. */
  r.get('/tts/callback', async (req, res) => {
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
    res.json({ promotion: await pushPromotion(q, idParam(req)) });
  });
  r.post('/promotions/:id/deactivate', async (req, res) => res.json({ promotion: await deactivatePromotion(q, idParam(req)) }));
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

  // ---- Grades ----
  r.get('/grades', (req, res) => res.json(buildGrades(q, monthParam(req))));
  r.put('/grade-settings', (req, res) => {
    const w = Number((req.body ?? {}).weight_checklist);
    if (!Number.isFinite(w) || w < 0 || w > 100) throw new HttpError(400, 'weight_checklist must be 0..100');
    q.setSetting('grade_weight_checklist', String(Math.round(w)));
    res.json({ weight_checklist: Math.round(w) });
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
    drafts: q.listDrafts(),
    examples: q.listExamples(),
    settings: {
      gmail_configured: gmail.configured,
      gmail_connected: gmail.connected,
      gmail_email: gmail.email,
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
    const limit = Math.min(Math.max(Number(b.limit) || 25, 1), 200);
    if (scheduler.bulkDrafts.state.running) throw new HttpError(409, 'A bulk draft run is already going. Wait for it to finish or stop it.');
    const state = scheduler.bulkDrafts.start({ ids, market: optText(b.market), limit, include_drafted: bool(b.include_drafted, false) }, { ...opts, to_gmail: bool(b.to_gmail, true), actor: actorOf(req) });
    if (bool(b.to_gmail, true) && !gmail.connected) log.warn('Bulk drafts: Gmail is not connected, drafts stay in the dashboard');
    res.status(202).json({ state, ...bdData() });
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
    if (!gmail.connected) throw new HttpError(400, 'Connect Gmail in Settings first.');
    const open = q.listDrafts({}).filter((d) => d.status === 'draft');
    let saved = 0;
    const errors: string[] = [];
    for (const d of open) {
      try {
        const g = await gmail.createDraft({ to: d.to_email, toName: d.to_name, subject: d.subject, body: d.body, html: bodyToHtml(d.body) });
        q.updateDraft(d.id, { status: 'gmail', gmail_draft_id: g.draft_id, gmail_message_id: g.message_id, gmail_url: g.url });
        q.logOutreach(d.prospect_id, { channel: 'gmail', action: 'note', note: `Draft "${d.subject}" saved to Gmail (${gmail.email})`, contact_name: d.to_name, actor: actorOf(req) });
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
    if (gmail.connected) {
      try {
        const g = await gmail.createDraft({ to: d.to_email, toName: d.to_name, subject: d.subject, body: d.body, html: bodyToHtml(d.body) });
        const draft = q.updateDraft(d.id, { status: d.status === 'sent' ? 'sent' : 'gmail', gmail_draft_id: g.draft_id, gmail_message_id: g.message_id, gmail_url: g.url });
        q.logOutreach(d.prospect_id, { channel: 'gmail', action: 'note', note: `Draft "${d.subject}" saved to Gmail (${gmail.email})`, contact_name: d.to_name, actor: actorOf(req) });
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
    q.updateDraft(d.id, { status: 'sent' });
    const before = q.getProspect(d.prospect_id);
    if (before && !before.outreach_gmail) q.patchProspect(d.prospect_id, { outreach_gmail: true, outreach_note: `Sent "${d.subject}" to ${d.to_email}`, outreach_contact: d.to_name }, actorOf(req));
    else q.logOutreach(d.prospect_id, { channel: 'gmail', action: 'contacted', note: `Sent "${d.subject}" to ${d.to_email}`, contact_name: d.to_name, actor: actorOf(req) });
    if (before && before.status === 'new') q.patchProspect(d.prospect_id, { status: 'contacted' }, actorOf(req));
    liveEvents.emitUpdate({ kind: 'bd' });
    res.json({ draft: q.getDraft(d.id), ...outreachData() });
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
  r.get('/gmail/connect', (req, res) => {
    if (!isAdminReq(req)) return res.status(403).send('Admin only');
    if (!gmail.configured) return res.status(400).send('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
    res.redirect(gmail.authUrl());
  });

  r.get('/gmail/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const back = (msg: string, ok: boolean) => res.redirect(`/outreach?${ok ? 'notice' : 'error'}=${encodeURIComponent(msg)}`);
    if (!isAdminReq(req)) return back('Sign in as admin, then connect Gmail again.', false);
    if (error) return back(`Google said: ${error}`, false);
    if (!code || !gmail.validState(state)) return back('Gmail connect failed: bad state. Try again.', false);
    try {
      const { email } = await gmail.exchangeCode(code);
      liveEvents.emitUpdate({ kind: 'settings' });
      back(`Gmail connected as ${email}.`, true);
    } catch (err) {
      back((err as Error).message, false);
    }
  });

  r.post('/gmail/disconnect', (_req, res) => {
    gmail.disconnect();
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

  r.post('/monitor/flags/:id/ack', (req, res) => {
    if (!q.acknowledgeFlag(idParam(req))) throw new HttpError(404, 'Flag not found');
    res.json(monitor.data());
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

  r.post('/inbox/sync', async (_req, res) => {
    const result = await syncInbox(q);
    if (!result.ok) return res.status(502).json({ error: result.error, result, ...inboxData() });
    res.json({ result, ...inboxData() });
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

  const conversationDetail = (id: number, language?: string | null): ConversationDetail => {
    const conversation = q.getConversation(id);
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    const messages = q.listMessages(id);
    return { conversation, messages, replies: q.listReplies(id), context: buildContext(q, conversation, messages, language) };
  };

  r.get('/inbox/conversations/:id', (req, res) => {
    const d = conversationDetail(idParam(req));
    const s = inboxSettings(q);
    res.json({ ...d, auto_reply_blocker: autoReplyBlocker(d.conversation, s, d.conversation.last_message_id ? q.autoRepliedTo(d.conversation.id, d.conversation.last_message_id) : false, q.lastAutoReplyAt(d.conversation.id)) });
  });

  r.put('/inbox/conversations/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!q.getConversation(idParam(req))) throw new HttpError(404, 'Conversation not found');
    if (b.status !== undefined) {
      if (!['open', 'replied', 'auto_replied', 'closed'].includes(String(b.status))) throw new HttpError(400, 'Bad status');
      q.setConversationStatus(idParam(req), b.status as 'open');
    }
    if (b.language !== undefined) q.setConversationLanguage(idParam(req), optText(b.language));
    liveEvents.emitUpdate({ kind: 'inbox' });
    res.json(conversationDetail(idParam(req)));
  });

  /** Draft a reply with Claude using the full context. Nothing is sent. */
  r.post('/inbox/conversations/:id/draft', async (req, res) => {
    const b = (req.body ?? {}) as { language?: string; instructions?: string };
    const d = conversationDetail(idParam(req), optText(b.language));
    const { system, user } = renderPrompt(d.conversation, d.messages, d.context);
    const extra = optText(b.instructions);
    try {
      const text = await draftWithClaude(system, extra ? `${user}\n\nExtra instruction from the team: ${extra}` : user);
      const reply = q.addReply({ conversation_ref: d.conversation.id, text, mode: 'draft', created_by: 'dashboard', in_reply_to: d.conversation.last_message_id });
      res.json({ reply, ...conversationDetail(d.conversation.id, optText(b.language)) });
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
    const reply = q.addReply({ conversation_ref: c.id, text, mode: 'manual', created_by: 'dashboard', in_reply_to: c.last_message_id });
    try {
      await sendReply(q, c, reply.id, text);
      res.json(conversationDetail(c.id));
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
    const status = err instanceof HttpError ? err.status : err instanceof AsanaError ? 502 : 500;
    const message = (err as Error)?.message ?? 'Unknown error';
    if (status === 500) console.error(err);
    else if (status === 502) console.warn(`Asana error on ${_req.method} ${_req.path}: ${message}`);
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
      const report = await reports.generate(accountId, period, { endDate: end, instructions: optText(b.instructions), notes: Array.isArray(b.notes) ? (b.notes as unknown[]).map(String).filter(Boolean) : optText(b.notes) ? String(b.notes).split('\n').map((x) => x.trim()).filter(Boolean) : [], actor: actorOf(req) });
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
    const report = q.updateReport(idParam(req), patch);
    if (!report) throw new HttpError(404, 'Report not found');
    liveEvents.emitUpdate({ kind: 'reports' });
    res.json({ report, ...reports.data() });
  });
  r.post('/reports/:id/send', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const report = await reports.send(idParam(req), optText(b.slack_channel));
      res.json({ report, ...reports.data() });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
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

  // ---- Cruva playbook (best practice matrix) ----
  const playbook = scheduler.playbook;
  const KINDS: PlaybookKind[] = ['automation', 'workflow', 'email_campaign', 'group', 'list'];
  r.get('/playbook', (_req, res) => res.json(playbook.data()));
  r.post('/playbook/check', async (req, res) => {
    try {
      const result = await playbook.check(optText((req.body ?? {}).shop_id) ?? undefined);
      res.json({ ...result, ...playbook.data() });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
  r.post('/playbook/shops/:shopId/import', (req, res) => {
    const text = String((req.body ?? {}).text ?? '');
    try {
      const result = playbook.importListing(String(req.params.shopId), text);
      res.json({ ...result, ...playbook.data() });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
  r.put('/playbook/shops/:shopId', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.language !== undefined) q.setSetting(`playbook_lang_${String(req.params.shopId)}`, String(b.language ?? '').trim());
    liveEvents.emitUpdate({ kind: 'playbook' });
    res.json(playbook.data());
  });
  r.post('/playbook/apply', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const shopIds = Array.isArray(b.shop_ids) ? (b.shop_ids as unknown[]).map(String) : [];
    const keys = Array.isArray(b.keys) ? (b.keys as unknown[]).map(String) : [];
    if (!shopIds.length || !keys.length) throw new HttpError(400, 'Pick at least one shop and one playbook item.');
    const result = await playbook.apply({ shop_ids: shopIds, keys, language: optText(b.language), brands: b.brands && typeof b.brands === 'object' ? (b.brands as Record<string, string>) : undefined });
    res.json({ ...result, ...playbook.data() });
  });
  r.post('/playbook/cells', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = String(b.kind ?? '') as PlaybookKind;
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Bad kind.');
    const status = String(b.status ?? '') as PlaybookSetupCell['status'];
    if (!['set', 'missing', 'unknown', 'queued', 'error'].includes(status)) throw new HttpError(400, 'Bad status.');
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
      const created = await copilot.ask({ account_id: accountId, question, source: 'manual', asked_by: optText(b.asked_by), created_by: actorOf(req) });
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
