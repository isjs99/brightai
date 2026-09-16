import cron, { type ScheduledTask } from 'node-cron';
import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { config } from '../config.js';
import { runRule } from '../sweep/runner.js';
import type { Rule } from '../sweep/types.js';
import { nextRun } from './describe.js';

/**
 * In-process scheduler. One node-cron task per enabled rule, each with its own expression and
 * timezone. Call reloadRule() after any rule change so the schedule reflects the database.
 */
export class Scheduler {
  private tasks = new Map<number, ScheduledTask>();
  private pruneTask: ScheduledTask | null = null;

  constructor(private q: Queries) {}

  start(): void {
    for (const rule of this.q.listRules()) this.register(rule);
    // Prune old runs once a day at 03:15 server time.
    this.pruneTask = cron.schedule('15 3 * * *', () => {
      const n = this.q.pruneRuns(config.runRetentionDays);
      if (n) log.info(`Pruned ${n} runs older than ${config.runRetentionDays} days`);
    });
    this.q.pruneRuns(config.runRetentionDays);
    log.info(`Scheduler started with ${this.tasks.size} active rule(s)`);
  }

  stop(): void {
    for (const [id, task] of this.tasks) {
      task.destroy();
      this.tasks.delete(id);
    }
    this.pruneTask?.destroy();
    this.pruneTask = null;
  }

  /** Re-read a rule from the database and (re)register or unregister it. */
  reloadRule(id: number): void {
    const existing = this.tasks.get(id);
    if (existing) {
      existing.destroy();
      this.tasks.delete(id);
    }
    const rule = this.q.getRule(id);
    if (rule) this.register(rule);
  }

  private register(rule: Rule): void {
    if (!rule.enabled) return;
    if (!cron.validate(rule.cron)) {
      log.error(`Rule ${rule.id} (${rule.name}) has an invalid cron "${rule.cron}", not scheduled`);
      return;
    }
    try {
      const task = cron.schedule(
        rule.cron,
        async () => {
          const fresh = this.q.getRule(rule.id);
          if (!fresh || !fresh.enabled) return;
          await runRule(this.q, fresh, { trigger: 'schedule' });
        },
        { timezone: rule.timezone, name: `rule-${rule.id}` },
      );
      this.tasks.set(rule.id, task);
      log.info(`Scheduled rule ${rule.id} (${rule.name}): "${rule.cron}" ${rule.timezone}, next ${this.nextRunAt(rule)?.toISOString() ?? 'unknown'}`);
    } catch (err) {
      log.error(`Could not schedule rule ${rule.id}: ${(err as Error).message}`);
    }
  }

  nextRunAt(rule: Rule): Date | null {
    if (!rule.enabled) return null;
    return nextRun(rule.cron, rule.timezone);
  }
}
