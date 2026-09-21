import { describe, it, expect } from 'vitest';
import { evaluateChecklist, isDue, isoWeekday, localDate, personMatches } from '../src/checklist/evaluate';
import type { ChecklistItem, ChecklistTick } from '../src/sweep/types';

const TZ = 'Europe/Madrid';
const DAY = '2026-09-16'; // a Wednesday
const opts = { checkDate: DAY, tz: TZ, amName: 'Elena', aaName: 'DM' };

let nextId = 1;
function item(p: Partial<ChecklistItem> & { name: string }): ChecklistItem {
  return { id: nextId++, account_id: null, parent_id: null, section: 'Orders', guidance: null, role: 'am', frequency: 'daily', weekday: null, position: 0, enabled: true, created_at: '', updated_at: '', ...p };
}
function tick(itemId: number, date = DAY, by = 'Elena'): ChecklistTick {
  return { id: itemId * 100, item_id: itemId, account_id: 1, tick_date: date, done_by: by, done_at: `${date}T10:00:00Z`, note: null };
}

describe('personMatches', () => {
  it('matches first names and email local parts', () => {
    expect(personMatches('Elena Frosali', 'Elena')).toBe(true);
    expect(personMatches('dm@brightform.agency', 'DM')).toBe(true);
    expect(personMatches('federica@brightform.agency', 'Federica')).toBe(true);
    expect(personMatches('Giorgia Gaetaniello', 'Elena')).toBe(false);
    expect(personMatches(null, 'Elena')).toBe(false);
  });
});

describe('localDate and weekdays', () => {
  it('converts to the account timezone', () => {
    expect(localDate('2026-09-16T22:30:00Z', TZ)).toBe('2026-09-17'); // 00:30 CEST next day
    expect(localDate('2026-09-16T09:00:00Z', TZ)).toBe('2026-09-16');
  });
  it('knows the weekday and when a weekly line is due', () => {
    expect(isoWeekday('2026-09-14')).toBe(1);
    expect(isoWeekday('2026-09-20')).toBe(7);
    expect(isDue({ frequency: 'weekly', weekday: 3 }, DAY)).toBe(true);
    expect(isDue({ frequency: 'weekly', weekday: 1 }, DAY)).toBe(false);
    expect(isDue({ frequency: 'daily', weekday: null }, DAY)).toBe(true);
  });
});

describe('evaluateChecklist', () => {
  it('counts a ticked item as done and an unticked due item as pending', () => {
    const home = item({ name: 'Homepage - AM daily checks' });
    const orders = item({ name: 'Orders - AM daily checks' });
    const r = evaluateChecklist([home, orders], [tick(home.id)], opts);
    expect(r.am_total).toBe(2);
    expect(r.am_done).toBe(1);
    expect(r.status).toBe('partial');
    expect(r.items.find((i) => i.name.startsWith('Homepage'))!.state).toBe('done');
    expect(r.items.find((i) => i.name.startsWith('Homepage'))!.assignee_name).toBe('Elena');
    expect(r.items.find((i) => i.name.startsWith('Orders'))!.state).toBe('pending');
    expect(r.items[0].name).toMatch(/Orders/); // pending first
  });

  it('leaves weekly lines out until their day, and counts them on it', () => {
    const weekly = item({ name: 'Affiliate - AM weekly checks', role: 'aa', frequency: 'weekly', weekday: 1 });
    const daily = item({ name: 'Orders - AM daily checks' });
    const r = evaluateChecklist([weekly, daily], [tick(daily.id)], opts);
    expect(r.items.find((i) => i.name.includes('weekly'))!.state).toBe('not_due');
    expect(r.am_total).toBe(1);
    expect(r.aa_total).toBe(0);
    expect(r.status).toBe('complete');
    expect(r.combined_complete).toBe(true);
    const monday = evaluateChecklist([weekly, daily], [], { ...opts, checkDate: '2026-09-14' });
    expect(monday.aa_total).toBe(1);
    expect(monday.status).toBe('none');
  });

  it('splits AM and AA by role, with action items under their parent', () => {
    const cs = item({ name: 'CS - AM daily checks', section: 'CS' });
    const s1 = item({ name: 'Reply to DE return', parent_id: cs.id, role: 'aa' });
    const s2 = item({ name: 'Escalate FR case', parent_id: cs.id, role: 'aa' });
    const weeklySub = item({ name: 'Review PDPs', parent_id: cs.id, role: 'aa', frequency: 'weekly', weekday: 1 });
    const aff = item({ name: 'Affiliate - AM daily checks', role: 'aa' });
    const r = evaluateChecklist([cs, s1, s2, weeklySub, aff], [tick(s1.id, DAY, 'DM')], opts);
    expect(r.am_total).toBe(1);
    expect(r.am_done).toBe(0);
    expect(r.aa_total).toBe(3); // Affiliate + 2 daily action items; the weekly one is not due
    expect(r.aa_done).toBe(1);
    const parent = r.items.find((i) => i.name.startsWith('CS'))!;
    expect(parent.subtasks.map((s) => s.name)).toEqual(['Reply to DE return', 'Escalate FR case']);
    expect(parent.subtasks[0].done).toBe(true);
    expect(parent.subtasks[0].assignee_name).toBe('DM');
    expect(r.status).toBe('partial');
  });

  it('reports AM complete and AA incomplete separately', () => {
    const a = item({ name: 'Orders' });
    const x = item({ name: 'Affiliate', role: 'aa' });
    const r = evaluateChecklist([a, x], [tick(a.id)], opts);
    expect(r.am_complete).toBe(true);
    expect(r.aa_complete).toBe(false);
    expect(r.combined_complete).toBe(false);
  });

  it('ignores disabled items and ticks from other days', () => {
    const a = item({ name: 'Orders' });
    const off = item({ name: 'Old line', enabled: false });
    const r = evaluateChecklist([a, off], [tick(a.id, '2026-09-15')], opts);
    expect(r.items).toHaveLength(1);
    expect(r.status).toBe('none');
  });

  it('returns empty for an account with no items', () => {
    const r = evaluateChecklist([], [], opts);
    expect(r.status).toBe('empty');
    expect(r.combined_complete).toBe(false);
  });
});
