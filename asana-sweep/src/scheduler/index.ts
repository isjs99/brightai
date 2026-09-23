import cron, { type ScheduledTask } from 'node-cron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { config } from '../config.js';
import { refreshLive, runAllChecks } from '../checklist/checker.js';
import { syncGmv } from '../gmv/sync.js';
import { LeadsWatcher } from '../leads/sync.js';
import { InboxWatcher } from '../inbox/sync.js';
import { importPullFiles } from '../bd/import.js';
import { apolloStatus, EnrichJob, refreshApolloCredits } from '../bd/enrich.js';
import { fastmoss, pullFastMoss } from '../bd/fastmoss.js';
import { AccountMonitor } from '../monitor/index.js';
import { HealthEngine } from '../health/index.js';
import { draftCallFollowups, tldv } from '../bd/tldv.js';
import { scanEnterpriseAlerts } from '../bd/alerts.js';
import { GmailClient } from '../bd/gmail.js';
import { BulkDraftJob } from '../bd/bulk.js';
import { StockTracker } from '../stock/index.js';
import { IncidentEngine } from '../incidents/index.js';
import { ClientReports } from '../reports/client.js';
import { PlaybookEngine } from '../playbook/index.js';
import { Copilot } from '../copilot/index.js';
import { slackBot } from '../notify/slackbot.js';
import { apollo } from '../bd/apollo.js';
import { nextRun } from './describe.js';

/**
 * In-process scheduler: the daily checklist lock and reminders, the GMV sync, the FastMoss pull and
 * enrichment, the account monitor and the smaller background jobs. Schedules are read from settings.
 */
export class Scheduler {
  private pruneTask: ScheduledTask | null = null;
  private rolloverTask: ScheduledTask | null = null;
  private pullsTask: ScheduledTask | null = null;
  private pullsLateTask: ScheduledTask | null = null;
  private fastmossTask: ScheduledTask | null = null;
  private checkTask: ScheduledTask | null = null;
  private reminderTask: ScheduledTask | null = null;
  private gmvTask: ScheduledTask | null = null;
  private gmvMonthlyTask: ScheduledTask | null = null;
  readonly leads: LeadsWatcher;
  readonly inbox: InboxWatcher;
  readonly enrich: EnrichJob;
  readonly monitor: AccountMonitor;
  readonly health: HealthEngine;
  private healthTask: ScheduledTask | null = null;
  readonly gmail: GmailClient;
  readonly bulkDrafts: BulkDraftJob;
  readonly stock: StockTracker;
  readonly incidents: IncidentEngine;
  readonly reports: ClientReports;
  readonly playbook: PlaybookEngine;
  readonly copilot: Copilot;
  private tldvTask: ScheduledTask | null = null;
  private apolloTask: ScheduledTask | null = null;
  private followupTask: ScheduledTask | null = null;

  constructor(private q: Queries) {
    this.leads = new LeadsWatcher(q);
    this.inbox = new InboxWatcher(q);
    this.enrich = new EnrichJob(q);
    this.monitor = new AccountMonitor(q);
    this.health = new HealthEngine(q);
    this.monitor.health = this.health;
    this.gmail = new GmailClient(q);
    this.bulkDrafts = new BulkDraftJob(q, this.gmail);
    this.stock = new StockTracker(q);
    this.incidents = new IncidentEngine(q);
    this.reports = new ClientReports(q);
    this.playbook = new PlaybookEngine(q);
    this.copilot = new Copilot(q, { gmail: this.gmail });
    this.monitor.afterScan = async () => { await this.incidents.scan(); };
  }

  start(): void {
    // Prune old checks and ticks once a day at 03:15 server time.
    this.pruneTask = cron.schedule('15 3 * * *', () => {
      const n = this.q.pruneChecks(config.runRetentionDays) + this.q.pruneTicks(config.runRetentionDays);
      if (n) log.info(`Pruned ${n} checklist rows older than ${config.runRetentionDays} days`);
      this.q.pruneHealthPulls(45);
      this.q.pruneAssessments(180);
    });
    this.q.pruneChecks(config.runRetentionDays);
    this.q.pruneTicks(config.runRetentionDays);
    this.reloadCheckSchedule();
    // Today's live checklist status: now, and again just after midnight so the new day starts at 0/N.
    refreshLive(this.q);
    this.rolloverTask = cron.schedule('2 0 * * *', () => refreshLive(this.q), { timezone: this.q.getSetting('check_timezone', 'Europe/Madrid') });
    this.leads.start();
    this.inbox.start();
    // New FastMoss pulls dropped into data/bd-pulls: import at start and every morning.
    importPullFiles(this.q);
    this.q.markExistingClients();
    this.refreshApollo();
    this.autoEnrich();
    scanEnterpriseAlerts(this.q);
    // Apollo credits: refresh every 10 minutes so the BD page shows a live balance and enrichment resumes when credits return.
    this.apolloTask = cron.schedule('*/10 * * * *', () => this.refreshApollo());
    this.reloadFastmossSchedule();
    this.pullsTask = cron.schedule('0 6 * * *', () => void this.dailyPull({ fastmoss: false }), { timezone: this.q.getSetting('check_timezone', 'Europe/Madrid') });
    // A second pass late morning in case the FastMoss routine ran late.
    this.pullsLateTask = cron.schedule('0 11 * * *', () => void this.dailyPull(), { timezone: this.q.getSetting('check_timezone', 'Europe/Madrid') });
    // Account monitor: rolling scan of every account for the flags the team otherwise catches by hand.
    this.monitor.start();
    // Account health: the daily Windsor pull, the rules and the AI review, before the AMs start (06:30 Madrid).
    this.reloadHealthSchedule();
    setTimeout(() => void this.dailyHealth({ onlyIfMissing: true }), 60000);
    // Stock countdown (products + 30 days of orders per shop), Cruva playbook library, client question copilot.
    this.stock.start();
    this.playbook.seed();
    this.copilot.start();
    // tl;dv: every 30 minutes, draft follow-ups for calls that just ended.
    this.tldvTask = cron.schedule('*/30 * * * *', () => this.checkCalls());
    setTimeout(() => this.checkCalls(), 30000);
    // Follow-up reminders: 09:00 on workdays, a Slack DM per person with what is due.
    this.followupTask = cron.schedule('0 9 * * 1-5', () => void this.remindFollowups(), { timezone: this.q.getSetting('check_timezone', 'Europe/Madrid') });
    log.info('Scheduler started');
  }

