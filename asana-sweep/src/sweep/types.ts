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
