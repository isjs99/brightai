import { Router, type Request, type Response } from 'express';
import { asana, AsanaError } from '../asana/client.js';
import { Queries } from '../db/queries.js';
import { Scheduler } from '../scheduler/index.js';
import { CRON_PRESETS, describeSchedule, isValidTimezone, nextRun, validateCron } from '../scheduler/describe.js';
import { isRuleRunning, previewRule, runRule } from '../sweep/runner.js';
import type { RuleInput, RuleSummary } from '../sweep/types.js';
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
    const run = await runRule(q, rule, { trigger: 'manual' });
    if (!run) return res.status(409).json({ error: 'This rule is already running. Try again in a moment.' });
    res.json({ run, rule: summarise(id) });
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
