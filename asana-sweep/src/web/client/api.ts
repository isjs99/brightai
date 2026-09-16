import { useEffect, useRef, useState } from 'react';
import type {
  Account,
  AccountInput,
  AccountShop,
  AccountStatusRow,
  BdContact,
  BdData,
  BdEmailDraft,
  OutreachData,
  BdProspect,
  BdProspectInput,
  BdProspectPatch,
  Analytics,
  CalendarData,
  CheckSettings,
  CheckWithItems,
  ContextEntry,
  ConversationDetail,
  InboxData,
  InboxReply,
  GmvData,
  GmvMaxPatch,
  GmvMaxRow,
  GmvSync,
  GradesData,
  Lead,
  LeadsData,
  Promotion,
  PromotionInput,
  TtsStatus,
  Person,
  PersonInput,
  PreviewResult,
  ReminderSettings,
  Rule,
  RuleInput,
  RuleSummary,
  Run,
  RunItem,
} from '../../sweep/types';

/**
 * Subscribe to server-sent live updates. `onUpdate` fires (debounced) whenever a check, run or
 * watcher tick changes state on the server, so pages can refetch without polling.
 */
export function useLiveUpdates(onUpdate: (e: { kind: string; account_id?: number; rule_id?: number }) => void, debounceMs = 400): boolean {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onUpdate);
  cb.current = onUpdate;
  useEffect(() => {
    let es: EventSource | null = null;
    let timer: number | null = null;
    let pending: { kind: string; account_id?: number; rule_id?: number } | null = null;
    let closed = false;
    const open = () => {
      if (closed) return;
      es = new EventSource('/api/events');
      es.addEventListener('hello', () => setConnected(true));
      es.addEventListener('update', (ev) => {
        try {
          pending = JSON.parse((ev as MessageEvent).data);
        } catch {
          pending = { kind: 'unknown' };
        }
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (pending) cb.current(pending);
          pending = null;
        }, debounceMs);
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) window.setTimeout(open, 5000);
      };
    };
    open();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      es?.close();
    };
  }, [debounceMs]);
  return connected;
}

export function fmtMoney(n: number | null | undefined, currency = 'EUR'): string {
  if (n === null || n === undefined) return '–';
  if (/^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Math.round(n));
    } catch {
      /* unknown code: fall through */
    }
  }
  return `${currency}${Math.round(n).toLocaleString('en-GB')}`;
}

