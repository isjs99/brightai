import cron, { type ScheduledTask } from 'node-cron';
import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { config } from '../config.js';
import { runRule } from '../sweep/runner.js';
import { runAllChecks } from '../checklist/checker.js';
import { syncGmv } from '../gmv/sync.js';
import { LeadsWatcher } from '../leads/sync.js';
import { InboxWatcher } from '../inbox/sync.js';
import { importPullFiles } from '../bd/import.js';
import { EnrichJob } from '../bd/enrich.js';
import { apollo } from '../bd/apollo.js';
import type { Rule } from '../sweep/types.js';
import { nextRun } from './describe.js';

/**
 * In-process scheduler. One node-cron task per enabled rule, each with its own expression and
 * timezone. Call reloadRule() after any rule change so the schedule reflects the database.
 */
export class Scheduler {
  private tasks = new Map<number, ScheduledTask>();
  private pruneTask: ScheduledTask | null = null;
  private pullsTask: ScheduledTask | null = null;
  private checkTask: ScheduledTask | null = null;
  private reminderTask: ScheduledTask | null = null;
  private gmvTask: ScheduledTask | null = null;
  private gmvMonthlyTask: ScheduledTask | null = null;
  readonly leads: LeadsWatcher;
  readonly inbox: InboxWatcher;
  readonly enrich: EnrichJob;

  constructor(private q: Queries) {
    this.leads = new LeadsWatcher(q);
    this.inbox = new InboxWatcher(q);
    this.enrich = new EnrichJob(q);
  }

  start(): void {
    for (const rule of this.q.listRules()) this.register(rule);
    // Prune old runs once a day at 03:15 server time.
    this.pruneTask = cron.schedule('15 3 * * *', () => {
      const n = this.q.pruneRuns(config.runRetentionDays);
      if (n) log.info(`Pruned ${n} runs older than ${config.runRetentionDays} days`);
    });
    this.q.pruneRuns(config.runRetentionDays);
    this.q.pruneChecks(config.runRetentionDays);
    this.q.pruneCompletions(config.runRetentionDays);
    this.reloadCheckSchedule();
    this.leads.start();
    this.inbox.start();
    // New FastMoss pulls dropped into data/bd-pulls: import at start and every morning.
    importPullFiles(this.q);
    this.q.markExistingClients();
    this.autoEnrich();
    this.pullsTask = cron.schedule('0 6 * * *', () => { importPullFiles(this.q); this.q.markExistingClients(); this.autoEnrich(); }, { timezone: this.q.getSetting('check_timezone', 'Europe/Madrid') });
    log.info(`Scheduler started with ${this.tasks.size} active rule(s)`);
  }

  /** Apollo decision makers for every prospect that has none, with no one clicking: needs APOLLO_API_KEY and the switch on. */
  autoEnrich(): void {
    if (!apollo.configured || this.q.getSetting('apollo_auto_enrich', '1') !== '1' || this.enrich.state.running) return;
    const n = this.enrich.candidates().length;
    if (!n) return;
    log.info(`Auto-enriching ${n} prospect(s) without contacts via Apollo`);
    this.enrich.start();
  }

  /** (Re)register the daily checklist completion check from settings. */
  reloadCheckSchedule(): void {
    this.checkTask?.destroy();
    this.checkTask = null;
    if (this.q.getSetting('check_enabled', '1') !== '1') {
      log.info('Checklist check schedule is disabled');
      return;
    }
    const expr = this.q.getSetting('check_cron', '0 16 * * 1-5');
    const tz = this.q.getSetting('check_timezone', 'Europe/Madrid');
    if (!cron.validate(expr)) {
      log.error(`Checklist check cron "${expr}" is invalid, not scheduled`);
      return;
    }
    // The final check also DMs AMs who missed the deadline (when reminders are on).
    this.checkTask = cron.schedule(expr, () => runAllChecks(this.q, { trigger: 'schedule', remind: true, final: true }), { timezone: tz, name: 'checklist-check' });
    log.info(`Checklist check scheduled: "${expr}" ${tz}, next ${nextRun(expr, tz)?.toISOString() ?? 'unknown'}`);
    this.reloadReminderSchedule(tz);
    this.reloadGmvSchedule();
  }

  /** Earlier reminder: run the check and DM AMs whose checklists are not done yet. */
  reloadReminderSchedule(tz = this.q.getSetting('check_timezone', 'Europe/Madrid')): void {
    this.reminderTask?.destroy();
    this.reminderTask = null;
    if (this.q.getSetting('notify_ams_enabled', '0') !== '1') return;
    const expr = this.q.getSetting('reminder_cron', '0 14 * * 1-5');
    if (!cron.validate(expr)) {
      log.error(`Reminder cron "${expr}" is invalid, not scheduled`);
      return;
    }
    this.reminderTask = cron.schedule(expr, () => runAllChecks(this.q, { trigger: 'schedule', notify: false, remind: true }), { timezone: tz, name: 'am-reminder' });
    log.info(`AM reminder scheduled: "${expr}" ${tz}, next ${nextRun(expr, tz)?.toISOString() ?? 'unknown'}`);
  }

  nextReminderAt(): Date | null {
    if (this.q.getSetting('notify_ams_enabled', '0') !== '1') return null;
    return nextRun(this.q.getSetting('reminder_cron', '0 14 * * 1-5'), this.q.getSetting('check_timezone', 'Europe/Madrid'));
  }

  reloadGmvSchedule(): void {
    this.gmvTask?.destroy();
    this.gmvTask = null;
    if (this.q.getSetting('gmv_sync_enabled', '1') !== '1') return;
    const expr = this.q.getSetting('gmv_sync_cron', '15 7 * * *');
    const tz = this.q.getSetting('check_timezone', 'Europe/Madrid');
    if (!cron.validate(expr)) {
      log.error(`GMV sync cron "${expr}" is invalid, not scheduled`);
      return;
    }
    this.gmvTask = cron.schedule(expr, () => syncGmv(this.q, { days: 10 }), { timezone: tz, name: 'gmv-sync' });
    // Once a month, re-pull the whole previous month so last month's base for the bonus rule is final.
    const monthly = this.q.getSetting('gmv_monthly_cron', '30 7 1 * *');
    if (cron.validate(monthly)) {
      this.gmvMonthlyTask?.destroy();
      this.gmvMonthlyTask = cron.schedule(monthly, () => syncGmv(this.q, { days: 45 }), { timezone: tz, name: 'gmv-monthly' });
    }
    log.info(`GMV sync scheduled: "${expr}" ${tz}`);
  }

  nextCheckAt(): Date | null {
    if (this.q.getSetting('check_enabled', '1') !== '1') return null;
    return nextRun(this.q.getSetting('check_cron', '0 16 * * 1-5'), this.q.getSetting('check_timezone', 'Europe/Madrid'));
  }

  stop(): void {
    this.leads.stop();
    this.inbox.stop();
    this.pullsTask?.destroy();
    this.pullsTask = null;
    for (const [id, task] of this.tasks) {
      task.destroy();
      this.tasks.delete(id);
    }
    this.pruneTask?.destroy();
    this.pruneTask = null;
    this.checkTask?.destroy();
    this.checkTask = null;
    this.reminderTask?.destroy();
    this.reminderTask = null;
    this.gmvTask?.destroy();
    this.gmvTask = null;
    this.gmvMonthlyTask?.destroy();
    this.gmvMonthlyTask = null;
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
