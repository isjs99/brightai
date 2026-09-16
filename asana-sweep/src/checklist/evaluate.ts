// Pure checklist completion logic. No I/O. Tested in tests/evaluate.test.ts.
//
// For one account project on one day:
//   - Group top-level tasks by trimmed name. Each group is one checklist item.
//   - An item is DONE if any copy was completed on the check date (in the account timezone).
//   - Otherwise it is PENDING if an incomplete copy is due today, overdue, or has no due date.
//   - Items whose only incomplete copy is due in the future (weekly checks) are not due today.
//   - Subtasks (AA action items) count if incomplete or completed today.
//   - Every task is attributed to the AM or the AA by assignee, so AM, AA and combined
//     completion can be reported separately.

import type { ChecklistTask } from '../asana/client.js';

export type Role = 'am' | 'aa';
export type ItemState = 'done' | 'pending' | 'not_due' | 'stale';
export type ItemFlag = 'no_repeat' | 'no_due_date' | 'overdue';

export interface ItemResult {
  name: string;
  state: ItemState;
  role: Role;
  task_gid: string;
  section_name: string | null;
  assignee_name: string | null;
  due_on: string | null;
  completed_at: string | null;
  flags: ItemFlag[];
  subtasks: SubtaskResult[];
}

export interface SubtaskResult {
  name: string;
  task_gid: string;
  role: Role;
  done: boolean;
  assignee_name: string | null;
  completed_at: string | null;
}

export interface EvalOptions {
  checkDate: string; // YYYY-MM-DD in tz
  tz: string;
  amName: string | null;
  aaName: string | null;
}

export type CheckStatus = 'complete' | 'partial' | 'none' | 'empty';

export interface EvalResult {
  status: CheckStatus;
  am_total: number;
  am_done: number;
  aa_total: number;
  aa_done: number;
  am_complete: boolean;
  aa_complete: boolean;
  combined_complete: boolean;
  warnings: string[];
  items: ItemResult[];
}

