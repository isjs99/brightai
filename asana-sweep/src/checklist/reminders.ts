import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { slackBot, SlackBot } from '../notify/slackbot.js';
import { config } from '../config.js';
import { personMatches } from './evaluate.js';
import type { Account, Check, Person } from '../sweep/types.js';

export interface ReminderResult {
  person: string;
  sent: boolean;
  error: string | null;
  accounts: string[];
}

export const DEFAULT_REMINDER_TEXT =
  'Hi {name}, your AM checklist is not done yet for: {accounts}. Deadline is {deadline}. {link}';

/** Build the per-AM list of incomplete accounts from a set of checks. */
export function incompleteByPerson(people: Person[], accounts: Account[], checks: Check[]): Map<number, { person: Person; accounts: { account: Account; check: Check }[] }> {
  const byAccount = new Map(checks.map((c) => [c.account_id, c]));
  const out = new Map<number, { person: Person; accounts: { account: Account; check: Check }[] }>();
  for (const account of accounts) {
    if (!account.enabled || !account.am_name) continue;
    const check = byAccount.get(account.id);
    if (!check) continue;
    if (check.status === 'unlinked' || check.status === 'empty' || check.combined_complete) continue;
    const person = people.find((p) => personMatches(account.am_name, p.name));
    if (!person) continue;
    const entry = out.get(person.id) ?? { person, accounts: [] };
    entry.accounts.push({ account, check });
    out.set(person.id, entry);
  }
  return out;
}

export function renderReminder(template: string, person: Person, items: { account: Account; check: Check }[], deadline: string): string {
  const accounts = items
    .map(({ account, check }) => {
      const parts: string[] = [];
      if (check.status === 'error') parts.push('error');
      else {
        if (!check.am_complete) parts.push(`AM ${check.am_done}/${check.am_total}`);
        if (!check.aa_complete) parts.push(`AA ${check.aa_done}/${check.aa_total}`);
      }
      return `${account.name} (${parts.join(', ')})`;
    })
    .join(', ');
  return template
    .replace('{name}', person.name)
    .replace('{accounts}', accounts)
    .replace('{deadline}', deadline)
    .replace('{link}', `<${config.publicUrl}/checklists|Open the checklist status>`);
}

/**
 * DM every AM whose accounts are not complete. `checks` are the checks just recorded.
 * Returns one result per person so the UI can show what happened.
 */
export async function notifyAms(q: Queries, checks: Check[], opts: { deadline: string; bot?: SlackBot; force?: boolean }): Promise<ReminderResult[]> {
  const bot = opts.bot ?? slackBot;
  if (!opts.force && q.getSetting('notify_ams_enabled', '0') !== '1') return [];
  if (!bot.configured) {
    log.warn('AM reminders are enabled but SLACK_BOT_TOKEN is not set.');
    return [];
  }
  const template = q.getSetting('reminder_text', '') || DEFAULT_REMINDER_TEXT;
  const groups = incompleteByPerson(q.listPeople(), q.listAccounts(), checks);
  const results: ReminderResult[] = [];
  for (const { person, accounts } of groups.values()) {
    const names = accounts.map((a) => a.account.name);
    if (!person.notify) {
      results.push({ person: person.name, sent: false, error: 'notifications off for this person', accounts: names });
      continue;
    }
    const to = person.slack_user_id || person.email;
    if (!to) {
      results.push({ person: person.name, sent: false, error: 'no Slack id or email on file', accounts: names });
      continue;
    }
    const error = await bot.tryDm(to, renderReminder(template, person, accounts, opts.deadline));
    results.push({ person: person.name, sent: !error, error, accounts: names });
  }
  log.info(`AM reminders: ${results.filter((r) => r.sent).length} sent, ${results.filter((r) => !r.sent).length} skipped`);
  return results;
}
