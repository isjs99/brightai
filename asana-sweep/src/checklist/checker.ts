import { asana, AsanaClient, type ChecklistTask } from '../asana/client.js';
import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { postSlack } from '../notify/slack.js';
import { config } from '../config.js';
import { evaluateChecklist, localDate } from './evaluate.js';
import { liveEvents } from '../live/events.js';
import type { Account, CheckItem, CheckWithItems } from '../sweep/types.js';

let checkRunning = false;

export function isCheckRunning(): boolean {
  return checkRunning;
}

export function todayIn(tz: string): string {
  return localDate(new Date().toISOString(), tz);
}

export interface CheckOptions {
  trigger: 'schedule' | 'manual' | 'live';
  tz: string;
  client?: AsanaClient;
  /** Lock the result as the official snapshot for the day (the deadline check). */
  final?: boolean;
}

/**
 * Check one account for the given date. Always records a row (status error / unlinked when it
 * cannot evaluate). Every check also refreshes the live status; the recorded check is only
 * overwritten while the day's snapshot has not been locked.
 */
export async function checkAccount(q: Queries, account: Account, opts: CheckOptions): Promise<CheckWithItems> {
  const client = opts.client ?? asana;
  const checkDate = todayIn(opts.tz);
  const empty = { am_total: 0, am_done: 0, aa_total: 0, aa_done: 0, am_complete: false, aa_complete: false, combined_complete: false, warnings: [] as string[], items: [] as CheckItem[] };
  const record = (data: Omit<CheckWithItems, 'id' | 'account_id' | 'check_date' | 'checked_at' | 'final' | 'trigger'>) => {
    q.upsertLive(account.id, checkDate, data);
    const stored = q.upsertCheck(account.id, checkDate, { ...data, trigger: opts.trigger, final: opts.final });
    liveEvents.emit('update', { kind: 'check', account_id: account.id });
    // Callers that want "what Asana looks like right now" get the live figures even after the lock.
    return opts.trigger === 'live' && stored.final ? q.getLive(account.id)! : stored;
  };

  if (!account.asana_project_gid) {
    return record({ ...empty, status: 'unlinked', error_message: 'No Asana checklist project linked.' });
  }

  try {
    const project = await client.getProject(account.asana_project_gid);
    q.setAccountProjectName(account.id, project.name);
    const topLevel = await client.listChecklistTasks(account.asana_project_gid);
    const subtasksByParent = new Map<string, ChecklistTask[]>();
    for (const t of topLevel) {
      if (t.num_subtasks > 0) subtasksByParent.set(t.gid, await client.listSubtasks(t.gid));
    }
    // Completed copies the sweep already deleted today still count as done.
    const dayStart = new Date(Date.now() - 48 * 3600000).toISOString();
    for (const c of q.listCompletionsSince(account.asana_project_gid, dayStart)) {
      if (topLevel.some((t) => t.gid === c.task_gid)) continue;
      const task: ChecklistTask = {
        gid: c.task_gid,
        name: c.name,
        completed: c.completed,
        completed_at: c.completed_at,
        due_on: null,
        assignee_name: c.assignee_name,
        section_name: c.section_name,
        num_subtasks: c.num_subtasks,
        parent_gid: c.parent_gid,
      };
      if (c.parent_gid) subtasksByParent.set(c.parent_gid, [...(subtasksByParent.get(c.parent_gid) ?? []), task]);
      else topLevel.push(task);
    }
    const result = evaluateChecklist(topLevel, subtasksByParent, {
      checkDate,
      tz: opts.tz,
      amName: account.am_name,
      aaName: account.aa_name,
    });
    return record({ ...result, error_message: null });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    log.error(`Check failed for ${account.name}: ${msg}`);
    return record({ ...empty, status: 'error', error_message: msg });
  }
}

/**
 * Check every enabled account. Returns null if a check is already in progress.
 * `remind` DMs each AM whose accounts are incomplete (if AM reminders are switched on).
 */
export async function runAllChecks(
  q: Queries,
  opts: { trigger: 'schedule' | 'manual'; client?: AsanaClient; notify?: boolean; remind?: boolean; final?: boolean },
): Promise<CheckWithItems[] | null> {
  if (checkRunning) {
    log.warn(`Checklist check already running, skipping ${opts.trigger} trigger.`);
    return null;
  }
  checkRunning = true;
  const tz = q.getSetting('check_timezone', 'Europe/Madrid');
  const results: CheckWithItems[] = [];
  try {
    const accounts = q.listAccounts().filter((a) => a.enabled);
    log.info(`Checklist check started (${opts.trigger}) for ${accounts.length} account(s)`);
    for (const account of accounts) {
      results.push(await checkAccount(q, account, { trigger: opts.trigger, tz, client: opts.client, final: opts.final }));
    }
    const complete = results.filter((r) => r.combined_complete).length;
    log.info(`Checklist check finished: ${complete}/${results.length} accounts complete`);
    const webhook = q.getSetting('check_slack_webhook', '');
    if (opts.notify !== false && webhook) {
      await postSlack(webhook, digestMessage(q, results, tz));
    }
    if (opts.remind) {
      const { notifyAms } = await import('./reminders.js');
      await notifyAms(q, results, { deadline: deadlineLabel(q) });
    }
  } finally {
    checkRunning = false;
  }
  return results;
}

/** "16:00 CEST" from the check cron, for reminder text. */
export function deadlineLabel(q: Queries): string {
  const cron = q.getSetting('check_cron', '0 16 * * 1-5').trim().split(/\s+/);
  const tz = q.getSetting('check_timezone', 'Europe/Madrid');
  const [min, hour] = cron;
  const abbr = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz;
  if (/^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour)) return `${hour.padStart(2, '0')}:${min.padStart(2, '0')} ${abbr}`;
  return `the daily check (${cron.join(' ')} ${abbr})`;
}

export function digestMessage(q: Queries, checks: CheckWithItems[], tz: string): string {
  const accounts = new Map(q.listAccounts().map((a) => [a.id, a]));
  const linked = checks.filter((c) => c.status !== 'unlinked');
  const complete = linked.filter((c) => c.combined_complete);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date());
  const lines: string[] = [`Checklist status ${time}: ${complete.length}/${linked.length} accounts complete. <${config.publicUrl}/checklists|View>`];
  const label = (c: CheckWithItems) => {
    const a = accounts.get(c.account_id);
    return `${a?.name ?? c.account_id}${a?.am_name ? ` (${a.am_name})` : ''}`;
  };
  for (const c of linked) {
    if (c.status === 'error') lines.push(`:x: ${label(c)}: error, ${c.error_message}`);
    else if (c.status === 'empty') lines.push(`:grey_question: ${label(c)}: no tasks due today`);
    else if (c.combined_complete) lines.push(`:white_check_mark: ${label(c)}: AM ${c.am_done}/${c.am_total}, AA ${c.aa_done}/${c.aa_total}`);
    else lines.push(`:warning: ${label(c)}: AM ${c.am_done}/${c.am_total}${c.am_complete ? ' ok' : ''}, AA ${c.aa_done}/${c.aa_total}${c.aa_complete ? ' ok' : ''}`);
  }
  const unlinked = checks.length - linked.length;
  if (unlinked) lines.push(`${unlinked} account(s) have no checklist project linked yet.`);
  return lines.join('\n');
}
