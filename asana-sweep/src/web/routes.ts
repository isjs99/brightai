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
import type { AuthProvider } from './auth.js';
import { requireAdminForWrites, requireAuth, SharedPasswordAuth } from './auth.js';
import { config } from '../config.js';

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
  r.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
    const status = err instanceof HttpError ? err.status : err instanceof AsanaError ? 502 : 500;
    const message = (err as Error)?.message ?? 'Unknown error';
    if (status === 500) console.error(err);
    else if (status === 502) console.warn(`Asana error on ${_req.method} ${_req.path}: ${message}`);
    res.status(status).json({ error: message });
  });

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
    const lead = q.patchLead(idParam(req), { sourced_by_id: person(body.sourced_by_id), onboarding_id: person(body.onboarding_id) });
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

  return r;
}
