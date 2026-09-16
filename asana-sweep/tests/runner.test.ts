import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { runRule, previewRule, slackMessage } from '../src/sweep/runner';
import type { AsanaClient } from '../src/asana/client';
import type { SweepTask } from '../src/sweep/match';
import type { Rule } from '../src/sweep/types';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();

function stubClient(tasks: SweepTask[], opts: { failDelete?: string[]; failProject?: boolean } = {}) {
  const deleted: string[] = [];
  const client = {
    async getProject() {
      if (opts.failProject) throw new Error('Asana access denied (403): not a member');
      return { gid: '1216709753301754', name: 'GreatVita - AM Daily Checklist (Pilot)' };
    },
    async listProjectTasks() {
      return tasks.filter((t) => !deleted.includes(t.gid));
    },
    async deleteTask(gid: string) {
      if (opts.failDelete?.includes(gid)) throw new Error('boom');
      deleted.push(gid);
    },
  } as unknown as AsanaClient;
  return { client, deleted };
}

const T = (gid: string, name: string, completed: boolean, completedHoursAgo: number | null, section = 'Orders'): SweepTask => ({
  gid,
  name,
  completed,
  completed_at: completedHoursAgo === null ? null : hoursAgo(completedHoursAgo),
  section_name: section,
  num_subtasks: 0,
});

const TASKS = [
  T('old1', 'Orders - AM daily checks', true, 20),
  T('new1', 'Orders - AM daily checks', false, null),
  T('old2', 'Finance - AM daily checks', true, 30, 'Finance'),
  T('new2', 'Finance - AM daily checks', false, null, 'Finance'),
  T('oneoff', 'Fix listing', true, 50),
];

