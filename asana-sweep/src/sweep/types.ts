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
  trigger: 'schedule' | 'manual' | 'live';
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
  /** Agency commission on the base amount, in percent. Null = no deal recorded. */
  commission_pct: number | null;
  /** What the commission is calculated on: actual GMV, or the net settlement amount (Merchant of Record). */
  commission_basis: 'gmv' | 'mor';
  /** For MoR accounts: estimated net settlement as a percent of GMV, used until the actual figure is entered. */
  settlement_pct: number;
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
  /** Latest live evaluation from the watcher, today only. */
  live: Check | null;
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
  live_enabled: boolean;
  live_interval_seconds: number;
  live_sweep_enabled: boolean;
  live_last_tick_at: string | null;
  live_watching: number;
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

/** A task the sweep deleted, kept so the day's checklist check can still count it as done. */
export interface Completion {
  task_gid: string;
  project_gid: string;
  parent_gid: string | null;
  name: string;
  section_name: string | null;
  assignee_name: string | null;
  completed: boolean;
  completed_at: string | null;
  num_subtasks: number;
  deleted_at: string;
  run_id: number | null;
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
}

export interface TtsStatus {
  configured: boolean;
  service_id: string;
  authorize_url: string | null;
  callback_url: string;
  shops: TtsShopRow[];
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
  status: BdStatus;
  owner_id: number | null;
  owner_name: string | null;
  notes: string | null;
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
  outreach_log: BdOutreachEvent[];
}

export type BdDraftStatus = 'draft' | 'gmail' | 'sent' | 'discarded';

/** A cold email drafted for one decision maker, reviewed in the inbox, then handed to Gmail. */
export interface BdEmailDraft {
  id: number;
  prospect_id: number;
  contact_id: number | null;
  shop_name: string;
  market: string;
  to_name: string;
  to_email: string;
  subject: string;
  body: string;
  language: string;
  style: 'short' | 'intro';
  status: BdDraftStatus;
  generator: 'claude' | 'template';
  gmail_draft_id: string | null;
  gmail_message_id: string | null;
  gmail_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
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
  llm_configured: boolean;
  sender_name: string;
  sender_title: string;
  booking_url: string;
  pitch: string;
  sent_query: string;
  last_pull_at: string | null;
  last_pull_error: string | null;
}

export interface OutreachData {
  drafts: BdEmailDraft[];
  examples: OutreachExample[];
  settings: OutreachSettings;
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
  totals: { prospects: number; complete: number; won: number; with_contacts: number; new_30d: number; gmv_started_30d: number };
  enrich: BdEnrichStatus;
  /** Enrich new prospects with Apollo automatically after every pull or import. */
  auto_enrich: boolean;
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
}

// ---- CS & affiliate inbox, context library, auto-reply ----

export type InboxChannel = 'cs' | 'affiliate';
export type InboxStatus = 'open' | 'replied' | 'auto_replied' | 'closed';

export interface InboxConversation {
  id: number;
  tts_shop_id: string;
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
  products: { id: string; title: string }[];
  history: { when: string; who: string; text: string }[];
  cruva_outreach: { when: string | null; summary: string }[];
  library: { title: string; body: string; language: string; scope: string }[];
}
