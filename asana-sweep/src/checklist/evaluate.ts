// Pure checklist completion logic. No I/O. Tested in tests/evaluate.test.ts.
//
// For one account on one day:
//   - Every enabled top-level item that is due on the date (daily items on workdays, weekly items on
//     their weekday) is one checklist line; it is DONE when a tick exists for that date, else PENDING.
//   - Items not due today are reported as NOT_DUE and do not count.
//   - Action items (children) are evaluated the same way underneath their parent; a child is only
//     shown when it is due (or was ticked) on the date.
//   - Every line carries a role (AM or AA) so AM, AA and combined completion are reported separately.

import type { ChecklistItem, ChecklistTick } from '../sweep/types.js';

export type Role = 'am' | 'aa';
export type ItemState = 'done' | 'pending' | 'not_due' | 'stale';
export type ItemFlag = 'no_repeat' | 'no_due_date' | 'overdue';

export interface ItemResult {
  name: string;
  state: ItemState;
  role: Role;
  task_gid: string;
  guidance: string | null;
  frequency: 'daily' | 'weekly';
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
  frequency: 'daily' | 'weekly';
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

/** ISO weekday of a YYYY-MM-DD date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(date + 'T12:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}

/** Is this item due on the date? Daily items every day the checklist is evaluated; weekly ones on their weekday. */
export function isDue(item: Pick<ChecklistItem, 'frequency' | 'weekday'>, date: string): boolean {
  if (item.frequency === 'weekly') return (item.weekday ?? 1) === isoWeekday(date);
  return true;
}

export function evaluateChecklist(items: ChecklistItem[], ticks: ChecklistTick[], opts: EvalOptions): EvalResult {
  const tickByItem = new Map<number, ChecklistTick>();
  for (const t of ticks) if (t.tick_date === opts.checkDate) tickByItem.set(t.item_id, t);
  const enabled = items.filter((i) => i.enabled);
  const children = new Map<number, ChecklistItem[]>();
  for (const i of enabled) if (i.parent_id !== null) children.set(i.parent_id, [...(children.get(i.parent_id) ?? []), i]);
  const byPos = (a: ChecklistItem, b: ChecklistItem) => a.position - b.position || a.id - b.id;
  const nameFor = (role: Role, tick: ChecklistTick | undefined) => tick?.done_by ?? (role === 'am' ? opts.amName : opts.aaName);

  const results: ItemResult[] = [];
  for (const item of enabled.filter((i) => i.parent_id === null).sort(byPos)) {
    const tick = tickByItem.get(item.id);
    const due = isDue(item, opts.checkDate);
    const state: ItemState = tick ? 'done' : due ? 'pending' : 'not_due';
    const subtasks: SubtaskResult[] = [];
    if (state !== 'not_due') {
      for (const child of (children.get(item.id) ?? []).sort(byPos)) {
        const ct = tickByItem.get(child.id);
        if (!ct && !isDue(child, opts.checkDate)) continue;
        subtasks.push({ name: child.name, task_gid: String(child.id), role: child.role, done: Boolean(ct), frequency: child.frequency, assignee_name: nameFor(child.role, ct), completed_at: ct?.done_at ?? null });
      }
    }
    results.push({
      name: item.name,
      state,
      role: item.role,
      task_gid: String(item.id),
      guidance: item.guidance,
      frequency: item.frequency,
      section_name: item.section || null,
      assignee_name: nameFor(item.role, tick),
      due_on: due ? opts.checkDate : null,
      completed_at: tick?.done_at ?? null,
      flags: [],
      subtasks,
    });
  }

  let am_total = 0;
  let am_done = 0;
  let aa_total = 0;
  let aa_done = 0;
  const count = (role: Role, done: boolean) => {
    if (role === 'am') { am_total += 1; if (done) am_done += 1; } else { aa_total += 1; if (done) aa_done += 1; }
  };
  for (const it of results) {
    if (it.state === 'done' || it.state === 'pending') count(it.role, it.state === 'done');
    for (const st of it.subtasks) count(st.role, st.done);
  }
  const total = am_total + aa_total;
  const done = am_done + aa_done;
  const am_complete = am_done === am_total;
  const aa_complete = aa_done === aa_total;
  const status: CheckStatus = total === 0 ? 'empty' : done === total ? 'complete' : done === 0 ? 'none' : 'partial';
  // Pending first, then done, then the weekly lines that are not due today. Position order within each group.
  const order: Record<ItemState, number> = { pending: 0, done: 1, not_due: 2, stale: 3 };
  results.sort((a, b) => order[a.state] - order[b.state]);
  return {
    status,
    am_total,
    am_done,
    aa_total,
    aa_done,
    am_complete: total > 0 && am_complete,
    aa_complete: total > 0 && aa_complete,
    combined_complete: total > 0 && am_complete && aa_complete,
    warnings: [],
    items: results,
  };
}
