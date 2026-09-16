import type Database from 'better-sqlite3';
import type { Rule, RuleInput, Run, RunItem, RunItemAction, RunStatus } from '../sweep/types.js';

type Row = Record<string, unknown>;

function rowToRule(r: Row): Rule {
  return {
    id: r.id as number,
    name: r.name as string,
    asana_project_gid: r.asana_project_gid as string,
    asana_project_name: r.asana_project_name as string,
    enabled: Boolean(r.enabled),
    cron: r.cron as string,
    timezone: r.timezone as string,
    dry_run: Boolean(r.dry_run),
    min_age_hours: r.min_age_hours as number,
    require_section_match: Boolean(r.require_section_match),
    max_deletes_per_run: r.max_deletes_per_run as number,
    notify_slack_webhook: (r.notify_slack_webhook as string | null) || null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function rowToRun(r: Row): Run {
  let warnings: string[] = [];
  try {
    warnings = JSON.parse((r.warnings as string) || '[]');
  } catch {
    warnings = [];
  }
  return {
    id: r.id as number,
    rule_id: r.rule_id as number,
    started_at: r.started_at as string,
    finished_at: (r.finished_at as string | null) ?? null,
    status: r.status as RunStatus,
    trigger: r.trigger as Run['trigger'],
    dry_run: Boolean(r.dry_run),
    scanned_count: r.scanned_count as number,
    matched_count: r.matched_count as number,
    deleted_count: r.deleted_count as number,
    error_message: (r.error_message as string | null) ?? null,
    warnings,
  };
}

function rowToItem(r: Row): RunItem {
  return {
    id: r.id as number,
    run_id: r.run_id as number,
    task_gid: r.task_gid as string,
    task_name: r.task_name as string,
    section_name: (r.section_name as string | null) ?? null,
    completed_at: (r.completed_at as string | null) ?? null,
    num_subtasks: (r.num_subtasks as number) ?? 0,
    action: r.action as RunItemAction,
    reason: (r.reason as string) ?? '',
  };
}

export class Queries {
  constructor(private db: Database.Database) {}

  // ---- Rules ----

  listRules(): Rule[] {
    return this.db.prepare('SELECT * FROM rules ORDER BY id').all().map((r) => rowToRule(r as Row));
  }

  getRule(id: number): Rule | null {
    const r = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToRule(r) : null;
  }

  createRule(input: RuleInput): Rule {
    const res = this.db
      .prepare(
        `INSERT INTO rules (name, asana_project_gid, asana_project_name, enabled, cron, timezone, dry_run,
                            min_age_hours, require_section_match, max_deletes_per_run, notify_slack_webhook)
         VALUES (@name, @asana_project_gid, @asana_project_name, @enabled, @cron, @timezone, @dry_run,
                 @min_age_hours, @require_section_match, @max_deletes_per_run, @notify_slack_webhook)`,
      )
      .run({
        ...input,
        enabled: input.enabled ? 1 : 0,
        dry_run: input.dry_run ? 1 : 0,
        require_section_match: input.require_section_match ? 1 : 0,
        notify_slack_webhook: input.notify_slack_webhook || null,
      });
    return this.getRule(Number(res.lastInsertRowid))!;
  }

  updateRule(id: number, input: RuleInput): Rule | null {
    const res = this.db
      .prepare(
        `UPDATE rules SET name=@name, asana_project_gid=@asana_project_gid, asana_project_name=@asana_project_name,
            enabled=@enabled, cron=@cron, timezone=@timezone, dry_run=@dry_run, min_age_hours=@min_age_hours,
            require_section_match=@require_section_match, max_deletes_per_run=@max_deletes_per_run,
            notify_slack_webhook=@notify_slack_webhook, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=@id`,
      )
      .run({
        ...input,
        id,
        enabled: input.enabled ? 1 : 0,
        dry_run: input.dry_run ? 1 : 0,
        require_section_match: input.require_section_match ? 1 : 0,
        notify_slack_webhook: input.notify_slack_webhook || null,
      });
    return res.changes ? this.getRule(id) : null;
  }

  setRuleProjectName(id: number, name: string): void {
    this.db.prepare('UPDATE rules SET asana_project_name = ? WHERE id = ? AND asana_project_name <> ?').run(name, id, name);
  }

  deleteRule(id: number): boolean {
    return this.db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0;
  }

  // ---- Runs ----

  createRun(ruleId: number, trigger: Run['trigger'], dryRun: boolean): Run {
    const res = this.db
      .prepare(`INSERT INTO runs (rule_id, started_at, status, trigger, dry_run) VALUES (?, ?, 'running', ?, ?)`)
      .run(ruleId, new Date().toISOString(), trigger, dryRun ? 1 : 0);
    return this.getRun(Number(res.lastInsertRowid))!;
  }

  finishRun(
    id: number,
    patch: { status: RunStatus; scanned_count: number; matched_count: number; deleted_count: number; error_message: string | null; warnings: string[] },
  ): Run {
    this.db
      .prepare(
        `UPDATE runs SET finished_at=?, status=?, scanned_count=?, matched_count=?, deleted_count=?, error_message=?, warnings=? WHERE id=?`,
      )
      .run(
        new Date().toISOString(),
        patch.status,
        patch.scanned_count,
        patch.matched_count,
        patch.deleted_count,
        patch.error_message,
        JSON.stringify(patch.warnings),
        id,
      );
    return this.getRun(id)!;
  }

  getRun(id: number): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToRun(r) : null;
  }

  listRuns(ruleId: number, limit = 100): Run[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE rule_id = ? ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(ruleId, limit)
      .map((r) => rowToRun(r as Row));
  }

  lastRun(ruleId: number): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE rule_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(ruleId) as Row | undefined;
    return r ? rowToRun(r) : null;
  }

  /** Mark any runs left in 'running' (e.g. after a crash) as errored. Called at startup. */
  failStaleRuns(): number {
    return this.db
      .prepare(`UPDATE runs SET status='error', finished_at=?, error_message='Process restarted while the run was in progress.' WHERE status='running'`)
      .run(new Date().toISOString()).changes;
  }

  addRunItems(runId: number, items: Omit<RunItem, 'id' | 'run_id'>[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO run_items (run_id, task_gid, task_name, section_name, completed_at, num_subtasks, action, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const it of items) {
        stmt.run(runId, it.task_gid, it.task_name, it.section_name, it.completed_at, it.num_subtasks, it.action, it.reason);
      }
    })();
  }

  listRunItems(runId: number): RunItem[] {
    return this.db.prepare('SELECT * FROM run_items WHERE run_id = ? ORDER BY action, task_name').all(runId).map((r) => rowToItem(r as Row));
  }

  pruneRuns(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    return this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(cutoff).changes;
  }
}