  /**
   * The daily sweep: pull the repo (so the FastMoss routine's committed pull file is on disk), import new
   * pull files, mark existing clients, enrich with Apollo, scan enterprise alerts. Also runs on demand.
   */
  async dailyPull(opts: { fastmoss?: boolean } = {}): Promise<{ pulled: boolean; fastmoss: Awaited<ReturnType<typeof pullFastMoss>> | null; fastmoss_error: string | null; imported: ReturnType<typeof importPullFiles> }> {
    const pulled = await this.gitPull();
    let fm: Awaited<ReturnType<typeof pullFastMoss>> | null = null;
    let fmError: string | null = null;
    // With FastMoss API credentials the server pulls the risers itself; otherwise the routine's committed file is used.
    if ((opts.fastmoss ?? true) && fastmoss.configured && this.q.getSetting('fastmoss_pull_enabled', '1') === '1') {
      try { fm = await pullFastMoss(this.q, fastmoss); } catch (err) { fmError = (err as Error).message; log.error(`FastMoss pull failed: ${fmError}`); this.q.setSetting('fastmoss_last_error', fmError); }
    }
    const imported = importPullFiles(this.q);
    this.q.markExistingClients();
    this.autoEnrich();
    scanEnterpriseAlerts(this.q);
    this.q.setSetting('bd_last_sweep_at', new Date().toISOString());
    return { pulled, fastmoss: fm, fastmoss_error: fmError, imported };
  }

  /** The in-process FastMoss pull, daily at the configured time (default 05:30 Madrid), followed by import and enrichment. */
  reloadFastmossSchedule(): void {
    this.fastmossTask?.destroy();
    this.fastmossTask = null;
    if (!fastmoss.configured) return;
    const expr = this.q.getSetting('fastmoss_pull_cron', '30 5 * * *');
    if (!cron.validate(expr)) { log.error(`FastMoss pull cron "${expr}" is invalid`); return; }
    this.fastmossTask = cron.schedule(expr, () => void this.dailyPull({ fastmoss: true }), { timezone: this.q.getSetting('check_timezone', 'Europe/Madrid'), name: 'fastmoss-pull' });
    log.info(`FastMoss pull scheduled: "${expr}" ${this.q.getSetting('check_timezone', 'Europe/Madrid')}`);
  }

  /** git pull --ff-only in the repo the server runs from (off with BD_GIT_PULL=0 or when there is no .git). */
  private gitPull(): Promise<boolean> {
    if (process.env.BD_GIT_PULL === '0') return Promise.resolve(false);
    const root = resolve(process.cwd());
    if (!existsSync(resolve(root, '.git')) && !existsSync(resolve(root, '..', '.git'))) return Promise.resolve(false);
    return new Promise((done) => {
      execFile('git', ['pull', '--ff-only'], { cwd: root, timeout: 60000 }, (err, stdout, stderr) => {
        if (err) { log.warn(`Daily sweep: git pull failed: ${(stderr || err.message).trim().slice(0, 200)}`); done(false); return; }
        const out = String(stdout).trim();
        if (!/Already up to date/i.test(out)) log.info(`Daily sweep: git pull: ${out.split('\n').pop()}`);
        done(true);
      });
    });
  }

  /** Apollo decision makers for every prospect that has none (and a deeper pass on those with no email yet), with no one clicking: needs APOLLO_API_KEY and the switch on. Pauses while Apollo is out of credits. */
  autoEnrich(): void {
    if (!apollo.configured || this.q.getSetting('apollo_auto_enrich', '1') !== '1' || this.enrich.state.running) return;
    if (apolloStatus(this.q).exhausted) { log.warn('Auto-enrich skipped: Apollo credits are exhausted'); return; }
    const n = this.enrich.candidates('all').length;
    if (!n) return;
    log.info(`Auto-enriching ${n} prospect(s) via Apollo (new and no-email)`);
    this.enrich.start({ mode: 'all' });
  }

