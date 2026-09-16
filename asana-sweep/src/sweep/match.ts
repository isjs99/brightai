// Pure matching logic. No I/O, no database, no Asana. Fully unit tested in tests/match.test.ts.
//
// Core rule (do not change without a config flag):
//   A completed task is a spent recurring instance if an incomplete task with the exact same
//   name (trimmed, case sensitive) exists in the same project. Delete it. Otherwise leave it.
//   Never touch incomplete tasks.

export interface SweepTask {
  gid: string;
  name: string;
  completed: boolean;
  completed_at: string | null;
  section_name: string | null;
  num_subtasks: number;
  assignee_name?: string | null;
}

export type PlanAction = 'delete' | 'skipped_no_twin' | 'skipped_too_recent' | 'skipped_section_mismatch';

export interface PlanItem {
  task: SweepTask;
  action: PlanAction;
  reason: string;
  twin_gid: string | null;
}

export interface MatchOptions {
  minAgeHours: number;
  requireSectionMatch: boolean;
  now?: Date;
}

export interface Plan {
  scanned: number;
  items: PlanItem[];
  toDelete: PlanItem[];
  warnings: string[];
}

const normalise = (name: string): string => name.trim();

export function buildPlan(tasks: SweepTask[], options: MatchOptions): Plan {
  const now = options.now ?? new Date();
  const minAgeMs = Math.max(0, options.minAgeHours) * 3600 * 1000;

  // Index incomplete tasks by trimmed name.
  const incompleteByName = new Map<string, SweepTask[]>();
  for (const t of tasks) {
    if (t.completed) continue;
    const key = normalise(t.name);
    const list = incompleteByName.get(key) ?? [];
    list.push(t);
    incompleteByName.set(key, list);
  }

  const warnings: string[] = [];
  for (const [name, list] of incompleteByName) {
    if (list.length > 1) {
      warnings.push(`${list.length} incomplete tasks share the name "${name}" (someone may have duplicated one).`);
    }
  }

  const items: PlanItem[] = [];
  for (const task of tasks) {
    if (!task.completed) continue;
    const key = normalise(task.name);
    const twins = incompleteByName.get(key) ?? [];

    if (twins.length === 0) {
      items.push({ task, action: 'skipped_no_twin', reason: 'No incomplete task with the same name. Treated as a one-off.', twin_gid: null });
      continue;
    }

    let candidates = twins;
    if (options.requireSectionMatch) {
      candidates = twins.filter((t) => (t.section_name ?? '') === (task.section_name ?? ''));
      if (candidates.length === 0) {
        const where = twins.map((t) => `"${t.section_name ?? 'no section'}"`).join(', ');
        items.push({
          task,
          action: 'skipped_section_mismatch',
          reason: `Incomplete twin exists but in a different section (${where}), this task is in "${task.section_name ?? 'no section'}".`,
          twin_gid: twins[0].gid,
        });
        continue;
      }
    }

    const twin = candidates[0];
    const completedAt = task.completed_at ? Date.parse(task.completed_at) : NaN;
    if (Number.isNaN(completedAt)) {
      items.push({ task, action: 'skipped_too_recent', reason: 'No completed_at timestamp on the task, so its age cannot be verified.', twin_gid: twin.gid });
      continue;
    }
    const ageMs = now.getTime() - completedAt;
    if (ageMs < minAgeMs) {
      const ageHours = Math.max(0, ageMs / 3600000);
      items.push({
        task,
        action: 'skipped_too_recent',
        reason: `Completed ${ageHours.toFixed(1)}h ago, under the ${options.minAgeHours}h minimum age.`,
        twin_gid: twin.gid,
      });
      continue;
    }

    items.push({
      task,
      action: 'delete',
      reason: `Incomplete twin ${twin.gid} exists${options.requireSectionMatch ? ' in the same section' : ''}. Spent recurring instance.`,
      twin_gid: twin.gid,
    });
  }

  return {
    scanned: tasks.length,
    items,
    toDelete: items.filter((i) => i.action === 'delete'),
    warnings,
  };
}

/** Returns an error message if the plan would delete more than the cap allows, otherwise null. */
export function checkCap(plan: Plan, maxDeletesPerRun: number): string | null {
  if (plan.toDelete.length > maxDeletesPerRun) {
    return `Would delete ${plan.toDelete.length} tasks, above the max_deletes_per_run cap of ${maxDeletesPerRun}. Nothing was deleted. Raise the cap or check the project.`;
  }
  return null;
}
