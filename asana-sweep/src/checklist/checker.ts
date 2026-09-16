import { asana, AsanaClient, type ChecklistTask } from '../asana/client.js';
import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { postSlack } from '../notify/slack.js';
import { config } from '../config.js';
import { evaluateChecklist, localDate } from './evaluate.js';
import type { Account, CheckWithItems } from '../sweep/types.js';

let checkRunning = false;

export function isCheckRunning(): boolean {
  return checkRunning;
}

export function todayIn(tz: string): string {
  return localDate(new Date().toISOString(), tz);
}

/** Check one account for the given date. Always records a row (status error / unlinked when it cannot evaluate). */
export async function checkAccount(q: Queries, account: Account, opts: { trigger: 'schedule' | 'manual'; tz: string; client?: AsanaClient }): Promise<CheckWithItems> {
  const client = opts.client ?? asana;
  const checkDate = todayIn(opts.tz);
  const empty = { am_total: 0, am_done: 0, aa_total: 0, aa_done: 0, am_complete: false, aa_complete: false, combined_complete: false, warnings: [] as string[], items: [] };

  if (!account.asana_project_gid) {
    return q.upsertCheck(account.id, checkDate, { ...empty, trigger: opts.trigger, status: 'unlinked', error_message: 'No Asana checklist project linked.' });
  }

  try {
    const project = await client.getProject(account.asana_project_gid);
    q.setAccountProjectName(account.id, project.name);
    const topLevel = await client.listChecklistTasks(account.asana_project_gid);
    const subtasksByParent = new Map<string, ChecklistTask[]>();
    for (const t of topLevel) {
      if (t.num_subtasks > 0) subtasksByParent.set(t.gid, await client.listSubtasks(t.gid));
    }
    const result = evaluateChecklist(topLevel, subtasksByParent, {
      checkDate,
      tz: opts.tz,
      amName: account.am_name,
      aaName: account.aa_name,
    });
    return q.upsertCheck(account.id, checkDate, { ...result, trigger: opts.trigger, error_message: null });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    log.error(`Check failed for ${account.name}: ${msg}`);
    return q.upsertCheck(account.id, checkDate, { ...empty, trigger: opts.trigger, status: 'error', error_message: msg });
  }
}

/** Check every enabled account. Returns null if a check is already in progress. */
export async function runAllChecks(q: Queries, opts: { trigger: 'schedule' | 'manual'; client?: AsanaClient; notify?: boolean }): Promise<CheckWithItems[] | null> {
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
      results.push(await checkAccount(q, account, { trigger: opts.trigger, tz, client: opts.client }));
    }
    const complete = results.filter((r) => r.combined_complete).length;
    log.info(`Checklist check finished: ${complete}/${results.length} accounts complete`);
    const webhook = q.getSetting('check_slack_webhook', '');
    if (opts.notify !== false && webhook) {
      await postSlack(webhook, digestMessage(q, results, tz));
    }
  } finally {
    checkRunning = false;
  }
  return results;
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
