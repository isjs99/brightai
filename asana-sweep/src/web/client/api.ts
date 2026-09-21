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
  BdContact as BdContactT,
  BdProspect as BdProspectT,
  BdFollowup,
  TtsContact,
  BdActivity,
  MonitorData,
  StockData,
  StockProjection,
  IncidentsData,
  ReportsData,
  ClientReport,
  PlaybookData,
  PlaybookKind,
  PlaybookSetupCell,
  CopilotData,
  CopilotQuestion,
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

/** Who is using the shared login right now, for the BD activity tracker. Stored per browser. */
export function currentActor(): string {
  try { return localStorage.getItem('actor') ?? ''; } catch { return ''; }
}
export function setCurrentActor(name: string): void {
  try { if (name) localStorage.setItem('actor', name); else localStorage.removeItem('actor'); } catch { /* ignore */ }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const actor = currentActor();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(actor ? { 'x-actor': actor } : {}) },
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
  bulkPreview: (opts: { market?: string; include_drafted?: boolean } = {}) => call<{ count: number; items: { prospect_id: number; shop_name: string; brand: string | null; market: string; contact_id: number; contact_name: string; contact_title: string | null; contact_email: string | null }[] }>('GET', `/bd/drafts/bulk/preview?market=${encodeURIComponent(opts.market ?? '')}${opts.include_drafted ? '&include_drafted=1' : ''}`),
  bulkDraft: (opts: { market?: string; ids?: number[]; limit?: number; language?: string; style?: 'short' | 'intro'; instructions?: string; to_gmail?: boolean; include_drafted?: boolean }) => call<BdData & { state: BdData['bulk_draft'] }>('POST', '/bd/drafts/bulk', opts),
  stopBulkDraft: () => call<BdData>('POST', '/bd/drafts/bulk/stop'),
  draftsToGmailAll: () => call<OutreachData & { saved: number; errors: string[] }>('POST', '/outreach/drafts/gmail-all'),
  draftEmail: (contactId: number, opts: { language?: string; style?: 'short' | 'intro'; instructions?: string } = {}) => call<OutreachData & { draft: BdEmailDraft }>('POST', `/bd/contacts/${contactId}/draft`, opts),
  regenerateDraft: (id: number, opts: { language?: string; style?: 'short' | 'intro'; instructions?: string } = {}) => call<OutreachData & { draft: BdEmailDraft }>('POST', `/outreach/drafts/${id}/regenerate`, opts),
  updateDraft: (id: number, patch: Partial<Pick<BdEmailDraft, 'subject' | 'body' | 'to_email' | 'to_name'>>) => call<OutreachData & { draft: BdEmailDraft }>('PUT', `/outreach/drafts/${id}`, patch),
  draftToGmail: (id: number) => call<OutreachData & { draft: BdEmailDraft; mode: 'gmail' | 'compose'; url: string }>('POST', `/outreach/drafts/${id}/gmail`),
  markDraftSent: (id: number) => call<OutreachData & { draft: BdEmailDraft }>('POST', `/outreach/drafts/${id}/sent`),
  deleteDraft: (id: number) => call<OutreachData>('DELETE', `/outreach/drafts/${id}`),
  saveOutreachSettings: (s: Partial<{ sender_name: string; sender_title: string; booking_url: string; pitch: string; sent_query: string; watchlist_sheet_tab: string; linkedin_check_days: number; tldv_auto_draft: boolean }>) => call<OutreachData>('PUT', '/outreach/settings', s),
  addExample: (e: { subject: string; body: string; kind: string }) => call<OutreachData>('POST', '/outreach/examples', e),
  setExample: (id: number, enabled: boolean) => call<OutreachData>('PUT', `/outreach/examples/${id}`, { enabled }),
  deleteExample: (id: number) => call<OutreachData>('DELETE', `/outreach/examples/${id}`),
  pullExamples: () => call<OutreachData & { pulled: number; added: number }>('POST', '/outreach/examples/pull'),
  gmailDisconnect: () => call<OutreachData>('POST', '/gmail/disconnect'),
  // LinkedIn sequence, follow-ups, TTS contacts, alerts, activity, calls
  linkedinStep: (contactId: number, step: 'requested' | 'connected' | 'messaged', note?: string) => call<OutreachData & { contact: BdContactT; prospect: BdProspectT; followup: BdFollowup | null; message: { text: string; generator: string } | null }>('POST', `/bd/contacts/${contactId}/linkedin`, { step, note }),
  addFollowup: (f: { prospect_id: number; contact_id?: number | null; title: string; due_at?: string; note?: string }) => call<OutreachData & { followup: BdFollowup }>('POST', '/bd/followups', f),
  completeFollowup: (id: number, note?: string) => call<OutreachData & { followup: BdFollowup }>('POST', `/bd/followups/${id}/done`, { note }),
  snoozeFollowup: (id: number, days: number) => call<OutreachData & { followup: BdFollowup }>('POST', `/bd/followups/${id}/snooze`, { days }),
  remindFollowups: () => call<OutreachData & { sent: number }>('POST', '/bd/followups/remind'),
  ttsContactFor: (prospectId: number) => call<{ contact: TtsContact | null; fallback: TtsContact | null; reason: string }>('GET', `/bd/prospects/${prospectId}/tts-contact`),
  saveTtsContact: (c: Partial<TtsContact> & { market: string; name: string }) => call<OutreachData & { contact: TtsContact }>('PUT', '/bd/tts-contacts', c),
  deleteTtsContact: (id: number) => call<OutreachData>('DELETE', `/bd/tts-contacts/${id}`),
  addWatchlist: (names: string) => call<OutreachData & { added: number; new_alerts: number }>('POST', '/bd/watchlist', { names }),
  setWatchlist: (id: number, enabled: boolean) => call<OutreachData>('PUT', `/bd/watchlist/${id}`, { enabled }),
  deleteWatchlist: (id: number) => call<OutreachData>('DELETE', `/bd/watchlist/${id}`),
  syncWatchlist: () => call<OutreachData & { added: number; total: number; new_alerts: number }>('POST', '/bd/watchlist/sync'),
  scanAlerts: () => call<OutreachData & { checked: number; new_alerts: number }>('POST', '/bd/alerts/scan'),
  dismissAlert: (id: number) => call<OutreachData>('POST', `/bd/alerts/${id}/dismiss`),
  bdActivity: (days: number) => call<BdActivity>('GET', `/bd/activity?days=${days}`),
  checkCalls: () => call<OutreachData & { checked: number; drafted: number; errors: string[] }>('POST', '/outreach/calls/check'),
  // Account monitor
  monitor: () => call<MonitorData>('GET', '/monitor'),
  monitorScan: () => call<MonitorData & { opened: number; resolved: number; found: number }>('POST', '/monitor/scan'),
  monitorRule: (code: string, enabled: boolean) => call<MonitorData>('PUT', `/monitor/rules/${code}`, { enabled }),
  monitorSettings: (s: { interval_minutes?: number; enabled?: boolean }) => call<MonitorData>('PUT', '/monitor/settings', s),
  ackFlag: (id: number) => call<MonitorData>('POST', `/monitor/flags/${id}/ack`),
  // Stock
  stock: () => call<StockData>('GET', '/stock'),
  stockScan: (shop_id?: string) => call<StockData & { shops: number; skus: number; errors: string[] }>('POST', '/stock/scan', { shop_id }),
  stockSettings: (s: Partial<{ crit_days: number; warn_days: number; default_cover_days: number; default_lead_days: number }>) => call<StockData>('PUT', '/stock/settings', s),
  stockProjection: (shopId: string, days: number, lead: number) => call<StockProjection>('GET', `/stock/${encodeURIComponent(shopId)}/projection?days=${days}&lead=${lead}`),
  stockCsvUrl: (shopId: string, days: number, lead: number, all = false) => `/api/stock/${encodeURIComponent(shopId)}/projection.csv?days=${days}&lead=${lead}${all ? '&all=1' : ''}`,
  stockOverride: (shopId: string, skuId: string, o: { velocity?: number | null; exclude?: boolean; note?: string | null }, days: number) => call<StockProjection>('PUT', `/stock/${encodeURIComponent(shopId)}/skus/${encodeURIComponent(skuId)}?days=${days}`, o),
  // Incidents
  incidents: () => call<IncidentsData>('GET', '/incidents'),
  incidentsScan: () => call<IncidentsData & { opened: number; resolved: number; errors: string[] }>('POST', '/incidents/scan'),
  incidentsSettings: (s: Partial<{ enabled: boolean; post_to_slack: boolean; default_channel: string; cooldown_hours: number }>) => call<IncidentsData>('PUT', '/incidents/settings', s),
  incidentChannel: (accountId: number, slack_channel: string) => call<IncidentsData>('PUT', `/incidents/accounts/${accountId}/channel`, { slack_channel }),
  incidentIngest: (i: { account_id: number | null; kind: string; message: string; severity?: string }) => call<IncidentsData & { opened: number }>('POST', '/incidents/ingest', i),
  resolveIncident: (id: number) => call<IncidentsData>('POST', `/incidents/${id}/resolve`),
  repostIncident: (id: number, slack_channel?: string) => call<IncidentsData>('POST', `/incidents/${id}/repost`, { slack_channel }),
  // Client reports
  reports: () => call<ReportsData>('GET', '/reports'),
  reportPeriod: (period: 'weekly' | 'monthly', end?: string) => call<{ start: string; end: string; prev_start: string; prev_end: string }>('GET', `/reports/period?period=${period}${end ? `&end=${end}` : ''}`),
  generateReport: (b: { account_id: number; period: 'weekly' | 'monthly'; end?: string; instructions?: string; notes?: string }) => call<ReportsData & { report: ClientReport }>('POST', '/reports/generate', b),
  regenerateReport: (id: number, b: { instructions?: string; notes?: string; refresh?: boolean } = {}) => call<ReportsData & { report: ClientReport }>('POST', `/reports/${id}/regenerate`, b),
  updateReport: (id: number, b: { title?: string; body?: string; slack_channel?: string | null }) => call<ReportsData & { report: ClientReport }>('PUT', `/reports/${id}`, b),
  sendReport: (id: number, slack_channel?: string) => call<ReportsData & { report: ClientReport }>('POST', `/reports/${id}/send`, { slack_channel }),
  deleteReport: (id: number) => call<ReportsData>('DELETE', `/reports/${id}`),
  reportAccount: (id: number, b: { client_slack_channel?: string | null; client_domain?: string | null }) => call<ReportsData>('PUT', `/reports/accounts/${id}`, b),
  reportExportUrl: (id: number) => `/api/reports/${id}/export.md`,
  // Cruva playbook
  playbook: () => call<PlaybookData>('GET', '/playbook'),
  playbookCheck: (shop_id?: string) => call<PlaybookData & { shops: number; errors: string[] }>('POST', '/playbook/check', { shop_id }),
  playbookImport: (shopId: string, text: string) => call<PlaybookData & { imported: number }>('POST', `/playbook/shops/${encodeURIComponent(shopId)}/import`, { text }),
  playbookShop: (shopId: string, b: { language?: string }) => call<PlaybookData>('PUT', `/playbook/shops/${encodeURIComponent(shopId)}`, b),
  playbookApply: (b: { shop_ids: string[]; keys: string[]; language?: string | null }) => call<PlaybookData & { created: number; queued: number; blocked: number; errors: string[]; pack: { shop_id: string; shop_name: string; tool: string; payload: Record<string, unknown>; blockers: string[] }[] }>('POST', '/playbook/apply', b),
  playbookCell: (c: { shop_id: string; kind: PlaybookKind; key: string; status: PlaybookSetupCell['status']; note?: string | null }) => call<PlaybookData>('POST', '/playbook/cells', c),
  playbookSettings: (b: { endpoints?: string }) => call<PlaybookData>('PUT', '/playbook/settings', b),
  playbookItemCreate: (b: { kind: PlaybookKind; key: string; language: string; name: string; description?: string; config: string }) => call<PlaybookData>('POST', '/playbook/items', b),
  playbookItemUpdate: (id: number, b: { name?: string; description?: string | null; enabled?: boolean; language?: string; config?: string }) => call<PlaybookData>('PUT', `/playbook/items/${id}`, b),
  playbookItemDelete: (id: number) => call<PlaybookData>('DELETE', `/playbook/items/${id}`),
  // Client question copilot
  copilot: () => call<CopilotData>('GET', '/copilot'),
  copilotIndex: () => call<CopilotData & { added: number; errors: string[] }>('POST', '/copilot/index'),
  copilotPoll: () => call<CopilotData & { found: number; errors: string[] }>('POST', '/copilot/poll'),
  copilotSettings: (s: Partial<{ watch_slack: boolean; watch_email: boolean; notify_am: boolean }>) => call<CopilotData>('PUT', '/copilot/settings', s),
  copilotAsk: (b: { account_id: number | null; question: string; asked_by?: string }) => call<CopilotData & { question: CopilotQuestion }>('POST', '/copilot/questions', b),
  copilotAnswer: (id: number) => call<CopilotData & { question: CopilotQuestion }>('POST', `/copilot/questions/${id}/answer`),
  copilotUpdate: (id: number, b: { answer?: string; status?: CopilotQuestion['status']; account_id?: number | null }) => call<CopilotData & { question: CopilotQuestion }>('PUT', `/copilot/questions/${id}`, b),
  copilotSend: (id: number, answer?: string) => call<CopilotData & { question: CopilotQuestion; mode: 'slack' | 'gmail_draft' | 'none'; url?: string | null }>('POST', `/copilot/questions/${id}/send`, { answer }),
  copilotDelete: (id: number) => call<CopilotData>('DELETE', `/copilot/questions/${id}`),
  deleteProspect: (id: number) => call<BdData>('DELETE', `/bd/prospects/${id}`),
  addContact: (prospectId: number, c: { name: string; title?: string; email?: string; linkedin_url?: string; phone?: string; notes?: string }) => call<BdData & { prospect: BdProspect }>('POST', `/bd/prospects/${prospectId}/contacts`, c),
  deleteContact: (id: number) => call<BdData>('DELETE', `/bd/contacts/${id}`),
  findContacts: (prospectId: number, opts: { domain?: string; reveal?: number } = {}) => call<BdData & { matched: boolean; company: string | null; domain: string | null; found: number; kept: number; revealed: number; prospect: BdProspect }>('POST', `/bd/prospects/${prospectId}/find-contacts`, opts),
  enrichAll: (opts: { reveal?: number; ids?: number[]; mode?: 'new' | 'no_email' | 'all' } = {}) => call<BdData & { candidates: number }>('POST', '/bd/enrich-all', opts),
  apolloTest: () => call<BdData & { healthy: boolean; health_error: string | null }>('POST', '/bd/apollo/test'),
  apolloRefresh: () => call<BdData>('POST', '/bd/apollo/refresh'),
  stopEnrich: () => call<BdData>('POST', '/bd/enrich-all/stop'),
  saveBdSettings: (s: { auto_enrich?: boolean; reveal_per_prospect?: number; keep_per_prospect?: number }) => call<BdData>('PUT', '/bd/settings', s),
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
