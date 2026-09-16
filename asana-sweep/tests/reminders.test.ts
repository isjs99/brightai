import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { incompleteByPerson, notifyAms, renderReminder, DEFAULT_REMINDER_TEXT } from '../src/checklist/reminders';
import type { SlackBot } from '../src/notify/slackbot';
import type { Check } from '../src/sweep/types';

function check(accountId: number, patch: Partial<Check>): Check {
  return {
    id: accountId,
    account_id: accountId,
    check_date: '2026-09-16',
    checked_at: '2026-09-16T12:00:00Z',
    trigger: 'manual',
    status: 'partial',
    am_total: 4,
    am_done: 2,
    aa_total: 3,
    aa_done: 1,
    am_complete: false,
    aa_complete: false,
    combined_complete: false,
    warnings: [],
    error_message: null,
    ...patch,
  };
}

describe('reminders', () => {
  it('groups incomplete accounts by AM and skips complete or unlinked ones', () => {
    const q = new Queries(openTestDb());
    const accounts = q.listAccounts();
    const gv = accounts.find((a) => a.name === 'GreatVita')!; // Elena
    const sn = accounts.find((a) => a.name === 'Super Ninja')!; // Elena
    const cl = accounts.find((a) => a.name === 'Clearly')!; // Tamara
    const checks = [
      check(gv.id, {}),
      check(sn.id, { status: 'complete', combined_complete: true, am_complete: true, aa_complete: true }),
      check(cl.id, { status: 'unlinked' }),
    ];
    const groups = incompleteByPerson(q.listPeople(), accounts, checks);
    const elena = [...groups.values()].find((g) => g.person.name === 'Elena')!;
    expect(elena.accounts.map((a) => a.account.name)).toEqual(['GreatVita']);
    expect([...groups.values()].some((g) => g.person.name === 'Tamara')).toBe(false);
  });

  it('renders the template', () => {
    const q = new Queries(openTestDb());
    const person = q.listPeople().find((p) => p.name === 'Elena')!;
    const gv = q.listAccounts().find((a) => a.name === 'GreatVita')!;
    const text = renderReminder(DEFAULT_REMINDER_TEXT, person, [{ account: gv, check: check(gv.id, {}) }], '16:00 CEST');
    expect(text).toMatch(/^Hi Elena, your AM checklist is not done yet for: GreatVita \(AM 2\/4, AA 1\/3\)\. Deadline is 16:00 CEST\./);
  });

  it('sends DMs only when enabled and the person has a contact', async () => {
    const q = new Queries(openTestDb());
    const sent: string[] = [];
    const bot = { configured: true, tryDm: async (to: string) => { sent.push(to); return null; } } as unknown as SlackBot;
    const gv = q.listAccounts().find((a) => a.name === 'GreatVita')!;
    const cl = q.listAccounts().find((a) => a.name === 'Clearly')!;
    const checks = [check(gv.id, {}), check(cl.id, {})];

    expect(await notifyAms(q, checks, { deadline: '16:00', bot })).toEqual([]); // disabled by default

    q.setSetting('notify_ams_enabled', '1');
    const results = await notifyAms(q, checks, { deadline: '16:00', bot });
    // Elena has no email or Slack id seeded; Tamara has an email.
    expect(results.find((r) => r.person === 'Elena')!.sent).toBe(false);
    expect(results.find((r) => r.person === 'Tamara')!.sent).toBe(true);
    expect(sent).toEqual(['tamara@brightform.agency']);
  });
});