export function localDate(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Loose person match: "Elena" ~ "Elena Frosali", "DM" ~ "dm@brightform.agency", "Feds" != "Federica". */
export function personMatches(assignee: string | null, configured: string | null): boolean {
  if (!assignee || !configured) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .split('@')[0]
      .split(/[^a-zà-ÿ]+/i)
      .filter(Boolean);
  const a = norm(assignee);
  const c = norm(configured);
  if (!a.length || !c.length) return false;
  return a[0] === c[0] || a.join(' ') === c.join(' ');
}

function roleOf(task: { assignee_name: string | null }, isSubtask: boolean, opts: EvalOptions): Role {
  const a = task.assignee_name;
  if (personMatches(a, opts.amName)) return 'am';
  if (personMatches(a, opts.aaName)) return 'aa';
  if (!a) return isSubtask ? 'aa' : 'am';
  // Assigned to someone who is not the configured AM: treat as AA work.
  return opts.amName ? 'aa' : 'am';
}

export function evaluateChecklist(topLevel: ChecklistTask[], subtasksByParent: Map<string, ChecklistTask[]>, opts: EvalOptions): EvalResult {
  const groups = new Map<string, ChecklistTask[]>();
  for (const t of topLevel) {
    const key = t.name.trim();
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const items: ItemResult[] = [];
  const warnings: string[] = [];

  for (const [name, copies] of groups) {
    // Most recent completion first, so repeated completions on one day resolve to the latest copy.
    const doneToday = copies
      .filter((c) => c.completed && c.completed_at && localDate(c.completed_at, opts.tz) === opts.checkDate)
      .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
    const incomplete = copies.filter((c) => !c.completed);
    // Earliest due first (no due date last), so the copy that is actually due today represents the item.
    const pending = incomplete
      .filter((c) => !c.due_on || c.due_on <= opts.checkDate)
      .sort((a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999'));
    const future = incomplete.filter((c) => c.due_on && c.due_on > opts.checkDate);

    let state: ItemState;
    let rep: ChecklistTask;
    const flags: ItemFlag[] = [];
    if (doneToday.length) {
      state = 'done';
      rep = doneToday[0];
      if (!incomplete.length) {
        flags.push('no_repeat');
        warnings.push(`"${name}" was completed today but no new copy appeared. Check it is set to repeat every workday.`);
      }
    } else if (pending.length) {
      state = 'pending';
      rep = pending[0];
      if (!rep.due_on) {
        flags.push('no_due_date');
        warnings.push(`"${name}" has no due date, so it cannot repeat.`);
      } else if (rep.due_on < opts.checkDate) {
        flags.push('overdue');
      }
    } else if (future.length) {
      state = 'not_due';
      rep = future[0];
    } else {
      state = 'stale';
      rep = copies[0];
      warnings.push(`"${name}" only exists as an old completed copy (no incomplete copy). One-off, or not set to repeat.`);
    }

    // Subtasks are evaluated like items: grouped by name across every copy of the parent, because
    // subtasks repeat too (a completed copy due today plus a fresh copy due tomorrow) and Asana
    // copies them onto each new parent instance. A subtask is done if any copy was completed
    // today, pending if a copy is due today or overdue, and ignored if it is only due later.
    const subtasks: SubtaskResult[] = [];
    if (state === 'done' || state === 'pending') {
      const byName = new Map<string, ChecklistTask[]>();
      for (const c of copies) {
        for (const st of subtasksByParent.get(c.gid) ?? []) {
          const key = st.name.trim().toLowerCase();
          if (!key) continue;
          byName.set(key, [...(byName.get(key) ?? []), st]);
        }
      }
      for (const list of byName.values()) {
        const doneSt = list
          .filter((s) => s.completed && s.completed_at && localDate(s.completed_at, opts.tz) === opts.checkDate)
          .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
        const pendingSt = list
          .filter((s) => !s.completed && (!s.due_on || s.due_on <= opts.checkDate))
          .sort((a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999'));
        const st = doneSt[0] ?? pendingSt[0];
        if (!st) continue; // only future copies, or finished on an earlier day
        subtasks.push({
          name: st.name,
          task_gid: st.gid,
          role: roleOf(st, true, opts),
          done: doneSt.length > 0,
          assignee_name: st.assignee_name,
          completed_at: doneSt.length ? st.completed_at : null,
        });
      }
    }

    items.push({
      name,
      state,
      role: roleOf(rep, false, opts),
      task_gid: rep.gid,
      section_name: rep.section_name,
      assignee_name: rep.assignee_name,
      due_on: rep.due_on,
      completed_at: state === 'done' ? rep.completed_at : null,
      flags,
      subtasks,
    });
  }

  let am_total = 0;
  let am_done = 0;
  let aa_total = 0;
  let aa_done = 0;
  const count = (role: Role, done: boolean) => {
    if (role === 'am') {
      am_total += 1;
      if (done) am_done += 1;
    } else {
      aa_total += 1;
      if (done) aa_done += 1;
    }
  };
  for (const it of items) {
    if (it.state === 'done' || it.state === 'pending') count(it.role, it.state === 'done');
    for (const st of it.subtasks) count(st.role, st.done);
  }

  const total = am_total + aa_total;
  const done = am_done + aa_done;
  const am_complete = am_done === am_total;
  const aa_complete = aa_done === aa_total;
  const status: CheckStatus = total === 0 ? 'empty' : done === total ? 'complete' : done === 0 ? 'none' : 'partial';

  items.sort((a, b) => {
    const order: Record<ItemState, number> = { pending: 0, done: 1, not_due: 2, stale: 3 };
    return order[a.state] - order[b.state] || a.name.localeCompare(b.name);
  });

  return {
    status,
    am_total,
    am_done,
    aa_total,
    aa_done,
    am_complete: total > 0 && am_complete,
    aa_complete: total > 0 && aa_complete,
    combined_complete: total > 0 && am_complete && aa_complete,
    warnings,
    items,
  };
}
