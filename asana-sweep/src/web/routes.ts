import { Router, type Request, type Response } from 'express';
import { asana, AsanaError } from '../asana/client.js';
import { Queries } from '../db/queries.js';
import { Scheduler } from '../scheduler/index.js';
import { CRON_PRESETS, describeSchedule, isValidTimezone, nextRun, validateCron } from '../scheduler/describe.js';
import { isRuleRunning, previewRule, runAllRules, runRule } from '../sweep/runner.js';
import type { AccountInput, AccountStatusRow, Analytics, AnalyticsAccount, AnalyticsAm, CheckSettings, RuleInput, RuleSummary } from '../sweep/types.js';
import { checkAccount, isCheckRunning, runAllChecks, todayIn } from '../checklist/checker.js';
import type { AuthProvider } from './auth.js';
import { requireAuth } from './auth.js';
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
  };
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

export function buildRouter(q: Queries, scheduler: Scheduler, auth: AuthProvider): Router {
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

  r.post('/login', (req, res) => {
    if (auth.login(req, res)) return res.json({ ok: true });
    res.status(401).json({ error: 'Wrong password' });
  });

  r.post('/logout', (_req, res) => {
    auth.logout(res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => res.json({ authenticated: auth.isAuthenticated(req) }));

  // ---- Everything below needs a session ----
  r.use(requireAuth(auth));

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
    return q.listAccounts().map((account) => ({
      account,
      check: checks.get(account.id) ?? null,
      has_sweep_rule: account.asana_project_gid ? q.ruleExistsForProject(account.asana_project_gid) : false,
    }));
  };

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
    res.json({ settings: settingsPayload() });
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

  return r;
}