export function fmtPct(n: number | null | undefined): string {
  return n === null || n === undefined ? '–' : `${Math.round(n)}%`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

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
  me: () => call<{ authenticated: boolean; role: 'admin' | 'am' | null; am_login_enabled: boolean }>('GET', '/me'),
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
  runAllRules: () => call<{ runs: Run[]; rules: RuleSummary[] }>('POST', '/rules/run-all'),
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
  getLiveCheck: (accountId: number) => call<{ check: CheckWithItems }>('GET', `/checks/${accountId}/live`),
  liveRefresh: () => call<{ ok: true; rows: AccountStatusRow[] }>('POST', '/live/refresh'),
  getCheckSettings: () => call<{ settings: CheckSettings }>('GET', '/check-settings'),
  saveCheckSettings: (s: Pick<CheckSettings, 'check_cron' | 'check_timezone' | 'check_enabled' | 'check_slack_webhook' | 'live_enabled' | 'live_interval_seconds' | 'live_sweep_enabled'>) =>
    call<{ settings: CheckSettings }>('PUT', '/check-settings', s),
  analytics: (days: number) => call<Analytics>('GET', `/analytics?days=${days}`),
  // People + reminders
  listPeople: () => call<{ people: Person[] }>('GET', '/people'),
  createPerson: (p: PersonInput) => call<{ person: Person }>('POST', '/people', p),
  updatePerson: (id: number, p: PersonInput) => call<{ person: Person }>('PUT', `/people/${id}`, p),
  deletePerson: (id: number) => call<{ ok: true }>('DELETE', `/people/${id}`),
  testDm: (id: number) => call<{ ok: true }>('POST', `/people/${id}/test-dm`),
  sendReminders: () => call<{ results: { person: string; sent: boolean; error: string | null; accounts: string[] }[] }>('POST', '/reminders/send'),
  previewReminders: () => call<{ messages: { person: string; to: string | null; notify: boolean; text: string }[] }>('GET', '/reminders/preview'),
  getReminderSettings: () => call<{ settings: ReminderSettings }>('GET', '/reminder-settings'),
  saveReminderSettings: (s: Pick<ReminderSettings, 'notify_ams_enabled' | 'reminder_cron' | 'reminder_text'>) => call<{ settings: ReminderSettings }>('PUT', '/reminder-settings', s),
  // Calendar, GMV, grades
  calendar: (month: string) => call<CalendarData>('GET', `/calendar?month=${month}`),
  gmv: (month: string) => call<GmvData>('GET', `/gmv?month=${month}`),
  saveTargets: (month: string, targets: Record<number, number | null>) => call<GmvData>('PUT', '/gmv/targets', { month, targets }),
  copyTargets: (from: string, to: string) => call<{ copied: number }>('POST', '/gmv/targets/copy', { from, to }),
  syncGmv: () => call<{ sync: GmvSync }>('POST', '/gmv/sync'),
  saveGmvSettings: (s: { month: string; fx_to_eur: Record<string, number>; bonus_threshold: number; bonus_growth_below: number; bonus_growth_above: number }) => call<GmvData>('PUT', '/gmv/settings', s),
  saveDeals: (s: { month: string; am_share_pct?: number; deals: Record<number, { commission_pct: number | null; commission_basis: 'gmv' | 'mor'; settlement_pct: number; net_settlement?: number | null }> }) =>
    call<GmvData>('PUT', '/gmv/deals', s),
  importGmv: (rows: unknown[]) => call<{ imported: number; skipped: number }>('POST', '/gmv/import', { rows }),
  addShop: (account_id: number, shop_id: string, shop_name: string) => call<{ shop: AccountShop }>('POST', '/gmv/shops', { account_id, shop_id, shop_name }),
  removeShop: (id: number) => call<{ ok: true }>('DELETE', `/gmv/shops/${id}`),
  grades: (month: string) => call<GradesData>('GET', `/grades?month=${month}`),
  // TikTok Shop, promotions, GMV Max
  ttsStatus: () => call<TtsStatus>('GET', '/tts/status'),
  saveTtsSettings: (service_id: string) => call<TtsStatus>('PUT', '/tts/settings', { service_id }),
  linkTtsShop: (id: string, account_id: number | null, market: string | null) => call<TtsStatus>('PUT', `/tts/shops/${id}/link`, { account_id, market }),
  removeTtsShop: (id: string) => call<TtsStatus>('DELETE', `/tts/shops/${id}`),
  ttsShopProducts: (id: string) => call<{ products: { id: string; title: string; status: string }[] }>('GET', `/tts/shops/${id}/products`),
  listPromotions: () => call<{ promotions: Promotion[]; tts: TtsStatus }>('GET', '/promotions'),
  createPromotion: (p: PromotionInput) => call<{ promotion: Promotion }>('POST', '/promotions', p),
  updatePromotion: (id: number, p: PromotionInput) => call<{ promotion: Promotion }>('PUT', `/promotions/${id}`, p),
  deletePromotion: (id: number) => call<{ ok: true }>('DELETE', `/promotions/${id}`),
  pushPromotion: (id: number) => call<{ promotion: Promotion }>('POST', `/promotions/${id}/push`),
  deactivatePromotion: (id: number) => call<{ promotion: Promotion }>('POST', `/promotions/${id}/deactivate`),
  syncPromotion: (id: number) => call<{ promotion: Promotion }>('POST', `/promotions/${id}/sync`),
  inbox: () => call<InboxData & { languages: Record<string, string> }>('GET', '/inbox'),
  syncInbox: () => call<InboxData & { result: { conversations: number; new_messages: number; auto_replies: number } }>('POST', '/inbox/sync'),
  saveInboxSettings: (s: Partial<{ auto_reply_master: boolean; inbox_enabled: boolean; poll_seconds: number; max_age_hours: number }>) => call<InboxData>('PUT', '/inbox/settings', s),
  saveAccountReply: (accountId: number, s: Partial<{ auto_reply_cs: boolean; auto_reply_affiliate: boolean; reply_language: string | null }>) => call<InboxData>('PUT', `/inbox/accounts/${accountId}`, s),
  conversation: (id: number) => call<ConversationDetail & { auto_reply_blocker: string | null }>('GET', `/inbox/conversations/${id}`),
  updateConversation: (id: number, s: Partial<{ status: string; language: string | null }>) => call<ConversationDetail>('PUT', `/inbox/conversations/${id}`, s),
  draftReply: (id: number, opts: { language?: string; instructions?: string } = {}) => call<ConversationDetail & { reply: InboxReply }>('POST', `/inbox/conversations/${id}/draft`, opts),
  sendReply: (id: number, text: string) => call<ConversationDetail>('POST', `/inbox/conversations/${id}/send`, { text }),
  listContext: () => call<{ entries: ContextEntry[]; languages: Record<string, string> }>('GET', '/inbox/context'),
  createContext: (e: { language: string; scope: string; account_id: number | null; title: string; body: string }) => call<{ entry: ContextEntry; entries: ContextEntry[] }>('POST', '/inbox/context', e),
  updateContext: (id: number, e: Partial<{ language: string; scope: string; account_id: number | null; title: string; body: string; enabled: boolean }>) => call<{ entry: ContextEntry; entries: ContextEntry[] }>('PUT', `/inbox/context/${id}`, e),
  deleteContext: (id: number) => call<{ entries: ContextEntry[] }>('DELETE', `/inbox/context/${id}`),
  importCruvaOutreach: (rows: Record<string, unknown>[], account_id?: number | null) => call<{ imported: number; total: number }>('POST', '/inbox/cruva-outreach/import', { rows, account_id }),
  bd: () => call<BdData>('GET', '/bd'),
  createProspect: (input: BdProspectInput) => call<BdData & { prospect: BdProspect }>('POST', '/bd/prospects', input),
  patchProspect: (id: number, patch: BdProspectPatch) => call<BdData & { prospect: BdProspect }>('PATCH', `/bd/prospects/${id}`, patch),
  logOutreach: (id: number, e: { note: string; channel?: string | null; contact_name?: string | null }) => call<BdData & { prospect: BdProspect }>('POST', `/bd/prospects/${id}/log`, e),
  deleteOutreachEvent: (id: number) => call<BdData>('DELETE', `/bd/outreach-log/${id}`),
  // BD outreach emails
  outreach: () => call<OutreachData>('GET', '/outreach'),
  draftEmail: (contactId: number, opts: { language?: string; style?: 'short' | 'intro'; instructions?: string } = {}) => call<OutreachData & { draft: BdEmailDraft }>('POST', `/bd/contacts/${contactId}/draft`, opts),
  regenerateDraft: (id: number, opts: { language?: string; style?: 'short' | 'intro'; instructions?: string } = {}) => call<OutreachData & { draft: BdEmailDraft }>('POST', `/outreach/drafts/${id}/regenerate`, opts),
  updateDraft: (id: number, patch: Partial<Pick<BdEmailDraft, 'subject' | 'body' | 'to_email' | 'to_name'>>) => call<OutreachData & { draft: BdEmailDraft }>('PUT', `/outreach/drafts/${id}`, patch),
  draftToGmail: (id: number) => call<OutreachData & { draft: BdEmailDraft; mode: 'gmail' | 'compose'; url: string }>('POST', `/outreach/drafts/${id}/gmail`),
  markDraftSent: (id: number) => call<OutreachData & { draft: BdEmailDraft }>('POST', `/outreach/drafts/${id}/sent`),
  deleteDraft: (id: number) => call<OutreachData>('DELETE', `/outreach/drafts/${id}`),
  saveOutreachSettings: (s: Partial<{ sender_name: string; sender_title: string; booking_url: string; pitch: string; sent_query: string }>) => call<OutreachData>('PUT', '/outreach/settings', s),
  addExample: (e: { subject: string; body: string; kind: string }) => call<OutreachData>('POST', '/outreach/examples', e),
  setExample: (id: number, enabled: boolean) => call<OutreachData>('PUT', `/outreach/examples/${id}`, { enabled }),
  deleteExample: (id: number) => call<OutreachData>('DELETE', `/outreach/examples/${id}`),
  pullExamples: () => call<OutreachData & { pulled: number; added: number }>('POST', '/outreach/examples/pull'),
  gmailDisconnect: () => call<OutreachData>('POST', '/gmail/disconnect'),
  deleteProspect: (id: number) => call<BdData>('DELETE', `/bd/prospects/${id}`),
  addContact: (prospectId: number, c: { name: string; title?: string; email?: string; linkedin_url?: string; phone?: string; notes?: string }) => call<BdData & { prospect: BdProspect }>('POST', `/bd/prospects/${prospectId}/contacts`, c),
  deleteContact: (id: number) => call<BdData>('DELETE', `/bd/contacts/${id}`),
  findContacts: (prospectId: number, opts: { domain?: string; company?: string } = {}) => call<BdData & { found: number; revealed: number; prospect: BdProspect }>('POST', `/bd/prospects/${prospectId}/find-contacts`, opts),
  revealContact: (id: number) => call<BdData & { contact: BdContact; prospect: BdProspect }>('POST', `/bd/contacts/${id}/reveal`),
  importProspects: (prospects: Record<string, unknown>[]) => call<{ result: { added: number; updated: number } }>('POST', '/bd/import', { prospects }),
  leads: () => call<LeadsData>('GET', '/leads'),
  patchLead: (id: number, patch: { sourced_by_id?: number | null; onboarding_id?: number | null; added_on?: string | null }) => call<LeadsData & { lead: Lead }>('PATCH', `/leads/${id}`, patch),
  syncLeads: () => call<LeadsData & { result: { rows: number; added: number; updated: number; removed: number } }>('POST', '/leads/sync'),
  importLeads: (csv: string) => call<LeadsData & { result: { rows: number; added: number; updated: number; removed: number } }>('POST', '/leads/import', { csv }),
  saveLeadsSettings: (s: Partial<{ sheet_id: string; sheet_tab: string; sync_enabled: boolean; sync_seconds: number; points_signed: number; points_sourced: number; currency: string }>) => call<LeadsData>('PUT', '/leads/settings', s),
  listGmvMax: () => call<{ rows: GmvMaxRow[] }>('GET', '/gmv-max'),
  generateGmvMax: (types: string[]) => call<{ rows: GmvMaxRow[]; ensured: number }>('POST', '/gmv-max/generate', { types }),
  addGmvMax: (account_id: number, market: string, campaign_type: 'PRODUCT' | 'LIVE') => call<{ rows: GmvMaxRow[] }>('POST', '/gmv-max', { account_id, market, campaign_type }),
  bulkGmvMax: (ids: number[], patch: GmvMaxPatch) => call<{ changed: number; rows: GmvMaxRow[] }>('PUT', '/gmv-max/bulk', { ids, patch }),
  deleteGmvMax: (id: number) => call<{ rows: GmvMaxRow[] }>('DELETE', `/gmv-max/${id}`),
  saveGradeWeight: (weight_checklist: number) => call<{ weight_checklist: number }>('PUT', '/grade-settings', { weight_checklist }),
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
