import { asana, AsanaClient } from '../asana/client.js';
import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { postSlack } from '../notify/slack.js';
import { config } from '../config.js';
import { buildPlan, checkCap, type PlanItem } from './match.js';
import type { PreviewResult, Rule, RuleInput, Run, RunItem, RunItemAction } from './types.js';

const running = new Set<number>();

export function isRuleRunning(ruleId: number): boolean {
  return running.has(ruleId);
}

function planToItem(p: PlanItem, action: RunItemAction, reason?: string): Omit<RunItem, 'id' | 'run_id'> {
  return {
    task_gid: p.task.gid,
    task_name: p.task.name,
    section_name: p.task.section_name,
    completed_at: p.task.completed_at,
    num_subtasks: p.task.num_subtasks,
    action,
    reason: reason ?? p.reason,
  };
}

const planActionToRunAction = (p: PlanItem, dryRun: boolean): RunItemAction =>
  p.action === 'delete' ? (dryRun ? 'would_delete' : 'deleted') : p.action;

/**
 * Executes the matching logic live against Asana for a rule-shaped input, without saving a run
 * or deleting anything. Used by the dashboard's "Preview" button.
 */
export async function previewRule(input: Pick<RuleInput, 'asana_project_gid' | 'min_age_hours' | 'require_section_match' | 'max_deletes_per_run'>, client: AsanaClient = asana): Promise<PreviewResult> {
  const project = await client.getProject(input.asana_project_gid);
  const tasks = await client.listProjectTasks(input.asana_project_gid);
  const plan = buildPlan(tasks, { minAgeHours: input.min_age_hours, requireSectionMatch: input.require_section_match });
  const capError = checkCap(plan, input.max_deletes_per_run);
  const warnings = [...plan.warnings];
  if (capError) warnings.push(capError);
  return {
    project_name: project.name,
    scanned_count: plan.scanned,
    matched_count: plan.toDelete.length,
    cap_exceeded: Boolean(capError),
    warnings,
    items: plan.items.map((p) => ({ ...planToItem(p, planActionToRunAction(p, true)) })),
  };
}

export interface RunOptions {
  trigger: Run['trigger'];
  client?: AsanaClient;
  /** Delete immediately: ignore the rule's dry_run flag and min_age_hours. Used by "Run now". */
  force?: boolean;
}

/**
 * Runs a rule end to end and records the result. Returns null if the rule is already running
 * (the new trigger is skipped and logged, never queued).
 */
export async function runRule(q: Queries, rule: Rule, opts: RunOptions): Promise<Run | null> {
  if (running.has(rule.id)) {
    log.warn(`Rule ${rule.id} (${rule.name}) is already running, skipping ${opts.trigger} trigger.`);
    return null;
  }
  running.add(rule.id);
  const client = opts.client ?? asana;
  const dryRun = opts.force ? false : rule.dry_run;
  const minAgeHours = opts.force ? 0 : rule.min_age_hours;
  const run = q.createRun(rule.id, opts.trigger, dryRun);
  log.info(`Run ${run.id} started for rule ${rule.id} (${rule.name}) via ${opts.trigger}${dryRun ? ' [dry run]' : ''}${opts.force ? ' [immediate]' : ''}`);

  let finished: Run;
  try {
    const project = await client.getProject(rule.asana_project_gid);
    q.setRuleProjectName(rule.id, project.name);
    const tasks = await client.listProjectTasks(rule.asana_project_gid);
    const plan = buildPlan(tasks, { minAgeHours, requireSectionMatch: rule.require_section_match });
    const warnings = [...plan.warnings];
    if (opts.force) warnings.push('Run now: deleted immediately, ignoring dry run and the minimum age.');
    for (const w of plan.warnings) log.warn(`Run ${run.id}: ${w}`);

    const capError = checkCap(plan, rule.max_deletes_per_run);
    if (capError) {
      q.addRunItems(run.id, plan.items.map((p) => planToItem(p, planActionToRunAction(p, true))));
      finished = q.finishRun(run.id, {
        status: 'error',
        scanned_count: plan.scanned,
        matched_count: plan.toDelete.length,
        deleted_count: 0,
        error_message: capError,
        warnings,
      });
    } else if (dryRun) {
      q.addRunItems(run.id, plan.items.map((p) => planToItem(p, planActionToRunAction(p, true))));
      finished = q.finishRun(run.id, {
        status: 'dry_run',
        scanned_count: plan.scanned,
        matched_count: plan.toDelete.length,
        deleted_count: 0,
        error_message: null,
        warnings,
      });
    } else {
      const items: Omit<RunItem, 'id' | 'run_id'>[] = plan.items
        .filter((p) => p.action !== 'delete')
        .map((p) => planToItem(p, planActionToRunAction(p, false)));
      let deleted = 0;
      let failures = 0;
      for (const p of plan.toDelete) {
        try {
          await client.deleteTask(p.task.gid);
          deleted += 1;
          items.push(planToItem(p, 'deleted'));
        } catch (err) {
          failures += 1;
          const msg = (err as Error).message;
          log.error(`Run ${run.id}: failed to delete ${p.task.gid} "${p.task.name}": ${msg}`);
          items.push(planToItem(p, 'delete_failed', `${p.reason} Delete failed: ${msg}`));
        }
      }
      q.addRunItems(run.id, items);
      finished = q.finishRun(run.id, {
        status: failures ? 'error' : 'ok',
        scanned_count: plan.scanned,
        matched_count: plan.toDelete.length,
        deleted_count: deleted,
        error_message: failures ? `${failures} of ${plan.toDelete.length} deletes failed. See run items.` : null,
        warnings,
      });
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    log.error(`Run ${run.id} failed: ${msg}`);
    finished = q.finishRun(run.id, {
      status: 'error',
      scanned_count: 0,
      matched_count: 0,
      deleted_count: 0,
      error_message: msg,
      warnings: [],
    });
  } finally {
    running.delete(rule.id);
  }

  log.info(`Run ${finished.id} finished: ${finished.status} (${finished.scanned_count} scanned, ${finished.matched_count} matched, ${finished.deleted_count} deleted)`);
  if (rule.notify_slack_webhook) {
    await postSlack(rule.notify_slack_webhook, slackMessage(rule, finished));
  }
  return finished;
}

/** Run every enabled rule in sequence. Skips rules that are already running. */
export async function runAllRules(q: Queries, opts: { force: boolean; client?: AsanaClient }): Promise<Run[]> {
  const out: Run[] = [];
  for (const rule of q.listRules().filter((r) => r.enabled)) {
    const run = await runRule(q, rule, { trigger: 'manual', force: opts.force, client: opts.client });
    if (run) out.push(run);
  }
  return out;
}

export function slackMessage(rule: Rule, run: Run): string {
  const link = `${config.publicUrl}/rules/${rule.id}/runs?run=${run.id}`;
  const label = rule.asana_project_name || rule.name;
  if (run.status === 'error') {
    return `Asana sweep - ${label}: ERROR. ${run.error_message ?? 'Unknown error'} <${link}|View run>`;
  }
  const skipped = Math.max(0, run.scanned_count - run.matched_count);
  if (run.status === 'dry_run') {
    return `Asana sweep - ${label} (dry run): ${run.scanned_count} scanned, ${run.matched_count} would be deleted, ${skipped} left alone. <${link}|View run>`;
  }
  return `Asana sweep - ${label}: ${run.scanned_count} scanned, ${run.deleted_count} deleted, ${skipped} skipped (one-off or incomplete). <${link}|View run>`;
}
