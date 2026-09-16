// Shared between server and client. Keep this file free of Node-only imports.

export type RunItemAction =
  | 'deleted'
  | 'would_delete'
  | 'delete_failed'
  | 'skipped_no_twin'
  | 'skipped_too_recent'
  | 'skipped_section_mismatch';

export type RunStatus = 'running' | 'ok' | 'error' | 'dry_run';

export interface Rule {
  id: number;
  name: string;
  asana_project_gid: string;
  asana_project_name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  dry_run: boolean;
  min_age_hours: number;
  require_section_match: boolean;
  max_deletes_per_run: number;
  notify_slack_webhook: string | null;
  created_at: string;
  updated_at: string;
}

export type RuleInput = Omit<Rule, 'id' | 'created_at' | 'updated_at'>;

export interface Run {
  id: number;
  rule_id: number;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  trigger: 'schedule' | 'manual';
  dry_run: boolean;
  scanned_count: number;
  matched_count: number;
  deleted_count: number;
  error_message: string | null;
  warnings: string[];
}

export interface RunItem {
  id: number;
  run_id: number;
  task_gid: string;
  task_name: string;
  section_name: string | null;
  completed_at: string | null;
  num_subtasks: number;
  action: RunItemAction;
  reason: string;
}

export interface RuleSummary extends Rule {
  schedule_text: string;
  next_run_at: string | null;
  last_run: Pick<Run, 'id' | 'status' | 'started_at' | 'finished_at' | 'scanned_count' | 'matched_count' | 'deleted_count' | 'error_message'> | null;
  is_running: boolean;
}

export interface PreviewItem {
  task_gid: string;
  task_name: string;
  section_name: string | null;
  completed_at: string | null;
  num_subtasks: number;
  action: RunItemAction;
  reason: string;
}

export interface PreviewResult {
  project_name: string;
  scanned_count: number;
  matched_count: number;
  cap_exceeded: boolean;
  warnings: string[];
  items: PreviewItem[];
}

// ---- Checklist completion tracking ----

export interface Account {
  id: number;
  name: string;
  markets: string | null;
  am_name: string | null;
  aa_name: string | null;
  asana_project_gid: string | null;
  asana_project_name: string;
  enabled: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type AccountInput = Omit<Account, 'id' | 'created_at' | 'updated_at'>;

export type CheckStatus = 'complete' | 'partial' | 'none' | 'empty' | 'error' | 'unlinked';

export interface CheckItem {
  name: string;
  state: 'done' | 'pending' | 'not_due' | 'stale';
  role: 'am' | 'aa';
  task_gid: string;
  section_name: string | null;
  assignee_name: string | null;
  due_on: string | null;
  completed_at: string | null;
  flags: ('no_repeat' | 'no_due_date' | 'overdue')[];
  subtasks: { name: string; task_gid: string; role: 'am' | 'aa'; done: boolean; assignee_name: string | null; completed_at: string | null }[];
}

export interface Check {
  id: number;
  account_id: number;
  check_date: string;
  checked_at: string;
  trigger: 'schedule' | 'manual';
  status: CheckStatus;
  am_total: number;
  am_done: number;
  aa_total: number;
  aa_done: number;
  am_complete: boolean;
  aa_complete: boolean;
  combined_complete: boolean;
  warnings: string[];
  error_message: string | null;
}

export interface CheckWithItems extends Check {
  items: CheckItem[];
}

export interface AccountStatusRow {
  account: Account;
  check: Check | null;
  has_sweep_rule: boolean;
}

export interface CheckSettings {
  check_cron: string;
  check_timezone: string;
  check_enabled: boolean;
  check_slack_webhook: string;
  schedule_text: string;
  next_run_at: string | null;
  is_running: boolean;
}

export interface AnalyticsDay {
  date: string;
  accounts_checked: number;
  combined_complete: number;
  am_complete: number;
  aa_complete: number;
}

export interface AnalyticsAccount {
  account: Account;
  days: { date: string; status: CheckStatus | null; am_complete: boolean; aa_complete: boolean; combined_complete: boolean; am_done: number; am_total: number; aa_done: number; aa_total: number }[];
  checks: number;
  rate_am: number | null;
  rate_aa: number | null;
  rate_combined: number | null;
}

export interface AnalyticsAm {
  am_name: string;
  accounts: number;
  checks: number;
  rate_am: number | null;
  rate_aa: number | null;
  rate_combined: number | null;
}

export interface Analytics {
  from: string;
  to: string;
  dates: string[];
  days: AnalyticsDay[];
  accounts: AnalyticsAccount[];
  ams: AnalyticsAm[];
}

// ---- People (AMs / AAs) and Slack reminders ----

export interface Person {
  id: number;
  name: string;
  role: 'am' | 'aa';
  email: string | null;
  slack_user_id: string | null;
  notify: boolean;
}

export type PersonInput = Omit<Person, 'id'>;

export interface ReminderSettings {
  notify_ams_enabled: boolean;
  reminder_cron: string;
  reminder_text: string;
  next_reminder_at: string | null;
  slack_bot_configured: boolean;
}

// ---- Calendar ----

export interface CalendarCell {
  date: string;
  status: CheckStatus | null;
  combined_complete: boolean;
  am_complete: boolean;
  aa_complete: boolean;
  am_done: number;
  am_total: number;
  aa_done: number;
  aa_total: number;
}

export interface CalendarAccountRow {
  account: Account;
  cells: CalendarCell[];
  checked_days: number;
  complete_days: number;
  missed: number;
  compliance: number | null;
}

export interface CalendarAmRow {
  am_name: string;
  accounts: CalendarAccountRow[];
  checked_days: number;
  complete_days: number;
  missed: number;
  compliance: number | null;
}

export interface CalendarData {
  month: string;
  workdays: string[];
  today: string;
  target: number;
  ams: CalendarAmRow[];
  totals: { checked_days: number; complete_days: number; missed: number; compliance: number | null };
}

// ---- GMV (Cruva) ----

export interface AccountShop {
  id: number;
  account_id: number;
  shop_id: string;
  shop_name: string;
  currency: string;
}

export interface GmvShopRow {
  shop: AccountShop;
  gmv: number;
  affiliate_gmv: number;
  units: number;
  last_synced: string | null;
}

export interface GmvAccountRow {
  account: Account;
  shops: GmvShopRow[];
  gmv: number;
  affiliate_gmv: number;
  units: number;
  target: number | null;
  attainment: number | null;
  projected: number | null;
  projected_attainment: number | null;
  daily: { date: string; gmv: number }[];
}

export interface GmvAmRow {
  am_name: string;
  accounts: number;
  gmv: number;
  target: number | null;
  attainment: number | null;
  projected: number | null;
  projected_attainment: number | null;
}

export interface GmvData {
  month: string;
  from: string;
  to: string;
  days_in_month: number;
  days_elapsed: number;
  currency: string;
  accounts: GmvAccountRow[];
  ams: GmvAmRow[];
  totals: { gmv: number; target: number | null; attainment: number | null; projected: number | null };
  last_sync: GmvSync | null;
  cruva_configured: boolean;
}

export interface GmvSync {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'ok' | 'error';
  shops_synced: number;
  error_message: string | null;
}

// ---- Grading ----

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface GradeRow {
  name: string;
  am_name: string | null;
  account_id: number | null;
  compliance: number | null;
  missed: number;
  checked_days: number;
  gmv: number;
  target: number | null;
  attainment: number | null;
  score: number | null;
  grade: Grade | null;
}

export interface GradesData {
  month: string;
  weight_checklist: number;
  ams: GradeRow[];
  accounts: GradeRow[];
}