  /** Keep the Apollo credit balance fresh for the BD page (free call); also clears the exhausted flag when credits come back, then resumes auto-enrich. */
  refreshApollo(): void {
    if (!apollo.configured) return;
    void refreshApolloCredits(this.q).then((s) => { if (!s.exhausted) this.autoEnrich(); }).catch((err) => log.warn(`Apollo credit check failed: ${(err as Error).message}`));
  }

  /** tl;dv call follow-ups, when the key is set, Claude is configured and the switch is on. */
  checkCalls(): void {
    if (!tldv.configured || !config.anthropicApiKey || this.q.getSetting('tldv_auto_draft', '1') !== '1') return;
    void draftCallFollowups(this.q, { gmail: this.gmail }).catch((err) => log.error(`tl;dv check failed: ${(err as Error).message}`));
  }

  /** DM each person their due BD follow-ups (matched by the actor name on the follow-up); the rest go to the admin channel if configured. */
  async remindFollowups(): Promise<{ sent: number }> {
    const due = this.q.listFollowups().filter((f) => Date.parse(f.due_at) <= Date.now() + 12 * 3600000);
    if (!due.length) return { sent: 0 };
    const people = this.q.listPeople();
    const byActor = new Map<string, typeof due>();
    for (const f of due) {
      const key = (f.created_by ?? '').toLowerCase();
      byActor.set(key, [...(byActor.get(key) ?? []), f]);
    }
    let sent = 0;
    for (const [actor, items] of byActor) {
      const person = people.find((p) => p.name.toLowerCase() === actor || actor.startsWith(p.name.toLowerCase()));
      if (!person?.slack_user_id) continue;
      const lines = items.slice(0, 15).map((f) => `• ${f.title}${f.linkedin_url ? ` (${f.linkedin_url})` : ''}${f.overdue ? ' — overdue' : ''}`);
      try {
        await slackBot.dm(person.slack_user_id, `BD follow-ups due today (${items.length}):\n${lines.join('\n')}\n${config.publicUrl}/outreach?tab=followups`);
        sent += 1;
      } catch (err) {
        log.warn(`Follow-up reminder to ${person.name} failed: ${(err as Error).message}`);
      }
    }
    return { sent };
  }

  reloadHealthSchedule(): void {
    this.healthTask?.destroy();
    this.healthTask = null;
    const expr = this.q.getSetting('health_cron', '30 6 * * *');
    const tz = this.q.getSetting('check_timezone', 'Europe/Madrid');
    if (!cron.validate(expr)) { log.error(`Health cron "${expr}" is invalid`); return; }
    this.healthTask = cron.schedule(expr, () => void this.dailyHealth(), { timezone: tz, name: 'health-daily' });
    log.info(`Account health pull scheduled: "${expr}" ${tz}`);
  }

  /** The daily health pass: Windsor pull, a monitor scan (rules + incidents), then the AI review. */
  async dailyHealth(opts: { onlyIfMissing?: boolean } = {}): Promise<{ pulled: number; errors: string[]; reviewed: number }> {
    const today = this.q.getSetting('health_last_pull_at', '').slice(0, 10);
    if (opts.onlyIfMissing && today === new Date().toISOString().slice(0, 10)) return { pulled: 0, errors: [], reviewed: 0 };
    const pull = await this.health.pullWindsor();
    await this.monitor.scan();
    const review = await this.health.review();
    if (review.reviewed) await this.monitor.scan();
    return { pulled: pull.shops, errors: [...pull.errors, ...review.errors], reviewed: review.reviewed };
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
    // 45 days back every day, so last month is always complete in the record and the bonus base never goes stale.
    this.gmvTask = cron.schedule(expr, () => syncGmv(this.q, { days: 45 }), { timezone: tz, name: 'gmv-sync' });
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
    this.stock.stop();
    this.copilot.stop();
    this.apolloTask?.destroy();
    this.apolloTask = null;
    this.fastmossTask?.destroy();
    this.fastmossTask = null;
    this.tldvTask?.destroy();
    this.followupTask?.destroy();
    this.monitor.stop();
    this.healthTask?.destroy();
    this.healthTask = null;
    this.pullsTask?.destroy();
    this.pullsTask = null;
    this.pullsLateTask?.destroy();
    this.pullsLateTask = null;
    this.pruneTask?.destroy();
    this.pruneTask = null;
    this.rolloverTask?.destroy();
    this.rolloverTask = null;
    this.checkTask?.destroy();
    this.checkTask = null;
    this.reminderTask?.destroy();
    this.reminderTask = null;
    this.gmvTask?.destroy();
    this.gmvTask = null;
    this.gmvMonthlyTask?.destroy();
    this.gmvMonthlyTask = null;
  }
}
