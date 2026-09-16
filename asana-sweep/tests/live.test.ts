import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { LiveWatcher } from '../src/live/index';
import { checkAccount } from '../src/checklist/checker';
import type { AsanaClient, ChecklistTask } from '../src/asana/client';
import type { SweepTask } from '../src/sweep/match';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
const today = new Date().toISOString().slice(0, 10);

function board() {
  // A completed task with a fresh incomplete twin, plus one plain incomplete task.
  const tasks: (SweepTask & ChecklistTask)[] = [
    { gid: 'old', name: 'Orders - AM daily checks', completed: true, completed_at: hoursAgo(0.2), section_name: 'Orders', num_subtasks: 0, due_on: today, assignee_name: 'Elena Frosali', parent_gid: null },
    { gid: 'new', name: 'Orders - AM daily checks', completed: false, completed_at: null, section_name: 'Orders', num_subtasks: 0, due_on: today, assignee_name: 'Elena Frosali', parent_gid: null },
    { gid: 'fin', name: 'Finance - AM daily checks', completed: false, completed_at: null, section_name: 'Finance', num_subtasks: 0, due_on: today, assignee_name: 'Elena Frosali', parent_gid: null },
  ];
  const state = { tasks, changed: true, deleted: [] as string[], changeChecks: 0 };
  const client = {
    async getProject() { return { gid: '1216709753301754', name: 'GreatVita - AM Daily Checklist (Pilot)' }; },
    async listProjectTasks() { return state.tasks; },
    async listChecklistTasks() { return state.tasks; },
    async listSubtasks() { return []; },
    async projectChangedSince() { state.changeChecks += 1; return state.changed; },
    async deleteTask(gid: string) { state.deleted.push(gid); state.tasks = state.tasks.filter((t) => t.gid !== gid); },
  } as unknown as AsanaClient;
  return { client, state };
}

describe('live watcher', () => {
  it('deletes the spent copy immediately and refreshes the live status only for changed boards', async () => {
    const q = new Queries(openTestDb());
    // Only GreatVita stays linked so the stub board applies to one account.
    for (const a of q.listAccounts()) if (a.name !== 'GreatVita') q.updateAccount(a.id, { ...a, asana_project_gid: null });
    const gv = q.listAccounts().find((a) => a.name === 'GreatVita')!;
    const { client, state } = board();
    const watcher = new LiveWatcher(q, client);

    await watcher.tick();
    expect(state.deleted).toEqual(['old']); // 12 minutes old, under the 12h minimum: live sweep ignores it
    const live = q.getLive(gv.id)!;
    expect(live.status).toBe('partial');
    expect(live.am_done).toBe(1);
    expect(live.am_total).toBe(2);
    expect(q.getCheckForDate(gv.id, today)!.final).toBe(false);

    // Nothing changed: the next tick only does the cheap change check.
    state.changed = false;
    const before = state.changeChecks;
    await watcher.tick();
    expect(state.changeChecks).toBe(before + 1);
    expect(q.listRuns(q.listRules()[0].id).filter((r) => r.trigger === 'live')).toHaveLength(1);
  });

  it('keeps the locked deadline snapshot when live updates arrive afterwards', async () => {
    const q = new Queries(openTestDb());
    const gv = q.listAccounts().find((a) => a.name === 'GreatVita')!;
    const { client, state } = board();

    const locked = await checkAccount(q, gv, { trigger: 'schedule', tz: 'Europe/Madrid', client, final: true });
    expect(locked.final).toBe(true);
    expect(locked.status).toBe('partial');

    // Everything gets completed after the deadline.
    state.tasks = state.tasks.map((t) => ({ ...t, completed: true, completed_at: hoursAgo(0.1) }));
    const live = await checkAccount(q, gv, { trigger: 'live', tz: 'Europe/Madrid', client });
    expect(live.status).toBe('complete');
    expect(q.getCheckForDate(gv.id, today)!.status).toBe('partial'); // record unchanged
    expect(q.getLive(gv.id)!.status).toBe('complete'); // live view updated
  });
});
