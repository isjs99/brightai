import type { Account, AccountInput, AccountStatusRow, Analytics, CheckSettings, CheckWithItems, PreviewResult, Rule, RuleInput, RuleSummary, Run, RunItem } from '../../sweep/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    if (res.status === 401 && path !== '/login') window.dispatchEvent(new CustomEvent('sweep:unauthenticated'));
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export interface Status {
  asana_user: { gid: string; name: string } | null;
  asana_error: string | null;
  public_url: string;
  retention_days: number;
}

export const api = {
  me: () => call<{ authenticated: boolean }>('GET', '/me'),
  login: (password: string) => call<{ ok: true }>('POST', '/login', { password }),
  logout: () => call<{ ok: true }>('POST', '/logout'),
  status: () => call<Status>('GET', '/status'),
  meta: () => call<{ cron_presets: { label: string; cron: string }[]; timezones: string[] }>('GET', '/meta'),
  describeCron: (expr: string, tz: string) =>
    call<{ error: string | null; text: string | null; next_run_at: string | null }>('GET', `/cron/describe?expr=${encodeURIComponent(expr)}&tz=${encodeURIComponent(tz)}`),
  searchProjects: (q: string) => call<{ projects: { gid: string; name: string; workspace?: { name: string } }[] }>('GET', `/asana/projects?q=${encodeURIComponent(q)}`),
  listRules: () => call<{ rules: RuleSummary[] }>('GET', '/rules'),
  getRule: (id: number) => call<{ rule: RuleSummary }>('GET', `/rules/${id}`),
  createRule: (input: RuleInput) => call<{ rule: RuleSummary }>('POST', '/rules', input),
  updateRule: (id: number, input: RuleInput) => call<{ rule: RuleSummary }>('PUT', `/rules/${id}`, input),
  patchRule: (id: number, patch: Partial<Pick<Rule, 'enabled' | 'dry_run'>>) => call<{ rule: RuleSummary }>('PATCH', `/rules/${id}`, patch),
  deleteRule: (id: number) => call<{ ok: true }>('DELETE', `/rules/${id}`),
  duplicateRule: (id: number) => call<{ rule: RuleSummary }>('POST', `/rules/${id}/duplicate`),
  runRule: (id: number) => call<{ run: Run; rule: RuleSummary }>('POST', `/rules/${id}/run`),
  listRuns: (id: number) => call<{ runs: Run[] }>('GET', `/rules/${id}/runs`),
  getRun: (id: number) => call<{ run: Run; items: RunItem[] }>('GET', `/runs/${id}`),
  // Accounts + checklist checks
  listAccounts: () => call<{ accounts: AccountStatusRow[] }>('GET', '/accounts'),
  createAccount: (input: AccountInput) => call<{ account: Account }>('POST', '/accounts', input),
  updateAccount: (id: number, input: AccountInput) => call<{ account: Account }>('PUT', `/accounts/${id}`, input),
  patchAccount: (id: number, patch: Partial<AccountInput>) => call<{ account: Account }>('PATCH', `/accounts/${id}`, patch),
  deleteAccount: (id: number) => call<{ ok: true }>('DELETE', `/accounts/${id}`),
  createSweepRule: (id: number) => call<{ rule: RuleSummary }>('POST', `/accounts/${id}/sweep-rule`),
  checkAccount: (id: number) => call<{ check: CheckWithItems }>('POST', `/accounts/${id}/check`),
  listChecks: (date?: string) => call<{ date: string; today: string; rows: AccountStatusRow[]; dates: string[]; is_running: boolean }>('GET', `/checks${date ? `?date=${date}` : ''}`),
  runChecks: () => call<{ checked: number; rows: AccountStatusRow[] }>('POST', '/checks/run'),
  getCheck: (id: number) => call<{ check: CheckWithItems }>('GET', `/checks/${id}`),
  getCheckSettings: () => call<{ settings: CheckSettings }>('GET', '/check-settings'),
  saveCheckSettings: (s: Pick<CheckSettings, 'check_cron' | 'check_timezone' | 'check_enabled' | 'check_slack_webhook'>) => call<{ settings: CheckSettings }>('PUT', '/check-settings', s),
  analytics: (days: number) => call<Analytics>('GET', `/analytics?days=${days}`),
  preview: (input: Pick<RuleInput, 'asana_project_gid' | 'min_age_hours' | 'require_section_match' | 'max_deletes_per_run'>) =>
    call<PreviewResult>('POST', '/preview', input),
};

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86400000, 'd'],
    [3600000, 'h'],
    [60000, 'min'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return diff > 0 ? `in ${n}${label === 'min' ? ' min' : label}` : `${n}${label === 'min' ? ' min' : label} ago`;
    }
  }
  return diff > 0 ? 'in under a minute' : 'just now';
}
