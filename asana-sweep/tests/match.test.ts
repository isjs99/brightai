import { describe, it, expect } from 'vitest';
import { buildPlan, checkCap, type SweepTask } from '../src/sweep/match';

const NOW = new Date('2026-09-16T06:30:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600000).toISOString();

function task(partial: Partial<SweepTask> & { gid: string; name: string }): SweepTask {
  return {
    completed: false,
    completed_at: null,
    section_name: 'Orders',
    num_subtasks: 0,
    ...partial,
  };
}

const defaults = { minAgeHours: 12, requireSectionMatch: true, now: NOW };

describe('buildPlan', () => {
  it('deletes a completed task when an incomplete twin exists (same name, same section)', () => {
    const tasks = [
      task({ gid: 'old', name: 'Orders - AM daily checks', completed: true, completed_at: hoursAgo(20) }),
      task({ gid: 'new', name: 'Orders - AM daily checks' }),
    ];
    const plan = buildPlan(tasks, defaults);
    expect(plan.scanned).toBe(2);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe('delete');
    expect(plan.items[0].task.gid).toBe('old');
    expect(plan.items[0].twin_gid).toBe('new');
    expect(plan.toDelete).toHaveLength(1);
  });

  it('skips a completed one-off with no twin', () => {
    const tasks = [
      task({ gid: 'x', name: 'Fix the DE listing image', completed: true, completed_at: hoursAgo(48) }),
      task({ gid: 'new', name: 'Orders - AM daily checks' }),
    ];
    const plan = buildPlan(tasks, defaults);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe('skipped_no_twin');
    expect(plan.toDelete).toHaveLength(0);
  });

  it('skips a twin completed more recently than min_age_hours', () => {
    const tasks = [
      task({ gid: 'old', name: 'Orders - AM daily checks', completed: true, completed_at: hoursAgo(2) }),
      task({ gid: 'new', name: 'Orders - AM daily checks' }),
    ];
    const plan = buildPlan(tasks, defaults);
    expect(plan.items[0].action).toBe('skipped_too_recent');
    expect(plan.toDelete).toHaveLength(0);

    // With a zero minimum age the same task is deletable.
    expect(buildPlan(tasks, { ...defaults, minAgeHours: 0 }).items[0].action).toBe('delete');
  });

  it('skips when the twin is in a different section and require_section_match is on', () => {
    const tasks = [
      task({ gid: 'old', name: 'Orders - AM daily checks', completed: true, completed_at: hoursAgo(20), section_name: 'Orders' }),
      task({ gid: 'new', name: 'Orders - AM daily checks', section_name: 'Done' }),
    ];
    const strict = buildPlan(tasks, defaults);
    expect(strict.items[0].action).toBe('skipped_section_mismatch');

    const loose = buildPlan(tasks, { ...defaults, requireSectionMatch: false });
    expect(loose.items[0].action).toBe('delete');
  });

  it('errors out above the max_deletes_per_run cap', () => {
    const tasks: SweepTask[] = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(task({ gid: `old${i}`, name: `Task ${i}`, completed: true, completed_at: hoursAgo(30) }));
      tasks.push(task({ gid: `new${i}`, name: `Task ${i}` }));
    }
    const plan = buildPlan(tasks, defaults);
    expect(plan.toDelete).toHaveLength(5);
    expect(checkCap(plan, 5)).toBeNull();
    expect(checkCap(plan, 4)).toMatch(/above the max_deletes_per_run cap of 4/);
  });

  it('never touches incomplete tasks', () => {
    const tasks = [task({ gid: 'a', name: 'A' }), task({ gid: 'b', name: 'A' }), task({ gid: 'c', name: 'B' })];
    const plan = buildPlan(tasks, defaults);
    expect(plan.items).toHaveLength(0);
    expect(plan.toDelete).toHaveLength(0);
  });

  it('matches names trimmed but case sensitive', () => {
    const tasks = [
      task({ gid: 'old', name: '  Orders - AM daily checks ', completed: true, completed_at: hoursAgo(20) }),
      task({ gid: 'old2', name: 'orders - am daily checks', completed: true, completed_at: hoursAgo(20) }),
      task({ gid: 'new', name: 'Orders - AM daily checks' }),
    ];
    const plan = buildPlan(tasks, defaults);
    const byGid = Object.fromEntries(plan.items.map((i) => [i.task.gid, i.action]));
    expect(byGid.old).toBe('delete');
    expect(byGid.old2).toBe('skipped_no_twin');
  });

  it('still deletes when two incomplete twins exist, and warns about it', () => {
    const tasks = [
      task({ gid: 'old', name: 'Orders - AM daily checks', completed: true, completed_at: hoursAgo(20) }),
      task({ gid: 'new1', name: 'Orders - AM daily checks' }),
      task({ gid: 'new2', name: 'Orders - AM daily checks' }),
    ];
    const plan = buildPlan(tasks, defaults);
    expect(plan.items[0].action).toBe('delete');
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/2 incomplete tasks share the name/);
  });

  it('treats a completed task with no completed_at as too recent (safe side)', () => {
    const tasks = [
      task({ gid: 'old', name: 'Orders - AM daily checks', completed: true, completed_at: null }),
      task({ gid: 'new', name: 'Orders - AM daily checks' }),
    ];
    expect(buildPlan(tasks, defaults).items[0].action).toBe('skipped_too_recent');
  });
});
