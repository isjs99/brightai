import { describe, it, expect } from 'vitest';
import { evaluateChecklist, localDate, personMatches } from '../src/checklist/evaluate';
import type { ChecklistTask } from '../src/asana/client';

const TZ = 'Europe/Madrid';
const DAY = '2026-09-16';
const opts = { checkDate: DAY, tz: TZ, amName: 'Elena', aaName: 'DM' };

function t(p: Partial<ChecklistTask> & { gid: string; name: string }): ChecklistTask {
  return {
    completed: false,
    completed_at: null,
    due_on: DAY,
    assignee_name: 'Elena Frosali',
    section_name: 'Orders',
    num_subtasks: 0,
    parent_gid: null,
    ...p,
  };
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

describe('localDate', () => {
  it('converts to the account timezone', () => {
    expect(localDate('2026-09-16T22:30:00Z', TZ)).toBe('2026-09-17'); // 00:30 CEST next day
    expect(localDate('2026-09-16T09:00:00Z', TZ)).toBe('2026-09-16');
  });
});

describe('evaluateChecklist', () => {
  it('counts an item done when a copy was completed today and a new copy exists', () => {
    const tasks = [
      t({ gid: 'a1', name: 'Homepage - AM daily checks', completed: true, completed_at: '2026-09-16T08:00:00Z' }),
      t({ gid: 'a2', name: 'Homepage - AM daily checks', due_on: '2026-09-17' }),
      t({ gid: 'b1', name: 'Orders - AM daily checks' }),
    ];
    const r = evaluateChecklist(tasks, new Map(), opts);
    expect(r.am_total).toBe(2);
    expect(r.am_done).toBe(1);
    expect(r.status).toBe('partial');
    expect(r.items.find((i) => i.name.startsWith('Homepage'))!.state).toBe('done');
    expect(r.items.find((i) => i.name.startsWith('Homepage'))!.flags).toEqual([]);
    expect(r.items.find((i) => i.name.startsWith('Orders'))!.state).toBe('pending');
  });

  it('flags a completed item with no fresh copy as not repeating', () => {
    const tasks = [t({ gid: 'a1', name: 'Finance - AM daily checks', completed: true, completed_at: '2026-09-16T08:00:00Z' })];
    const r = evaluateChecklist(tasks, new Map(), opts);
    expect(r.items[0].flags).toContain('no_repeat');
    expect(r.warnings[0]).toMatch(/no new copy appeared/);
    expect(r.status).toBe('complete');
  });

  it('flags missing due dates and overdue copies', () => {
    const tasks = [
      t({ gid: 'a', name: 'No date', due_on: null }),
      t({ gid: 'b', name: 'Late', due_on: '2026-09-14' }),
    ];
    const r = evaluateChecklist(tasks, new Map(), opts);
    expect(r.items.find((i) => i.name === 'No date')!.flags).toContain('no_due_date');
    expect(r.items.find((i) => i.name === 'Late')!.flags).toContain('overdue');
    expect(r.am_total).toBe(2);
  });

  it('excludes items only due in the future (weekly checks) from today', () => {
    const tasks = [
      t({ gid: 'w', name: 'Affiliate - AM weekly checks', due_on: '2026-09-22' }),
      t({ gid: 'd', name: 'Orders - AM daily checks', completed: true, completed_at: '2026-09-16T10:00:00Z' }),
      t({ gid: 'd2', name: 'Orders - AM daily checks', due_on: '2026-09-17' }),
    ];
    const r = evaluateChecklist(tasks, new Map(), opts);
    expect(r.items.find((i) => i.name.includes('weekly'))!.state).toBe('not_due');
    expect(r.am_total).toBe(1);
    expect(r.status).toBe('complete');
    expect(r.combined_complete).toBe(true);
  });

  it('splits AM and AA by assignee, including top-level tasks assigned to the AA', () => {
    const tasks = [
      t({ gid: 'am1', name: 'Orders - AM daily checks', completed: true, completed_at: '2026-09-16T10:00:00Z' }),
      t({ gid: 'am1b', name: 'Orders - AM daily checks', due_on: '2026-09-17' }),
      t({ gid: 'aa1', name: 'Affiliate - AM daily checks', assignee_name: 'dm@brightform.agency' }),
      t({ gid: 'cs', name: 'CS - AM daily checks', num_subtasks: 2 }),
    ];
    const subs = new Map<string, ChecklistTask[]>([
      [
        'cs',
        [
          t({ gid: 's1', name: 'Reply to DE return', assignee_name: 'dm@brightform.agency', completed: true, completed_at: '2026-09-16T11:00:00Z', parent_gid: 'cs' }),
          t({ gid: 's2', name: 'Escalate FR case', assignee_name: null, parent_gid: 'cs' }),
          t({ gid: 's3', name: 'Old one', assignee_name: null, completed: true, completed_at: '2026-09-10T11:00:00Z', parent_gid: 'cs' }),
        ],
      ],
    ]);
    const r = evaluateChecklist(tasks, subs, opts);
    expect(r.am_total).toBe(2); // Orders + CS
    expect(r.am_done).toBe(1);
    expect(r.aa_total).toBe(3); // Affiliate + 2 live subtasks (old one excluded)
    expect(r.aa_done).toBe(1);
    expect(r.am_complete).toBe(false);
    expect(r.aa_complete).toBe(false);
    expect(r.status).toBe('partial');
  });

  it('reports AM complete and AA incomplete separately', () => {
    const tasks = [
      t({ gid: 'a', name: 'Orders', completed: true, completed_at: '2026-09-16T10:00:00Z' }),
      t({ gid: 'a2', name: 'Orders', due_on: '2026-09-17' }),
      t({ gid: 'x', name: 'Affiliate', assignee_name: 'dm@brightform.agency' }),
    ];
    const r = evaluateChecklist(tasks, new Map(), opts);
    expect(r.am_complete).toBe(true);
    expect(r.aa_complete).toBe(false);
    expect(r.combined_complete).toBe(false);
  });

  it('counts subtasks once even when several recurring copies of the item exist', () => {
    // Three copies of the same item: two completed today (a test run), one fresh incomplete copy.
    // Each carries its own copy of the same two subtasks, as Asana does on recurrence.
    const tasks = [
      t({ gid: 'c1', name: 'Affiliate - AM daily checks', completed: true, completed_at: '2026-09-16T08:00:00Z', num_subtasks: 2 }),
      t({ gid: 'c2', name: 'Affiliate - AM daily checks', completed: true, completed_at: '2026-09-16T10:00:00Z', num_subtasks: 2 }),
      t({ gid: 'c3', name: 'Affiliate - AM daily checks', due_on: '2026-09-17', num_subtasks: 2 }),
    ];
    const sub = (gid: string, parent: string, name: string, done: boolean) =>
      t({ gid, name, parent_gid: parent, assignee_name: 'dm@brightform.agency', completed: done, completed_at: done ? '2026-09-16T09:30:00Z' : null });
    const subs = new Map<string, ChecklistTask[]>([
      ['c1', [sub('s1', 'c1', 'Process daily sample requests within SLA', true), sub('s2', 'c1', 'All affiliate chats answered', false)]],
      ['c2', [sub('s3', 'c2', 'Process daily sample requests within SLA', true), sub('s4', 'c2', 'All affiliate chats answered', true)]],
      ['c3', [sub('s5', 'c3', 'Process daily sample requests within SLA', false), sub('s6', 'c3', 'All affiliate chats answered', false)]],
    ]);
    const r = evaluateChecklist(tasks, subs, opts);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].state).toBe('done');
    expect(r.items[0].task_gid).toBe('c2'); // the latest completion represents the item
    expect(r.items[0].subtasks.map((s) => s.name)).toEqual(['Process daily sample requests within SLA', 'All affiliate chats answered']);
    expect(r.items[0].subtasks.every((s) => s.done)).toBe(true);
    expect(r.aa_total).toBe(2);
    expect(r.aa_done).toBe(2);
  });

  it('returns empty for a project with no tasks', () => {
    const r = evaluateChecklist([], new Map(), opts);
    expect(r.status).toBe('empty');
    expect(r.combined_complete).toBe(false);
  });

  it('treats unassigned top-level tasks as AM and unassigned subtasks as AA when no AM is configured', () => {
    const tasks = [t({ gid: 'a', name: 'Orders', assignee_name: null, num_subtasks: 1 })];
    const subs = new Map([[ 'a', [t({ gid: 's', name: 'Fix', assignee_name: null, parent_gid: 'a' })] ]]);
    const r = evaluateChecklist(tasks, subs, { ...opts, amName: null, aaName: null });
    expect(r.am_total).toBe(1);
    expect(r.aa_total).toBe(1);
  });
});
