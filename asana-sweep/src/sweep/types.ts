// Shared between server and client. Keep this file free of Node-only imports.

// ---- Native AM checklist (items live in this app; ticks are recorded per account and day) ----

export type ChecklistRole = 'am' | 'aa';
export type ChecklistFrequency = 'daily' | 'weekly';

/** One line of the checklist. account_id null = the master template every account uses unless it has its own rows. */
export interface ChecklistItem {
  id: number;
  account_id: number | null;
  parent_id: number | null;
  section: string;
  name: string;
  /** What to look at, shown under the item. */
  guidance: string | null;
  role: ChecklistRole;
  frequency: ChecklistFrequency;
  /** For weekly items: 1 = Monday … 5 = Friday. */
  weekday: number | null;
  position: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type ChecklistItemInput = Pick<ChecklistItem, 'account_id' | 'parent_id' | 'section' | 'name' | 'guidance' | 'role' | 'frequency' | 'weekday' | 'position' | 'enabled'>;

export interface ChecklistTick {
  id: number;
  item_id: number;
  account_id: number;
  tick_date: string;
  done_by: string | null;
  done_at: string;
  note: string | null;
}

// ---- Checklist completion tracking ----

export interface Account {
  id: number;
  name: string;
  markets: string | null;
  am_name: string | null;
  aa_name: string | null;
  enabled: boolean;
  notes: string | null;
  /** Agency commission on the base amount, in percent. Null = no deal recorded. */
  commission_pct: number | null;
  /** What the commission is calculated on: actual GMV, or the net settlement amount (Merchant of Record). */
  commission_basis: 'gmv' | 'mor';
  /** For MoR accounts: estimated net settlement as a percent of GMV, used until the actual figure is entered. */
  settlement_pct: number;
  /** Internal Slack channel for this account (incidents land here); default channel when empty. */
  slack_channel: string | null;
  /** Shared client Slack channel (reports go here, client questions are picked up from here). */
  client_slack_channel: string | null;
  /** Client email domain, used to spot client emails and tl;dv calls with them. */
  client_domain: string | null;
  created_at: string;
  updated_at: string;
}

export type AccountInput = Omit<Account, 'id' | 'created_at' | 'updated_at'>;

export type CheckStatus = 'complete' | 'partial' | 'none' | 'empty' | 'error' | 'unlinked';

export interface CheckItem {
  name: string;
  state: 'done' | 'pending' | 'not_due' | 'stale';
  role: 'am' | 'aa';
  /** The checklist item id as a string (historically the Asana task gid). */
  task_gid: string;
  guidance?: string | null;
  frequency?: ChecklistFrequency;
  section_name: string | null;
  assignee_name: string | null;
  due_on: string | null;
  completed_at: string | null;
  flags: ('no_repeat' | 'no_due_date' | 'overdue')[];
  subtasks: { name: string; task_gid: string; role: 'am' | 'aa'; done: boolean; assignee_name: string | null; completed_at: string | null; frequency?: ChecklistFrequency }[];
}

export interface Check {
  id: number;
  account_id: number;
  check_date: string;
  checked_at: string;
  trigger: 'schedule' | 'manual' | 'live';
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
  /** True for the locked deadline snapshot (the official record for the day). */
  final: boolean;
}

export interface CheckWithItems extends Check {
  items: CheckItem[];
}

export interface AccountStatusRow {
  account: Account;
  /** The recorded check for the date (locked at the deadline). */
  check: Check | null;
  /** Latest live evaluation (re-done on every tick), today only. */
  live: Check | null;
  /** Whether the account uses the master template or its own item list. */
  checklist_source: 'template' | 'custom' | 'none';
  checklist_items: number;
}

export interface CheckSettings {
  check_cron: string;
  check_timezone: string;
  check_enabled: boolean;
  check_slack_webhook: string;
  /** Where each checklist section opens, per country: the saved templates and the defaults they override. */
  section_urls: Record<string, string>;
  section_url_defaults: Record<string, string>;
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
  /** Cruva shop id, or the Windsor.ai account id (e.g. DEESLCN8QWCV) for shops read through Windsor. */
  shop_id: string;
  shop_name: string;
  currency: string;
  source: 'cruva' | 'windsor';
}

export interface WindsorShopInfo { account_id: string; account_name: string; shop_id: string; shop_name: string; shop_region: string; shop_seller_type: string; market: string; account_id_linked?: number | null; account_name_linked?: string | null }

export interface WindsorStatus {
  configured: boolean;
  last_sync_at: string | null;
  last_error: string | null;
  discovered: WindsorShopInfo[];
  shops: AccountShop[];
}

export interface GmvShopRow {
  shop: AccountShop;
  /** In the shop's market currency. */
  gmv: number;
  affiliate_gmv: number;
  units: number;
  /** Converted to the report currency. */
  gmv_report: number;
  prev_gmv: number;
  last_synced: string | null;
}

export type BonusStatus = 'eligible' | 'on_track' | 'behind' | 'no_base' | 'no_data';

export interface GmvAccountRow {
  account: Account;
  shops: GmvShopRow[];
  /** All figures below are in the report currency. */
  gmv: number;
  affiliate_gmv: number;
  units: number;
  prev_gmv: number | null;
  required_growth_pct: number | null;
  target: number | null;
  target_source: 'rule' | 'manual' | null;
  attainment: number | null;
  projected: number | null;
  projected_attainment: number | null;
  growth_pct: number | null;
  /** GMV over the same number of elapsed days last month, and the month-to-date change against it. */
  prev_same_days: number | null;
  pace_pct: number | null;
  bonus: BonusStatus;
  daily: { date: string; gmv: number }[];
  /** Commission deal for the month, in the report currency. */
  commission_basis: 'gmv' | 'mor';
  commission_pct: number | null;
  settlement_pct: number;
  /** Actual net settlement entered for this month (MoR accounts), or null. */
  net_settlement: number | null;
  /** The amount the commission is calculated on. */
  base_amount: number | null;
  base_source: 'gmv' | 'settlement_actual' | 'settlement_estimate' | null;
  agency_billing: number | null;
  am_share: number | null;
}

export interface GmvAmRow {
  am_name: string;
  accounts: number;
  gmv: number;
  prev_gmv: number | null;
  target: number | null;
  attainment: number | null;
  projected: number | null;
  projected_attainment: number | null;
  growth_pct: number | null;
  eligible: number;
  on_track: number;
  agency_billing: number | null;
  am_share: number | null;
}

export interface GmvSettings {
  report_currency: string;
  fx_to_eur: Record<string, number>;
  bonus_threshold: number;
  bonus_growth_below: number;
  bonus_growth_above: number;
  /** AM entitlement as a percent of agency billing. */
  am_share_pct: number;
}

export interface GmvData {
  month: string;
  prev_month: string;
  from: string;
  /** Last day included: yesterday while the month is running (today is excluded as incomplete). */
  to: string;
  month_closed: boolean;
  days_in_month: number;
  days_elapsed: number;
  currency: string;
  settings: GmvSettings;
  accounts: GmvAccountRow[];
  ams: GmvAmRow[];
  totals: {
    gmv: number;
    prev_gmv: number | null;
    target: number | null;
    attainment: number | null;
    projected: number | null;
    growth_pct: number | null;
    eligible: number;
    on_track: number;
    agency_billing: number | null;
    am_share: number | null;
  };
  last_sync: GmvSync | null;
  cruva_configured: boolean;
  windsor_configured: boolean;
}

export interface GmvExploreRow {
  account_id: number | null;
  account_name: string;
  shops: { shop_id: string; shop_name: string; source: 'cruva' | 'windsor'; gmv: number; prev_gmv: number; units: number }[];
  gmv: number;
  affiliate_gmv: number;
  units: number;
  prev_gmv: number;
  change_pct: number | null;
  daily: { date: string; gmv: number }[];
}

export interface GmvExplore {
  from: string;
  to: string;
  prev_from: string;
  prev_to: string;
  days: number;
  currency: string;
  rows: GmvExploreRow[];
  totals: { gmv: number; prev_gmv: number; change_pct: number | null; units: number; daily: { date: string; gmv: number; prev_gmv: number }[] };
  last_synced: string | null;
}

export interface GmvSync {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'ok' | 'error';
  shops_synced: number;
  error_message: string | null;
}

// ---- TikTok Shop, promotions, GMV Max ----

export interface TtsShopRow {
  id: string;
  name: string;
  region: string;
  seller_type: string;
  cipher: string;
  account_id: number | null;
  market: string | null;
  seller_name: string | null;
  access_expires_at: number;
  refresh_expires_at: number;
  authorized_at: string;
  token_ok: boolean;
  /** The affiliate app (separate Partner Center app): when this shop authorised it, and whether that token still works. */
  affiliate_authorized_at: string | null;
  affiliate_token_ok: boolean;
}

export interface TtsAppStatus { configured: boolean; service_id: string; authorize_url: string | null; callback_url: string }

export interface TtsStatus {
  configured: boolean;
  service_id: string;
  authorize_url: string | null;
  callback_url: string;
  shops: TtsShopRow[];
  /** The affiliate app, granted separately in Partner Center. */
  affiliate: TtsAppStatus;
}

export type ActivityType = 'DIRECT_DISCOUNT' | 'FIXED_PRICE' | 'FLASHSALE' | 'SHIPPING_DISCOUNT';
export type ProductLevel = 'SHOP' | 'PRODUCT' | 'VARIATION';
export type TargetStatus = 'planned' | 'pushed' | 'live' | 'ended' | 'deactivated' | 'error' | 'unlinked';

export interface PromotionTarget {
  id: number;
  promotion_id: number;
  account_id: number;
  account_name: string;
  market: string;
  tts_shop_id: string | null;
  tts_shop_name: string | null;
  status: TargetStatus;
  tts_activity_id: string | null;
  tts_status: string | null;
  error_message: string | null;
  pushed_at: string | null;
  /** Who last pushed or deactivated this target (audit trail). */
  actor: string | null;
}

export interface Promotion {
  id: number;
  name: string;
  activity_type: ActivityType;
  product_level: ProductLevel;
  discount_type: 'PERCENTAGE_OFF' | 'AMOUNT_OFF' | 'FIXED_PRICE';
  discount_value: number | null;
  begin_at: string;
  end_at: string;
  participation: 'BUYER_NO_LIMIT' | 'BUYER_LIMIT_ONLY_ONE';
  /** Product ids per TikTok shop id, for PRODUCT / VARIATION level. */
  products: Record<string, string[]>;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  targets: PromotionTarget[];
}

export interface PromotionInput {
  name: string;
  activity_type: ActivityType;
  product_level: ProductLevel;
  discount_type: Promotion['discount_type'];
  discount_value: number | null;
  begin_at: string;
  end_at: string;
  participation: Promotion['participation'];
  products: Record<string, string[]>;
  notes: string | null;
  targets: { account_id: number; market: string }[];
}

export interface GmvMaxRow {
  id: number;
  account_id: number;
  account_name: string;
  am_name: string | null;
  market: string;
  campaign_type: 'PRODUCT' | 'LIVE';
  campaign_name: string | null;
  daily_budget: number | null;
  budget_currency: string;
  bid_strategy: 'MAX_GMV' | 'TARGET_ROI';
  target_roi: number | null;
  status: 'planned' | 'active' | 'paused';
  product_scope: string;
  notes: string | null;
  tts_campaign_id: string | null;
  last_pushed_at: string | null;
  updated_at: string;
}

export interface GmvMaxPatch {
  campaign_name?: string | null;
  daily_budget?: number | null;
  bid_strategy?: 'MAX_GMV' | 'TARGET_ROI';
  target_roi?: number | null;
  status?: 'planned' | 'active' | 'paused';
  product_scope?: string;
  notes?: string | null;
}

// ---- Grading ----

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

// ---- Leads (synced from the lead sheet) ----

export interface Lead {
  id: number;
  name: string;
  poc: string | null;
  stage: string | null;
  country: string | null;
  last_contact: string | null;
  notes: string | null;
  est_value: number | null;
  priority: string | null;
  row_no: number | null;
  added_on: string | null; // date it was added to the lead list (YYYY-MM-DD)
  sourced_by_id: number | null;
  sourced_by_name: string | null;
  onboarding_id: number | null;
  onboarding_name: string | null;
  signed: boolean;
  signed_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  removed_at: string | null;
  updated_at: string;
}

export interface LeadAmRow {
  person_id: number;
  name: string;
  role: 'am' | 'aa';
  onboarding_total: number;
  onboarding_signed: number;
  sourced_total: number;
  sourced_signed: number;
  points: number;
  signed_value: number;
  pipeline_value: number;
}

export interface LeadsSettings {
  sheet_id: string;
  sheet_tab: string;
  sync_enabled: boolean;
  sync_seconds: number;
  points_signed: number;
  points_sourced: number;
  currency: string;
  csv_url: string; // what the server actually fetches
  csv_url_from_env: boolean;
}

export interface LeadsSyncStatus {
  last_sync_at: string | null;
  status: 'ok' | 'error' | 'never';
  error: string | null;
  rows: number;
  columns: string[];
}

export interface LeadsData {
  leads: Lead[];
  ams: LeadAmRow[];
  people: Person[];
  settings: LeadsSettings;
  sync: LeadsSyncStatus;
  stages: string[];
  countries: string[];
  totals: { leads: number; signed: number; open: number; pipeline_value: number; signed_value: number; close_rate: number | null };
  /** Sofía's CRM records tied to each lead (by id). */
  crm: Record<number, CrmLink[]>;
}

// ---- BD pipeline (fast-rising TikTok shops, decision makers, outreach) ----

export type BdStatus = 'new' | 'researching' | 'contacted' | 'replied' | 'meeting' | 'won' | 'lost';
export type BdChannel = 'tts_am' | 'gmail' | 'linkedin';

export interface BdContact {
  id: number;
  prospect_id: number;
  name: string;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  phone: string | null;
  source: 'apollo' | 'manual';
  apollo_id: string | null;
  enriched: boolean;
  notes: string | null;
  linkedin_status: 'none' | 'requested' | 'connected' | 'messaged';
  linkedin_requested_at: string | null;
  linkedin_connected_at: string | null;
  linkedin_messaged_at: string | null;
  created_at: string;
}

export interface BdOutreachEvent {
  id: number;
  prospect_id: number;
  channel: BdChannel | null;
  action: 'contacted' | 'uncontacted' | 'note' | 'status' | 'replied';
  note: string | null;
  contact_name: string | null;
  actor: string | null;
  created_at: string;
}

export interface BdProspect {
  id: number;
  seller_id: string | null;
  shop_name: string;
  brand: string | null;
  market: string;
  category: string | null;
  gmv_7d: number | null;
  gmv_total: number | null;
  units_7d: number | null;
  units_total: number | null;
  currency: string;
  shop_type: string | null;
  tiktok_handle: string | null;
  rating: number | null;
  products: number | null;
  rise_score: number | null; // share of lifetime GMV made in the last 7 days
  launched_at: string | null; // shop created date (YYYY-MM-DD) when known
  gmv_started_at: string | null; // first day with sales (YYYY-MM-DD) when known
  new_shop_30d: boolean; // launched in the last 30 days
  gmv_started_30d: boolean; // first sales in the last 30 days (known date, or estimated from the 7d share)
  age_estimate_days: number | null; // lifetime / 7d run-rate, when no dates are known
  fastmoss_url: string | null;
  is_client: boolean; // matches an account on the roster
  domain: string | null;
  website: string | null;
  apollo_org_id: string | null;
  company_industry: string | null;
  company_employees: number | null;
  company_linkedin: string | null;
  company_location: string | null;
  company_description: string | null;
  /** Last Apollo enrichment pass (new prospects and no-email prospects are revisited from this). */
  enriched_at: string | null;
  enrich_note: string | null;
  status: BdStatus;
  owner_id: number | null;
  owner_name: string | null;
  notes: string | null;
  /** The TikTok Shop AM we know for sure is on this account (a tts_contacts id), when recorded. */
  tts_am_contact_id: number | null;
  outreach_tts_am: boolean;
  outreach_tts_am_at: string | null;
  outreach_gmail: boolean;
  outreach_gmail_at: string | null;
  outreach_linkedin: boolean;
  outreach_linkedin_at: string | null;
  outreach_complete: boolean;
  source: string;
  pulled_at: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  contacts: BdContact[];
  /** Newest first. The pipeline list carries only the latest few; `outreach_count` is the full number. */
  outreach_log: BdOutreachEvent[];
  outreach_count: number;
}

export type BdDraftStatus = 'draft' | 'gmail' | 'queued' | 'sent' | 'discarded';

/** A cold email drafted for one decision maker, reviewed in the inbox, then handed to Gmail. */
export interface BdEmailDraft {
  id: number;
  prospect_id: number;
  contact_id: number | null;
  shop_name: string;
  market: string;
  /** Segment fields from the prospect, so the list can be filtered and queued by country, momentum or category. */
  brand: string | null;
  category: string | null;
  gmv_7d: number | null;
  currency: string;
  rise_band: 'surging' | 'rising' | 'steady' | 'unknown';
  prospect_status: BdStatus;
  to_name: string;
  to_email: string;
  subject: string;
  body: string;
  language: string;
  style: 'short' | 'intro';
  status: BdDraftStatus;
  generator: 'claude' | 'template';
  kind: 'cold' | 'followup';
  meeting_id: string | null;
  meeting_title: string | null;
  gmail_draft_id: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  gmail_url: string | null;
  /** Send queue: when and by whom it was queued, which Gmail account sends it ('' = shared), when it went, last failure. */
  queued_at: string | null;
  queued_by: string | null;
  send_account: string | null;
  sent_at: string | null;
  send_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Live state of the outreach send queue. */
export interface SendQueueState {
  queued: number;
  sent_today: number;
  last_sent_at: string | null;
  /** When the next queued draft can go out, null when nothing is queued, paused, outside the window or the cap is reached. */
  next_at: string | null;
  in_window: boolean;
  sending: boolean;
  last_error: string | null;
  settings: { daily_cap: number; gap_seconds: number; hours: string; hours_enabled: boolean; weekdays_only: boolean; paused: boolean; timezone: string };
}

/** One of Isaac's earlier outreach emails, used as a voice sample when drafting. */
export interface OutreachExample {
  id: number;
  subject: string;
  body: string;
  kind: 'cold' | 'intro' | 'reply' | 'followup';
  to_domain: string | null;
  sent_at: string | null;
  source: 'seed' | 'gmail' | 'manual';
  gmail_id: string | null;
  enabled: boolean;
}

export interface OutreachSettings {
  gmail_configured: boolean;
  gmail_connected: boolean;
  gmail_email: string | null;
  /** Everyone who has connected their own Gmail, plus the shared account (person ''). */
  gmail_accounts: GmailAccountInfo[];
  llm_configured: boolean;
  sender_name: string;
  sender_title: string;
  booking_url: string;
  pitch: string;
  sent_query: string;
  last_pull_at: string | null;
  last_pull_error: string | null;
  watchlist_sheet_tab: string;
  linkedin_check_days: number;
}

export interface OutreachData {
  send_queue: SendQueueState;
  lark_messages: LarkMessage[];
  lark_job: LarkDraftStatus;
  /** The last bulk draft run, so the queue card can say what it produced. */
  bulk_draft: BulkDraftStatus;
  drafts: BdEmailDraft[];
  examples: OutreachExample[];
  settings: OutreachSettings;
  followups: BdFollowup[];
  alerts: BdAlert[];
  watchlist: WatchlistEntry[];
  tts_contacts: TtsContact[];
  activity: BdActivity;
  people: Person[];
  tldv: { configured: boolean; last_check_at: string | null; last_error: string | null; auto_draft: boolean };
}

/** A reminder in the BD sequence: check whether a LinkedIn request was accepted, send the follow-up message, chase an email. */
export interface BdFollowup {
  id: number;
  prospect_id: number;
  contact_id: number | null;
  shop_name: string;
  contact_name: string | null;
  linkedin_url: string | null;
  kind: 'linkedin_check' | 'linkedin_message' | 'email_chase' | 'custom';
  title: string;
  due_at: string;
  done_at: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  overdue: boolean;
}

/** Who at TikTok Shop to loop in for a prospect (per market, optionally per category). */
/** A Lark DM to someone at TikTok Shop about one prospect: who, why them, what it says, the facts it used. */
export type LarkStatus = 'draft' | 'scheduled' | 'sent' | 'discarded';

export interface LarkMessage {
  id: number;
  prospect_id: number;
  shop_name: string;
  brand: string | null;
  market: string;
  contact_id: number | null;
  contact_name: string | null;
  contact_role: string | null;
  contact_lark: string | null;
  /** known = the AM recorded on the prospect; tsp = the market's TSP manager (we are not sure who the AM is). */
  confidence: 'known' | 'tsp';
  reason: string | null;
  body: string;
  /** The verifiable facts the message was written from, for the sender to check. */
  facts: string[];
  generator: 'claude' | 'template';
  status: LarkStatus;
  /** The day it should be sent (YYYY-MM-DD) once scheduled. */
  scheduled_for: string | null;
  sent_at: string | null;
  sent_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LarkDraftStatus {
  running: boolean;
  total: number;
  done: number;
  drafted: number;
  skipped: number;
  current: string | null;
  errors: string[];
  started_at: string | null;
  finished_at: string | null;
}

export interface TtsContact {
  id: number;
  market: string;
  category: string | null;
  name: string;
  role: string | null;
  lark: string | null;
  email: string | null;
  notes: string | null;
  is_agency_manager: boolean;
}

export interface WatchlistEntry {
  id: number;
  name: string;
  source: 'seed' | 'sheet' | 'manual';
  enabled: boolean;
}

export interface BdAlert {
  id: number;
  prospect_id: number;
  shop_name: string;
  market: string;
  kind: 'enterprise_launch';
  watch_name: string | null;
  message: string;
  created_at: string;
  dismissed_at: string | null;
  launched_at: string | null;
  gmv_7d: number | null;
  currency: string;
}

/** Per-person BD activity for the tracker. */
export interface BdActivityRow {
  actor: string;
  contacted: number;
  tts_am: number;
  gmail: number;
  linkedin: number;
  notes: number;
  drafts: number;
  emails_sent: number;
  linkedin_requests: number;
  linkedin_connected: number;
  replies: number;
  meetings: number;
  prospects_touched: number;
  last_active_at: string | null;
}

export interface BdActivity {
  days: number;
  rows: BdActivityRow[];
  weekly: { week: string; contacted: number; emails_sent: number; linkedin_requests: number; replies: number }[];
  totals: { contacted: number; emails_sent: number; linkedin_requests: number; replies: number; meetings: number };
}

export interface MonitorFlag {
  id: number;
  account_id: number | null;
  account_name: string | null;
  shop_id: string | null;
  code: string;
  severity: 'crit' | 'warn' | 'info';
  message: string;
  detail: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
}

export type MonitorSource = 'tts' | 'dashboard' | 'cruva' | 'checklist' | 'windsor' | 'ai' | 'targets';

/** TikTok Shop OpenAPI scopes the app can hold; each rule names the one it needs so the UI can say what is missing. */
export type TtsScope = 'analytics' | 'order' | 'product' | 'return_refund' | 'affiliate_seller' | 'customer_service' | 'finance' | 'promotion' | 'seller' | 'none';
export type TtsScopeState = 'ok' | 'denied' | 'error' | 'unknown' | 'unavailable';
export interface TtsScopeStatus { scope: TtsScope; state: TtsScopeState; message: string | null; checked_at: string | null; shops_ok: number; shops_total: number }

export interface MonitorRule {
  code: string;
  title: string;
  description: string;
  severity: 'crit' | 'warn' | 'info';
  source: MonitorSource;
  /** Checklist section the flag belongs to (shown against the AM's daily lines). */
  section?: string | null;
  /** The TikTok Shop API scope the rule reads from ('none' for rules on the dashboard's own data). */
  scope?: TtsScope;
  enabled: boolean;
}

export interface MonitorData {
  flags: MonitorFlag[];
  rules: MonitorRule[];
  health: HealthSummary;
  accounts: MonitorAccountRow[];
  scopes: TtsScopeStatus[];
  /** Every account's targets, for the Targets tab. */
  targets: AccountTarget[];
  last_scan_at: string | null;
  last_scan_error: string | null;
  scanning: boolean;
  interval_minutes: number;
  tts_configured: boolean;
  /** Authorised TikTok shops, so the overview can say which accounts are connected. */
  tts_shops: number;
  /** The affiliate app (separate key and secret) and how many linked shops have authorised it. */
  tts_affiliate_configured: boolean;
  tts_affiliate_shops: number;
}

/** One line per account on the monitor's Accounts tab. */
export interface MonitorAccountRow {
  id: number;
  name: string;
  markets: string | null;
  am_name: string | null;
  open: number;
  crit: number;
  warn: number;
  info: number;
  risk: HealthRisk | null;
  /** Authorised TikTok shops linked to this account. */
  shops: number;
  /** Cruva shops linked to this account (fill in where the TikTok app is not connected). */
  cruva_shops: number;
  /** Where the numbers come from: the TikTok app, Cruva, or nothing connected. */
  source: 'tts' | 'cruva' | 'none';
  /** TikTok scopes that are not live for this account, so the related checks cannot run (orders, returns, products, customer service…). */
  missing_scopes: string[];
  gmv_7d: number | null;
  gmv_prev_7d: number | null;
  currency: string;
  /** Progress against the targets on file, when there is one (1 = on target). */
  gmv_pace: number | null;
  samples_pace: number | null;
  roi_pace: number | null;
  last_pull_at: string | null;
}

/** Per-account targets (settings the rules compare against), per market or for every market (market ''). */
export type TargetKey = 'samples_per_week' | 'samples_min_per_week' | 'gmv_target_month' | 'gmv_max_weekly_spend' | 'gmv_max_min_roi' | 'gmv_max_gmv_target_week' | 'gmv_max_spend_actual_week' | 'gmv_max_gmv_actual_week' | 'promo_max_discount_pct' | 'campaign_full_participation' | 'campaign_max_discount_pct';
export interface AccountTarget { account_id: number; market: string; key: TargetKey; value: number; updated_at: string; updated_by: string | null }

/** The agreed price list per SKU for an account (list, floor and promo price), used by the promotion rules. */
export interface AccountSkuPrice {
  id: number;
  account_id: number;
  market: string;
  tts_shop_id: string | null;
  product_id: string | null;
  sku_id: string | null;
  seller_sku: string | null;
  name: string;
  list_price: number | null;
  floor_price: number | null;
  promo_price: number | null;
  /** The price the shop currently shows, from the last product pull (null until pulled). */
  current_price: number | null;
  currency: string;
  updated_at: string;
}

/** A platform campaign the account takes part in (typed in; TikTok has no API for campaign enrolment). */
export interface AccountCampaign {
  id: number;
  account_id: number;
  market: string;
  name: string;
  begin_at: string;
  end_at: string;
  participation: 'full' | 'partial' | 'none';
  discount_pct: number | null;
  sku_scope: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** What the monitor shows when one account is opened: numbers against targets, series for the charts, and the checklist walk-through. */
export interface AccountSeriesPoint { date: string; gmv: number; orders: number; visitors: number; conversion: number | null; video_gmv: number; live_gmv: number; card_gmv: number; ads_gmv: number | null; /** Cruva-sourced days carry these instead of orders and visitors. */ affiliate_gmv?: number | null; units?: number | null; videos?: number | null; views?: number | null }

/** Daily analytics for an account over a chosen range, straight from the Analytics API, with the period before it for comparison. */
export interface AccountSeries {
  from: string;
  to: string;
  currency: string;
  /** Where the days came from: the TikTok Analytics API, or Cruva when no shop is authorised. */
  source: 'tts' | 'cruva' | 'none';
  series: AccountSeriesPoint[];
  previous: AccountSeriesPoint[];
  /** Shops that could not be read (token expired, scope missing). */
  errors: string[];
}

export interface AccountOverview {
  account: Account;
  shops: { id: string; name: string; region: string; market: string | null; token_ok: boolean; last_pull_at: string | null; pull_ok: boolean; pull_error: string | null }[];
  /** Cruva shops on the account that fill in where the TikTok app is not connected. */
  cruva_shops: { shop_id: string; shop_name: string; last_pull_at: string | null; pull_ok: boolean; pull_error: string | null }[];
  /** Where the daily series came from. */
  series_source: 'tts' | 'cruva' | 'none';
  currency: string;
  kpis: AccountKpi[];
  series: AccountSeriesPoint[];
  sections: AccountSection[];
  flags: MonitorFlag[];
  resolved_14d: MonitorFlag[];
  targets: AccountTarget[];
  sku_prices: AccountSkuPrice[];
  campaigns: AccountCampaign[];
  assessment: HealthAssessment | null;
  /** The traffic lights: one per area, worst first, with the flags, numbers and checks behind each light. */
  areas: AccountArea[];
  /** The overall light: the worst area. */
  light: AreaLight;
}

export type AreaLight = 'red' | 'amber' | 'green' | 'grey';

export interface AccountArea {
  key: string;
  label: string;
  light: AreaLight;
  /** One line: the worst open flag, "All clear" with the live check count, or why there is no data. */
  summary: string;
  flags: MonitorFlag[];
  /** The area's numbers against their targets. */
  metrics: AccountKpi[];
  checks: { code: string; title: string; scope: TtsScope; available: boolean; enabled: boolean }[];
  missing: string[];
  links: { label: string; to: string }[];
}

export interface AccountKpi {
  key: string;
  label: string;
  value: number | null;
  /** The target it is measured against (null when none is set). */
  target: number | null;
  /** Previous period for the up/down arrow. */
  previous: number | null;
  unit: 'money' | 'count' | 'pct' | 'ratio';
  /** 'good' on or above target, 'warn' within the behind-threshold, 'crit' further behind; null without data. */
  state: 'good' | 'warn' | 'crit' | null;
  /** Why there is no value: the scope that is missing, or where the number lives when the API has none. */
  note: string | null;
  /** Set when the number came from Cruva because the TikTok scope is not live. */
  via?: 'cruva';
  /** 'higher' when more is better, 'lower' when less is better. */
  direction: 'higher' | 'lower';
}

/** One checklist section in the account walk-through: what the scan checks for it, and what it found. */
export interface AccountSection {
  section: string;
  /** Plain-words list of what the AM checks here (from the checklist guidance). */
  guidance: string | null;
  state: 'good' | 'warn' | 'crit' | 'nodata' | 'manual';
  flags: MonitorFlag[];
  /** Rules that cover this section, with whether their data source is live. */
  rules: { code: string; title: string; scope: TtsScope; available: boolean; enabled: boolean }[];
  /** What is missing to automate this section (scopes to approve, or things only Seller Center shows). */
  missing: string[];
}

// ---- Account health (daily Windsor and Cruva pulls, rules with thresholds, AI review) ----

export interface HealthThresholds {
  /** Orders */
  ship_grace_hours: number;
  ship_due_within_hours: number;
  auto_cancel_within_hours: number;
  pickup_late_hours: number;
  delivery_late_days: number;
  cancel_rate_pct: number;
  refund_rate_pct: number;
  order_drop_pct: number;
  aov_shift_pct: number;
  min_orders_for_rates: number;
  /** Products */
  low_stock_units: number;
  drafts_max: number;
  /** Finance */
  payout_missing_days: number;
  reserve_share_pct: number;
  adjustment_share_pct: number;
  unsettled_age_days: number;
  fee_share_pct: number;
  data_stale_hours: number;
  /** Affiliate (samples, from the TikTok Shop Affiliate seller scope) */
  samples_review_hours: number;
  samples_drop_pct: number;
  /** Cruva */
  sps_min: number;
  dms_drop_pct: number;
  dms_silent_days: number;
  affiliate_gmv_drop_pct: number;
  /** Returns and CS */
  return_response_grace_hours: number;
  cs_response_pct_min: number;
  cs_satisfaction_pct_min: number;
  /** Analytics */
  gmv_drop_pct: number;
  visitors_drop_pct: number;
  conversion_drop_pct: number;
  /** Targets */
  target_behind_pct: number;
  gmv_max_overspend_pct: number;
}

export type HealthRisk = 'green' | 'amber' | 'red';

export interface HealthAssessment {
  id: number;
  account_id: number;
  account_name: string | null;
  assess_date: string;
  assessed_at: string;
  source: 'ai' | 'routine' | 'manual';
  risk: HealthRisk;
  summary: string;
  action: string;
  watch: string[];
}

export type HealthSource = 'windsor' | 'cruva' | 'tts';

export interface HealthPullSummary {
  shop_id: string;
  shop_name: string;
  account_id: number | null;
  account_name: string | null;
  source: HealthSource;
  pull_date: string;
  pulled_at: string;
  ok: boolean;
  error: string | null;
  metrics: Record<string, number | string | null>;
}

export interface HealthSummary {
  windsor_configured: boolean;
  llm_configured: boolean;
  ingest_configured: boolean;
  last_pull_at: string | null;
  last_pull_error: string | null;
  last_review_at: string | null;
  last_review_error: string | null;
  last_ingest_at: string | null;
  pulling: boolean;
  reviewing: boolean;
  tts_last_pull_at: string | null;
  tts_last_pull_error: string | null;
  pulling_tts: boolean;
  thresholds: HealthThresholds;
  pulls: HealthPullSummary[];
  assessments: HealthAssessment[];
}

export interface BdCountryRow {
  market: string;
  prospects: number;
  new: number;
  in_progress: number;
  contacted_any: number;
  complete: number;
  won: number;
  lost: number;
  gmv_7d: number;
  currency: string;
}

export interface BdData {
  prospects: BdProspect[];
  countries: BdCountryRow[];
  people: Person[];
  markets: string[];
  categories: string[];
  apollo_configured: boolean;
  gmail_connected: boolean;
  llm_configured: boolean;
  ingest_configured: boolean;
  last_pull_at: string | null;
  totals: { prospects: number; complete: number; won: number; with_contacts: number; new_30d: number; gmv_started_30d: number; found_7d: number; surging_found_7d: number; found_today: number };
  enrich: BdEnrichStatus;
  apollo: ApolloStatus;
  fastmoss: FastmossStatus;
  /** Enrich new prospects with Apollo automatically after every pull or import. */
  auto_enrich: boolean;
  bulk_draft: BulkDraftStatus;
  /** Cold email state per prospect id: draft (in the dashboard), gmail (saved to Gmail drafts), sent. */
  draft_state: Record<number, 'draft' | 'gmail' | 'sent'>;
  /** Lark message state per prospect id. */
  lark_state: Record<number, LarkStatus>;
  lark_job: LarkDraftStatus;
  /** The TikTok Shop directory, so a prospect can record which AM is on the account. */
  tts_contacts: TtsContact[];
  /** Sofía's CRM records tied to each prospect (by id): the label, never a source of rows. */
  crm: Record<number, CrmLink[]>;
}

/** Progress of a bulk "draft an email to the best contact of every prospect" run. */
export interface BulkDraftStatus {
  running: boolean;
  total: number;
  done: number;
  drafted: number;
  gmail: number;
  /** Drafts handed to the send queue (auto-send runs). */
  queued: number;
  skipped: number;
  current: string | null;
  errors: string[];
  started_at: string | null;
  finished_at: string | null;
  to_gmail: boolean;
  /** This run queues each draft to be sent from Gmail instead of saving it to Drafts. */
  auto_send: boolean;
}

/** Progress of the background "find decision makers for every prospect" job. */
export interface BdEnrichStatus {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  matched: number;
  contacts: number;
  revealed: number;
  errors: string[];
  started_at: string | null;
  finished_at: string | null;
  /** Which prospects this run visits: new (no contacts), no_email (contacts but nobody with an email), or all. */
  mode: 'new' | 'no_email' | 'all';
  /** Why the run stopped early, if it did. */
  stopped_reason: 'credits' | 'stopped' | null;
}

/** FastMoss OpenAPI connection, last in-process pull, and credit balance when the API exposes it. */
export interface FastmossStatus {
  configured: boolean;
  transport: 'http' | 'cli';
  last_pull_at: string | null;
  last_error: string | null;
  last_test: string | null;
  quota_hit_at: string | null;
  last_pull: { date: string; file: string | null; markets: { market: string; pages: number; fetched: number; kept: number; error: string | null }[]; added: number; updated: number; quota_hit: boolean; new_surging?: number; new_rising?: number; sorts?: string[]; min_gmv_7d?: number } | null;
  credits: { available: number; granted: number; consumed: number; plan: string | null; expires_at: string | null; monthly?: number | null; checked_at?: string } | null;
  markets: string;
  pages: number;
  pull_hour: string;
  /** ICP for the daily pull: which sort orders to sweep and the minimum 7-day GMV to keep a shop. */
  sorts: string;
  min_gmv_7d: number;
  min_rise: number;
}

/** Apollo connection and credit balance, refreshed every few minutes and after every enrichment. */
export interface ApolloStatus {
  configured: boolean;
  ok: boolean;
  error: string | null;
  remaining: number | null;
  limit: number | null;
  used: number | null;
  cycle_end: string | null;
  checked_at: string | null;
  /** Apollo refused a call for lack of credits (or the balance is zero); enrichment pauses until the balance comes back. */
  exhausted: boolean;
  exhausted_at: string | null;
  reveal_per_prospect: number;
  keep_per_prospect: number;
}

export interface BdProspectInput {
  shop_name: string;
  market: string;
  brand?: string | null;
  category?: string | null;
  seller_id?: string | null;
  domain?: string | null;
  website?: string | null;
  tiktok_handle?: string | null;
  gmv_7d?: number | null;
  gmv_total?: number | null;
  units_7d?: number | null;
  units_total?: number | null;
  currency?: string;
  shop_type?: string | null;
  rating?: number | null;
  products?: number | null;
  notes?: string | null;
  source?: string;
  pulled_at?: string | null;
  launched_at?: string | null;
  gmv_started_at?: string | null;
}

export interface BdProspectPatch {
  status?: BdStatus;
  tts_am_contact_id?: number | null;
  owner_id?: number | null;
  notes?: string | null;
  domain?: string | null;
  website?: string | null;
  outreach_tts_am?: boolean;
  outreach_gmail?: boolean;
  outreach_linkedin?: boolean;
  archived?: boolean;
  launched_at?: string | null;
  gmv_started_at?: string | null;
  /** Optional note stored with an outreach tick, e.g. who was contacted and about what. */
  outreach_note?: string | null;
  outreach_contact?: string | null;
  apollo_org_id?: string | null;
  company_industry?: string | null;
  company_employees?: number | null;
  company_linkedin?: string | null;
  company_location?: string | null;
  company_description?: string | null;
  enriched_at?: string | null;
  enrich_note?: string | null;
}

// ---- CS & affiliate inbox, context library, auto-reply ----

export type InboxChannel = 'cs' | 'affiliate';
export type InboxStatus = 'open' | 'replied' | 'auto_replied' | 'closed';

export interface InboxConversation {
  id: number;
  /** The TikTok shop id, or the Cruva shop id when the thread is read through Cruva. */
  tts_shop_id: string;
  /** tts: TikTok affiliate / CS API; cruva: the creator inbox read and answered through Cruva. */
  source: 'tts' | 'cruva';
  shop_name: string;
  account_id: number | null;
  account_name: string | null;
  market: string | null;
  channel: InboxChannel;
  conversation_id: string;
  counterpart_name: string | null;
  counterpart_id: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_text: string | null;
  last_sender: 'them' | 'us' | 'system' | null;
  last_message_id: string | null;
  can_send: boolean;
  status: InboxStatus;
  language: string | null;
  needs_reply: boolean;
  auto_reply_on: boolean;
  synced_at: string;
  updated_at: string;
}

export interface InboxMessage {
  id: number;
  conversation_ref: number;
  message_id: string;
  sender_role: 'them' | 'us' | 'system';
  sender_name: string | null;
  type: string;
  text: string | null;
  created_at: string;
}

export interface InboxReply {
  id: number;
  conversation_ref: number;
  text: string;
  mode: 'draft' | 'manual' | 'auto';
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
  tts_message_id: string | null;
  error_message: string | null;
  in_reply_to: string | null;
}

export interface ContextEntry {
  id: number;
  language: string; // ISO 639-1, or '*' for every language
  scope: 'cs' | 'affiliate' | 'both';
  account_id: number | null;
  account_name: string | null;
  title: string;
  body: string;
  enabled: boolean;
  updated_at: string;
}

export interface CruvaOutreach {
  id: number;
  account_id: number | null;
  creator_handle: string;
  summary: string;
  occurred_at: string | null;
  source: string;
}

export interface AccountReplySettings {
  account_id: number;
  account_name: string;
  markets: string | null;
  auto_reply_cs: boolean;
  auto_reply_affiliate: boolean;
  reply_language: string | null;
  shops: { id: string; name: string; market: string | null; token_ok: boolean }[];
}

export interface InboxSettings {
  auto_reply_master: boolean;
  inbox_enabled: boolean;
  poll_seconds: number;
  max_age_hours: number;
  llm_configured: boolean;
  model: string;
  tts_configured: boolean;
  last_sync_at: string | null;
  last_sync_error: string | null;
  cruva_configured: boolean;
}

export interface InboxData {
  conversations: InboxConversation[];
  accounts: AccountReplySettings[];
  settings: InboxSettings;
  counts: { open: number; needs_reply: number; auto_replied_today: number; cs: number; affiliate: number };
}

export interface ConversationDetail {
  conversation: InboxConversation;
  messages: InboxMessage[];
  replies: InboxReply[];
  context: ReplyContext;
}

export interface ReplyContext {
  language: string;
  account: string | null;
  market: string | null;
  promotions: { name: string; discount: string; period: string; status: string }[];
  products: { id: string; title: string; price?: number | null; currency?: string | null; stock?: number | null; status?: string | null }[];
  history: { when: string; who: string; text: string }[];
  cruva_outreach: { when: string | null; summary: string }[];
  library: { title: string; body: string; language: string; scope: string }[];
  /** Commission terms as the creator would hear them. */
  commission: { pct: number | null; ads_pct: number | null; note: string | null };
  brief_link: string | null;
  /** The creator as Cruva knows them (affiliate channel). */
  creator: { handle: string; followers: number | null; gmv_for_us: number | null; videos: number | null; showcasing: boolean | null; tags: string[]; last_post: string | null } | null;
  samples: { product: string; status: string; requested: string | null; approved: string | null; received: string | null; source: string | null }[];
  outreach_logs: { when: string; campaign: string; channel: string; status: string }[];
  campaigns: { title: string; type: string; status: string; link: string | null; ends: string | null }[];
  /** The buyer's orders and returns (customer service channel). */
  orders: { id: string; status: string; created: string; shipped: string | null; delivered: string | null; ship_by: string | null; carrier: string | null; total: number | null; currency: string | null; items: string[] }[];
  returns: { id: string; order_id: string | null; status: string; type: string | null; refund: number | null; next_action: string | null }[];
  /** Why the context is thinner than it could be (Cruva not linked, no key, pull failed). */
  notes: string[];
}

// ---- Reply audit ----

export type ReplyAuditAction =
  | { kind: 'note'; note_id: number; account_id: number; channel: InboxChannel; language: string; note_key: string; title: string; body: string; replies: number; undone: boolean }
  | { kind: 'rule'; fault: string; rule: string; replies: number; undone: boolean }
  | { kind: 'nudge'; account_id: number; channel: InboxChannel; intent: string; direction: 'to_human' | 'restored'; fail_rate: number; undone: boolean }
  | { kind: 'note_disabled' | 'note_checked'; note_id: number; account_id: number; channel: InboxChannel; note_key: string; why: string; undone: boolean };

export interface ReplyAuditRow { n: number; mean: number | null; fail_rate: number | null; prev_mean: number | null; worst: { item_id: number; counterpart: string | null; total: number; fail: boolean; why: string }[] }
export interface ReplyAuditSummary {
  by_account: (ReplyAuditRow & { account_id: number; account_name: string; channel: InboxChannel })[];
  by_intent: (ReplyAuditRow & { channel: InboxChannel; intent: string; label: string })[];
  by_language: (ReplyAuditRow & { language: string })[];
  by_rubric: { key: string; label: string; mean: number | null; zeros: number }[];
  /** Accounts over 10% fails or under 7 mean. */
  red: string[];
}
export interface ReplyAudit { id: number; started_at: string; finished_at: string | null; since: string; sampled: number; mean: number | null; prev_mean: number | null; fail_rate: number | null; summary: ReplyAuditSummary; actions: ReplyAuditAction[]; slack_posted_at: string | null; error: string | null }
export interface ReplyAuditItem { id: number; audit_id: number; event_id: number; conversation_ref: number; account_id: number | null; channel: InboxChannel; intent: string | null; language: string | null; decision: string; scores: Record<string, number>; total: number; fail: boolean; why: string; unverified_claim: string | null; note_key: string | null; note: string | null; fault: string | null; their_text: string | null; reply_text: string | null; followup_text: string | null; counterpart: string | null; created_at: string }

// ---- Replies per account: policy, events ----

export type ReplyMode = 'off' | 'draft' | 'auto';
/** `waiting`: the message was under 90 seconds old at the pass and is read again on the next one. */
export type ReplyDecision = 'auto_sent' | 'drafted' | 'skipped' | 'escalated' | 'capped' | 'quiet' | 'error' | 'waiting';

export interface ReplyPolicy {
  account_id: number;
  channel: InboxChannel;
  mode: ReplyMode;
  /** Automatic replies a day in the shop's timezone; null = unlimited. */
  daily_cap: number | null;
  /** Answer every message that needs one: the only-filters and the always-a-human list are ignored; the model still hands over when it cannot answer from the facts. */
  answer_all: boolean;
  /** Only reply automatically when every listed condition holds (keys from ONLY_FILTERS). */
  only: string[];
  /** Intents that always wait for a human. */
  never: string[];
  /** Intents allowed to go out automatically (customer service); empty = all non-escalated intents. */
  auto_intents: string[];
  quiet_from: string | null;
  quiet_to: string | null;
  max_age_hours: number;
  /** TikTok shop ids (countries) switched off for this channel; empty = every shop on the account. */
  shops_off: string[];
  /** Reply language per TikTok shop id; unset = detect from the message, then the shop's market. */
  languages: Record<string, string>;
  updated_at: string | null;
}

export interface ReplyEvent {
  id: number;
  conversation_ref: number;
  account_id: number | null;
  channel: InboxChannel;
  message_id: string | null;
  needs_reply: boolean;
  intent: string | null;
  escalation: string | null;
  confidence: number | null;
  language: string | null;
  /** The facts the model leant on, as short chips. */
  context: { chips: string[]; their_text: string | null; reply_text: string | null; counterpart: string | null; their_at?: string | null };
  decision: ReplyDecision;
  reply_id: number | null;
  model: string | null;
  /** What the Claude call behind this decision cost (filled in when the event is listed). */
  cost?: { usd: number; input: number; output: number; model: string } | null;
  /** The audit's verdict on this reply, when it was sampled. */
  audit?: { audit_id: number; total: number; fail: boolean; why: string } | null;
  feedback: 'right' | 'wrong' | null;
  feedback_note: string | null;
  created_at: string;
}

export interface RepliesData {
  account: Account;
  channel: InboxChannel;
  policy: ReplyPolicy;
  master_on: boolean;
  llm_configured: boolean;
  /** Channel readiness: the TikTok scope and shops behind it. */
  channel_ready: boolean;
  channel_note: string | null;
  shops: { id: string; name: string; market: string | null; token_ok: boolean; off: boolean; language: string | null; source: 'tts' | 'cruva' }[];
  counts: { replied_today: number; auto_today: number; manual_today: number; cap: number | null; waiting: number; escalated: number; drafts: number; skipped_today: number; median_minutes: number | null; wrong_7d: number };
  waiting: (InboxConversation & { event: ReplyEvent | null; draft: InboxReply | null })[];
  /** The waiting threads grouped by what stops them; `deferred` groups clear on their own once the cause is lifted. */
  blockers: { reason: string; deferred: boolean; count: number; examples: { id: number; counterpart_name: string | null; last_message_at: string | null }[] }[];
  /** Intents the audit handed to a human on this account (restored when they score well again); honoured even with Answer everything on. */
  audit_nudged: string[];
  log: ReplyEvent[];
  knowledge: { label: string; state: 'ok' | 'warn' | 'missing'; detail: string }[];
  intents: { key: string; label: string; escalates: boolean }[];
  only_filters: { key: string; label: string }[];
  languages: Record<string, string>;
}

/** Cruva pull: the 4-hourly read of every linked shop's stats, score, samples and stock. */
export interface CruvaPullStatus { configured: boolean; running: boolean; last_run_at: string | null; last_error: string | null; shops: number; shops_ok: number; next_run_at: string | null; every_hours: number }

/** Alerts calendar: one cell per day with the traffic light and what sits behind it. */
export type AlertLight = 'crit' | 'warn' | 'good' | 'none';
export interface AlertDayAccount { account_id: number; account_name: string; am_name: string | null; light: AlertLight; incidents: { id: number; kind: string; title: string; severity: IncidentSeverity; message: string; slack_channel: string | null; posted_at: string | null; resolved_at: string | null; opened_today: boolean }[]; flags: { code: string; severity: 'crit' | 'warn' | 'info'; message: string; opened_today: boolean; resolved_at: string | null }[]; checklist: { status: CheckStatus | null; combined_complete: boolean; am_done: number; am_total: number; aa_done: number; aa_total: number } | null }
export interface AlertDay { date: string; light: AlertLight; crit: number; warn: number; info: number; resolved: number; checklist_complete: number; checklist_checked: number; accounts: AlertDayAccount[] }
export interface AlertCalendar { month: string; today: string; days: AlertDay[]; totals: { crit: number; warn: number; info: number; resolved: number; days_red: number; days_amber: number; days_green: number }; channels: { id: number; name: string; slack_channel: string | null }[]; default_channel: string }

export interface SlackChannel { id: string; name: string; is_private: boolean; is_member: boolean; num_members: number | null }

export interface RepliesSummaryRow { account_id: number; account_name: string; am_name: string | null; channel: InboxChannel; mode: ReplyMode; waiting: number; escalated: number; auto_today: number; cap: number | null; ready: boolean; note: string | null; shops: { id: string; name: string; market: string | null; token_ok: boolean; off: boolean; language: string | null; source: 'tts' | 'cruva' }[] }

// ---- FBT paperwork ----

/** How a shop ships into Fulfilled by TikTok: the warehouse and the template it uploads. */
export interface FbtProfile {
  account_id: number;
  market: string;
  warehouse_name: string;
  warehouse_id: string;
  ship_from: string;
  contact: string;
  /** The template's header row, in order, and which field each column takes. */
  columns: { header: string; field: FbtField }[];
  delimiter: ',' | ';';
  updated_at: string | null;
}
export type FbtField = 'goods_id' | 'seller_sku' | 'sku_id' | 'product_id' | 'product_name' | 'sku_name' | 'barcode' | 'units_per_carton' | 'cartons' | 'total_units' | 'carton_length_cm' | 'carton_width_cm' | 'carton_height_cm' | 'carton_weight_kg' | 'pallets' | 'warehouse_id' | 'warehouse_name' | 'expiry' | 'lot' | 'blank';
export interface FbtSkuSpec {
  shop_id: string;
  sku_id: string;
  goods_id: string | null;
  barcode: string | null;
  units_per_carton: number | null;
  carton_length_cm: number | null;
  carton_width_cm: number | null;
  carton_height_cm: number | null;
  carton_weight_kg: number | null;
  cartons_per_pallet: number | null;
  expiry: string | null;
  lot: string | null;
  updated_at: string | null;
}
export interface FbtLine extends FbtSkuSpec {
  product_id: string;
  product_title: string;
  sku_name: string | null;
  seller_sku: string | null;
  on_hand: number;
  velocity: number;
  /** What the projection says to send in for the chosen cover. */
  suggested_units: number;
  /** What the AM asks for (defaults to the suggestion, rounded up to full cartons). */
  units: number;
  cartons: number;
  pallets: number;
  /** Why this line cannot go on the template yet. */
  blockers: string[];
}
export interface FbtPlan { shop_id: string; shop_name: string; market: string | null; account_id: number | null; account_name: string | null; profile: FbtProfile; lines: FbtLine[]; totals: { units: number; cartons: number; pallets: number; weight_kg: number; skus: number; ready: number }; cover_days: number }

// ---- P&L per account ----

export interface PnlInputs {
  /** TikTok platform commission on GMV, percent. */
  platform_fee_pct: number;
  /** Creator (affiliate) commission on affiliate GMV, percent. */
  creator_commission_pct: number;
  /** Agency retainer for the month, in the report currency. */
  agency_fee: number;
  /** Agency commission, percent of the base (account.commission_basis). */
  agency_commission_pct: number;
  /** COGS as a percent of GMV (blended) or per SKU (needs the SKU table). */
  cogs_mode: 'blended' | 'sku';
  cogs_pct: number;
  /** Shipping and fulfilment per order or as a percent of GMV. */
  shipping_pct: number;
  ad_spend: number;
  samples_sent: number;
  sample_unit_cost: number;
  other_costs: number;
  notes: string;
}
export interface PnlSkuCogs { account_id: number; key: string; label: string; cogs: number; currency: string; updated_at: string | null }
export interface PnlLine { key: string; label: string; amount: number; pct_of_gmv: number | null; kind: 'revenue' | 'cost' | 'result'; note?: string | null }
export interface PnlMonth { month: string; actual: boolean; gmv: number; affiliate_gmv: number; units: number; days_with_data: number; inputs: PnlInputs; lines: PnlLine[]; net: number; margin_pct: number | null; agency_billing: number; client_profit: number; cogs_source: 'sku' | 'blended' | 'none' }
export interface PnlForecastInputs { months: number; gmv_growth_pct: number; ad_spend: number; ad_roi: number; samples_per_month: number; sample_gmv_each: number; keep_fees: boolean }
export interface PnlData {
  account: Account;
  currency: string;
  month: string;
  inputs: PnlInputs;
  defaults: PnlInputs;
  sku_cogs: PnlSkuCogs[];
  /** SKUs known for this account (from the stock snapshots), to price COGS per SKU. */
  skus: { key: string; label: string; sold_30d: number; shop_name: string }[];
  history: PnlMonth[];
  current: PnlMonth;
  forecast_inputs: PnlForecastInputs;
  forecast: PnlMonth[];
  light: 'red' | 'amber' | 'green' | 'grey';
}
export interface PnlSummaryRow { account_id: number; account_name: string; am_name: string | null; markets: string | null; currency: string; month: string; gmv: number; net: number; margin_pct: number | null; agency_billing: number; has_inputs: boolean; light: 'red' | 'amber' | 'green' | 'grey' }

// ---- Ad hoc client tasks ----

export interface ClientTask {
  id: number;
  account_id: number;
  account_name: string;
  am_name: string | null;
  /** The short bullet. */
  title: string;
  /** The deeper context: what was said, where, the full notes. */
  detail: string;
  source: 'slack' | 'email' | 'call' | 'manual';
  source_ref: string | null;
  source_url: string | null;
  due_date: string | null;
  /** context: taken from the conversation; am: set or amended by the AM. */
  due_source: 'context' | 'am';
  status: 'open' | 'done' | 'dismissed';
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  completed_by: string | null;
  dismissed_at: string | null;
}
export interface ClientTasksData {
  from: string;
  to: string;
  today: string;
  tasks: ClientTask[];
  accounts: { id: number; name: string; am_name: string | null; markets: string | null; client_slack_channel: string | null; client_domain: string | null }[];
  last_scan_at: string | null;
  last_scan_error: string | null;
  scanning: boolean;
  llm_configured: boolean;
  /** Where the tasks come from and whether each source can deliver; the fix is spelled out per source. */
  sources: ClientTaskSources;
}
export interface ClientTaskSource { ok: boolean; label: string; detail: string; fix: string | null }
export interface ClientTaskSources {
  slack: ClientTaskSource;
  gmail: ClientTaskSource;
  tldv: ClientTaskSource;
  llm: ClientTaskSource;
  index: { last_at: string | null; last_error: string | null; indexing: boolean };
  /** Per account: evidence rows in the last 14 days by kind, and what is missing to get more. */
  accounts: { id: number; name: string; slack: number; email: number; call: number; missing: string[] }[];
  /** Calls indexed in the last 14 days that matched no account (no client domain or name matched). */
  unmatched_calls: { title: string; occurred_at: string | null }[];
}

// ---- Sync status (what scans when) ----

export interface SyncFeed {
  key: string;
  label: string;
  /** What it feeds, in a few words. */
  feeds: string;
  /** "Daily 06:30 CET", "Every 4 hours", … */
  schedule_text: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  running: boolean;
  configured: boolean;
}
export interface SyncStatus { timezone: string; now: string; feeds: SyncFeed[] }


// ---- Onboarding: targets (deals in the pipeline) and onboarding steps ----

export type TargetLight = 'red' | 'amber' | 'green' | 'grey';
export interface TargetSource { kind: string; title: string; occurred_at: string | null; url: string | null; snippet: string }
export interface TargetAnalysis {
  light: TargetLight;
  /** How far along the deal is, 0 to 100. */
  progress_pct: number;
  stage_label: string;
  summary: string;
  next_steps: string[];
  blockers: string[];
  signals: string[];
  sources: TargetSource[];
  generator: 'claude' | 'rules';
  analysed_at: string;
}
export interface TargetRow {
  lead: Lead;
  status: 'open' | 'ready' | 'lost';
  am_person_id: number | null;
  am_name: string | null;
  analysis: TargetAnalysis | null;
  /** First seen in the last two days, or changed since the team last looked. */
  is_new: boolean;
  ready_at: string | null;
  ready_by: string | null;
  lost_at: string | null;
  onboarding_id: number | null;
  /** Closed (signed) or lost in the month shown, for the history view. */
  closed_in_month: 'won' | 'lost' | null;
}
export interface TargetsData {
  month: string;
  today: string;
  rows: TargetRow[];
  people: Person[];
  totals: { open: number; ready: number; won: number; lost: number; pipeline_value: number; won_value: number; new: number };
  last_refresh_at: string | null;
  last_refresh_error: string | null;
  refreshing: boolean;
  llm_configured: boolean;
  currency: string;
}
export interface OnboardingStep {
  key: string;
  group: string;
  title: string;
  help: string | null;
  /** A link to the template or the place to do it, when there is one. */
  link: string | null;
  done_at: string | null;
  done_by: string | null;
  note: string | null;
  custom: boolean;
}
export interface OnboardingTerms {
  retainer: number | null;
  currency: string;
  commission_pct: number | null;
  commission_basis: 'gmv' | 'mor';
  settlement_pct: number;
  term_months: number | null;
  notice_months: number | null;
  start_date: string | null;
  markets: string;
  billing_entity: string;
  notes: string;
}
export interface OnboardingContext {
  summary: string | null;
  sources: TargetSource[];
  poc: string | null;
  country: string | null;
  est_value: number | null;
  analysed_at: string | null;
}
export interface Onboarding {
  id: number;
  lead_id: number | null;
  lead_name: string | null;
  account_id: number | null;
  account_name: string | null;
  name: string;
  markets: string | null;
  am_person_id: number | null;
  am_name: string | null;
  status: 'active' | 'done';
  steps: OnboardingStep[];
  terms: OnboardingTerms;
  context: OnboardingContext;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  done: number;
  total: number;
}
export interface OnboardingsData {
  onboardings: Onboarding[];
  people: Person[];
  accounts: { id: number; name: string }[];
  templates: { key: string; label: string; url: string; kind: string }[];
}


// ---- Pitch designer ----

export interface PitchProduct { name: string; price: number | null; url: string | null; image: string | null }
export interface PitchBrief {
  client: string;
  website: string;
  markets: string[];
  category: string;
  /** What the creators' videos should look like, for the Cruva creator search. */
  creator_query: string;
  products: PitchProduct[];
  pdp_images: string[];
  logo_url: string;
  colours: { primary: string; secondary: string; accent: string };
  options: { pdp_imagery: boolean; livestream: boolean; forecasts: boolean; case_studies: boolean; creators: boolean; market: boolean; amazon: boolean; resellers: boolean };
  pricing: { retainer: number | null; currency: string; commission_pct: number | null; commission_basis: 'gmv' | 'mor'; term_months: number; creator_video_fee: number | null; live_rate: number | null };
  forecast: { start_gmv: number; aov: number; cogs_pct: number; discount_pct: number; growth_pct: number; ad_spend: number; ad_roi: number; samples_per_month: number; sample_gmv_each: number; months: number };
  case_studies: string[];
  notes: string;
  instructions: string;
}
export interface PitchCreator { handle: string; name: string | null; followers: number | null; gmv_30d: number | null; engagement: number | null; categories: string | null; video_url: string | null; source: 'cruva' | 'fastmoss' }
export interface PitchResearch {
  fetched_at: string;
  errors: string[];
  site: { title: string | null; description: string | null; theme_colour: string | null; images: string[]; platform?: 'shopify' | 'other'; colours?: string[]; logo?: string | null; currency?: string | null; product_count?: number } | null;
  /** The brand's products: from the brief's PDP list, else found by the scan (Shopify JSON or JSON-LD), best sellers first. */
  products: { name: string; price: number | null; image: string | null; url: string; rank?: number | null; images?: string[]; currency?: string | null }[];
  /** Product images (and the logo) downloaded into the pitch's folder: source url → file name. */
  assets?: Record<string, string>;
  context: TargetSource[];
  tiktok: { brand: { name: string; gmv: number | null; creators: number | null; videos: number | null; region: string } | null; shops: { shop_name: string; region: string; gmv_7d: number | null; total_gmv: number | null; seller_id: string | null }[]; top_products: { name: string; region: string; gmv: number | null; units: number | null; price: number | null; shop: string | null }[]; /** The brand's own products on TikTok Shop by 28-day GMV (FastMoss shop products by seller id, else a product search on the name). */
  brand_products: { name: string; region: string; gmv_28d: number | null; units_28d: number | null; price: number | null; image: string | null }[];
  market: { market: string; prospects: number; surging: number; leaders: string[] }[] };
  creators: PitchCreator[];
  amazon: { reachable: boolean; items: { title: string; price: string | null; url: string }[] };
  resellers: { name: string; region: string; gmv_7d: number | null; note: string | null }[];
}
export interface PitchStat { label: string; value: string; note: string | null }
export interface PitchSlide {
  key: string;
  kind: 'cover' | 'agenda' | 'about' | 'why_us' | 'portfolio' | 'clients' | 'awards' | 'divider' | 'market' | 'presence' | 'products' | 'opportunity' | 'forecast' | 'creators' | 'cruva' | 'outreach' | 'framework' | 'profitability' | 'content' | 'shoppable' | 'livestream' | 'studio' | 'case_studies' | 'case_study' | 'deliverables' | 'mor' | 'team' | 'pricing' | 'roadmap' | 'next' | 'closing' | 'custom';
  enabled: boolean;
  title: string;
  subtitle: string | null;
  bullets: string[];
  stats: PitchStat[];
  images: string[];
  /** Free text under the bullets (one paragraph). */
  body: string | null;
  notes: string | null;
  /** Three-panel layouts (framework, outreach, deliverables): a heading and its lines per panel. */
  panels?: { heading: string; items: string[] }[];
  /** A bar chart (case studies, the forecast): one value per label, drawn in accent ink. */
  chart?: { label: string; labels: string[]; values: number[] };
}
/** The six brand-layer tokens of the Brightform Design System for this client, derived from their colours. */
export interface PitchTheme { panel1: string; panel2: string; accent: string; accent_ink: string; data: string; data_ink: string; contrast_accent: number; contrast_data: number; neutral: boolean }
export interface PitchDeck { palette: { primary: string; secondary: string; accent: string; ink: string; paper: string }; theme?: PitchTheme; slides: PitchSlide[]; generator: 'claude' | 'template'; built_at: string }
/** Progress of a "build the pitch" run: research, the deck copy, the PDF. */
export interface PitchJobStatus { running: boolean; step: 'research' | 'build' | 'pdf' | null; started_at: string | null; finished_at: string | null; error: string | null }
export interface Pitch {
  id: number;
  lead_id: number | null;
  lead_name: string | null;
  /** The BD prospect this pitch was started from, when it was. */
  prospect_id: number | null;
  prospect_name: string | null;
  job?: PitchJobStatus | null;
  /** A PDF rendered for the current deck exists on the server. */
  pdf_available?: boolean;
  pdf_possible?: boolean;
  name: string;
  client: string;
  brief: PitchBrief;
  research: PitchResearch | null;
  deck: PitchDeck | null;
  status: 'draft' | 'ready';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface PitchesData {
  pitches: Pitch[];
  leads: { id: number; name: string; country: string | null; poc: string | null }[];
  accounts: { id: number; name: string; markets: string | null }[];
  fastmoss_configured: boolean;
  cruva_configured: boolean;
  llm_configured: boolean;
  /** Chromium is available on the server, so decks render to PDF. */
  pdf_configured: boolean;
  gmail_connected: boolean;
  slack_configured: boolean;
}

// ---- Stock ----

export interface StockSku {
  shop_id: string;
  account_id: number | null;
  /** tts: TikTok Shop API snapshot; cruva: read through Cruva for shops the TikTok app cannot read. */
  source: 'tts' | 'cruva';
  product_id: string;
  product_title: string;
  sku_id: string;
  sku_name: string | null;
  seller_sku: string | null;
  product_status: string | null;
  on_hand: number;
  sold_7d: number;
  sold_30d: number;
  captured_at: string;
  /** Manual units-per-day override, when the AM knows better than the last 30 days. */
  velocity_override: number | null;
  exclude: boolean;
  note: string | null;
}

/** A SKU with the derived countdown and what to send in to cover the chosen number of days. */
export interface StockProjectionRow extends StockSku {
  velocity: number;
  days_left: number | null;
  stockout_at: string | null;
  /** Units needed to cover cover_days (plus lead time) minus what is on hand. */
  send_in: number;
  level: 'out' | 'crit' | 'warn' | 'ok' | 'idle';
}

export interface StockProjection {
  shop_id: string;
  shop_name: string;
  account_id: number | null;
  account_name: string | null;
  cover_days: number;
  lead_days: number;
  captured_at: string | null;
  rows: StockProjectionRow[];
  totals: { skus: number; send_in_units: number; send_in_skus: number; out: number; crit: number; warn: number };
}

export interface StockData {
  shops: { shop_id: string; shop_name: string; account_id: number | null; account_name: string | null; market: string | null; token_ok: boolean; source: 'tts' | 'cruva'; skus: number; captured_at: string | null; out: number; crit: number; warn: number; next_stockout_days: number | null }[];
  alerts: (StockProjectionRow & { shop_name: string; account_name: string | null })[];
  settings: { crit_days: number; warn_days: number; default_cover_days: number; default_lead_days: number };
  last_scan_at: string | null;
  last_scan_error: string | null;
  scanning: boolean;
  tts_configured: boolean;
  cruva_configured: boolean;
}

// ---- Website enquiries (brightform.agency contact form) ----

export type InquiryStatus = 'new' | 'replied' | 'qualified' | 'closed';
/** "contact" is the message form, "call" the book-a-call request (the site's calendar link was replaced by a form). */
export type InquiryKind = 'contact' | 'call';

export interface SiteInquiry {
  id: number;
  kind: InquiryKind;
  name: string;
  email: string;
  brand: string | null;
  message: string;
  phone: string | null;
  /** Free text from the call form, e.g. "morning: Mornings (9–12 CET)". */
  preferred_time: string | null;
  language: string | null;
  page: string | null;
  /** Google Ads click id the visitor arrived with (from the site), so qualified leads can be imported as offline conversions. */
  gclid: string | null;
  status: InquiryStatus;
  assigned_to: string | null;
  note: string | null;
  slack_ts: string | null;
  replied_at: string | null;
  /** When the enquiry was emailed to the team's inbox (null when Gmail was not connected or the send failed). */
  forwarded_at: string | null;
  created_at: string;
}

/** A line in an enquiry's history. */
export type InquiryEventKind = 'created' | 'forwarded' | 'assigned' | 'status' | 'note' | 'draft' | 'slack' | 'airtable';

export interface InquiryEvent {
  id: number;
  inquiry_id: number;
  at: string;
  kind: InquiryEventKind;
  actor: string | null;
  detail: string | null;
  url: string | null;
}

/** An email to or from the enquirer found in the connected Gmail account. */
export interface InquiryMail {
  id: string;
  direction: 'sent' | 'received';
  from: string | null;
  to: string | null;
  subject: string;
  snippet: string;
  date: string | null;
  url: string;
}

export interface InquiryHistory {
  inquiry: SiteInquiry;
  events: InquiryEvent[];
  mail: InquiryMail[];
  /** Which Gmail account the mail was searched in, null when none is connected. */
  mail_account: string | null;
  mail_error: string | null;
}

export interface GmailAccountInfo { person: string; email: string; connected_at: string | null }

export interface InquiriesData {
  inquiries: SiteInquiry[];
  people: Person[];
  /** Connected Gmail accounts: the shared one (person '') and each person's own. */
  gmail_accounts: GmailAccountInfo[];
  slack_channel: string;
  slack_configured: boolean;
  gmail_connected: boolean;
  gmail_email: string | null;
  /** Where every enquiry is forwarded by email; empty switches the forward off. */
  forward_to: string;
  origins: string[];
}

// ---- Incidents (instant issue alerts to Slack) ----

export type IncidentSeverity = 'crit' | 'warn' | 'info';

export interface Incident {
  id: number;
  account_id: number | null;
  account_name: string | null;
  shop_id: string | null;
  kind: string;
  severity: IncidentSeverity;
  title: string;
  message: string;
  recommended_action: string;
  owner: string | null;
  owner_slack_id: string | null;
  source: string;
  dedupe_key: string;
  slack_channel: string | null;
  slack_ts: string | null;
  posted_at: string | null;
  post_error: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface IncidentKind {
  kind: string;
  title: string;
  severity: IncidentSeverity;
  description: string;
  action: string;
  source: string;
}

export interface IncidentsData {
  incidents: Incident[];
  kinds: IncidentKind[];
  accounts: { id: number; name: string; am_name: string | null; slack_channel: string | null; open: number }[];
  settings: { enabled: boolean; post_to_slack: boolean; default_channel: string; cooldown_hours: number };
  slack_configured: boolean;
  llm_configured: boolean;
  last_scan_at: string | null;
}

// ---- Client reports ----

export interface ClientReport {
  id: number;
  account_id: number;
  account_name: string;
  period: 'weekly' | 'monthly';
  period_start: string;
  period_end: string;
  title: string;
  body: string;
  data: ReportData;
  generator: 'claude' | 'template';
  /** draft: in the queue to review; approved: ready to send now or at send_at; sent. */
  status: 'draft' | 'approved' | 'sent';
  /** standard: the usual report; cruva: the Cruva performance report (creators, videos, samples, DMs, score). */
  kind: 'standard' | 'cruva';
  /** The Slack message the AM edits (defaults to the report in Slack syntax). */
  slack_draft: string | null;
  approved_at: string | null;
  approved_by: string | null;
  /** When an approved report goes out by itself (autosend); null = send by hand. */
  send_at: string | null;
  slack_channel: string | null;
  sent_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface ReportContext {
  /** Client Slack channel messages in the period (one entry per day). */
  slack: { date: string; text: string }[];
  /** Emails with the client in the period. */
  emails: { date: string | null; subject: string; snippet: string; url: string | null }[];
}
export interface ReportCruva {
  shops: { shop_id: string; shop_name: string; market: string | null; gmv: number; affiliate_gmv: number; units: number; videos_posted: number; video_views: number; samples_approved: number; samples_shipped: number; dms_sent: number; sps: number | null }[];
  totals: { gmv: number; affiliate_gmv: number; units: number; videos_posted: number; video_views: number; samples_approved: number; samples_shipped: number; dms_sent: number };
  prev_totals: { gmv: number; affiliate_gmv: number; units: number; videos_posted: number; video_views: number; samples_approved: number; samples_shipped: number; dms_sent: number };
  /** Daily GMV in the period, for the chart. */
  daily: { date: string; gmv: number; affiliate_gmv: number }[];
}
export interface ReportSchedule {
  account_id: number;
  enabled: boolean;
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
  period: 'weekly' | 'monthly';
  kind: 'standard' | 'cruva';
  /** Send to the client channel as soon as it is generated (otherwise it waits in the queue for approval). */
  autosend: boolean;
  /** Attach the Brightform PDF to the Slack message. */
  pdf: boolean;
  last_generated_at: string | null;
  updated_at: string | null;
}

export interface ReportData {
  gmv: { total: number; affiliate: number; units: number; prev_total: number; prev_affiliate: number; prev_units: number; currency: string; days_with_data: number; by_shop: { shop_id: string; shop_name: string; total: number; affiliate: number; units: number; prev_total: number }[] };
  tts: { shop_id: string; shop_name: string; gmv: number | null; orders: number | null; refunds: number | null; conversion: number | null; visitors: number | null; error: string | null }[];
  market: { market: string; prospects: number; surging: number; category_leaders: { name: string; gmv_7d: number | null; currency: string; category: string | null }[] }[];
  calls: { id: string; title: string; happened_at: string; notes: string[]; url: string | null }[];
  incidents: { kind: string; severity: string; title: string; created_at: string; resolved_at: string | null }[];
  promotions: { name: string; begin_at: string; end_at: string }[];
  checklist: { days: number; complete: number };
  notes: string[];
  context?: ReportContext;
  cruva?: ReportCruva | null;
}

export interface ReportsData {
  reports: ClientReport[];
  schedules: ReportSchedule[];
  accounts: { id: number; name: string; client_slack_channel: string | null; client_domain: string | null; markets: string | null; shops: number }[];
  slack_configured: boolean;
  llm_configured: boolean;
  tldv_configured: boolean;
  tts_configured: boolean;
}

// ---- Cruva playbook (best practice matrix) ----

export type PlaybookKind = 'group' | 'automation' | 'workflow' | 'email_campaign' | 'list' | 'brief' | 'sender' | 'tag' | 'manual';

export interface PlaybookItem {
  id: number;
  kind: PlaybookKind;
  key: string;
  language: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  source: string;
  updated_at: string;
}

export interface PlaybookSetupCell {
  shop_id: string;
  kind: PlaybookKind;
  playbook_key: string;
  /** set = in place · paused = exists but stopped · drift = copy differs from the library · missing · manual = Cruva UI only (or marked by hand) · queued = in a rollout · error */
  status: PlaybookCellStatus;
  remote_id: string | null;
  remote_name: string | null;
  checked_at: string | null;
  applied_at: string | null;
  note: string | null;
  /** The copy the shop runs today, when the check could read it. */
  remote_copy?: string | null;
}

export type PlaybookCellStatus = 'set' | 'paused' | 'drift' | 'missing' | 'manual' | 'unknown' | 'queued' | 'error';

/** What the check learnt about a shop from its existing setup, reused when drafting: categories, products, contact email, timezone, senders, lists, brief link. */
export interface PlaybookLearned {
  categories: string[];
  products: string[];
  contact_email: string | null;
  timezone: string | null;
  sender_emails: string[];
  lists: { id: string; name: string; count: number }[];
  brief_link: string | null;
  plan: string | null;
}

export interface PlaybookRollout {
  id: number;
  created_at: string;
  created_by: string | null;
  status: 'draft' | 'running' | 'done' | 'undone';
  shop_ids: string[];
  note: string | null;
  counts: Record<PlaybookDraftStatus, number>;
  ran_at: string | null;
}

export type PlaybookDraftStatus = 'ready' | 'needs_input' | 'blocked' | 'approved' | 'skipped' | 'done' | 'error' | 'undone';

export interface PlaybookDraft {
  id: number;
  rollout_id: number;
  shop_id: string;
  shop_name: string;
  account_id: number | null;
  kind: PlaybookKind;
  key: string;
  name: string;
  description: string | null;
  language: string;
  /** create a new object, update an existing one (drift), or start a paused one. */
  action: 'create' | 'update' | 'start';
  tool: string;
  payload: Record<string, unknown>;
  /** The editable copy (DM text, invite message or email body), mirrored into the payload on save. */
  copy: string | null;
  /** The copy the shop runs today for this piece (an update), or its nearest existing message (a create), for reference. */
  existing_copy?: string | null;
  /** Set when the copy was rewritten in the shop's voice with the content profile. */
  tailored_at?: string | null;
  /** Fields the reviewer still has to fill (needs_input) or cannot (blocked). */
  blockers: string[];
  status: PlaybookDraftStatus;
  start_after: boolean;
  save_override: boolean;
  remote_id: string | null;
  remote_name: string | null;
  result: string | null;
  order_no: number;
  updated_at: string;
}

export interface PlaybookWalkStep { key: string; title: string; why: string }

/** One affiliate video from Cruva's search_videos, with the analysis Cruva already ran on it. */
export interface PlaybookContentVideo { video_id: string; handle: string; product_id: string | null; products: string[]; gmv: number; units: number; views: number; likes: number; gmv_per_view: number | null; conversion: number | null; post_time: string | null; link: string | null; title: string | null; overview: string | null; transcript: string | null; hooks: { hook: string; score: number | null; explanation: string | null }[]; rank_gmv: number; rank_eff: number | null; top: boolean }

/** What the top videos of a shop have in common, learnt weekly; every claim carries the video ids it came from. */
export interface PlaybookProfile {
  learned_at: string; window_from: string; window_to: string; videos: number; top_count: number; top_gmv: number; total_gmv: number;
  summary: string;
  hooks: { group: string; example: string; language: string | null; video_ids: string[] }[];
  formats: { name: string; video_ids: string[] }[];
  products_carry: { product_id: string; gmv: number; videos: number }[];
  products_no_gmv: string[];
  creator_shape: { follower_band: string | null; niches: string[]; first_video_share: number | null; video_ids: string[] };
  timing: { best_days: string[]; best_hours: string[]; video_ids: string[] };
  offer: string | null;
  example_scripts: { handle: string; video_id: string; link: string | null; lines: string }[];
  content_ideas: string[];
  top_creators: { handle: string; gmv: number; videos: number }[];
}

/** The shop's own voice, learnt from the copy already running in Cruva. */
export interface PlaybookVoice { learned_at: string; samples: { name: string; kind: string; sent: number | null; replies: number | null; copy: string }[]; summary: string; greeting: string | null; signoff: string | null; register: string | null; emoji: string | null; length: string | null; phrases: string[]; avoid: string[] }

/** A direct competitor of a shop on TikTok Shop, verified against Cruva's marketplace brand index. */
export interface PlaybookCompetitor { id: number; shop_id: string; brand_id: string; name: string; region: string; gmv: number | null; creators: number | null; videos: number | null; category: string | null; status: 'suggested' | 'confirmed' | 'rejected'; reason: string | null; source: 'claude' | 'manual'; added_at: string; scanned_at: string | null }
export interface PlaybookMarketVideo { video_id: string; brand_id: string; brand_name: string; handle: string; gmv: number; views: number; likes: number; comments: number; posted: string | null; product: string | null; product_id: string | null; link: string | null; overview: string | null; hook: string | null; script: string | null; /** In the top slice (same rule as the shop's own videos: top pct by GMV, plus the best by GMV per view). */ top: boolean }
export interface PlaybookMarketCreator { handle: string; creator_id: string; brand_id: string; brand_name: string; brand_gmv: number; platform_gmv_30d: number; followers: number; /** Also sells for this shop (seen in its own top videos). */ ours: boolean }
/** The weekly market read: what sells for the shop's direct competitors; every claim carries the video ids it came from. */
export interface PlaybookMarketProfile {
  learned_at: string; window_from: string; window_to: string;
  competitors: { brand_id: string; name: string; gmv: number | null; videos_read: number; creators_read: number }[];
  /** Videos in the window across the competitors (their totals) and how many made the top slice. */
  videos_total: number; top_count: number; top_pct: number;
  summary: string;
  trends: { name: string; detail: string; brands: string[]; video_ids: string[] }[];
  hooks: { group: string; example: string; brand: string | null; video_ids: string[] }[];
  formats: { name: string; video_ids: string[] }[];
  products: { name: string; brand: string | null; gmv: number; angle: string; video_ids: string[] }[];
  gaps: string[];
  ideas: string[];
  creators_to_approach: { handle: string; creator_id: string; brand: string; brand_gmv: number; platform_gmv_30d: number; followers: number; why: string }[];
  videos: PlaybookMarketVideo[];
}

export interface PlaybookData {
  items: PlaybookItem[];
  shops: PlaybookShop[];
  /** Cruva shops not linked to any account yet (from list_shops). */
  unlinked: { shop_id: string; shop_name: string; plan: string | null }[];
  cells: PlaybookSetupCell[];
  languages: string[];
  /** The portal talks to Cruva itself (CRUVA_API_KEY set). */
  mcp_configured: boolean;
  cruva_configured: boolean;
  endpoints: Record<string, string>;
  last_error: string | null;
  last_check_at: string | null;
  checking: boolean;
  /** Progress of the running check: shops done of total. */
  progress: { done: number; total: number } | null;
  rollouts: PlaybookRollout[];
}

export interface PlaybookShop { shop_id: string; shop_name: string; account_id: number; account_name: string; am_name: string | null; language: string; market: string | null; plan: string | null; remote_counts: Record<string, number>; checked_at: string | null; learned: PlaybookLearned | null; /** Why the last check of this shop failed, or null. */ error: string | null; /** The content profile and voice, when learnt. */ profile: PlaybookProfile | null; voice: PlaybookVoice | null; top_pct: number; auto_update: boolean; /** The latest market read of the shop's direct competitors, when scanned, and how many competitors are confirmed or suggested. */ market_read: PlaybookMarketProfile | null; competitors: number; /** Outreach health: DMs out, days without one, live outreach bots, the Always-on switch and an ended campaign waiting on its replacement. */ outreach: PlaybookOutreach; /** Background learning under way for this shop. */ learning: 'running' | 'queued' | null }

export interface PlaybookOutreach { dms_7d: number | null; silent_days: number | null; live: number; always_on: boolean; ended: { reason: string; name: string; rollout_id: number; started: boolean; at: string; resolved_at: string | null } | null }

// ---- Samples: the traffic light, the rules, the shortlist ----

/** The numbers a creator's pending sample request has to clear, per account; the weekly cap comes from the account's targets unless overridden here. */
export interface SampleRules { min_gmv: number; min_engagement: number; min_post_rate: number; min_followers: number; /** require: only creators Claude or the research call relevant make the shortlist; prefer: relevance only ranks; ignore: numbers only. */ relevance: 'require' | 'prefer' | 'ignore'; cap_override: number | null; auto_accept: boolean; /** How many the scan may accept on its own each week. */ auto_per_week: number }
export interface SampleResearch { creator_id: string | null; categories: string[]; category_splits: Record<string, number>; bio: string | null; content_quality: number | null; brand_collaborations: number | null; language: string | null; brands: { name: string; id: string; gmv: number; videos: number }[]; /** The direct competitor the creator sold for, when one matched. */ competitor: string | null; /** A category of theirs that matches the shop's. */ category_match: string | null; relevant: 0 | 1 | 2; risk: 'none' | 'some' | 'high'; note: string | null; researched_at: string }
export interface SampleRequest {
  shop_id: string; apply_id: string; handle: string; name: string | null; followers: number; gmv_30d: number; engagement: number | null; post_rate: number | null;
  product: string | null; product_id: string | null; variant: string | null; submitted: string | null; commission: number | null; videos: { url: string; views: number }[];
  research: SampleResearch | null; verdict: 'accept' | 'review' | 'skip'; score: number; reasons: string[];
  seen_at: string; status: 'pending' | 'accepted' | 'gone'; decided_at: string | null; decided_by: string | null;
}
export interface SampleShop { shop_id: string; shop_name: string; market: string | null; account_id: number; pending: number; oldest_days: number | null; shortlist: SampleRequest[]; review: SampleRequest[]; skipped: SampleRequest[]; accepted: SampleRequest[]; accepted_week: number; auto_week: number; cap: number | null; cap_source: 'target' | 'override' | null; min_target: number | null; scanned_at: string | null; error: string | null }
export interface SampleAccount { account_id: number; name: string; am_name: string | null; light: 'red' | 'amber' | 'green' | 'grey'; summary: string; rules: SampleRules; shops: SampleShop[] }
export interface SamplesData { configured: boolean; accounts: SampleAccount[]; defaults: SampleRules; scanning: boolean }

// ---- Airtable mirror (Sofía's leads pipeline) ----

export interface AirtableFieldSchema { id: string; name: string; type: string; description?: string; options?: Record<string, unknown> }
export interface AirtableTableSchema { id: string; name: string; description?: string; primaryFieldId: string; fields: AirtableFieldSchema[] }
export interface AirtableTableRow { base_id: string; table_id: string; name: string; schema: AirtableTableSchema; synced_at: string | null; full_synced_at: string | null; records: number; error: string | null }
export interface AirtableLinkRow { id: number; base_id: string; table_id: string; record_id: string; kind: 'prospect' | 'lead' | 'enquiry'; local_id: string; confidence: number; how: string; status: 'auto' | 'review' | 'confirmed' | 'rejected'; created_at: string }
export interface AirtableRecordRow { base_id: string; table_id: string; record_id: string; primary: string | null; fields: Record<string, unknown>; modified_at: string | null; synced_at: string }
export interface AirtableData { configured: boolean; base_id: string; base_name: string | null; tables: AirtableTableRow[]; last_sync_at: string | null; last_error: string | null; syncing: boolean; interval_minutes: number; matches: CrmMatchStats; review: CrmLink[]; /** Website enquiries are written into her Website Enquiries table. */ write_enquiries: boolean; writes: number }
/** How Sofía's base overlaps our BD prospects and Leads: counts of rows carrying a label, and the loose matches waiting on a person. */
export interface CrmMatchStats { prospects: number; leads: number; review: number; matched_at: string | null }
/** One of Sofía's records tied to one of our rows. Status: auto (matched by domain or exact name), review (a loose name match, to confirm), confirmed, rejected. */
export interface CrmLink {
  id: number;
  kind: 'prospect' | 'lead';
  local_id: number;
  local_name: string | null;
  table: string;
  table_id: string;
  record_id: string;
  primary: string | null;
  url: string;
  status: 'auto' | 'review' | 'confirmed' | 'rejected';
  confidence: number;
  how: string;
  stage: string | null;
  detail: string | null;
  owner: string | null;
  next_action: string | null;
  next_action_date: string | null;
  last_contact: string | null;
  modified_at: string | null;
}

// ---- Client question copilot ----

export interface CopilotSource {
  kind: string;
  title: string;
  snippet: string;
  url: string | null;
  occurred_at: string | null;
  score: number;
}

export interface CopilotQuestion {
  id: number;
  account_id: number | null;
  account_name: string | null;
  source: 'slack' | 'email' | 'manual';
  /** client: a reply the AM sends on; internal: a briefing for the team, in Slack syntax. */
  audience: 'client' | 'internal';
  /** The day the question is about (evidence up to that day, the numbers of that day). */
  as_of: string | null;
  channel: string | null;
  thread_ts: string | null;
  external_id: string | null;
  asked_by: string | null;
  question: string;
  answer: string | null;
  /** The answer as a Slack message (mrkdwn), ready to paste. */
  slack_text: string | null;
  sources: CopilotSource[];
  generator: 'claude' | 'template' | null;
  status: 'open' | 'drafted' | 'answered' | 'dismissed';
  created_by: string | null;
  created_at: string;
  answered_at: string | null;
  sent_at: string | null;
}

export interface CopilotData {
  questions: CopilotQuestion[];
  accounts: { id: number; name: string; client_slack_channel: string | null; client_domain: string | null; evidence: number }[];
  settings: { watch_slack: boolean; watch_email: boolean; notify_am: boolean };
  evidence_counts: Record<string, number>;
  last_index_at: string | null;
  last_index_error: string | null;
  slack_configured: boolean;
  gmail_connected: boolean;
  tldv_configured: boolean;
  llm_configured: boolean;
}

// ---- Competitor intelligence (Growth > Competitors) ----

export type AtsKind = 'greenhouse' | 'lever' | 'workable' | 'personio';
export interface CompetitorAts { kind: AtsKind; slug: string }
export interface Competitor {
  id: number;
  name: string;
  domain: string | null;
  linkedin_url: string | null;
  tiktok_handle: string | null;
  markets: string[];
  apollo_org_id: string | null;
  watch_urls: string[];
  ats: CompetitorAts[];
  notes: string | null;
  enabled: boolean;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
export interface CompetitorPerson {
  id: number;
  competitor_id: number;
  apollo_id: string;
  name: string;
  title: string | null;
  prev_title: string | null;
  seniority: string | null;
  department: string | null;
  location: string | null;
  linkedin_url: string | null;
  started_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  miss_count: number;
  left_at: string | null;
}
export interface CompetitorJob {
  id: number;
  competitor_id: number;
  source: string;
  ext_id: string;
  title: string;
  location: string | null;
  url: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
}
export interface CompetitorClient {
  id: number;
  competitor_id: number;
  brand: string;
  brand_key: string;
  market: string | null;
  confidence: 'low' | 'medium' | 'high';
  sources: { url: string | null; evidence: string; at: string }[];
  prospect_id: number | null;
  lead_id: number | null;
  status: 'active' | 'removed';
  first_seen_at: string;
  last_seen_at: string;
}
export type CompetitorSignalKind = 'joined' | 'left' | 'title_change' | 'hiring' | 'job_closed' | 'new_client' | 'client_gone' | 'overlap' | 'press' | 'event' | 'market' | 'website' | 'note';
export interface CompetitorSignal {
  id: number;
  competitor_id: number;
  kind: CompetitorSignalKind;
  summary: string;
  evidence: string | null;
  url: string | null;
  observed_at: string;
  created_at: string;
  seen_at: string | null;
}
export interface CompetitorView extends Competitor {
  people_active: number;
  joined_30d: number;
  left_30d: number;
  open_jobs: number;
  clients: number;
  overlap: number;
  new_signals: number;
  latest_signal_at: string | null;
}
export interface CompetitorOverlapRow {
  competitor_id: number;
  competitor: string;
  brand: string;
  market: string | null;
  confidence: string;
  prospect_id: number | null;
  prospect_status: string | null;
  lead_id: number | null;
  lead_stage: string | null;
  last_seen_at: string;
}
export interface CompetitorsSettings { day: number; time: string; digest_time: string; channel: string; apollo_jobs: boolean }
export interface CompetitorsData {
  competitors: CompetitorView[];
  overlap: CompetitorOverlapRow[];
  settings: CompetitorsSettings;
  apollo_configured: boolean;
  llm_configured: boolean;
  slack_configured: boolean;
  running: boolean;
  last_run_at: string | null;
  last_error: string | null;
  last_digest_at: string | null;
  digest_preview: string;
  timezone: string;
}
export interface CompetitorDetail {
  competitor: Competitor;
  people: CompetitorPerson[];
  leavers: CompetitorPerson[];
  jobs: CompetitorJob[];
  clients: CompetitorClient[];
  signals: CompetitorSignal[];
  snapshots: { url: string; fetched_at: string; error: string | null; chars: number }[];
}

// ---- Claude usage and cost ----

export interface LlmModelPrice { id: string; label: string; input: number; output: number; cache_read: number; note: string }
export interface LlmUsageBucket { calls: number; ok: number; input: number; output: number; cache_read: number; cost_usd: number }
export interface LlmUsageData {
  configured: boolean;
  models: LlmModelPrice[];
  /** Model per feature, as configured (or the default). */
  feature_models: { feature: string; label: string; model: string; auto: boolean }[];
  daily_budget_usd: number;
  today: LlmUsageBucket;
  d7: LlmUsageBucket;
  month: LlmUsageBucket;
  projected_month_usd: number;
  by_feature: ({ feature: string; label: string } & LlmUsageBucket)[];
  by_model: ({ model: string } & LlmUsageBucket)[];
  /** Replies: what one message costs on average over the last 7 days, and on each model at that size. */
  reply_avg: { cost_usd: number | null; input: number | null; output: number | null; messages_7d: number; per_model: { model: string; label: string; cost_usd: number }[] };
  last_error: { at: string; feature: string; message: string } | null;
  budget_reached: boolean;
}