describe('runRule', () => {
  let q: Queries;
  let rule: Rule;

  beforeEach(() => {
    q = new Queries(openTestDb());
    rule = q.getRule(1)!; // seed rule, put into dry run for these tests
    expect(rule).toBeTruthy();
    rule = q.updateRule(rule.id, { ...rule, dry_run: true })!;
  });

  it('seeds a live sweep rule for every linked checklist board', () => {
    const rules = q.listRules();
    const linked = q.listAccounts().filter((a) => a.asana_project_gid);
    expect(rules.length).toBe(linked.length);
    for (const a of linked) expect(rules.some((r) => r.asana_project_gid === a.asana_project_gid)).toBe(true);
    expect(rules.filter((r) => r.id !== rule.id).every((r) => !r.dry_run && r.enabled)).toBe(true);
  });

  it('seeds the pilot rule', () => {
    expect(rule.asana_project_gid).toBe('1216709753301754');
    expect(rule.cron).toBe('30 6 * * 1-5');
    expect(rule.timezone).toBe('Europe/Madrid');
    expect(rule.enabled).toBe(true);
    expect(rule.min_age_hours).toBe(12);
    expect(rule.require_section_match).toBe(true);
    expect(rule.max_deletes_per_run).toBe(50);
  });

  it('dry run records would_delete and deletes nothing', async () => {
    const { client, deleted } = stubClient(TASKS);
    const run = (await runRule(q, rule, { trigger: 'manual', client }))!;
    expect(run.status).toBe('dry_run');
    expect(run.scanned_count).toBe(5);
    expect(run.matched_count).toBe(2);
    expect(run.deleted_count).toBe(0);
    expect(deleted).toEqual([]);
    const actions = q.listRunItems(run.id).map((i) => i.action).sort();
    expect(actions).toEqual(['skipped_no_twin', 'would_delete', 'would_delete']);
  });

  it('live run deletes the matched tasks and records them', async () => {
    const live = q.updateRule(rule.id, { ...rule, dry_run: false })!;
    const { client, deleted } = stubClient(TASKS);
    const run = (await runRule(q, live, { trigger: 'schedule', client }))!;
    expect(run.status).toBe('ok');
    expect(run.deleted_count).toBe(2);
    expect(deleted.sort()).toEqual(['old1', 'old2']);
    const items = q.listRunItems(run.id);
    expect(items.filter((i) => i.action === 'deleted')).toHaveLength(2);
    expect(items.find((i) => i.task_gid === 'oneoff')?.action).toBe('skipped_no_twin');
    // A second run finds nothing left to delete.
    const again = (await runRule(q, live, { trigger: 'schedule', client }))!;
    expect(again.matched_count).toBe(0);
  });

  it('errors out above the cap without deleting anything', async () => {
    const live = q.updateRule(rule.id, { ...rule, dry_run: false, max_deletes_per_run: 1 })!;
    const { client, deleted } = stubClient(TASKS);
    const run = (await runRule(q, live, { trigger: 'manual', client }))!;
    expect(run.status).toBe('error');
    expect(run.error_message).toMatch(/cap of 1/);
    expect(deleted).toEqual([]);
    expect(q.listRunItems(run.id).filter((i) => i.action === 'would_delete')).toHaveLength(2);
  });

  it('records a failed delete as delete_failed and marks the run as error', async () => {
    const live = q.updateRule(rule.id, { ...rule, dry_run: false })!;
    const { client } = stubClient(TASKS, { failDelete: ['old2'] });
    const run = (await runRule(q, live, { trigger: 'manual', client }))!;
    expect(run.status).toBe('error');
    expect(run.deleted_count).toBe(1);
    expect(q.listRunItems(run.id).find((i) => i.task_gid === 'old2')?.action).toBe('delete_failed');
  });

  it('fails cleanly when the project is inaccessible and leaves the rule enabled', async () => {
    const { client } = stubClient(TASKS, { failProject: true });
    const run = (await runRule(q, rule, { trigger: 'schedule', client }))!;
    expect(run.status).toBe('error');
    expect(run.error_message).toMatch(/403/);
    expect(q.getRule(rule.id)!.enabled).toBe(true);
  });

  it('skips an overlapping trigger while a run is in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      async getProject() {
        await gate;
        return { gid: 'x', name: 'P' };
      },
      async listProjectTasks() {
        return [];
      },
      async deleteTask() {},
    } as unknown as AsanaClient;
    const first = runRule(q, rule, { trigger: 'schedule', client: slow });
    const second = await runRule(q, rule, { trigger: 'manual', client: slow });
    expect(second).toBeNull();
    release();
    expect((await first)!.status).toBe('dry_run');
  });

  it('force run deletes immediately, ignoring dry run and the minimum age', async () => {
    const recent = [
      T('r1', 'Orders - AM daily checks', true, 1), // completed 1h ago, under the 12h minimum
      T('r2', 'Orders - AM daily checks', false, null),
    ];
    const { client, deleted } = stubClient(recent);
    expect(rule.dry_run).toBe(true);
    const run = (await runRule(q, rule, { trigger: 'manual', client, force: true }))!;
    expect(run.status).toBe('ok');
    expect(run.dry_run).toBe(false);
    expect(run.deleted_count).toBe(1);
    expect(deleted).toEqual(['r1']);
    expect(run.warnings.some((w) => w.startsWith('Run now'))).toBe(true);
    // Without force the same task is protected by dry run and the minimum age.
    const { client: c2, deleted: d2 } = stubClient(recent);
    const safe = (await runRule(q, rule, { trigger: 'schedule', client: c2 }))!;
    expect(safe.status).toBe('dry_run');
    expect(safe.matched_count).toBe(0);
    expect(d2).toEqual([]);
  });

  it('preview never writes', async () => {
    const { client, deleted } = stubClient(TASKS);
    const result = await previewRule({ asana_project_gid: '1216709753301754', min_age_hours: 12, require_section_match: true, max_deletes_per_run: 50 }, client);
    expect(result.matched_count).toBe(2);
    expect(result.items.map((i) => i.action).sort()).toEqual(['skipped_no_twin', 'would_delete', 'would_delete']);
    expect(deleted).toEqual([]);
    expect(q.listRuns(rule.id)).toHaveLength(0);
  });

  it('formats the Slack one-liner', async () => {
    const live = q.updateRule(rule.id, { ...rule, dry_run: false })!;
    const { client } = stubClient(TASKS);
    const run = (await runRule(q, live, { trigger: 'schedule', client }))!;
    const msg = slackMessage(live, run);
    expect(msg).toMatch(/^Asana sweep - GreatVita - AM Daily Checklist \(Pilot\): 5 scanned, 2 deleted, 3 skipped/);
    expect(msg).toMatch(/View run/);
  });
});
