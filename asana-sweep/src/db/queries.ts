import type Database from 'better-sqlite3';
import { marketOfShopName } from '../gmv/market.js';
import type {
  ChecklistItem,
  ChecklistItemInput,
  ChecklistTick,
  Account,
  AccountInput,
  AccountShop,
  BdContact,
  BdOutreachEvent,
  BdProspect,
  BdProspectInput,
  BdProspectPatch,
  Check,
  CheckItem,
  CheckStatus,
  CheckWithItems,
  ContextEntry,
  BdEmailDraft,
  OutreachExample,
  BdFollowup,
  TtsContact,
  LarkMessage,
  HealthSource,
  AccountTarget,
  AccountSkuPrice,
  AccountCampaign,
  TargetKey,
  WatchlistEntry,
  BdAlert,
  BdActivity,
  BdActivityRow,
  MonitorFlag,
  CruvaOutreach,
  StockSku,
  Incident,
  HealthAssessment,
  SiteInquiry,
  InquiryEvent,
  ClientReport,
  ReportData,
  PlaybookItem,
  PlaybookKind,
  PlaybookSetupCell,
  PlaybookRollout,
  PlaybookDraft,
  PlaybookDraftStatus,
  ReplyPolicy,
  FbtProfile,
  FbtSkuSpec,
  PnlInputs,
  PnlSkuCogs,
  ClientTask,
  ReportSchedule,
  Onboarding,
  OnboardingContext,
  Competitor,
  CompetitorAts,
  CompetitorClient,
  CompetitorJob,
  CompetitorPerson,
  CompetitorSignal,
  CompetitorSignalKind,
  Pitch,
  PitchBrief,
  PitchDeck,
  PitchResearch,
  OnboardingStep,
  OnboardingTerms,
  TargetAnalysis,
  ReplyEvent,
  ReplyDecision,
  InboxChannel,
  CopilotQuestion,
  CopilotSource,
  InboxConversation,
  InboxMessage,
  InboxReply,
  AccountReplySettings,
  GmvMaxPatch,
  GmvMaxRow,
  GmvSync,
  Lead,
  Promotion,
  PromotionInput,
  PromotionTarget,
  TtsShopRow,
  Person,
  PersonInput,
  ReplyAudit,
  ReplyAuditAction,
  ReplyAuditItem,
  ReplyAuditSummary,
  AirtableRecordRow, AirtableTableRow, AirtableTableSchema, PlaybookCompetitor, PlaybookContentVideo, PlaybookMarketProfile, SampleRequest, SampleResearch,
  PlaybookProfile,
} from '../sweep/types.js';
import { isSignedStage, leadKey, matchPerson, type SheetLead } from '../leads/sheet.js';
import { fastmossShopUrl, launchFlags, matchesAccountName, outreachComplete, riseBand, riseScore } from '../bd/score.js';

export interface HealthPullRow { id: number; shop_id: string; account_id: number | null; source: HealthSource; pull_date: string; pulled_at: string; ok: boolean; error: string | null; metrics: Record<string, unknown>; rows: Record<string, unknown> }

type Row = Record<string, unknown>;

function rowToAccount(r: Row): Account {
  return {
    id: r.id as number,
    name: r.name as string,
    markets: (r.markets as string | null) || null,
    am_name: (r.am_name as string | null) || null,
    aa_name: (r.aa_name as string | null) || null,
    enabled: Boolean(r.enabled),
    notes: (r.notes as string | null) || null,
    commission_pct: r.commission_pct === null || r.commission_pct === undefined ? null : Number(r.commission_pct),
    commission_basis: r.commission_basis === 'mor' ? 'mor' : 'gmv',
    settlement_pct: r.settlement_pct === null || r.settlement_pct === undefined ? 100 : Number(r.settlement_pct),
    slack_channel: (r.slack_channel as string | null) || null,
    client_slack_channel: (r.client_slack_channel as string | null) || null,
    client_domain: (r.client_domain as string | null) || null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function parseJson<T>(v: unknown, fallback: T): T {
  try {
    return JSON.parse((v as string) || '') as T;
  } catch {
    return fallback;
  }
}

function rowToCheck(r: Row): Check {
  return {
    id: r.id as number,
    account_id: r.account_id as number,
    check_date: r.check_date as string,
    checked_at: r.checked_at as string,
    trigger: r.trigger as Check['trigger'],
    status: r.status as CheckStatus,
    am_total: r.am_total as number,
    am_done: r.am_done as number,
    aa_total: r.aa_total as number,
    aa_done: r.aa_done as number,
    am_complete: Boolean(r.am_complete),
    aa_complete: Boolean(r.aa_complete),
    combined_complete: Boolean(r.combined_complete),
    warnings: parseJson<string[]>(r.warnings, []),
    error_message: (r.error_message as string | null) ?? null,
    final: Boolean(r.final),
  };
}

export class Queries {
  constructor(private db: Database.Database) {}

  /** Rises with every row this connection writes; a payload cached against it is fresh while it is equal. */
  changeStamp(): number {
    return Number((this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  }

  // ---- Accounts ----

  listAccounts(): Account[] {
    return this.db.prepare('SELECT * FROM accounts ORDER BY name COLLATE NOCASE').all().map((r) => rowToAccount(r as Row));
  }

  getAccount(id: number): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToAccount(r) : null;
  }

  createAccount(input: AccountInput): Account {
    const res = this.db
      .prepare(
        `INSERT INTO accounts (name, markets, am_name, aa_name, enabled, notes, commission_pct, commission_basis, settlement_pct, slack_channel, client_slack_channel, client_domain)
         VALUES (@name, @markets, @am_name, @aa_name, @enabled, @notes, @commission_pct, @commission_basis, @settlement_pct, @slack_channel, @client_slack_channel, @client_domain)`,
      )
      .run({ ...input, enabled: input.enabled ? 1 : 0 });
    return this.getAccount(Number(res.lastInsertRowid))!;
  }

  updateAccount(id: number, input: AccountInput): Account | null {
    const res = this.db
      .prepare(
        `UPDATE accounts SET name=@name, markets=@markets, am_name=@am_name, aa_name=@aa_name, enabled=@enabled, notes=@notes,
            commission_pct=@commission_pct, commission_basis=@commission_basis, settlement_pct=@settlement_pct,
            slack_channel=@slack_channel, client_slack_channel=@client_slack_channel, client_domain=@client_domain,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=@id`,
      )
      .run({ ...input, id, enabled: input.enabled ? 1 : 0 });
    return res.changes ? this.getAccount(id) : null;
  }

  deleteAccount(id: number): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }

  // ---- Settings ----

  getSetting(key: string, fallback = ''): string {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined;
    return r?.value ?? fallback;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Every setting whose key starts with `prefix`, e.g. the per-person Gmail connections. */
  listSettings(prefix: string): { key: string; value: string }[] {
    return (this.db.prepare("SELECT key, value FROM settings WHERE key LIKE ? || '%' ORDER BY key").all(prefix) as { key: string; value: string | null }[]).map((r) => ({ key: r.key, value: r.value ?? '' }));
  }

  // ---- Checks ----

  /**
   * Record the day's check. A row marked `final` (the deadline snapshot) is never overwritten by a
   * non-final write, so live updates after the deadline do not change the official record.
   */
  upsertCheck(
    accountId: number,
    checkDate: string,
    data: Omit<Check, 'id' | 'account_id' | 'check_date' | 'checked_at' | 'final'> & { items: CheckItem[]; final?: boolean },
  ): CheckWithItems {
    const existing = this.getCheckForDate(accountId, checkDate);
    if (existing?.final && !data.final) return existing;
    this.db
      .prepare(
        `INSERT INTO checks (account_id, check_date, checked_at, trigger, status, am_total, am_done, aa_total, aa_done,
                             am_complete, aa_complete, combined_complete, warnings, error_message, items, final)
         VALUES (@account_id, @check_date, @checked_at, @trigger, @status, @am_total, @am_done, @aa_total, @aa_done,
                 @am_complete, @aa_complete, @combined_complete, @warnings, @error_message, @items, @final)
         ON CONFLICT(account_id, check_date) DO UPDATE SET
           checked_at=excluded.checked_at, trigger=excluded.trigger, status=excluded.status,
           am_total=excluded.am_total, am_done=excluded.am_done, aa_total=excluded.aa_total, aa_done=excluded.aa_done,
           am_complete=excluded.am_complete, aa_complete=excluded.aa_complete, combined_complete=excluded.combined_complete,
           warnings=excluded.warnings, error_message=excluded.error_message, items=excluded.items, final=excluded.final`,
      )
      .run({ ...this.checkParams(data), account_id: accountId, check_date: checkDate, trigger: data.trigger, final: data.final ? 1 : 0 });
    return this.getCheckForDate(accountId, checkDate)!;
  }

  private checkParams(data: Omit<Check, 'id' | 'account_id' | 'check_date' | 'checked_at' | 'final' | 'trigger'> & { items: CheckItem[] }) {
    return {
      checked_at: new Date().toISOString(),
      status: data.status,
      am_total: data.am_total,
      am_done: data.am_done,
      aa_total: data.aa_total,
      aa_done: data.aa_done,
      am_complete: data.am_complete ? 1 : 0,
      aa_complete: data.aa_complete ? 1 : 0,
      combined_complete: data.combined_complete ? 1 : 0,
      warnings: JSON.stringify(data.warnings),
      error_message: data.error_message,
      items: JSON.stringify(data.items),
    };
  }

  /** Latest live evaluation for an account (always overwritten). */
  upsertLive(accountId: number, checkDate: string, data: Omit<Check, 'id' | 'account_id' | 'check_date' | 'checked_at' | 'final' | 'trigger'> & { items: CheckItem[] }): void {
    this.db
      .prepare(
        `INSERT INTO live_checks (account_id, check_date, checked_at, status, am_total, am_done, aa_total, aa_done,
                                  am_complete, aa_complete, combined_complete, warnings, error_message, items)
         VALUES (@account_id, @check_date, @checked_at, @status, @am_total, @am_done, @aa_total, @aa_done,
                 @am_complete, @aa_complete, @combined_complete, @warnings, @error_message, @items)
         ON CONFLICT(account_id) DO UPDATE SET
           check_date=excluded.check_date, checked_at=excluded.checked_at, status=excluded.status,
           am_total=excluded.am_total, am_done=excluded.am_done, aa_total=excluded.aa_total, aa_done=excluded.aa_done,
           am_complete=excluded.am_complete, aa_complete=excluded.aa_complete, combined_complete=excluded.combined_complete,
           warnings=excluded.warnings, error_message=excluded.error_message, items=excluded.items`,
      )
      .run({ ...this.checkParams(data), account_id: accountId, check_date: checkDate });
  }

  private rowToLive(r: Row): CheckWithItems {
    return { ...rowToCheck({ ...r, id: -(r.account_id as number), trigger: 'live', final: 0 }), items: parseJson<CheckItem[]>(r.items, []) };
  }

  listLive(checkDate: string): CheckWithItems[] {
    return this.db.prepare('SELECT * FROM live_checks WHERE check_date = ?').all(checkDate).map((r) => this.rowToLive(r as Row));
  }

  getLive(accountId: number): CheckWithItems | null {
    const r = this.db.prepare('SELECT * FROM live_checks WHERE account_id = ?').get(accountId) as Row | undefined;
    return r ? this.rowToLive(r) : null;
  }

  getCheckForDate(accountId: number, checkDate: string): CheckWithItems | null {
    const r = this.db.prepare('SELECT * FROM checks WHERE account_id = ? AND check_date = ?').get(accountId, checkDate) as Row | undefined;
    return r ? { ...rowToCheck(r), items: parseJson<CheckItem[]>(r.items, []) } : null;
  }

  getCheck(id: number): CheckWithItems | null {
    const r = this.db.prepare('SELECT * FROM checks WHERE id = ?').get(id) as Row | undefined;
    return r ? { ...rowToCheck(r), items: parseJson<CheckItem[]>(r.items, []) } : null;
  }

  listChecksForDate(checkDate: string): Check[] {
    return this.db.prepare('SELECT * FROM checks WHERE check_date = ?').all(checkDate).map((r) => rowToCheck(r as Row));
  }

  listChecksBetween(from: string, to: string): Check[] {
    return this.db
      .prepare('SELECT * FROM checks WHERE check_date >= ? AND check_date <= ? ORDER BY check_date')
      .all(from, to)
      .map((r) => rowToCheck(r as Row));
  }

  listCheckDates(limit = 60): string[] {
    return this.db
      .prepare('SELECT DISTINCT check_date FROM checks ORDER BY check_date DESC LIMIT ?')
      .all(limit)
      .map((r) => (r as { check_date: string }).check_date);
  }

  pruneChecks(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString().slice(0, 10);
    return this.db.prepare('DELETE FROM checks WHERE check_date < ?').run(cutoff).changes;
  }

  // ---- Native checklist: items (template or per account) and daily ticks ----

  private rowToChecklistItem(r: Row): ChecklistItem {
    return {
      id: r.id as number,
      account_id: (r.account_id as number | null) ?? null,
      parent_id: (r.parent_id as number | null) ?? null,
      section: (r.section as string) ?? '',
      name: r.name as string,
      guidance: (r.guidance as string | null) || null,
      role: r.role === 'aa' ? 'aa' : 'am',
      frequency: r.frequency === 'weekly' ? 'weekly' : 'daily',
      weekday: (r.weekday as number | null) ?? null,
      position: (r.position as number) ?? 0,
      enabled: Boolean(r.enabled),
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  /** The master template (account_id NULL). */
  listTemplateItems(): ChecklistItem[] {
    return (this.db.prepare('SELECT * FROM checklist_items WHERE account_id IS NULL ORDER BY position, id').all() as Row[]).map((r) => this.rowToChecklistItem(r));
  }

  /** An account's own items, if it has customised its list. */
  listAccountItems(accountId: number): ChecklistItem[] {
    return (this.db.prepare('SELECT * FROM checklist_items WHERE account_id = ? ORDER BY position, id').all(accountId) as Row[]).map((r) => this.rowToChecklistItem(r));
  }

  /** What the account is checked against: its own list when it has one, else the template. */
  checklistItemsFor(accountId: number): ChecklistItem[] {
    const own = this.listAccountItems(accountId);
    return own.length ? own : this.listTemplateItems();
  }

  checklistSource(accountId: number): { source: 'template' | 'custom' | 'none'; items: number } {
    const own = this.listAccountItems(accountId).filter((i) => i.enabled);
    if (own.length) return { source: 'custom', items: own.length };
    const tpl = this.listTemplateItems().filter((i) => i.enabled);
    return { source: tpl.length ? 'template' : 'none', items: tpl.length };
  }

  getChecklistItem(id: number): ChecklistItem | null {
    const r = this.db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToChecklistItem(r) : null;
  }

  createChecklistItem(i: Partial<ChecklistItemInput> & { name: string }): ChecklistItem {
    const scope = i.account_id ?? null;
    const parent = i.parent_id ?? null;
    const position = i.position ?? ((this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM checklist_items WHERE account_id IS ? AND parent_id IS ?').get(scope, parent) as { p: number }).p);
    const freq = i.frequency === 'weekly' ? 'weekly' : 'daily';
    const res = this.db
      .prepare('INSERT INTO checklist_items (account_id, parent_id, section, name, guidance, role, frequency, weekday, position, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(scope, parent, i.section ?? '', i.name, i.guidance ?? null, i.role === 'aa' ? 'aa' : parent !== null && !i.role ? 'aa' : 'am', freq, freq === 'weekly' ? i.weekday ?? 1 : null, position, i.enabled === false ? 0 : 1);
    return this.getChecklistItem(Number(res.lastInsertRowid))!;
  }

  updateChecklistItem(id: number, patch: Partial<ChecklistItemInput>): ChecklistItem | null {
    const cur = this.getChecklistItem(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    const freq = next.frequency === 'weekly' ? 'weekly' : 'daily';
    this.db
      .prepare(`UPDATE checklist_items SET section = ?, name = ?, guidance = ?, role = ?, frequency = ?, weekday = ?, position = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(next.section ?? '', next.name, next.guidance ?? null, next.role === 'aa' ? 'aa' : 'am', freq, freq === 'weekly' ? next.weekday ?? 1 : null, next.position ?? 0, next.enabled === false ? 0 : 1, id);
    return this.getChecklistItem(id);
  }

  deleteChecklistItem(id: number): boolean {
    return this.db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id).changes > 0;
  }

  /** Give an account its own copy of the template so it can be edited without touching the others. Returns the new items. */
  customiseChecklist(accountId: number): ChecklistItem[] {
    if (this.listAccountItems(accountId).length) return this.listAccountItems(accountId);
    const tpl = this.listTemplateItems();
    const ins = this.db.prepare('INSERT INTO checklist_items (account_id, parent_id, section, name, guidance, role, frequency, weekday, position, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const map = new Map<number, number>();
    this.db.transaction(() => {
      for (const i of tpl.filter((x) => x.parent_id === null)) map.set(i.id, Number(ins.run(accountId, null, i.section, i.name, i.guidance, i.role, i.frequency, i.weekday, i.position, i.enabled ? 1 : 0).lastInsertRowid));
      for (const i of tpl.filter((x) => x.parent_id !== null)) {
        const parent = map.get(i.parent_id!);
        if (parent) ins.run(accountId, parent, i.section, i.name, i.guidance, i.role, i.frequency, i.weekday, i.position, i.enabled ? 1 : 0);
      }
    })();
    return this.listAccountItems(accountId);
  }

  /** Drop an account's own list so it follows the template again (its ticks on those items go with it). */
  resetChecklist(accountId: number): number {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE account_id = ?').get(accountId) as { n: number }).n;
    this.db.prepare('DELETE FROM checklist_items WHERE account_id = ?').run(accountId);
    return n;
  }

  private rowToTick(r: Row): ChecklistTick {
    return { id: r.id as number, item_id: r.item_id as number, account_id: r.account_id as number, tick_date: r.tick_date as string, done_by: (r.done_by as string | null) || null, done_at: r.done_at as string, note: (r.note as string | null) || null };
  }

  listTicks(accountId: number, date: string): ChecklistTick[] {
    return (this.db.prepare('SELECT * FROM checklist_ticks WHERE account_id = ? AND tick_date = ?').all(accountId, date) as Row[]).map((r) => this.rowToTick(r));
  }

  /** Tick or untick one item for an account on a date. Returns the tick, or null when unticked. */
  setTick(accountId: number, itemId: number, date: string, done: boolean, by: string | null, note?: string | null): ChecklistTick | null {
    if (!done) {
      this.db.prepare('DELETE FROM checklist_ticks WHERE account_id = ? AND item_id = ? AND tick_date = ?').run(accountId, itemId, date);
      return null;
    }
    this.db
      .prepare(`INSERT INTO checklist_ticks (item_id, account_id, tick_date, done_by, done_at, note) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(item_id, account_id, tick_date) DO UPDATE SET note = COALESCE(excluded.note, checklist_ticks.note)`)
      .run(itemId, accountId, date, by, new Date().toISOString(), note ?? null);
    return this.rowToTick(this.db.prepare('SELECT * FROM checklist_ticks WHERE account_id = ? AND item_id = ? AND tick_date = ?').get(accountId, itemId, date) as Row);
  }

  /** Who ticked what across a period (for the team activity view). */
  countTicks(from: string, to: string): { done_by: string | null; ticks: number }[] {
    return this.db.prepare('SELECT done_by, COUNT(*) AS ticks FROM checklist_ticks WHERE tick_date >= ? AND tick_date <= ? GROUP BY done_by ORDER BY ticks DESC').all(from, to) as { done_by: string | null; ticks: number }[];
  }

  pruneTicks(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString().slice(0, 10);
    return this.db.prepare('DELETE FROM checklist_ticks WHERE tick_date < ?').run(cutoff).changes;
  }

  // ---- TikTok Shop authorisations ----

  private rowToTtsShop(r: Row): TtsShopRow & { access_token: string; refresh_token: string } {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: r.id as string,
      name: r.name as string,
      region: (r.region as string) ?? '',
      seller_type: (r.seller_type as string) ?? '',
      cipher: (r.cipher as string) ?? '',
      account_id: (r.account_id as number | null) ?? null,
      market: (r.market as string | null) ?? null,
      seller_name: (r.seller_name as string | null) ?? null,
      access_expires_at: Number(r.access_expires_at ?? 0),
      refresh_expires_at: Number(r.refresh_expires_at ?? 0),
      authorized_at: r.authorized_at as string,
      token_ok: Number(r.refresh_expires_at ?? 0) === 0 || Number(r.refresh_expires_at) > now,
      affiliate_authorized_at: (r.aff_authorized_at as string | null) ?? null,
      affiliate_token_ok: r.aff_authorized_at ? Number(r.aff_refresh_expires_at ?? 0) === 0 || Number(r.aff_refresh_expires_at) > now : false,
      access_token: r.access_token as string,
      refresh_token: r.refresh_token as string,
    };
  }

  private static readonly TTS_SHOP_SELECT = `SELECT s.*, a.authorized_at AS aff_authorized_at, a.refresh_expires_at AS aff_refresh_expires_at
    FROM tts_shops s LEFT JOIN tts_shop_apps a ON a.shop_id = s.id AND a.app = 'affiliate'`;

  listTtsShops(): TtsShopRow[] {
    return this.db.prepare(`${Queries.TTS_SHOP_SELECT} ORDER BY s.name`).all().map((r) => {
      const { access_token: _a, refresh_token: _b, ...rest } = this.rowToTtsShop(r as Row);
      return rest;
    });
  }

  getTtsShop(id: string): (TtsShopRow & { access_token: string; refresh_token: string }) | null {
    const r = this.db.prepare(`${Queries.TTS_SHOP_SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    return r ? this.rowToTtsShop(r) : null;
  }

  // ---- Tokens for a second Partner Center app (the affiliate app) ----

  getTtsShopApp(shopId: string, app: string): { shop_id: string; app: string; access_token: string; refresh_token: string; access_expires_at: number; refresh_expires_at: number; authorized_at: string; token_ok: boolean } | null {
    const r = this.db.prepare('SELECT * FROM tts_shop_apps WHERE shop_id = ? AND app = ?').get(shopId, app) as Row | undefined;
    if (!r) return null;
    const now = Math.floor(Date.now() / 1000);
    return { shop_id: r.shop_id as string, app: r.app as string, access_token: r.access_token as string, refresh_token: r.refresh_token as string, access_expires_at: Number(r.access_expires_at ?? 0), refresh_expires_at: Number(r.refresh_expires_at ?? 0), authorized_at: r.authorized_at as string, token_ok: Number(r.refresh_expires_at ?? 0) === 0 || Number(r.refresh_expires_at) > now };
  }

  upsertTtsShopApp(shopId: string, app: string, t: { access_token: string; refresh_token: string; access_token_expire_in: number; refresh_token_expire_in: number }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO tts_shop_apps (shop_id, app, access_token, refresh_token, access_expires_at, refresh_expires_at, authorized_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, app) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at, authorized_at = excluded.authorized_at, updated_at = excluded.updated_at`)
      .run(shopId, app, t.access_token, t.refresh_token, t.access_token_expire_in, t.refresh_token_expire_in, now, now);
  }

  updateTtsShopAppTokens(shopId: string, app: string, t: { access_token: string; refresh_token: string; access_token_expire_in: number; refresh_token_expire_in: number }): void {
    this.db.prepare('UPDATE tts_shop_apps SET access_token = ?, refresh_token = ?, access_expires_at = ?, refresh_expires_at = ?, updated_at = ? WHERE shop_id = ? AND app = ?')
      .run(t.access_token, t.refresh_token, t.access_token_expire_in, t.refresh_token_expire_in, new Date().toISOString(), shopId, app);
  }

  deleteTtsShopApp(shopId: string, app: string): boolean {
    return this.db.prepare('DELETE FROM tts_shop_apps WHERE shop_id = ? AND app = ?').run(shopId, app).changes > 0;
  }

  upsertTtsShop(shop: { id: string; name: string; region: string; seller_type: string; cipher: string; seller_name?: string | null }, tokens: { access_token: string; refresh_token: string; access_token_expire_in: number; refresh_token_expire_in: number }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tts_shops (id, name, region, seller_type, cipher, seller_name, access_token, refresh_token, access_expires_at, refresh_expires_at, authorized_at, updated_at, market)
         VALUES (@id, @name, @region, @seller_type, @cipher, @seller_name, @access_token, @refresh_token, @access_expires_at, @refresh_expires_at, @now, @now, @market)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, region=excluded.region, seller_type=excluded.seller_type, cipher=excluded.cipher,
           seller_name=excluded.seller_name, access_token=excluded.access_token, refresh_token=excluded.refresh_token,
           access_expires_at=excluded.access_expires_at, refresh_expires_at=excluded.refresh_expires_at, authorized_at=excluded.authorized_at, updated_at=excluded.updated_at`,
      )
      .run({
        ...shop,
        seller_name: shop.seller_name ?? null,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        access_expires_at: tokens.access_token_expire_in,
        refresh_expires_at: tokens.refresh_token_expire_in,
        now,
        market: shop.region === 'GB' ? 'UK' : shop.region,
      });
  }

  updateTtsTokens(id: string, t: { access_token: string; refresh_token: string; access_token_expire_in: number; refresh_token_expire_in: number }): void {
    this.db
      .prepare(`UPDATE tts_shops SET access_token = ?, refresh_token = ?, access_expires_at = ?, refresh_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(t.access_token, t.refresh_token, t.access_token_expire_in, t.refresh_token_expire_in, new Date().toISOString(), id);
  }

  linkTtsShop(id: string, accountId: number | null, market: string | null): void {
    this.db.prepare('UPDATE tts_shops SET account_id = ?, market = ?, updated_at = ? WHERE id = ?').run(accountId, market, new Date().toISOString(), id);
  }

  deleteTtsShop(id: string): boolean {
    return this.db.prepare('DELETE FROM tts_shops WHERE id = ?').run(id).changes > 0;
  }

  findTtsShopFor(accountId: number, market: string): (TtsShopRow & { access_token: string; refresh_token: string }) | null {
    const r = this.db.prepare('SELECT * FROM tts_shops WHERE account_id = ? AND market = ? LIMIT 1').get(accountId, market) as Row | undefined;
    return r ? this.rowToTtsShop(r) : null;
  }

  // ---- Promotions ----

  private rowToPromotion(r: Row): Omit<Promotion, 'targets'> {
    return {
      id: r.id as number,
      name: r.name as string,
      activity_type: r.activity_type as Promotion['activity_type'],
      product_level: r.product_level as Promotion['product_level'],
      discount_type: r.discount_type as Promotion['discount_type'],
      discount_value: r.discount_value === null || r.discount_value === undefined ? null : Number(r.discount_value),
      begin_at: r.begin_at as string,
      end_at: r.end_at as string,
      participation: r.participation as Promotion['participation'],
      products: parseJson<Record<string, string[]>>(r.products, {}),
      notes: (r.notes as string | null) ?? null,
      created_by: (r.created_by as string | null) ?? null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  private targetsFor(promotionId: number): PromotionTarget[] {
    return (
      this.db
        .prepare(
          `SELECT t.*, a.name AS account_name, s.name AS tts_shop_name FROM promotion_targets t
           JOIN accounts a ON a.id = t.account_id LEFT JOIN tts_shops s ON s.id = t.tts_shop_id
           WHERE t.promotion_id = ? ORDER BY a.name, t.market`,
        )
        .all(promotionId) as Row[]
    ).map((r) => ({
      id: r.id as number,
      promotion_id: r.promotion_id as number,
      account_id: r.account_id as number,
      account_name: r.account_name as string,
      market: r.market as string,
      tts_shop_id: (r.tts_shop_id as string | null) ?? null,
      tts_shop_name: (r.tts_shop_name as string | null) ?? null,
      status: r.status as PromotionTarget['status'],
      tts_activity_id: (r.tts_activity_id as string | null) ?? null,
      tts_status: (r.tts_status as string | null) ?? null,
      error_message: (r.error_message as string | null) ?? null,
      pushed_at: (r.pushed_at as string | null) ?? null,
      actor: (r.actor as string | null) ?? null,
    }));
  }

  listPromotions(): Promotion[] {
    return (this.db.prepare('SELECT * FROM promotions ORDER BY begin_at DESC, id DESC').all() as Row[]).map((r) => ({ ...this.rowToPromotion(r), targets: this.targetsFor(r.id as number) }));
  }

  getPromotion(id: number): Promotion | null {
    const r = this.db.prepare('SELECT * FROM promotions WHERE id = ?').get(id) as Row | undefined;
    return r ? { ...this.rowToPromotion(r), targets: this.targetsFor(id) } : null;
  }

  createPromotion(input: PromotionInput, createdBy: string | null): Promotion {
    const res = this.db
      .prepare(
        `INSERT INTO promotions (name, activity_type, product_level, discount_type, discount_value, begin_at, end_at, participation, products, notes, created_by)
         VALUES (@name, @activity_type, @product_level, @discount_type, @discount_value, @begin_at, @end_at, @participation, @products, @notes, @created_by)`,
      )
      .run({ ...input, products: JSON.stringify(input.products), created_by: createdBy });
    const id = Number(res.lastInsertRowid);
    this.setTargets(id, input.targets);
    return this.getPromotion(id)!;
  }

  updatePromotion(id: number, input: PromotionInput): Promotion | null {
    const res = this.db
      .prepare(
        `UPDATE promotions SET name=@name, activity_type=@activity_type, product_level=@product_level, discount_type=@discount_type, discount_value=@discount_value,
            begin_at=@begin_at, end_at=@end_at, participation=@participation, products=@products, notes=@notes, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=@id`,
      )
      .run({ ...input, id, products: JSON.stringify(input.products) });
    if (!res.changes) return null;
    this.setTargets(id, input.targets);
    return this.getPromotion(id);
  }

  /** Add missing targets and drop planned ones that are no longer wanted. Pushed targets are kept. */
  private setTargets(promotionId: number, targets: { account_id: number; market: string }[]): void {
    const wanted = new Set(targets.map((t) => `${t.account_id}:${t.market}`));
    const existing = this.targetsFor(promotionId);
    const del = this.db.prepare('DELETE FROM promotion_targets WHERE id = ?');
    for (const t of existing) if (!wanted.has(`${t.account_id}:${t.market}`) && (t.status === 'planned' || t.status === 'unlinked')) del.run(t.id);
    const ins = this.db.prepare('INSERT OR IGNORE INTO promotion_targets (promotion_id, account_id, market) VALUES (?, ?, ?)');
    for (const t of targets) ins.run(promotionId, t.account_id, t.market);
  }

  updateTarget(id: number, patch: Partial<Pick<PromotionTarget, 'status' | 'tts_shop_id' | 'tts_activity_id' | 'tts_status' | 'error_message' | 'pushed_at' | 'actor'>>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = @${k}`);
      params[k] = v;
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE promotion_targets SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run(params);
  }

  deletePromotion(id: number): boolean {
    return this.db.prepare('DELETE FROM promotions WHERE id = ?').run(id).changes > 0;
  }

  // ---- GMV Max settings ----

  private rowToGmvMax(r: Row): GmvMaxRow {
    return {
      id: r.id as number,
      account_id: r.account_id as number,
      account_name: r.account_name as string,
      am_name: (r.am_name as string | null) ?? null,
      market: r.market as string,
      campaign_type: r.campaign_type as GmvMaxRow['campaign_type'],
      campaign_name: (r.campaign_name as string | null) ?? null,
      daily_budget: r.daily_budget === null || r.daily_budget === undefined ? null : Number(r.daily_budget),
      budget_currency: (r.budget_currency as string) ?? 'EUR',
      bid_strategy: r.bid_strategy as GmvMaxRow['bid_strategy'],
      target_roi: r.target_roi === null || r.target_roi === undefined ? null : Number(r.target_roi),
      status: r.status as GmvMaxRow['status'],
      product_scope: (r.product_scope as string) ?? 'ALL',
      notes: (r.notes as string | null) ?? null,
      tts_campaign_id: (r.tts_campaign_id as string | null) ?? null,
      last_pushed_at: (r.last_pushed_at as string | null) ?? null,
      updated_at: r.updated_at as string,
    };
  }

  listGmvMax(): GmvMaxRow[] {
    return (
      this.db
        .prepare(`SELECT g.*, a.name AS account_name, a.am_name FROM gmv_max_settings g JOIN accounts a ON a.id = g.account_id ORDER BY a.name, g.market, g.campaign_type`)
        .all() as Row[]
    ).map((r) => this.rowToGmvMax(r));
  }

  ensureGmvMaxRow(accountId: number, market: string, campaignType: 'PRODUCT' | 'LIVE', currency: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO gmv_max_settings (account_id, market, campaign_type, budget_currency) VALUES (?, ?, ?, ?)`)
      .run(accountId, market, campaignType, currency);
  }

  patchGmvMax(ids: number[], patch: GmvMaxPatch): number {
    const sets: string[] = [];
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = @${k}`);
      params[k] = v;
    }
    if (!sets.length || !ids.length) return 0;
    const stmt = this.db.prepare(`UPDATE gmv_max_settings SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`);
    let n = 0;
    this.db.transaction(() => {
      for (const id of ids) n += stmt.run({ ...params, id }).changes;
    })();
    return n;
  }

  deleteGmvMax(id: number): boolean {
    return this.db.prepare('DELETE FROM gmv_max_settings WHERE id = ?').run(id).changes > 0;
  }

  // ---- People ----

  listPeople(): Person[] {
    return this.db.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE').all().map((r) => this.rowToPerson(r as Row));
  }

  getPerson(id: number): Person | null {
    const r = this.db.prepare('SELECT * FROM people WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToPerson(r) : null;
  }

  private rowToPerson(r: Row): Person {
    return {
      id: r.id as number,
      name: r.name as string,
      role: (r.role as Person['role']) ?? 'am',
      email: (r.email as string | null) || null,
      slack_user_id: (r.slack_user_id as string | null) || null,
      notify: Boolean(r.notify),
    };
  }

  createPerson(input: PersonInput): Person {
    const res = this.db
      .prepare(`INSERT INTO people (name, role, email, slack_user_id, notify) VALUES (@name, @role, @email, @slack_user_id, @notify)`)
      .run({ ...input, notify: input.notify ? 1 : 0 });
    return this.getPerson(Number(res.lastInsertRowid))!;
  }

  updatePerson(id: number, input: PersonInput): Person | null {
    const res = this.db
      .prepare(
        `UPDATE people SET name=@name, role=@role, email=@email, slack_user_id=@slack_user_id, notify=@notify,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`,
      )
      .run({ ...input, id, notify: input.notify ? 1 : 0 });
    return res.changes ? this.getPerson(id) : null;
  }

  deletePerson(id: number): boolean {
    return this.db.prepare('DELETE FROM people WHERE id = ?').run(id).changes > 0;
  }

  // ---- Cruva shops ----

  listShops(source?: 'cruva' | 'windsor'): AccountShop[] {
    const rows = source
      ? this.db.prepare('SELECT * FROM account_shops WHERE source = ? ORDER BY shop_name COLLATE NOCASE').all(source)
      : this.db.prepare('SELECT * FROM account_shops ORDER BY shop_name COLLATE NOCASE').all();
    return rows.map((r) => this.rowToShop(r as Row));
  }

  private rowToShop(r: Row): AccountShop {
    return {
      id: r.id as number,
      account_id: r.account_id as number,
      shop_id: r.shop_id as string,
      shop_name: r.shop_name as string,
      currency: (r.currency as string) || 'EUR',
      source: r.source === 'windsor' ? 'windsor' : 'cruva',
    };
  }

  addShop(accountId: number, shopId: string, shopName: string, currency = 'EUR', source: 'cruva' | 'windsor' = 'cruva'): AccountShop {
    this.db
      .prepare(
        `INSERT INTO account_shops (account_id, shop_id, shop_name, currency, source) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(shop_id) DO UPDATE SET account_id = excluded.account_id, shop_name = excluded.shop_name, currency = excluded.currency, source = excluded.source`,
      )
      .run(accountId, shopId, shopName, currency, source);
    return this.rowToShop(this.db.prepare('SELECT * FROM account_shops WHERE shop_id = ?').get(shopId) as Row);
  }

  removeShop(id: number): boolean {
    return this.db.prepare('DELETE FROM account_shops WHERE id = ?').run(id).changes > 0;
  }

  // ---- GMV ----

  upsertGmv(rows: { shop_id: string; date: string; total_gmv: number; affiliate_gmv: number; units: number; source?: string }[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO gmv_daily (shop_id, date, total_gmv, affiliate_gmv, units, source, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(shop_id, date) DO UPDATE SET total_gmv = excluded.total_gmv, affiliate_gmv = excluded.affiliate_gmv,
         units = excluded.units, source = excluded.source, synced_at = excluded.synced_at`,
    );
    const now = new Date().toISOString();
    let n = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        stmt.run(r.shop_id, r.date, r.total_gmv, r.affiliate_gmv, r.units, r.source ?? 'cruva', now);
        n += 1;
      }
    })();
    return n;
  }

  listGmvBetween(from: string, to: string): { shop_id: string; date: string; total_gmv: number; affiliate_gmv: number; units: number; synced_at: string }[] {
    return this.db
      .prepare('SELECT shop_id, date, total_gmv, affiliate_gmv, units, synced_at FROM gmv_daily WHERE date >= ? AND date <= ? ORDER BY date')
      .all(from, to) as { shop_id: string; date: string; total_gmv: number; affiliate_gmv: number; units: number; synced_at: string }[];
  }

  getTargets(month: string): Map<number, number> {
    const rows = this.db.prepare('SELECT account_id, target FROM gmv_targets WHERE month = ?').all(month) as { account_id: number; target: number }[];
    return new Map(rows.map((r) => [r.account_id, r.target]));
  }

  getSettlements(month: string): Map<number, number> {
    const rows = this.db.prepare('SELECT account_id, amount FROM settlements WHERE month = ?').all(month) as { account_id: number; amount: number }[];
    return new Map(rows.map((r) => [r.account_id, r.amount]));
  }

  setSettlement(accountId: number, month: string, amount: number | null): void {
    if (amount === null) this.db.prepare('DELETE FROM settlements WHERE account_id = ? AND month = ?').run(accountId, month);
    else
      this.db
        .prepare(`INSERT INTO settlements (account_id, month, amount) VALUES (?, ?, ?) ON CONFLICT(account_id, month) DO UPDATE SET amount = excluded.amount`)
        .run(accountId, month, amount);
  }

  setAccountDeal(id: number, deal: { commission_pct: number | null; commission_basis: 'gmv' | 'mor'; settlement_pct: number }): void {
    this.db
      .prepare(`UPDATE accounts SET commission_pct = ?, commission_basis = ?, settlement_pct = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(deal.commission_pct, deal.commission_basis, deal.settlement_pct, id);
  }

  setTarget(accountId: number, month: string, target: number | null): void {
    if (target === null) this.db.prepare('DELETE FROM gmv_targets WHERE account_id = ? AND month = ?').run(accountId, month);
    else
      this.db
        .prepare(`INSERT INTO gmv_targets (account_id, month, target) VALUES (?, ?, ?) ON CONFLICT(account_id, month) DO UPDATE SET target = excluded.target`)
        .run(accountId, month, target);
  }

  copyTargets(fromMonth: string, toMonth: string): number {
    return this.db
      .prepare(`INSERT OR IGNORE INTO gmv_targets (account_id, month, target) SELECT account_id, ?, target FROM gmv_targets WHERE month = ?`)
      .run(toMonth, fromMonth).changes;
  }

  startGmvSync(): GmvSync {
    const res = this.db.prepare(`INSERT INTO gmv_syncs (started_at, status) VALUES (?, 'running')`).run(new Date().toISOString());
    return this.getGmvSync(Number(res.lastInsertRowid))!;
  }

  finishGmvSync(id: number, status: 'ok' | 'error', shopsSynced: number, error: string | null): GmvSync {
    this.db.prepare(`UPDATE gmv_syncs SET finished_at = ?, status = ?, shops_synced = ?, error_message = ? WHERE id = ?`).run(new Date().toISOString(), status, shopsSynced, error, id);
    return this.getGmvSync(id)!;
  }

  getGmvSync(id: number): GmvSync | null {
    const r = this.db.prepare('SELECT * FROM gmv_syncs WHERE id = ?').get(id) as GmvSync | undefined;
    return r ?? null;
  }

  lastGmvSync(): GmvSync | null {
    const r = this.db.prepare('SELECT * FROM gmv_syncs ORDER BY id DESC LIMIT 1').get() as GmvSync | undefined;
    return r ?? null;
  }

  failStaleGmvSyncs(): void {
    this.db.prepare(`UPDATE gmv_syncs SET status = 'error', finished_at = ?, error_message = 'Process restarted during sync.' WHERE status = 'running'`).run(new Date().toISOString());
  }
  // ---- Leads ----

  private rowToLead(r: Row): Lead {
    return {
      id: r.id as number,
      name: r.name as string,
      poc: (r.poc as string | null) ?? null,
      stage: (r.stage as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      last_contact: (r.last_contact as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      est_value: (r.est_value as number | null) ?? null,
      priority: (r.priority as string | null) ?? null,
      row_no: (r.row_no as number | null) ?? null,
      added_on: (r.added_on as string | null) ?? null,
      sourced_by_id: (r.sourced_by_id as number | null) ?? null,
      sourced_by_name: (r.sourced_by_name as string | null) ?? null,
      onboarding_id: (r.onboarding_id as number | null) ?? null,
      onboarding_name: (r.onboarding_name as string | null) ?? null,
      signed: Boolean(r.signed),
      signed_at: (r.signed_at as string | null) ?? null,
      first_seen_at: r.first_seen_at as string,
      last_seen_at: r.last_seen_at as string,
      removed_at: (r.removed_at as string | null) ?? null,
      updated_at: r.updated_at as string,
    };
  }

  private static LEAD_SELECT = `SELECT l.*, s.name AS sourced_by_name, o.name AS onboarding_name FROM leads l LEFT JOIN people s ON s.id = l.sourced_by_id LEFT JOIN people o ON o.id = l.onboarding_id`;

  listLeads(includeRemoved = false): Lead[] {
    const where = includeRemoved ? '' : 'WHERE l.removed_at IS NULL';
    return this.db.prepare(`${Queries.LEAD_SELECT} ${where} ORDER BY l.row_no, l.name COLLATE NOCASE`).all().map((r) => this.rowToLead(r as Row));
  }

  getLead(id: number): Lead | null {
    const r = this.db.prepare(`${Queries.LEAD_SELECT} WHERE l.id = ?`).get(id) as Row | undefined;
    return r ? this.rowToLead(r) : null;
  }

  /**
   * Mirror the sheet: update or insert every row, mark rows that vanished as removed, and stamp
   * signed_at the first time a stage flips to signed. Sourced-by / onboarding set in the dashboard
   * survive syncs; a "Sourced By" / "Onboarding AM" column in the sheet fills them when it can be
   * matched to a team member.
   */
  upsertLeads(rows: SheetLead[], now = new Date().toISOString()): { added: number; updated: number; removed: number; newly_signed: string[] } {
    const people = this.listPeople();
    const existing = new Map<string, Row>();
    for (const r of this.db.prepare('SELECT * FROM leads').all() as Row[]) existing.set(r.key as string, r);
    const insert = this.db.prepare(`INSERT INTO leads (key, name, poc, stage, country, last_contact, notes, est_value, priority, row_no, added_on, sourced_by_id, onboarding_id, signed, signed_at, first_seen_at, last_seen_at, updated_at)
      VALUES (@key, @name, @poc, @stage, @country, @last_contact, @notes, @est_value, @priority, @row_no, @added_on, @sourced_by_id, @onboarding_id, @signed, @signed_at, @now, @now, @now)`);
    const update = this.db.prepare(`UPDATE leads SET name = @name, poc = @poc, stage = @stage, country = @country, last_contact = @last_contact, notes = @notes, est_value = @est_value, priority = @priority, row_no = @row_no,
      sourced_by_id = @sourced_by_id, onboarding_id = @onboarding_id, signed = @signed, signed_at = @signed_at, added_on = COALESCE(@sheet_added_on, added_on), last_seen_at = @now, removed_at = NULL, updated_at = CASE WHEN @changed THEN @now ELSE updated_at END WHERE id = @id`);
    const result = { added: 0, updated: 0, removed: 0, newly_signed: [] as string[] };
    this.db.transaction(() => {
      const seen = new Set<string>();
      for (const row of rows) {
        const key = leadKey(row.name);
        seen.add(key);
        const signed = isSignedStage(row.stage) ? 1 : 0;
        const prev = existing.get(key);
        const sourced = matchPerson(row.sourced_by, people)?.id ?? (prev?.sourced_by_id as number | null) ?? null;
        const onboarding = matchPerson(row.onboarding, people)?.id ?? (prev?.onboarding_id as number | null) ?? null;
        if (!prev) {
          insert.run({ key, ...row, added_on: row.added_on ?? now.slice(0, 10), sourced_by_id: sourced, onboarding_id: onboarding, signed, signed_at: signed ? now : null, now });
          result.added += 1;
          if (signed) result.newly_signed.push(row.name);
          continue;
        }
        const wasSigned = Boolean(prev.signed);
        const signedAt = signed ? ((prev.signed_at as string | null) ?? now) : null;
        const fields: (keyof SheetLead)[] = ['name', 'poc', 'stage', 'country', 'last_contact', 'notes', 'est_value', 'priority'];
        const changed = fields.some((f) => (prev[f] ?? null) !== (row[f] ?? null)) || (row.added_on !== null && row.added_on !== prev.added_on) || prev.sourced_by_id !== sourced || prev.onboarding_id !== onboarding || wasSigned !== Boolean(signed) || prev.removed_at !== null;
        update.run({ id: prev.id, ...row, sheet_added_on: row.added_on ?? null, sourced_by_id: sourced, onboarding_id: onboarding, signed, signed_at: signedAt, now, changed: changed ? 1 : 0 });
        if (changed) result.updated += 1;
        if (signed && !wasSigned) result.newly_signed.push(row.name);
      }
      const remove = this.db.prepare('UPDATE leads SET removed_at = ?, updated_at = ? WHERE key = ? AND removed_at IS NULL');
      for (const [key, r] of existing) if (!seen.has(key) && r.removed_at === null) result.removed += remove.run(now, now, key).changes;
    })();
    return result;
  }

  patchLead(id: number, patch: { sourced_by_id?: number | null; onboarding_id?: number | null; added_on?: string | null }): Lead | null {
    const sets: string[] = [];
    if (patch.sourced_by_id !== undefined) sets.push('sourced_by_id = @sourced_by_id');
    if (patch.onboarding_id !== undefined) sets.push('onboarding_id = @onboarding_id');
    if (patch.added_on !== undefined) sets.push('added_on = @added_on');
    if (sets.length) this.db.prepare(`UPDATE leads SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run({ ...patch, id, now: new Date().toISOString() });
    return this.getLead(id);
  }

  // ---- BD pipeline ----

  private rowToContact(r: Row): BdContact {
    return {
      id: r.id as number,
      prospect_id: r.prospect_id as number,
      name: r.name as string,
      title: (r.title as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      linkedin_url: (r.linkedin_url as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      source: (r.source as BdContact['source']) ?? 'manual',
      apollo_id: (r.apollo_id as string | null) ?? null,
      enriched: Boolean(r.enriched),
      notes: (r.notes as string | null) ?? null,
      linkedin_status: ((r.linkedin_status as string | null) ?? 'none') as BdContact['linkedin_status'],
      linkedin_requested_at: (r.linkedin_requested_at as string | null) ?? null,
      linkedin_connected_at: (r.linkedin_connected_at as string | null) ?? null,
      linkedin_messaged_at: (r.linkedin_messaged_at as string | null) ?? null,
      created_at: r.created_at as string,
    };
  }

  /** Move a contact along the LinkedIn sequence and stamp the step. */
  setContactLinkedin(id: number, status: BdContact['linkedin_status'], at = new Date().toISOString()): BdContact | null {
    const col = status === 'requested' ? 'linkedin_requested_at' : status === 'connected' ? 'linkedin_connected_at' : status === 'messaged' ? 'linkedin_messaged_at' : null;
    this.db.prepare(`UPDATE bd_contacts SET linkedin_status = ?${col ? `, ${col} = COALESCE(${col}, ?)` : ''} WHERE id = ?`).run(...(col ? [status, at, id] : [status, id]));
    return this.getContact(id);
  }

  private rowToOutreach(r: Row): BdOutreachEvent {
    return { id: r.id as number, prospect_id: r.prospect_id as number, channel: (r.channel as BdOutreachEvent['channel']) ?? null, action: r.action as BdOutreachEvent['action'], note: (r.note as string | null) ?? null, contact_name: (r.contact_name as string | null) ?? null, actor: (r.actor as string | null) ?? null, created_at: r.created_at as string };
  }

  private rowToProspect(r: Row, contacts: BdContact[], outreachLog: BdOutreachEvent[] = [], outreachCount = outreachLog.length): BdProspect {
    const o = { outreach_tts_am: Boolean(r.outreach_tts_am), outreach_gmail: Boolean(r.outreach_gmail), outreach_linkedin: Boolean(r.outreach_linkedin) };
    return {
      id: r.id as number,
      seller_id: (r.seller_id as string | null) ?? null,
      shop_name: r.shop_name as string,
      brand: (r.brand as string | null) ?? null,
      market: r.market as string,
      category: (r.category as string | null) ?? null,
      gmv_7d: (r.gmv_7d as number | null) ?? null,
      gmv_total: (r.gmv_total as number | null) ?? null,
      units_7d: (r.units_7d as number | null) ?? null,
      units_total: (r.units_total as number | null) ?? null,
      currency: (r.currency as string) ?? 'EUR',
      shop_type: (r.shop_type as string | null) ?? null,
      tiktok_handle: (r.tiktok_handle as string | null) ?? null,
      rating: (r.rating as number | null) ?? null,
      products: (r.products as number | null) ?? null,
      rise_score: riseScore(r.gmv_7d as number | null, r.gmv_total as number | null),
      launched_at: (r.launched_at as string | null) ?? null,
      gmv_started_at: (r.gmv_started_at as string | null) ?? null,
      ...launchFlags({ launched_at: (r.launched_at as string | null) ?? null, gmv_started_at: (r.gmv_started_at as string | null) ?? null, gmv_7d: (r.gmv_7d as number | null) ?? null, gmv_total: (r.gmv_total as number | null) ?? null }),
      fastmoss_url: fastmossShopUrl(r.seller_id as string | null),
      is_client: Boolean(r.is_client),
      domain: (r.domain as string | null) ?? null,
      website: (r.website as string | null) ?? null,
      apollo_org_id: (r.apollo_org_id as string | null) ?? null,
      company_industry: (r.company_industry as string | null) ?? null,
      company_employees: r.company_employees === null || r.company_employees === undefined ? null : Number(r.company_employees),
      company_linkedin: (r.company_linkedin as string | null) ?? null,
      company_location: (r.company_location as string | null) ?? null,
      company_description: (r.company_description as string | null) ?? null,
      enriched_at: (r.enriched_at as string | null) ?? null,
      enrich_note: (r.enrich_note as string | null) ?? null,
      status: (r.status as BdProspect['status']) ?? 'new',
      owner_id: (r.owner_id as number | null) ?? null,
      owner_name: (r.owner_name as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      tts_am_contact_id: (r.tts_am_contact_id as number | null) ?? null,
      ...o,
      outreach_tts_am_at: (r.outreach_tts_am_at as string | null) ?? null,
      outreach_gmail_at: (r.outreach_gmail_at as string | null) ?? null,
      outreach_linkedin_at: (r.outreach_linkedin_at as string | null) ?? null,
      outreach_complete: outreachComplete(o),
      source: (r.source as string) ?? 'manual',
      pulled_at: (r.pulled_at as string | null) ?? null,
      archived: Boolean(r.archived),
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
      contacts,
      outreach_log: outreachLog,
      outreach_count: outreachCount,
    };
  }

  private static PROSPECT_SELECT = `SELECT p.*, o.name AS owner_name, (p.notes LIKE 'Existing client%') AS is_client FROM bd_prospects p LEFT JOIN people o ON o.id = p.owner_id`;

  /**
   * Every prospect with its contacts and outreach history. `logLimit` keeps only the newest events per prospect
   * (the page shows the latest few and the count); server jobs that read the whole history leave it unset.
   */
  listProspects(includeArchived = false, opts: { logLimit?: number } = {}): BdProspect[] {
    const contacts = new Map<number, BdContact[]>();
    for (const r of this.db.prepare('SELECT * FROM bd_contacts ORDER BY enriched DESC, id').all() as Row[]) {
      const c = this.rowToContact(r);
      const list = contacts.get(c.prospect_id);
      if (list) list.push(c); else contacts.set(c.prospect_id, [c]);
    }
    const logs = new Map<number, BdOutreachEvent[]>();
    const logSql = opts.logLimit
      ? `SELECT * FROM (SELECT l.*, ROW_NUMBER() OVER (PARTITION BY prospect_id ORDER BY created_at DESC, id DESC) AS rn FROM bd_outreach_log l) WHERE rn <= ${Math.max(1, Math.floor(opts.logLimit))} ORDER BY created_at DESC, id DESC`
      : 'SELECT * FROM bd_outreach_log ORDER BY created_at DESC, id DESC';
    for (const r of this.db.prepare(logSql).all() as Row[]) {
      const e = this.rowToOutreach(r);
      const list = logs.get(e.prospect_id);
      if (list) list.push(e); else logs.set(e.prospect_id, [e]);
    }
    const counts = new Map<number, number>();
    if (opts.logLimit) for (const r of this.db.prepare('SELECT prospect_id, COUNT(*) AS n FROM bd_outreach_log GROUP BY prospect_id').all() as Row[]) counts.set(r.prospect_id as number, Number(r.n));
    const where = includeArchived ? '' : 'WHERE p.archived = 0';
    return (this.db.prepare(`${Queries.PROSPECT_SELECT} ${where} ORDER BY p.market, p.gmv_7d DESC, p.shop_name COLLATE NOCASE`).all() as Row[]).map((r) => {
      const id = r.id as number;
      const log = logs.get(id) ?? [];
      return this.rowToProspect(r, contacts.get(id) ?? [], log, opts.logLimit ? counts.get(id) ?? 0 : log.length);
    });
  }

  getProspect(id: number): BdProspect | null {
    const r = this.db.prepare(`${Queries.PROSPECT_SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
    if (!r) return null;
    const contacts = (this.db.prepare('SELECT * FROM bd_contacts WHERE prospect_id = ? ORDER BY enriched DESC, id').all(id) as Row[]).map((c) => this.rowToContact(c));
    const log = (this.db.prepare('SELECT * FROM bd_outreach_log WHERE prospect_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(id) as Row[]).map((e) => this.rowToOutreach(e));
    const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM bd_outreach_log WHERE prospect_id = ?').get(id) as { n: number }).n);
    return this.rowToProspect(r, contacts, log, count);
  }

  /** Insert new shops or refresh the numbers of ones we already track (by seller id). Never touches status, owner or outreach. */
  upsertProspects(rows: BdProspectInput[]): { added: number; updated: number } {
    const insert = this.db.prepare(`INSERT INTO bd_prospects (seller_id, shop_name, brand, market, category, gmv_7d, gmv_total, units_7d, units_total, currency, shop_type, tiktok_handle, rating, products, domain, website, notes, source, pulled_at, launched_at, gmv_started_at)
      VALUES (@seller_id, @shop_name, @brand, @market, @category, @gmv_7d, @gmv_total, @units_7d, @units_total, @currency, @shop_type, @tiktok_handle, @rating, @products, @domain, @website, @notes, @source, @pulled_at, @launched_at, @gmv_started_at)`);
    const update = this.db.prepare(`UPDATE bd_prospects SET shop_name = @shop_name, brand = COALESCE(@brand, brand), category = COALESCE(@category, category), gmv_7d = @gmv_7d, gmv_total = @gmv_total, units_7d = @units_7d, units_total = @units_total,
      currency = @currency, shop_type = COALESCE(@shop_type, shop_type), tiktok_handle = COALESCE(@tiktok_handle, tiktok_handle), rating = COALESCE(@rating, rating), products = COALESCE(@products, products), domain = COALESCE(domain, @domain), website = COALESCE(website, @website),
      pulled_at = @pulled_at, launched_at = COALESCE(@launched_at, launched_at), gmv_started_at = COALESCE(@gmv_started_at, gmv_started_at), archived = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE seller_id = @seller_id`);
    const result = { added: 0, updated: 0 };
    this.db.transaction(() => {
      for (const r of rows) {
        const row = {
          seller_id: r.seller_id ?? null,
          shop_name: r.shop_name,
          brand: r.brand ?? null,
          market: r.market,
          category: r.category ?? null,
          gmv_7d: r.gmv_7d ?? null,
          gmv_total: r.gmv_total ?? null,
          units_7d: r.units_7d ?? null,
          units_total: r.units_total ?? null,
          currency: r.currency ?? (r.market === 'UK' ? 'GBP' : 'EUR'),
          shop_type: r.shop_type ?? null,
          tiktok_handle: r.tiktok_handle ?? null,
          rating: r.rating ?? null,
          products: r.products ?? null,
          domain: r.domain ?? null,
          website: r.website ?? null,
          notes: r.notes ?? null,
          source: r.source ?? 'manual',
          pulled_at: r.pulled_at ?? null,
          launched_at: r.launched_at ?? null,
          gmv_started_at: r.gmv_started_at ?? null,
        };
        if (row.seller_id && update.run(row).changes) result.updated += 1;
        else {
          insert.run(row);
          result.added += 1;
        }
      }
    })();
    this.markExistingClients();
    return result;
  }

  /** Shops that are already roster accounts are not prospects: mark them won with a note, once. */
  markExistingClients(): number {
    const accounts = this.listAccounts().map((a) => a.name);
    const rows = this.db.prepare(`SELECT id, shop_name, brand FROM bd_prospects WHERE status = 'new' AND (notes IS NULL OR notes NOT LIKE 'Existing client%')`).all() as { id: number; shop_name: string; brand: string | null }[];
    const upd = this.db.prepare(`UPDATE bd_prospects SET status = 'won', notes = ?, updated_at = ? WHERE id = ?`);
    let n = 0;
    for (const r of rows) {
      const hit = accounts.find((a) => matchesAccountName(r.shop_name, a) || (r.brand ? matchesAccountName(r.brand, a) : false));
      if (hit) n += upd.run(`Existing client (${hit} on the roster)`, new Date().toISOString(), r.id).changes;
    }
    return n;
  }

  createProspect(input: BdProspectInput): BdProspect {
    const r = this.upsertProspects([input]);
    const id = r.added ? (this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id : (this.db.prepare('SELECT id FROM bd_prospects WHERE seller_id = ?').get(input.seller_id) as { id: number }).id;
    return this.getProspect(id)!;
  }

  patchProspect(id: number, patch: BdProspectPatch, actor?: string | null): BdProspect | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: new Date().toISOString() };
    const simple: (keyof BdProspectPatch)[] = ['status', 'owner_id', 'notes', 'tts_am_contact_id', 'domain', 'website', 'launched_at', 'gmv_started_at', 'apollo_org_id', 'company_industry', 'company_employees', 'company_linkedin', 'company_location', 'company_description', 'enriched_at', 'enrich_note'];
    for (const k of simple) {
      if (patch[k] !== undefined) {
        sets.push(`${k} = @${k}`);
        params[k] = patch[k];
      }
    }
    if (patch.archived !== undefined) {
      sets.push('archived = @archived');
      params.archived = patch.archived ? 1 : 0;
    }
    const before = this.getProspect(id);
    if (!before) return null;
    const events: { channel: BdOutreachEvent['channel']; action: BdOutreachEvent['action']; note: string | null }[] = [];
    for (const ch of ['tts_am', 'gmail', 'linkedin'] as const) {
      const v = patch[`outreach_${ch}`];
      if (v === undefined) continue;
      sets.push(`outreach_${ch} = @o_${ch}`, `outreach_${ch}_at = CASE WHEN @o_${ch} = 1 THEN COALESCE(outreach_${ch}_at, @now) ELSE NULL END`);
      params[`o_${ch}`] = v ? 1 : 0;
      if (Boolean(v) !== before[`outreach_${ch}`]) events.push({ channel: ch, action: v ? 'contacted' : 'uncontacted', note: patch.outreach_note ?? null });
    }
    if (patch.status !== undefined && patch.status !== before.status) events.push({ channel: null, action: patch.status === 'replied' || patch.status === 'meeting' ? 'replied' : 'status', note: `Status: ${before.status} → ${patch.status}${patch.outreach_note ? ` (${patch.outreach_note})` : ''}` });
    if (sets.length) this.db.prepare(`UPDATE bd_prospects SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
    for (const e of events) this.logOutreach(id, { ...e, contact_name: patch.outreach_contact ?? null, actor: actor ?? null });
    if (!events.length && patch.outreach_note) this.logOutreach(id, { channel: null, action: 'note', note: patch.outreach_note, contact_name: patch.outreach_contact ?? null, actor: actor ?? null });
    return this.getProspect(id);
  }

  logOutreach(prospectId: number, e: { channel: BdOutreachEvent['channel']; action: BdOutreachEvent['action']; note: string | null; contact_name?: string | null; actor?: string | null }): BdOutreachEvent {
    const info = this.db.prepare(`INSERT INTO bd_outreach_log (prospect_id, channel, action, note, contact_name, actor) VALUES (?, ?, ?, ?, ?, ?)`).run(prospectId, e.channel, e.action, e.note, e.contact_name ?? null, e.actor ?? null);
    return this.rowToOutreach(this.db.prepare('SELECT * FROM bd_outreach_log WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
  }

  deleteOutreachEvent(id: number): boolean {
    return this.db.prepare('DELETE FROM bd_outreach_log WHERE id = ?').run(id).changes > 0;
  }

  // ---- Email drafts (BD outreach) ----

  private rowToDraft(r: Row): BdEmailDraft {
    return {
      id: r.id as number, prospect_id: r.prospect_id as number, contact_id: (r.contact_id as number | null) ?? null,
      shop_name: (r.shop_name as string) ?? '', market: (r.market as string) ?? '',
      brand: (r.brand as string | null) ?? null, category: (r.category as string | null) ?? null, gmv_7d: (r.gmv_7d as number | null) ?? null, currency: (r.currency as string) ?? 'EUR',
      rise_band: riseBand(riseScore(r.gmv_7d as number | null, r.gmv_total as number | null)), prospect_status: ((r.prospect_status as string | null) ?? 'new') as BdEmailDraft['prospect_status'],
      to_name: r.to_name as string, to_email: r.to_email as string, subject: r.subject as string, body: r.body as string,
      language: r.language as string, style: r.style as BdEmailDraft['style'], status: r.status as BdEmailDraft['status'], generator: r.generator as BdEmailDraft['generator'],
      kind: ((r.kind as string | null) ?? 'cold') as BdEmailDraft['kind'], meeting_id: (r.meeting_id as string | null) ?? null, meeting_title: (r.meeting_title as string | null) ?? null,
      gmail_draft_id: (r.gmail_draft_id as string | null) ?? null, gmail_message_id: (r.gmail_message_id as string | null) ?? null, gmail_thread_id: (r.gmail_thread_id as string | null) ?? null, gmail_url: (r.gmail_url as string | null) ?? null,
      queued_at: (r.queued_at as string | null) ?? null, queued_by: (r.queued_by as string | null) ?? null, send_account: (r.send_account as string | null) ?? null, sent_at: (r.sent_at as string | null) ?? null, send_error: (r.send_error as string | null) ?? null,
      created_by: (r.created_by as string | null) ?? null, created_at: r.created_at as string, updated_at: r.updated_at as string,
    };
  }

  private static DRAFT_SELECT = `SELECT d.*, p.shop_name, p.market, p.brand, p.category, p.gmv_7d, p.gmv_total, p.currency, p.status AS prospect_status FROM bd_email_drafts d JOIN bd_prospects p ON p.id = d.prospect_id`;

  listDrafts(opts: { prospectId?: number; includeDiscarded?: boolean } = {}): BdEmailDraft[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.prospectId !== undefined) { where.push('d.prospect_id = ?'); params.push(opts.prospectId); }
    if (!opts.includeDiscarded) where.push(`d.status != 'discarded'`);
    const sql = `${Queries.DRAFT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY d.updated_at DESC`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.rowToDraft(r));
  }

  getDraft(id: number): BdEmailDraft | null {
    const r = this.db.prepare(`${Queries.DRAFT_SELECT} WHERE d.id = ?`).get(id) as Row | undefined;
    return r ? this.rowToDraft(r) : null;
  }

  createDraft(d: { prospect_id: number; contact_id: number | null; to_name: string; to_email: string; subject: string; body: string; language: string; style: BdEmailDraft['style']; generator: BdEmailDraft['generator']; created_by?: string | null; kind?: BdEmailDraft['kind']; meeting_id?: string | null; meeting_title?: string | null }): BdEmailDraft {
    const info = this.db
      .prepare(`INSERT INTO bd_email_drafts (prospect_id, contact_id, to_name, to_email, subject, body, language, style, generator, created_by, kind, meeting_id, meeting_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.prospect_id, d.contact_id, d.to_name, d.to_email, d.subject, d.body, d.language, d.style, d.generator, d.created_by ?? null, d.kind ?? 'cold', d.meeting_id ?? null, d.meeting_title ?? null);
    return this.getDraft(Number(info.lastInsertRowid))!;
  }

  draftForMeeting(meetingId: string): BdEmailDraft | null {
    const r = this.db.prepare(`${Queries.DRAFT_SELECT} WHERE d.meeting_id = ?`).get(meetingId) as Row | undefined;
    return r ? this.rowToDraft(r) : null;
  }

  updateDraft(id: number, patch: Partial<Pick<BdEmailDraft, 'subject' | 'body' | 'language' | 'style' | 'status' | 'generator' | 'gmail_draft_id' | 'gmail_message_id' | 'gmail_thread_id' | 'gmail_url' | 'to_email' | 'to_name' | 'queued_at' | 'queued_by' | 'send_account' | 'sent_at' | 'send_error'>>): BdEmailDraft | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = @${k}`);
      params[k] = v;
    }
    if (sets.length) this.db.prepare(`UPDATE bd_email_drafts SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
    return this.getDraft(id);
  }

  deleteDraft(id: number): boolean {
    return this.db.prepare('DELETE FROM bd_email_drafts WHERE id = ?').run(id).changes > 0;
  }

  // ---- Outreach voice examples ----

  private rowToExample(r: Row): OutreachExample {
    return { id: r.id as number, subject: r.subject as string, body: r.body as string, kind: r.kind as OutreachExample['kind'], to_domain: (r.to_domain as string | null) ?? null, sent_at: (r.sent_at as string | null) ?? null, source: r.source as OutreachExample['source'], gmail_id: (r.gmail_id as string | null) ?? null, enabled: Boolean(r.enabled) };
  }

  listExamples(enabledOnly = false): OutreachExample[] {
    return (this.db.prepare(`SELECT * FROM outreach_examples${enabledOnly ? ' WHERE enabled = 1' : ''} ORDER BY COALESCE(sent_at, created_at) DESC, id DESC`).all() as Row[]).map((r) => this.rowToExample(r));
  }

  /** Insert an example; one with a gmail_id that already exists is skipped (returns null). */
  addExample(e: { subject: string; body: string; kind?: OutreachExample['kind']; to_domain?: string | null; sent_at?: string | null; source?: OutreachExample['source']; gmail_id?: string | null }): OutreachExample | null {
    if (e.gmail_id && this.db.prepare('SELECT 1 FROM outreach_examples WHERE gmail_id = ?').get(e.gmail_id)) return null;
    const info = this.db
      .prepare(`INSERT INTO outreach_examples (subject, body, kind, to_domain, sent_at, source, gmail_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(e.subject, e.body, e.kind ?? 'cold', e.to_domain ?? null, e.sent_at ?? null, e.source ?? 'manual', e.gmail_id ?? null);
    return this.rowToExample(this.db.prepare('SELECT * FROM outreach_examples WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
  }

  setExampleEnabled(id: number, enabled: boolean): boolean {
    return this.db.prepare('UPDATE outreach_examples SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
  }

  deleteExample(id: number): boolean {
    return this.db.prepare('DELETE FROM outreach_examples WHERE id = ?').run(id).changes > 0;
  }

  // ---- Follow-ups (BD sequence reminders) ----

  private rowToFollowup(r: Row, now = Date.now()): BdFollowup {
    return { id: r.id as number, prospect_id: r.prospect_id as number, contact_id: (r.contact_id as number | null) ?? null, shop_name: (r.shop_name as string) ?? '', contact_name: (r.contact_name as string | null) ?? null, linkedin_url: (r.linkedin_url as string | null) ?? null, kind: r.kind as BdFollowup['kind'], title: r.title as string, due_at: r.due_at as string, done_at: (r.done_at as string | null) ?? null, note: (r.note as string | null) ?? null, created_by: (r.created_by as string | null) ?? null, created_at: r.created_at as string, overdue: !r.done_at && Date.parse(r.due_at as string) < now };
  }

  private static FOLLOWUP_SELECT = `SELECT f.*, p.shop_name, c.name AS contact_name, c.linkedin_url FROM bd_followups f JOIN bd_prospects p ON p.id = f.prospect_id LEFT JOIN bd_contacts c ON c.id = f.contact_id`;

  listFollowups(opts: { includeDone?: boolean; prospectId?: number } = {}): BdFollowup[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeDone) where.push('f.done_at IS NULL');
    if (opts.prospectId !== undefined) { where.push('f.prospect_id = ?'); params.push(opts.prospectId); }
    return (this.db.prepare(`${Queries.FOLLOWUP_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY f.done_at IS NOT NULL, f.due_at`).all(...params) as Row[]).map((r) => this.rowToFollowup(r));
  }

  getFollowup(id: number): BdFollowup | null {
    const r = this.db.prepare(`${Queries.FOLLOWUP_SELECT} WHERE f.id = ?`).get(id) as Row | undefined;
    return r ? this.rowToFollowup(r) : null;
  }

  addFollowup(f: { prospect_id: number; contact_id?: number | null; kind: BdFollowup['kind']; title: string; due_at: string; note?: string | null; created_by?: string | null }): BdFollowup {
    // One open follow-up of a kind per contact: refresh the existing one instead of stacking.
    const existing = this.db.prepare(`SELECT id FROM bd_followups WHERE prospect_id = ? AND contact_id IS ? AND kind = ? AND done_at IS NULL`).get(f.prospect_id, f.contact_id ?? null, f.kind) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE bd_followups SET title = ?, due_at = ?, note = COALESCE(?, note) WHERE id = ?`).run(f.title, f.due_at, f.note ?? null, existing.id);
      return this.getFollowup(existing.id)!;
    }
    const info = this.db.prepare(`INSERT INTO bd_followups (prospect_id, contact_id, kind, title, due_at, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(f.prospect_id, f.contact_id ?? null, f.kind, f.title, f.due_at, f.note ?? null, f.created_by ?? null);
    return this.getFollowup(Number(info.lastInsertRowid))!;
  }

  completeFollowup(id: number, note?: string | null): BdFollowup | null {
    this.db.prepare(`UPDATE bd_followups SET done_at = ?, note = COALESCE(?, note) WHERE id = ? AND done_at IS NULL`).run(new Date().toISOString(), note ?? null, id);
    return this.getFollowup(id);
  }

  /** Close open follow-ups of the given kinds for a contact (the step happened). */
  closeFollowups(contactId: number, kinds: BdFollowup['kind'][]): number {
    if (!kinds.length) return 0;
    return this.db.prepare(`UPDATE bd_followups SET done_at = ? WHERE contact_id = ? AND done_at IS NULL AND kind IN (${kinds.map(() => '?').join(',')})`).run(new Date().toISOString(), contactId, ...kinds).changes;
  }

  snoozeFollowup(id: number, dueAt: string): BdFollowup | null {
    this.db.prepare(`UPDATE bd_followups SET due_at = ? WHERE id = ?`).run(dueAt, id);
    return this.getFollowup(id);
  }

  // ---- TikTok Shop contacts (who to loop in per market / category) ----

  private rowToTtsContact(r: Row): TtsContact {
    return { id: r.id as number, market: r.market as string, category: (r.category as string | null) ?? null, name: r.name as string, role: (r.role as string | null) ?? null, lark: (r.lark as string | null) ?? null, email: (r.email as string | null) ?? null, notes: (r.notes as string | null) ?? null, is_agency_manager: Boolean(r.is_agency_manager) };
  }

  listTtsContacts(): TtsContact[] {
    return (this.db.prepare('SELECT * FROM tts_contacts ORDER BY market, is_agency_manager DESC, category NULLS FIRST, name').all() as Row[]).map((r) => this.rowToTtsContact(r));
  }

  saveTtsContact(c: Partial<TtsContact> & { market: string; name: string }): TtsContact {
    if (c.id) {
      this.db.prepare(`UPDATE tts_contacts SET market = ?, category = ?, name = ?, role = ?, lark = ?, email = ?, notes = ?, is_agency_manager = ? WHERE id = ?`).run(c.market, c.category ?? null, c.name, c.role ?? null, c.lark ?? null, c.email ?? null, c.notes ?? null, c.is_agency_manager ? 1 : 0, c.id);
      return this.rowToTtsContact(this.db.prepare('SELECT * FROM tts_contacts WHERE id = ?').get(c.id) as Row);
    }
    const info = this.db.prepare(`INSERT INTO tts_contacts (market, category, name, role, lark, email, notes, is_agency_manager) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(c.market, c.category ?? null, c.name, c.role ?? null, c.lark ?? null, c.email ?? null, c.notes ?? null, c.is_agency_manager ? 1 : 0);
    return this.rowToTtsContact(this.db.prepare('SELECT * FROM tts_contacts WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
  }

  deleteTtsContact(id: number): boolean {
    return this.db.prepare('DELETE FROM tts_contacts WHERE id = ?').run(id).changes > 0;
  }

  // ---- Lark messages to TikTok Shop AMs / TSP managers ----

  private static LARK_SELECT = `SELECT m.*, p.shop_name, p.brand, p.market, c.name AS contact_name, c.role AS contact_role, c.lark AS contact_lark FROM bd_lark_messages m JOIN bd_prospects p ON p.id = m.prospect_id LEFT JOIN tts_contacts c ON c.id = m.contact_id`;

  private rowToLark(r: Row): LarkMessage {
    let facts: string[] = [];
    try { const v = JSON.parse((r.facts_json as string) || '[]'); if (Array.isArray(v)) facts = v.map(String); } catch { facts = []; }
    return {
      id: r.id as number,
      prospect_id: r.prospect_id as number,
      shop_name: r.shop_name as string,
      brand: (r.brand as string | null) ?? null,
      market: r.market as string,
      contact_id: (r.contact_id as number | null) ?? null,
      contact_name: (r.contact_name as string | null) ?? null,
      contact_role: (r.contact_role as string | null) ?? null,
      contact_lark: (r.contact_lark as string | null) ?? null,
      confidence: r.confidence === 'known' ? 'known' : 'tsp',
      reason: (r.reason as string | null) ?? null,
      body: r.body as string,
      facts,
      generator: r.generator === 'claude' ? 'claude' : 'template',
      status: (r.status as LarkMessage['status']) ?? 'draft',
      scheduled_for: (r.scheduled_for as string | null) ?? null,
      sent_at: (r.sent_at as string | null) ?? null,
      sent_by: (r.sent_by as string | null) ?? null,
      created_by: (r.created_by as string | null) ?? null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  createLarkMessage(m: { prospect_id: number; contact_id: number | null; confidence: LarkMessage['confidence']; reason: string | null; body: string; facts: string[]; generator: LarkMessage['generator']; created_by: string | null }): LarkMessage {
    const info = this.db.prepare(`INSERT INTO bd_lark_messages (prospect_id, contact_id, confidence, reason, body, facts_json, generator, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(m.prospect_id, m.contact_id, m.confidence, m.reason, m.body, JSON.stringify(m.facts), m.generator, m.created_by);
    return this.getLarkMessage(Number(info.lastInsertRowid))!;
  }

  getLarkMessage(id: number): LarkMessage | null {
    const r = this.db.prepare(`${Queries.LARK_SELECT} WHERE m.id = ?`).get(id) as Row | undefined;
    return r ? this.rowToLark(r) : null;
  }

  /** Every Lark message that is not discarded: due ones first, then drafts, then sent (newest first). */
  listLarkMessages(opts: { includeDiscarded?: boolean } = {}): LarkMessage[] {
    const where = opts.includeDiscarded ? '' : ` WHERE m.status != 'discarded'`;
    return (this.db.prepare(`${Queries.LARK_SELECT}${where} ORDER BY CASE m.status WHEN 'scheduled' THEN 0 WHEN 'draft' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END, m.scheduled_for, m.sent_at DESC, m.id DESC`).all() as Row[]).map((r) => this.rowToLark(r));
  }

  updateLarkMessage(id: number, patch: Partial<Pick<LarkMessage, 'body' | 'contact_id' | 'confidence' | 'reason' | 'status' | 'scheduled_for' | 'sent_at' | 'sent_by' | 'facts' | 'generator'>>): LarkMessage | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: new Date().toISOString() };
    for (const k of ['body', 'contact_id', 'confidence', 'reason', 'status', 'scheduled_for', 'sent_at', 'sent_by', 'generator'] as const) {
      if (patch[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = patch[k]; }
    }
    if (patch.facts !== undefined) { sets.push('facts_json = @facts_json'); params.facts_json = JSON.stringify(patch.facts); }
    if (!sets.length) return this.getLarkMessage(id);
    this.db.prepare(`UPDATE bd_lark_messages SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
    return this.getLarkMessage(id);
  }

  deleteLarkMessage(id: number): boolean {
    return this.db.prepare('DELETE FROM bd_lark_messages WHERE id = ?').run(id).changes > 0;
  }

  // ---- Enterprise watchlist and alerts ----

  listWatchlist(): WatchlistEntry[] {
    return (this.db.prepare('SELECT * FROM bd_watchlist ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => ({ id: r.id as number, name: r.name as string, source: r.source as WatchlistEntry['source'], enabled: Boolean(r.enabled) }));
  }

  addWatchlist(name: string, source: WatchlistEntry['source'] = 'manual'): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO bd_watchlist (name, source) VALUES (?, ?)`).run(name.trim(), source).changes > 0;
  }

  setWatchlist(id: number, enabled: boolean): boolean {
    return this.db.prepare('UPDATE bd_watchlist SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
  }

  deleteWatchlist(id: number): boolean {
    return this.db.prepare('DELETE FROM bd_watchlist WHERE id = ?').run(id).changes > 0;
  }

  private static ALERT_SELECT = `SELECT a.*, p.shop_name, p.market, p.launched_at, p.gmv_7d, p.currency FROM bd_alerts a JOIN bd_prospects p ON p.id = a.prospect_id`;

  listAlerts(includeDismissed = false): BdAlert[] {
    return (this.db.prepare(`${Queries.ALERT_SELECT}${includeDismissed ? '' : ' WHERE a.dismissed_at IS NULL'} ORDER BY a.created_at DESC`).all() as Row[]).map((r) => ({ id: r.id as number, prospect_id: r.prospect_id as number, shop_name: r.shop_name as string, market: r.market as string, kind: r.kind as BdAlert['kind'], watch_name: (r.watch_name as string | null) ?? null, message: r.message as string, created_at: r.created_at as string, dismissed_at: (r.dismissed_at as string | null) ?? null, launched_at: (r.launched_at as string | null) ?? null, gmv_7d: (r.gmv_7d as number | null) ?? null, currency: (r.currency as string) ?? 'EUR' }));
  }

  addAlert(a: { prospect_id: number; kind: BdAlert['kind']; watch_name: string | null; message: string }): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO bd_alerts (prospect_id, kind, watch_name, message) VALUES (?, ?, ?, ?)`).run(a.prospect_id, a.kind, a.watch_name, a.message).changes > 0;
  }

  dismissAlert(id: number): boolean {
    return this.db.prepare('UPDATE bd_alerts SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL').run(new Date().toISOString(), id).changes > 0;
  }

  // ---- BD activity tracker ----

  bdActivity(days = 30): BdActivity {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = new Map<string, BdActivityRow>();
    const row = (actor: string | null) => {
      const key = actor?.trim() || 'unknown';
      let r = rows.get(key);
      if (!r) { r = { actor: key, contacted: 0, tts_am: 0, gmail: 0, linkedin: 0, notes: 0, drafts: 0, emails_sent: 0, linkedin_requests: 0, linkedin_connected: 0, replies: 0, meetings: 0, prospects_touched: 0, last_active_at: null }; rows.set(key, r); }
      return r;
    };
    const touched = new Map<string, Set<number>>();
    const weekOf = (iso: string) => { const d = new Date(iso); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };
    const weekly = new Map<string, { week: string; contacted: number; emails_sent: number; linkedin_requests: number; replies: number }>();
    const wk = (iso: string) => { const w = weekOf(iso); let x = weekly.get(w); if (!x) { x = { week: w, contacted: 0, emails_sent: 0, linkedin_requests: 0, replies: 0 }; weekly.set(w, x); } return x; };
    for (const e of this.db.prepare('SELECT * FROM bd_outreach_log WHERE created_at >= ?').all(since) as Row[]) {
      const r = row(e.actor as string | null);
      const at = e.created_at as string;
      r.last_active_at = !r.last_active_at || at > r.last_active_at ? at : r.last_active_at;
      (touched.get(r.actor) ?? touched.set(r.actor, new Set()).get(r.actor)!).add(e.prospect_id as number);
      const note = String(e.note ?? '');
      if (e.action === 'contacted') {
        r.contacted += 1; wk(at).contacted += 1;
        if (e.channel === 'tts_am') r.tts_am += 1; else if (e.channel === 'gmail') { r.gmail += 1; if (/^Sent /.test(note)) { r.emails_sent += 1; wk(at).emails_sent += 1; } } else if (e.channel === 'linkedin') { r.linkedin += 1; if (/connection request/i.test(note)) { r.linkedin_requests += 1; wk(at).linkedin_requests += 1; } }
      } else if (e.action === 'note') {
        r.notes += 1;
        if (/accepted the LinkedIn/i.test(note)) r.linkedin_connected += 1;
      } else if (e.action === 'replied') { r.replies += 1; wk(at).replies += 1; if (/→ meeting/.test(note)) r.meetings += 1; }
      else if (e.action === 'status' && /→ meeting/.test(note)) r.meetings += 1;
    }
    for (const d of this.db.prepare('SELECT created_by, prospect_id, created_at FROM bd_email_drafts WHERE created_at >= ?').all(since) as Row[]) {
      const r = row(d.created_by as string | null);
      r.drafts += 1;
      (touched.get(r.actor) ?? touched.set(r.actor, new Set()).get(r.actor)!).add(d.prospect_id as number);
    }
    for (const r of rows.values()) r.prospects_touched = touched.get(r.actor)?.size ?? 0;
    const list = [...rows.values()].sort((a, b) => b.contacted + b.drafts - (a.contacted + a.drafts));
    const totals = list.reduce((t, r) => ({ contacted: t.contacted + r.contacted, emails_sent: t.emails_sent + r.emails_sent, linkedin_requests: t.linkedin_requests + r.linkedin_requests, replies: t.replies + r.replies, meetings: t.meetings + r.meetings }), { contacted: 0, emails_sent: 0, linkedin_requests: 0, replies: 0, meetings: 0 });
    return { days, rows: list, weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)), totals };
  }

  // ---- Account monitor flags ----

  private rowToFlag(r: Row): MonitorFlag {
    return { id: r.id as number, account_id: (r.account_id as number | null) ?? null, account_name: (r.account_name as string | null) ?? null, shop_id: (r.shop_id as string | null) ?? null, code: r.code as string, severity: r.severity as MonitorFlag['severity'], message: r.message as string, detail: (r.detail as string | null) ?? null, first_seen_at: r.first_seen_at as string, last_seen_at: r.last_seen_at as string, resolved_at: (r.resolved_at as string | null) ?? null, acknowledged_at: (r.acknowledged_at as string | null) ?? null };
  }

  listFlags(includeResolved = false): MonitorFlag[] {
    return (this.db.prepare(`SELECT f.*, a.name AS account_name FROM monitor_flags f LEFT JOIN accounts a ON a.id = f.account_id${includeResolved ? '' : ' WHERE f.resolved_at IS NULL'} ORDER BY CASE f.severity WHEN 'crit' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, f.last_seen_at DESC`).all() as Row[]).map((r) => this.rowToFlag(r));
  }

  /** Replace the open flags found by a scan: matching open ones get last_seen bumped, missing ones are resolved, new ones inserted. */
  applyScan(found: { account_id: number | null; shop_id: string | null; code: string; severity: MonitorFlag['severity']; message: string; detail?: string | null }[], scope: { account_ids?: number[]; codes?: string[] } = {}): { opened: number; resolved: number } {
    const now = new Date().toISOString();
    // Only flags inside the scope (these accounts, these rule codes) can be resolved by this scan; the rest are left as they are.
    const codes = scope.codes ? new Set(scope.codes) : null;
    const open = this.listFlags(false).filter((f) => (!scope.account_ids || (f.account_id !== null && scope.account_ids.includes(f.account_id))) && (!codes || codes.has(f.code)));
    const key = (f: { account_id: number | null; shop_id: string | null; code: string }) => `${f.account_id ?? ''}|${f.shop_id ?? ''}|${f.code}`;
    const seen = new Set<string>();
    let opened = 0;
    const upd = this.db.prepare('UPDATE monitor_flags SET last_seen_at = ?, message = ?, detail = ?, severity = ? WHERE id = ?');
    const ins = this.db.prepare('INSERT INTO monitor_flags (account_id, shop_id, code, severity, message, detail, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const f of found) {
      const k = key(f);
      seen.add(k);
      const existing = open.find((o) => key(o) === k);
      if (existing) upd.run(now, f.message, f.detail ?? null, f.severity, existing.id);
      else { ins.run(f.account_id, f.shop_id, f.code, f.severity, f.message, f.detail ?? null, now, now); opened += 1; }
    }
    let resolved = 0;
    const res = this.db.prepare('UPDATE monitor_flags SET resolved_at = ? WHERE id = ?');
    for (const o of open) if (!seen.has(key(o))) { res.run(now, o.id); resolved += 1; }
    return { opened, resolved };
  }

  acknowledgeFlag(id: number): boolean {
    return this.db.prepare('UPDATE monitor_flags SET acknowledged_at = ? WHERE id = ?').run(new Date().toISOString(), id).changes > 0;
  }

  listFlagsBetween(from: string, to: string): MonitorFlag[] {
    return (this.db.prepare('SELECT f.*, a.name AS account_name FROM monitor_flags f LEFT JOIN accounts a ON a.id = f.account_id WHERE substr(f.first_seen_at, 1, 10) <= ? AND (f.resolved_at IS NULL OR substr(f.resolved_at, 1, 10) >= ?) ORDER BY f.first_seen_at').all(to, from) as Row[]).map((r) => this.rowToFlag(r));
  }

  // ---- Website enquiries ----

  private rowToInquiry(r: Row): SiteInquiry {
    return { id: r.id as number, kind: (r.kind === 'call' ? 'call' : 'contact'), name: r.name as string, email: r.email as string, brand: (r.brand as string | null) ?? null, message: r.message as string, phone: (r.phone as string | null) ?? null, preferred_time: (r.preferred_time as string | null) ?? null, language: (r.language as string | null) ?? null, page: (r.page as string | null) ?? null, gclid: (r.gclid as string | null) ?? null, status: r.status as SiteInquiry['status'], assigned_to: (r.assigned_to as string | null) ?? null, note: (r.note as string | null) ?? null, slack_ts: (r.slack_ts as string | null) ?? null, replied_at: (r.replied_at as string | null) ?? null, forwarded_at: (r.forwarded_at as string | null) ?? null, created_at: r.created_at as string };
  }

  createInquiry(i: { kind?: SiteInquiry['kind']; name: string; email: string; brand?: string | null; message: string; phone?: string | null; preferred_time?: string | null; language?: string | null; page?: string | null; gclid?: string | null; ip?: string | null }): SiteInquiry {
    const res = this.db.prepare('INSERT INTO site_inquiries (kind, name, email, brand, message, phone, preferred_time, language, page, gclid, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(i.kind ?? 'contact', i.name, i.email, i.brand ?? null, i.message, i.phone ?? null, i.preferred_time ?? null, i.language ?? null, i.page ?? null, i.gclid ?? null, i.ip ?? null);
    return this.getInquiry(Number(res.lastInsertRowid))!;
  }

  getInquiry(id: number): SiteInquiry | null {
    const r = this.db.prepare('SELECT * FROM site_inquiries WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToInquiry(r) : null;
  }

  listInquiries(limit = 300): SiteInquiry[] {
    return (this.db.prepare('SELECT * FROM site_inquiries ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as Row[]).map((r) => this.rowToInquiry(r));
  }

  /** Same email in the last minutes: the form was double-submitted or a bot is hammering it. */
  recentInquiryFrom(email: string, minutes: number): SiteInquiry | null {
    const cut = new Date(Date.now() - minutes * 60000).toISOString();
    const r = this.db.prepare('SELECT * FROM site_inquiries WHERE lower(email) = lower(?) AND created_at > ? ORDER BY created_at DESC LIMIT 1').get(email, cut) as Row | undefined;
    return r ? this.rowToInquiry(r) : null;
  }

  /** One line in an enquiry's history: who did what, when. */
  addInquiryEvent(inquiryId: number, e: { kind: InquiryEvent['kind']; actor?: string | null; detail?: string | null; url?: string | null }): InquiryEvent {
    const res = this.db.prepare('INSERT INTO site_inquiry_events (inquiry_id, kind, actor, detail, url) VALUES (?, ?, ?, ?, ?)').run(inquiryId, e.kind, e.actor ?? null, e.detail ?? null, e.url ?? null);
    return this.listInquiryEvents(inquiryId).find((x) => x.id === Number(res.lastInsertRowid))!;
  }

  listInquiryEvents(inquiryId: number): InquiryEvent[] {
    return (this.db.prepare('SELECT * FROM site_inquiry_events WHERE inquiry_id = ? ORDER BY at ASC, id ASC').all(inquiryId) as Row[]).map((r) => ({ id: r.id as number, inquiry_id: r.inquiry_id as number, at: r.at as string, kind: r.kind as InquiryEvent['kind'], actor: (r.actor as string | null) ?? null, detail: (r.detail as string | null) ?? null, url: (r.url as string | null) ?? null }));
  }

  updateInquiry(id: number, patch: Partial<Pick<SiteInquiry, 'status' | 'assigned_to' | 'note' | 'slack_ts' | 'replied_at' | 'forwarded_at'>>): SiteInquiry | null {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length) this.db.prepare(`UPDATE site_inquiries SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
    return this.getInquiry(id);
  }

  // ---- Account health: daily pulls and AI assessments ----

  upsertHealthPull(p: { shop_id: string; account_id: number | null; source: HealthSource; pull_date: string; ok: boolean; error?: string | null; metrics: Record<string, unknown>; rows?: Record<string, unknown> }): void {
    this.db.prepare(`INSERT INTO health_pulls (shop_id, account_id, source, pull_date, pulled_at, ok, error, metrics_json, rows_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, source, pull_date) DO UPDATE SET account_id = excluded.account_id, pulled_at = excluded.pulled_at, ok = excluded.ok, error = excluded.error, metrics_json = excluded.metrics_json, rows_json = excluded.rows_json`)
      .run(p.shop_id, p.account_id, p.source, p.pull_date, new Date().toISOString(), p.ok ? 1 : 0, p.error ?? null, JSON.stringify(p.metrics), JSON.stringify(p.rows ?? {}));
  }

  private rowToPull(r: Row): HealthPullRow {
    const parse = <T,>(v: unknown, fallback: T): T => { try { return JSON.parse(String(v ?? '')) as T; } catch { return fallback; } };
    return { id: r.id as number, shop_id: r.shop_id as string, account_id: (r.account_id as number | null) ?? null, source: r.source as HealthSource, pull_date: r.pull_date as string, pulled_at: r.pulled_at as string, ok: Boolean(r.ok), error: (r.error as string | null) ?? null, metrics: parse<Record<string, unknown>>(r.metrics_json, {}), rows: parse<Record<string, unknown>>(r.rows_json, {}) };
  }

  private pullsCache = new Map<HealthSource, { stamp: number; rows: HealthPullRow[] }>();

  /**
   * The most recent pull per shop for a source (any date). The row payloads are large JSON (analytics days, products,
   * orders) and the monitor reads them several times per page, so the parsed rows are kept until something is written.
   */
  latestHealthPulls(source: HealthSource): HealthPullRow[] {
    const stamp = this.changeStamp();
    const hit = this.pullsCache.get(source);
    if (hit && hit.stamp === stamp) return hit.rows;
    const rows = this.readLatestHealthPulls(source);
    this.pullsCache.set(source, { stamp, rows });
    return rows;
  }

  private readLatestHealthPulls(source: HealthSource): HealthPullRow[] {
    return (this.db.prepare('SELECT p.* FROM health_pulls p WHERE p.source = ? AND p.pull_date = (SELECT MAX(pull_date) FROM health_pulls x WHERE x.shop_id = p.shop_id AND x.source = p.source) ORDER BY p.shop_id').all(source) as Row[]).map((r) => this.rowToPull(r));
  }

  /** Metrics history for a shop (no row payloads), newest last. */
  healthMetricsHistory(shopId: string, source: HealthSource, days: number): { pull_date: string; metrics: Record<string, unknown> }[] {
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return (this.db.prepare('SELECT pull_date, metrics_json FROM health_pulls WHERE shop_id = ? AND source = ? AND pull_date >= ? AND ok = 1 ORDER BY pull_date').all(shopId, source, from) as Row[]).map((r) => { let m: Record<string, unknown> = {}; try { m = JSON.parse(String(r.metrics_json)); } catch { m = {}; } return { pull_date: r.pull_date as string, metrics: m }; });
  }

  // ---- Account targets, SKU price list and platform campaigns (what the targets rules compare against) ----

  listAccountTargets(accountId?: number): AccountTarget[] {
    const rows = (accountId === undefined ? this.db.prepare('SELECT * FROM account_targets ORDER BY account_id, market, key').all() : this.db.prepare('SELECT * FROM account_targets WHERE account_id = ? ORDER BY market, key').all(accountId)) as Row[];
    return rows.map((r) => ({ account_id: r.account_id as number, market: r.market as string, key: r.key as TargetKey, value: Number(r.value), updated_at: r.updated_at as string, updated_by: (r.updated_by as string | null) ?? null }));
  }

  /** Set (or clear with null) one target for an account, for every market ('') or one market. */
  setAccountTarget(accountId: number, market: string, key: TargetKey, value: number | null, actor: string | null): void {
    const m = market.trim().toUpperCase();
    if (value === null) { this.db.prepare('DELETE FROM account_targets WHERE account_id = ? AND market = ? AND key = ?').run(accountId, m, key); return; }
    this.db.prepare(`INSERT INTO account_targets (account_id, market, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, market, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(accountId, m, key, value, new Date().toISOString(), actor);
  }

  private rowToSkuPrice(r: Row): AccountSkuPrice {
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return { id: r.id as number, account_id: r.account_id as number, market: r.market as string, tts_shop_id: (r.tts_shop_id as string | null) ?? null, product_id: (r.product_id as string | null) ?? null, sku_id: (r.sku_id as string | null) ?? null, seller_sku: (r.seller_sku as string | null) ?? null, name: r.name as string, list_price: num(r.list_price), floor_price: num(r.floor_price), promo_price: num(r.promo_price), current_price: num(r.current_price), currency: (r.currency as string) ?? 'EUR', updated_at: r.updated_at as string };
  }

  listSkuPrices(accountId?: number): AccountSkuPrice[] {
    const rows = (accountId === undefined ? this.db.prepare('SELECT * FROM account_sku_prices ORDER BY account_id, market, name').all() : this.db.prepare('SELECT * FROM account_sku_prices WHERE account_id = ? ORDER BY market, name').all(accountId)) as Row[];
    return rows.map((r) => this.rowToSkuPrice(r));
  }

  saveSkuPrice(p: Partial<AccountSkuPrice> & { account_id: number; market: string; name: string }): AccountSkuPrice {
    const now = new Date().toISOString();
    if (p.id) {
      this.db.prepare(`UPDATE account_sku_prices SET market = ?, tts_shop_id = ?, product_id = ?, sku_id = ?, seller_sku = ?, name = ?, list_price = ?, floor_price = ?, promo_price = ?, current_price = COALESCE(?, current_price), currency = ?, updated_at = ? WHERE id = ?`)
        .run(p.market, p.tts_shop_id ?? null, p.product_id ?? null, p.sku_id ?? null, p.seller_sku ?? null, p.name, p.list_price ?? null, p.floor_price ?? null, p.promo_price ?? null, p.current_price ?? null, p.currency ?? 'EUR', now, p.id);
      return this.rowToSkuPrice(this.db.prepare('SELECT * FROM account_sku_prices WHERE id = ?').get(p.id) as Row);
    }
    // One row per SKU per account: a pull or a second paste updates the row it already has.
    const existing = p.sku_id ? (this.db.prepare('SELECT id FROM account_sku_prices WHERE account_id = ? AND sku_id = ?').get(p.account_id, p.sku_id) as Row | undefined) : undefined;
    if (existing) return this.saveSkuPrice({ ...p, id: existing.id as number });
    const info = this.db.prepare(`INSERT INTO account_sku_prices (account_id, market, tts_shop_id, product_id, sku_id, seller_sku, name, list_price, floor_price, promo_price, current_price, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.account_id, p.market, p.tts_shop_id ?? null, p.product_id ?? null, p.sku_id ?? null, p.seller_sku ?? null, p.name, p.list_price ?? null, p.floor_price ?? null, p.promo_price ?? null, p.current_price ?? null, p.currency ?? 'EUR', now);
    return this.rowToSkuPrice(this.db.prepare('SELECT * FROM account_sku_prices WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
  }

  /** The product pull refreshes what the shop currently charges, without touching the agreed prices. */
  setSkuCurrentPrice(accountId: number, skuId: string, price: number | null, currency: string | null): boolean {
    return this.db.prepare('UPDATE account_sku_prices SET current_price = ?, currency = COALESCE(?, currency), updated_at = ? WHERE account_id = ? AND sku_id = ?').run(price, currency, new Date().toISOString(), accountId, skuId).changes > 0;
  }

  deleteSkuPrice(id: number): boolean {
    return this.db.prepare('DELETE FROM account_sku_prices WHERE id = ?').run(id).changes > 0;
  }

  private rowToCampaign(r: Row): AccountCampaign {
    return { id: r.id as number, account_id: r.account_id as number, market: r.market as string, name: r.name as string, begin_at: r.begin_at as string, end_at: r.end_at as string, participation: (r.participation as AccountCampaign['participation']) ?? 'full', discount_pct: r.discount_pct === null || r.discount_pct === undefined ? null : Number(r.discount_pct), sku_scope: (r.sku_scope as string | null) ?? null, notes: (r.notes as string | null) ?? null, created_at: r.created_at as string, updated_at: r.updated_at as string };
  }

  listAccountCampaigns(accountId?: number): AccountCampaign[] {
    const rows = (accountId === undefined ? this.db.prepare('SELECT * FROM account_campaigns ORDER BY begin_at DESC, id DESC').all() : this.db.prepare('SELECT * FROM account_campaigns WHERE account_id = ? ORDER BY begin_at DESC, id DESC').all(accountId)) as Row[];
    return rows.map((r) => this.rowToCampaign(r));
  }

  saveAccountCampaign(c: Partial<AccountCampaign> & { account_id: number; market: string; name: string; begin_at: string; end_at: string }): AccountCampaign {
    const now = new Date().toISOString();
    if (c.id) {
      this.db.prepare(`UPDATE account_campaigns SET market = ?, name = ?, begin_at = ?, end_at = ?, participation = ?, discount_pct = ?, sku_scope = ?, notes = ?, updated_at = ? WHERE id = ?`).run(c.market, c.name, c.begin_at, c.end_at, c.participation ?? 'full', c.discount_pct ?? null, c.sku_scope ?? null, c.notes ?? null, now, c.id);
      return this.rowToCampaign(this.db.prepare('SELECT * FROM account_campaigns WHERE id = ?').get(c.id) as Row);
    }
    const info = this.db.prepare(`INSERT INTO account_campaigns (account_id, market, name, begin_at, end_at, participation, discount_pct, sku_scope, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.account_id, c.market, c.name, c.begin_at, c.end_at, c.participation ?? 'full', c.discount_pct ?? null, c.sku_scope ?? null, c.notes ?? null, now, now);
    return this.rowToCampaign(this.db.prepare('SELECT * FROM account_campaigns WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
  }

  deleteAccountCampaign(id: number): boolean {
    return this.db.prepare('DELETE FROM account_campaigns WHERE id = ?').run(id).changes > 0;
  }

  pruneHealthPulls(olderThanDays: number): number {
    const cut = new Date(Date.now() - olderThanDays * 86400000).toISOString().slice(0, 10);
    // Row payloads are only needed for the latest pulls; older rows keep their metrics for the trend and lose the payload.
    this.db.prepare(`UPDATE health_pulls SET rows_json = '{}' WHERE pull_date < ? AND rows_json != '{}'`).run(new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10));
    return this.db.prepare('DELETE FROM health_pulls WHERE pull_date < ?').run(cut).changes;
  }

  private rowToAssessment(r: Row): HealthAssessment {
    let watch: string[] = [];
    try { watch = JSON.parse(String(r.watch_json ?? '[]')); } catch { watch = []; }
    return { id: r.id as number, account_id: r.account_id as number, account_name: (r.account_name as string | null) ?? null, assess_date: r.assess_date as string, assessed_at: r.assessed_at as string, source: r.source as HealthAssessment['source'], risk: r.risk as HealthAssessment['risk'], summary: r.summary as string, action: r.action as string, watch: Array.isArray(watch) ? watch.map(String) : [] };
  }

  upsertAssessment(a: { account_id: number; assess_date: string; source: HealthAssessment['source']; risk: HealthAssessment['risk']; summary: string; action: string; watch?: string[] }): HealthAssessment {
    this.db.prepare(`INSERT INTO health_assessments (account_id, assess_date, assessed_at, source, risk, summary, action, watch_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, assess_date) DO UPDATE SET assessed_at = excluded.assessed_at, source = excluded.source, risk = excluded.risk, summary = excluded.summary, action = excluded.action, watch_json = excluded.watch_json`)
      .run(a.account_id, a.assess_date, new Date().toISOString(), a.source, a.risk, a.summary, a.action, JSON.stringify(a.watch ?? []));
    return this.rowToAssessment(this.db.prepare('SELECT h.*, a.name AS account_name FROM health_assessments h LEFT JOIN accounts a ON a.id = h.account_id WHERE h.account_id = ? AND h.assess_date = ?').get(a.account_id, a.assess_date) as Row);
  }

  /** Latest assessment per account. */
  latestAssessments(): HealthAssessment[] {
    return (this.db.prepare('SELECT h.*, a.name AS account_name FROM health_assessments h LEFT JOIN accounts a ON a.id = h.account_id WHERE h.assess_date = (SELECT MAX(assess_date) FROM health_assessments x WHERE x.account_id = h.account_id) ORDER BY CASE h.risk WHEN \'red\' THEN 0 WHEN \'amber\' THEN 1 ELSE 2 END, a.name').all() as Row[]).map((r) => this.rowToAssessment(r));
  }

  listAssessments(accountId: number, days: number): HealthAssessment[] {
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return (this.db.prepare('SELECT h.*, a.name AS account_name FROM health_assessments h LEFT JOIN accounts a ON a.id = h.account_id WHERE h.account_id = ? AND h.assess_date >= ? ORDER BY h.assess_date DESC').all(accountId, from) as Row[]).map((r) => this.rowToAssessment(r));
  }

  pruneAssessments(olderThanDays: number): number {
    return this.db.prepare('DELETE FROM health_assessments WHERE assess_date < ?').run(new Date(Date.now() - olderThanDays * 86400000).toISOString().slice(0, 10)).changes;
  }

  deleteProspect(id: number): boolean {
    return this.db.prepare('DELETE FROM bd_prospects WHERE id = ?').run(id).changes > 0;
  }

  addContact(prospectId: number, c: { name: string; title?: string | null; email?: string | null; linkedin_url?: string | null; phone?: string | null; source?: 'apollo' | 'manual'; apollo_id?: string | null; enriched?: boolean; notes?: string | null }): BdContact {
    // One row per Apollo person; re-finding the same person updates it instead of duplicating.
    if (c.apollo_id) {
      const existing = this.db.prepare('SELECT id FROM bd_contacts WHERE prospect_id = ? AND apollo_id = ?').get(prospectId, c.apollo_id) as { id: number } | undefined;
      if (existing) return this.updateContact(existing.id, c)!;
    }
    const info = this.db
      .prepare(`INSERT INTO bd_contacts (prospect_id, name, title, email, linkedin_url, phone, source, apollo_id, enriched, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(prospectId, c.name, c.title ?? null, c.email ?? null, c.linkedin_url ?? null, c.phone ?? null, c.source ?? 'manual', c.apollo_id ?? null, c.enriched ? 1 : 0, c.notes ?? null);
    return this.getContact(Number(info.lastInsertRowid))!;
  }

  getContact(id: number): BdContact | null {
    const r = this.db.prepare('SELECT * FROM bd_contacts WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToContact(r) : null;
  }

  updateContact(id: number, c: { name?: string; title?: string | null; email?: string | null; linkedin_url?: string | null; phone?: string | null; apollo_id?: string | null; enriched?: boolean; notes?: string | null }): BdContact | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const k of ['name', 'title', 'email', 'linkedin_url', 'phone', 'apollo_id', 'notes'] as const) {
      if (c[k] !== undefined) {
        sets.push(`${k} = COALESCE(@${k}, ${k})`);
        params[k] = c[k];
      }
    }
    if (c.enriched !== undefined) {
      sets.push('enriched = @enriched');
      params.enriched = c.enriched ? 1 : 0;
    }
    if (sets.length) this.db.prepare(`UPDATE bd_contacts SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getContact(id);
  }

  deleteContact(id: number): boolean {
    return this.db.prepare('DELETE FROM bd_contacts WHERE id = ?').run(id).changes > 0;
  }

  lastProspectPull(): string | null {
    const r = this.db.prepare('SELECT MAX(pulled_at) AS at FROM bd_prospects').get() as { at: string | null };
    return r.at ?? null;
  }

  // ---- CS & affiliate inbox ----

  private rowToConversation(r: Row): InboxConversation {
    const lastSender = (r.last_sender as InboxConversation['last_sender']) ?? null;
    const status = (r.status as InboxConversation['status']) ?? 'open';
    const channel = r.channel as InboxConversation['channel'];
    const autoOn = channel === 'cs' ? Boolean(r.auto_reply_cs) : Boolean(r.auto_reply_affiliate);
    return {
      id: r.id as number,
      tts_shop_id: r.tts_shop_id as string,
      shop_name: (r.shop_name as string) ?? '',
      account_id: (r.account_id as number | null) ?? null,
      account_name: (r.account_name as string | null) ?? null,
      market: (r.market as string | null) ?? (r.source === 'cruva' ? marketOfShopName(String(r.shop_name ?? '')) : null),
      source: r.source === 'cruva' ? 'cruva' : 'tts',
      channel,
      conversation_id: r.conversation_id as string,
      counterpart_name: (r.counterpart_name as string | null) ?? null,
      counterpart_id: (r.counterpart_id as string | null) ?? null,
      unread_count: (r.unread_count as number) ?? 0,
      last_message_at: (r.last_message_at as string | null) ?? null,
      last_message_text: (r.last_message_text as string | null) ?? null,
      last_sender: lastSender,
      last_message_id: (r.last_message_id as string | null) ?? null,
      can_send: Boolean(r.can_send),
      status,
      language: (r.language as string | null) ?? null,
      needs_reply: lastSender === 'them' && status !== 'closed',
      auto_reply_on: autoOn,
      synced_at: r.synced_at as string,
      updated_at: r.updated_at as string,
    };
  }

  /** A conversation belongs to a TikTok shop (tts_shops) or, when read through Cruva, to a linked Cruva shop (account_shops). */
  private static CONV_SELECT = `SELECT c.*, COALESCE(s.name, cs.shop_name) AS shop_name, COALESCE(s.account_id, cs.account_id) AS account_id, s.market, a.name AS account_name, a.auto_reply_cs, a.auto_reply_affiliate
    FROM inbox_conversations c LEFT JOIN tts_shops s ON s.id = c.tts_shop_id LEFT JOIN account_shops cs ON cs.shop_id = c.tts_shop_id LEFT JOIN accounts a ON a.id = COALESCE(s.account_id, cs.account_id)`;

  listConversations(opts: { channel?: InboxConversation['channel']; accountId?: number; limit?: number } = {}): InboxConversation[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.channel) {
      where.push('c.channel = ?');
      params.push(opts.channel);
    }
    if (opts.accountId) {
      where.push('COALESCE(s.account_id, cs.account_id) = ?');
      params.push(opts.accountId);
    }
    const sql = `${Queries.CONV_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT ?`;
    params.push(opts.limit ?? 500);
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.rowToConversation(r));
  }

  /** Threads waiting on an answer: open, last word from them, with a message id. One query for the whole dashboard or one account. */
  /** One thread by its shop, channel and platform id, or null. */
  findConversation(ttsShopId: string, channel: InboxConversation['channel'], conversationId: string): InboxConversation | null {
    const r = this.db.prepare(`${Queries.CONV_SELECT} WHERE c.tts_shop_id = ? AND c.channel = ? AND c.conversation_id = ?`).get(ttsShopId, channel, conversationId) as Row | undefined;
    return r ? this.rowToConversation(r) : null;
  }

  listOpenConversations(opts: { channel?: InboxConversation['channel']; accountId?: number; limit?: number } = {}): InboxConversation[] {
    const where: string[] = ["c.status != 'closed'", "c.last_sender = 'them'", 'c.last_message_id IS NOT NULL'];
    const params: unknown[] = [];
    if (opts.channel) { where.push('c.channel = ?'); params.push(opts.channel); }
    if (opts.accountId) { where.push('COALESCE(s.account_id, cs.account_id) = ?'); params.push(opts.accountId); }
    params.push(opts.limit ?? 500);
    return (this.db.prepare(`${Queries.CONV_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT ?`).all(...params) as Row[]).map((r) => this.rowToConversation(r));
  }

  countConversations(opts: { channel?: InboxConversation['channel']; accountId?: number } = {}): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.channel) { where.push('c.channel = ?'); params.push(opts.channel); }
    if (opts.accountId) { where.push('COALESCE(s.account_id, cs.account_id) = ?'); params.push(opts.accountId); }
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM inbox_conversations c LEFT JOIN tts_shops s ON s.id = c.tts_shop_id LEFT JOIN account_shops cs ON cs.shop_id = c.tts_shop_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...params) as { n: number };
    return r.n;
  }

  /** The latest decision for each (conversation, message) pair, in one query per 400 threads. */
  replyEventsForMessages(pairs: { conversation_ref: number; message_id: string }[]): Map<string, ReplyEvent> {
    const out = new Map<string, ReplyEvent>();
    const ids = [...new Set(pairs.map((p) => p.conversation_ref))];
    const wanted = new Set(pairs.map((p) => `${p.conversation_ref}:${p.message_id}`));
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of this.db.prepare(`SELECT * FROM reply_events WHERE conversation_ref IN (${chunk.map(() => '?').join(',')}) ORDER BY id`).all(...chunk) as Row[]) {
        const key = `${r.conversation_ref}:${r.message_id}`;
        if (wanted.has(key)) out.set(key, this.rowToReplyEvent(r));
      }
    }
    return out;
  }

  /** The newest unsent draft per thread, in one query per 400 threads. */
  pendingDrafts(conversationRefs: number[]): Map<number, InboxReply> {
    const out = new Map<number, InboxReply>();
    const ids = [...new Set(conversationRefs)];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of this.db.prepare(`SELECT * FROM inbox_replies WHERE conversation_ref IN (${chunk.map(() => '?').join(',')}) AND sent_at IS NULL AND error_message IS NULL AND mode = 'draft' ORDER BY id`).all(...chunk) as Row[]) out.set(Number(r.conversation_ref), this.rowToReply(r));
    }
    return out;
  }

  /** Row counts inside the latest pull per shop without parsing the payloads. */
  latestHealthPullCounts(source: HealthSource, shopIds: string[]): Map<string, { products: number; orders: number }> {
    const out = new Map<string, { products: number; orders: number }>();
    if (!shopIds.length) return out;
    for (const r of this.db.prepare(`SELECT p.shop_id, COALESCE(json_array_length(p.rows_json, '$.products'), 0) AS products, COALESCE(json_array_length(p.rows_json, '$.orders'), 0) AS orders FROM health_pulls p WHERE p.source = ? AND p.shop_id IN (${shopIds.map(() => '?').join(',')}) AND p.pull_date = (SELECT MAX(pull_date) FROM health_pulls x WHERE x.shop_id = p.shop_id AND x.source = p.source)`).all(source, ...shopIds) as Row[]) out.set(String(r.shop_id), { products: Number(r.products ?? 0), orders: Number(r.orders ?? 0) });
    return out;
  }

  getConversation(id: number): InboxConversation | null {
    const r = this.db.prepare(`${Queries.CONV_SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
    return r ? this.rowToConversation(r) : null;
  }

  /** Insert or refresh a conversation from a TikTok listing. Returns its row id and whether the newest message changed. */
  upsertConversation(c: { tts_shop_id: string; channel: InboxConversation['channel']; conversation_id: string; counterpart_name?: string | null; counterpart_id?: string | null; unread_count?: number; can_send?: boolean; last_message_at?: string | null; last_message_text?: string | null; last_sender?: InboxConversation['last_sender']; last_message_id?: string | null; source?: 'tts' | 'cruva' }, now = new Date().toISOString()): { id: number; changed: boolean } {
    const prev = this.db.prepare('SELECT id, last_message_id, status, counterpart_name, counterpart_id, unread_count, can_send, last_message_at, last_message_text, last_sender FROM inbox_conversations WHERE tts_shop_id = ? AND channel = ? AND conversation_id = ?').get(c.tts_shop_id, c.channel, c.conversation_id) as { id: number; last_message_id: string | null; status: string; counterpart_name: string | null; counterpart_id: string | null; unread_count: number; can_send: number; last_message_at: string | null; last_message_text: string | null; last_sender: string | null } | undefined;
    const changed = !prev || (c.last_message_id !== undefined && c.last_message_id !== prev.last_message_id);
    // Nothing new in this listing: no write, so a quiet sync over thousands of threads costs no disk at all.
    if (prev && !changed && (c.counterpart_name == null || c.counterpart_name === prev.counterpart_name) && (c.counterpart_id == null || c.counterpart_id === prev.counterpart_id) && (c.unread_count === undefined || c.unread_count === prev.unread_count) && (c.can_send === undefined || (c.can_send ? 1 : 0) === prev.can_send) && (c.last_message_at == null || c.last_message_at === prev.last_message_at) && (c.last_message_text == null || c.last_message_text === prev.last_message_text) && (c.last_sender == null || c.last_sender === prev.last_sender)) return { id: prev.id, changed: false };
    if (!prev) {
      const info = this.db
        .prepare(`INSERT INTO inbox_conversations (tts_shop_id, channel, conversation_id, counterpart_name, counterpart_id, unread_count, can_send, last_message_at, last_message_text, last_sender, last_message_id, status, synced_at, updated_at, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
        .run(c.tts_shop_id, c.channel, c.conversation_id, c.counterpart_name ?? null, c.counterpart_id ?? null, c.unread_count ?? 0, c.can_send === false ? 0 : 1, c.last_message_at ?? null, c.last_message_text ?? null, c.last_sender ?? null, c.last_message_id ?? null, now, now, c.source ?? 'tts');
      return { id: Number(info.lastInsertRowid), changed: true };
    }
    // A new message from the other side re-opens a replied / closed thread.
    const reopen = changed && c.last_sender === 'them' && prev.status !== 'open';
    this.db
      .prepare(`UPDATE inbox_conversations SET counterpart_name = COALESCE(?, counterpart_name), counterpart_id = COALESCE(?, counterpart_id), unread_count = COALESCE(?, unread_count), can_send = COALESCE(?, can_send),
        last_message_at = COALESCE(?, last_message_at), last_message_text = COALESCE(?, last_message_text), last_sender = COALESCE(?, last_sender), last_message_id = COALESCE(?, last_message_id),
        status = CASE WHEN ? THEN 'open' ELSE status END, synced_at = ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?`)
      .run(c.counterpart_name ?? null, c.counterpart_id ?? null, c.unread_count ?? null, c.can_send === undefined ? null : c.can_send ? 1 : 0, c.last_message_at ?? null, c.last_message_text ?? null, c.last_sender ?? null, c.last_message_id ?? null, reopen ? 1 : 0, now, changed ? 1 : 0, now, prev.id);
    return { id: prev.id, changed };
  }

  /** Stamp a thread as read from the platform just now, whether or not anything in it changed. */
  markConversationSynced(id: number, now = new Date().toISOString()): void {
    this.db.prepare('UPDATE inbox_conversations SET synced_at = ? WHERE id = ?').run(now, id);
  }

  setConversationStatus(id: number, status: InboxConversation['status']): void {
    this.db.prepare(`UPDATE inbox_conversations SET status = ?, updated_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id);
  }

  setConversationLanguage(id: number, language: string | null): void {
    this.db.prepare(`UPDATE inbox_conversations SET language = ? WHERE id = ?`).run(language, id);
  }

  upsertMessages(conversationRef: number, rows: { message_id: string; sender_role: InboxMessage['sender_role']; sender_name?: string | null; type?: string; text?: string | null; created_at: string }[]): number {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO inbox_messages (conversation_ref, message_id, sender_role, sender_name, type, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    let n = 0;
    this.db.transaction(() => {
      for (const m of rows) n += stmt.run(conversationRef, m.message_id, m.sender_role, m.sender_name ?? null, m.type ?? 'TEXT', m.text ?? null, m.created_at).changes;
    })();
    return n;
  }

  listMessages(conversationRef: number, limit = 60): InboxMessage[] {
    return (this.db.prepare('SELECT * FROM inbox_messages WHERE conversation_ref = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(conversationRef, limit) as Row[])
      .reverse()
      .map((r) => ({ id: r.id as number, conversation_ref: r.conversation_ref as number, message_id: r.message_id as string, sender_role: r.sender_role as InboxMessage['sender_role'], sender_name: (r.sender_name as string | null) ?? null, type: r.type as string, text: (r.text as string | null) ?? null, created_at: r.created_at as string }));
  }

  /** Other conversations with the same buyer / creator on this shop: the "past history" part of the context. */
  historyForCounterpart(conversation: InboxConversation, limit = 30): { when: string; who: string; text: string }[] {
    if (!conversation.counterpart_id && !conversation.counterpart_name) return [];
    const rows = this.db
      .prepare(`SELECT m.created_at, m.sender_role, m.text FROM inbox_messages m JOIN inbox_conversations c ON c.id = m.conversation_ref
        WHERE c.id != ? AND c.tts_shop_id = ? AND c.channel = ? AND ((c.counterpart_id IS NOT NULL AND c.counterpart_id = ?) OR (c.counterpart_name IS NOT NULL AND c.counterpart_name = ?)) AND m.text IS NOT NULL
        ORDER BY m.created_at DESC LIMIT ?`)
      .all(conversation.id, conversation.tts_shop_id, conversation.channel, conversation.counterpart_id, conversation.counterpart_name, limit) as Row[];
    return rows.reverse().map((r) => ({ when: r.created_at as string, who: r.sender_role === 'us' ? 'us' : r.sender_role === 'them' ? (conversation.channel === 'cs' ? 'buyer' : 'creator') : 'system', text: r.text as string }));
  }

  private rowToReply(r: Row): InboxReply {
    return { id: r.id as number, conversation_ref: r.conversation_ref as number, text: r.text as string, mode: r.mode as InboxReply['mode'], created_by: (r.created_by as string | null) ?? null, created_at: r.created_at as string, sent_at: (r.sent_at as string | null) ?? null, tts_message_id: (r.tts_message_id as string | null) ?? null, error_message: (r.error_message as string | null) ?? null, in_reply_to: (r.in_reply_to as string | null) ?? null };
  }

  addReply(r: { conversation_ref: number; text: string; mode: InboxReply['mode']; created_by?: string | null; in_reply_to?: string | null }): InboxReply {
    const info = this.db.prepare(`INSERT INTO inbox_replies (conversation_ref, text, mode, created_by, in_reply_to) VALUES (?, ?, ?, ?, ?)`).run(r.conversation_ref, r.text, r.mode, r.created_by ?? null, r.in_reply_to ?? null);
    return this.getReply(Number(info.lastInsertRowid))!;
  }

  getReply(id: number): InboxReply | null {
    const r = this.db.prepare('SELECT * FROM inbox_replies WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToReply(r) : null;
  }

  markReplySent(id: number, ttsMessageId: string | null, error: string | null): void {
    this.db.prepare(`UPDATE inbox_replies SET sent_at = CASE WHEN ? IS NULL THEN ? ELSE sent_at END, tts_message_id = ?, error_message = ? WHERE id = ?`).run(error, new Date().toISOString(), ttsMessageId, error, id);
  }

  listReplies(conversationRef: number): InboxReply[] {
    return (this.db.prepare('SELECT * FROM inbox_replies WHERE conversation_ref = ? ORDER BY created_at DESC, id DESC LIMIT 20').all(conversationRef) as Row[]).map((r) => this.rowToReply(r));
  }

  /** Has an auto reply already gone out for this exact incoming message? */
  autoRepliedTo(conversationRef: number, messageId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM inbox_replies WHERE conversation_ref = ? AND mode = 'auto' AND in_reply_to = ? AND sent_at IS NOT NULL`).get(conversationRef, messageId));
  }

  lastAutoReplyAt(conversationRef: number): string | null {
    const r = this.db.prepare(`SELECT MAX(sent_at) AS at FROM inbox_replies WHERE conversation_ref = ? AND mode = 'auto'`).get(conversationRef) as { at: string | null };
    return r.at ?? null;
  }

  countAutoRepliesSince(iso: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM inbox_replies WHERE mode = 'auto' AND sent_at >= ?`).get(iso) as { n: number }).n;
  }

  // ---- Context library ----

  private rowToContext(r: Row): ContextEntry {
    return { id: r.id as number, language: r.language as string, scope: r.scope as ContextEntry['scope'], account_id: (r.account_id as number | null) ?? null, account_name: (r.account_name as string | null) ?? null, title: r.title as string, body: r.body as string, enabled: Boolean(r.enabled), updated_at: r.updated_at as string };
  }

  listContext(): ContextEntry[] {
    return (this.db.prepare(`SELECT l.*, a.name AS account_name FROM context_library l LEFT JOIN accounts a ON a.id = l.account_id ORDER BY l.language, l.scope, l.account_id NULLS FIRST, l.id`).all() as Row[]).map((r) => this.rowToContext(r));
  }

  /** Entries that apply to one conversation: global + that language, for the channel, for all accounts or this one. */
  contextFor(language: string, channel: 'cs' | 'affiliate', accountId: number | null): ContextEntry[] {
    return (this.db
      .prepare(`SELECT l.*, a.name AS account_name FROM context_library l LEFT JOIN accounts a ON a.id = l.account_id
        WHERE l.enabled = 1 AND (l.language = '*' OR l.language = ?) AND (l.scope = 'both' OR l.scope = ?) AND (l.account_id IS NULL OR l.account_id = ?)
        ORDER BY l.account_id NULLS FIRST, l.language, l.id`)
      .all(language, channel, accountId) as Row[]).map((r) => this.rowToContext(r));
  }

  createContext(e: { language: string; scope: ContextEntry['scope']; account_id: number | null; title: string; body: string; enabled?: boolean }): ContextEntry {
    const info = this.db.prepare(`INSERT INTO context_library (language, scope, account_id, title, body, enabled) VALUES (?, ?, ?, ?, ?, ?)`).run(e.language, e.scope, e.account_id, e.title, e.body, e.enabled === false ? 0 : 1);
    return this.listContext().find((c) => c.id === Number(info.lastInsertRowid))!;
  }

  updateContext(id: number, e: Partial<{ language: string; scope: ContextEntry['scope']; account_id: number | null; title: string; body: string; enabled: boolean }>): ContextEntry | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: new Date().toISOString() };
    for (const k of ['language', 'scope', 'account_id', 'title', 'body'] as const) {
      if (e[k] !== undefined) {
        sets.push(`${k} = @${k}`);
        params[k] = e[k];
      }
    }
    if (e.enabled !== undefined) {
      sets.push('enabled = @enabled');
      params.enabled = e.enabled ? 1 : 0;
    }
    if (sets.length) this.db.prepare(`UPDATE context_library SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
    return this.listContext().find((c) => c.id === id) ?? null;
  }

  deleteContext(id: number): boolean {
    return this.db.prepare('DELETE FROM context_library WHERE id = ?').run(id).changes > 0;
  }

  // ---- Cruva outreach memory ----

  upsertCruvaOutreach(rows: { account_id: number | null; creator_handle: string; summary: string; occurred_at?: string | null; source?: string }[]): number {
    // NULL account ids are distinct to a UNIQUE index, so dedupe by hand.
    const exists = this.db.prepare(`SELECT 1 FROM cruva_outreach WHERE account_id IS ? AND creator_handle = ? AND summary = ?`);
    const stmt = this.db.prepare(`INSERT INTO cruva_outreach (account_id, creator_handle, summary, occurred_at, source) VALUES (?, ?, ?, ?, ?)`);
    let n = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const handle = r.creator_handle.replace(/^@/, '').toLowerCase();
        if (exists.get(r.account_id, handle, r.summary)) continue;
        n += stmt.run(r.account_id, handle, r.summary, r.occurred_at ?? null, r.source ?? 'import').changes;
      }
    })();
    return n;
  }

  cruvaOutreachFor(creatorHandle: string | null, accountId: number | null, limit = 10): CruvaOutreach[] {
    if (!creatorHandle) return [];
    return (this.db
      .prepare(`SELECT * FROM cruva_outreach WHERE creator_handle = ? AND (account_id IS NULL OR account_id = ?) ORDER BY occurred_at DESC LIMIT ?`)
      .all(creatorHandle.replace(/^@/, '').toLowerCase(), accountId, limit) as Row[]).map((r) => ({ id: r.id as number, account_id: (r.account_id as number | null) ?? null, creator_handle: r.creator_handle as string, summary: r.summary as string, occurred_at: (r.occurred_at as string | null) ?? null, source: r.source as string }));
  }

  countCruvaOutreach(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM cruva_outreach').get() as { n: number }).n;
  }

  // ---- Per-account auto-reply switches ----

  listAccountReplySettings(): AccountReplySettings[] {
    const shops = this.listTtsShops();
    return (this.db.prepare('SELECT id, name, markets, auto_reply_cs, auto_reply_affiliate, reply_language FROM accounts WHERE enabled = 1 ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => ({
      account_id: r.id as number,
      account_name: r.name as string,
      markets: (r.markets as string | null) ?? null,
      auto_reply_cs: Boolean(r.auto_reply_cs),
      auto_reply_affiliate: Boolean(r.auto_reply_affiliate),
      reply_language: (r.reply_language as string | null) ?? null,
      shops: shops.filter((s) => s.account_id === r.id).map((s) => ({ id: s.id, name: s.name, market: s.market, token_ok: s.token_ok })),
    }));
  }

  setAccountReply(accountId: number, s: Partial<{ auto_reply_cs: boolean; auto_reply_affiliate: boolean; reply_language: string | null }>): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: accountId, now: new Date().toISOString() };
    if (s.auto_reply_cs !== undefined) {
      sets.push('auto_reply_cs = @cs');
      params.cs = s.auto_reply_cs ? 1 : 0;
    }
    if (s.auto_reply_affiliate !== undefined) {
      sets.push('auto_reply_affiliate = @aff');
      params.aff = s.auto_reply_affiliate ? 1 : 0;
    }
    if (s.reply_language !== undefined) {
      sets.push('reply_language = @lang');
      params.lang = s.reply_language;
    }
    if (!sets.length) return true;
    return this.db.prepare(`UPDATE accounts SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params).changes > 0;
  }

  /** Set only the Slack / client fields of an account (from the incidents, reports or copilot pages). */
  setAccountChannels(id: number, s: Partial<{ slack_channel: string | null; client_slack_channel: string | null; client_domain: string | null }>): Account | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const k of ['slack_channel', 'client_slack_channel', 'client_domain'] as const) {
      if (s[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = s[k] ? String(s[k]).trim() : null; }
    }
    if (!sets.length) return this.getAccount(id);
    this.db.prepare(`UPDATE accounts SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run(params);
    return this.getAccount(id);
  }

  // ---- Stock snapshots ----

  replaceStockSnapshot(shopId: string, accountId: number | null, rows: Omit<StockSku, 'shop_id' | 'account_id' | 'captured_at' | 'velocity_override' | 'exclude' | 'note' | 'source'>[], capturedAt = new Date().toISOString(), source: StockSku['source'] = 'tts'): number {
    const del = this.db.prepare('DELETE FROM stock_snapshots WHERE shop_id = ?');
    const ins = this.db.prepare(`INSERT INTO stock_snapshots (shop_id, account_id, product_id, product_title, sku_id, sku_name, seller_sku, product_status, on_hand, sold_7d, sold_30d, captured_at, source)
      VALUES (@shop_id, @account_id, @product_id, @product_title, @sku_id, @sku_name, @seller_sku, @product_status, @on_hand, @sold_7d, @sold_30d, @captured_at, @source)
      ON CONFLICT(shop_id, sku_id) DO UPDATE SET product_title = excluded.product_title, sku_name = excluded.sku_name, seller_sku = excluded.seller_sku, product_status = excluded.product_status, on_hand = excluded.on_hand, sold_7d = excluded.sold_7d, sold_30d = excluded.sold_30d, captured_at = excluded.captured_at, account_id = excluded.account_id, source = excluded.source`);
    let n = 0;
    this.db.transaction(() => {
      del.run(shopId);
      for (const r of rows) n += ins.run({ ...r, shop_id: shopId, account_id: accountId, captured_at: capturedAt, source }).changes;
    })();
    return n;
  }

  listStock(shopId?: string): StockSku[] {
    const rows = (shopId
      ? this.db.prepare('SELECT s.*, o.velocity AS velocity_override, o.exclude AS exclude, o.note AS note FROM stock_snapshots s LEFT JOIN stock_overrides o ON o.shop_id = s.shop_id AND o.sku_id = s.sku_id WHERE s.shop_id = ? ORDER BY s.product_title COLLATE NOCASE, s.sku_name COLLATE NOCASE').all(shopId)
      : this.db.prepare('SELECT s.*, o.velocity AS velocity_override, o.exclude AS exclude, o.note AS note FROM stock_snapshots s LEFT JOIN stock_overrides o ON o.shop_id = s.shop_id AND o.sku_id = s.sku_id ORDER BY s.shop_id, s.product_title COLLATE NOCASE').all()) as Row[];
    return rows.map((r) => ({
      shop_id: r.shop_id as string, account_id: (r.account_id as number | null) ?? null, source: (r.source as StockSku['source']) ?? 'tts', product_id: r.product_id as string, product_title: r.product_title as string, sku_id: r.sku_id as string, sku_name: (r.sku_name as string | null) ?? null, seller_sku: (r.seller_sku as string | null) ?? null, product_status: (r.product_status as string | null) ?? null,
      on_hand: Number(r.on_hand), sold_7d: Number(r.sold_7d), sold_30d: Number(r.sold_30d), captured_at: r.captured_at as string,
      velocity_override: r.velocity_override === null || r.velocity_override === undefined ? null : Number(r.velocity_override), exclude: Boolean(r.exclude), note: (r.note as string | null) ?? null,
    }));
  }

  setStockOverride(shopId: string, skuId: string, o: { velocity?: number | null; exclude?: boolean; note?: string | null }): void {
    const cur = this.db.prepare('SELECT * FROM stock_overrides WHERE shop_id = ? AND sku_id = ?').get(shopId, skuId) as Row | undefined;
    const velocity = o.velocity !== undefined ? o.velocity : ((cur?.velocity as number | null) ?? null);
    const exclude = o.exclude !== undefined ? o.exclude : Boolean(cur?.exclude);
    const note = o.note !== undefined ? o.note : ((cur?.note as string | null) ?? null);
    if (velocity === null && !exclude && !note) { this.db.prepare('DELETE FROM stock_overrides WHERE shop_id = ? AND sku_id = ?').run(shopId, skuId); return; }
    this.db.prepare('INSERT INTO stock_overrides (shop_id, sku_id, velocity, exclude, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT(shop_id, sku_id) DO UPDATE SET velocity = excluded.velocity, exclude = excluded.exclude, note = excluded.note').run(shopId, skuId, velocity, exclude ? 1 : 0, note);
  }

  // ---- Incidents ----

  private rowToIncident(r: Row): Incident {
    return {
      id: r.id as number, account_id: (r.account_id as number | null) ?? null, account_name: (r.account_name as string | null) ?? null, shop_id: (r.shop_id as string | null) ?? null, kind: r.kind as string, severity: r.severity as Incident['severity'],
      title: r.title as string, message: r.message as string, recommended_action: r.recommended_action as string, owner: (r.owner as string | null) ?? null, owner_slack_id: (r.owner_slack_id as string | null) ?? null, source: r.source as string, dedupe_key: r.dedupe_key as string,
      slack_channel: (r.slack_channel as string | null) ?? null, slack_ts: (r.slack_ts as string | null) ?? null, posted_at: (r.posted_at as string | null) ?? null, post_error: (r.post_error as string | null) ?? null, resolved_at: (r.resolved_at as string | null) ?? null, created_at: r.created_at as string,
    };
  }

  listIncidents(opts: { open?: boolean; limit?: number } = {}): Incident[] {
    return (this.db.prepare(`SELECT i.*, a.name AS account_name FROM incidents i LEFT JOIN accounts a ON a.id = i.account_id ${opts.open ? 'WHERE i.resolved_at IS NULL' : ''} ORDER BY i.created_at DESC LIMIT ?`).all(opts.limit ?? 300) as Row[]).map((r) => this.rowToIncident(r));
  }

  /** Incidents that were open at any point between two dates (inclusive), oldest first. */
  listIncidentsBetween(from: string, to: string): Incident[] {
    return (this.db.prepare('SELECT i.*, a.name AS account_name FROM incidents i LEFT JOIN accounts a ON a.id = i.account_id WHERE substr(i.created_at, 1, 10) <= ? AND (i.resolved_at IS NULL OR substr(i.resolved_at, 1, 10) >= ?) ORDER BY i.created_at').all(to, from) as Row[]).map((r) => this.rowToIncident(r));
  }

  getIncident(id: number): Incident | null {
    const r = this.db.prepare('SELECT i.*, a.name AS account_name FROM incidents i LEFT JOIN accounts a ON a.id = i.account_id WHERE i.id = ?').get(id) as Row | undefined;
    return r ? this.rowToIncident(r) : null;
  }

  /** Open incident with this key, or one resolved less than cooldownHours ago (so a flapping condition does not spam Slack). */
  findIncidentByKey(key: string, cooldownHours: number): Incident | null {
    const cut = new Date(Date.now() - cooldownHours * 3600000).toISOString();
    const r = this.db.prepare('SELECT i.*, a.name AS account_name FROM incidents i LEFT JOIN accounts a ON a.id = i.account_id WHERE i.dedupe_key = ? AND (i.resolved_at IS NULL OR i.resolved_at > ?) ORDER BY i.created_at DESC LIMIT 1').get(key, cut) as Row | undefined;
    return r ? this.rowToIncident(r) : null;
  }

  createIncident(i: Omit<Incident, 'id' | 'account_name' | 'slack_ts' | 'posted_at' | 'post_error' | 'resolved_at' | 'created_at'>): Incident {
    const res = this.db.prepare(`INSERT INTO incidents (account_id, shop_id, kind, severity, title, message, recommended_action, owner, owner_slack_id, source, dedupe_key, slack_channel)
      VALUES (@account_id, @shop_id, @kind, @severity, @title, @message, @recommended_action, @owner, @owner_slack_id, @source, @dedupe_key, @slack_channel)`).run(i);
    return this.getIncident(Number(res.lastInsertRowid))!;
  }

  updateIncident(id: number, patch: Partial<Pick<Incident, 'slack_ts' | 'posted_at' | 'post_error' | 'resolved_at' | 'slack_channel' | 'message' | 'recommended_action'>>): Incident | null {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length) this.db.prepare(`UPDATE incidents SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
    return this.getIncident(id);
  }

  /** Resolve open incidents whose key is not in the live set (only for the given source). */
  resolveMissingIncidents(source: string, liveKeys: Set<string>): Incident[] {
    const open = this.listIncidents({ open: true }).filter((i) => i.source === source && !liveKeys.has(i.dedupe_key));
    const now = new Date().toISOString();
    for (const i of open) this.updateIncident(i.id, { resolved_at: now });
    return open.map((i) => ({ ...i, resolved_at: now }));
  }

  // ---- Client reports ----

  private rowToReport(r: Row): ClientReport {
    return {
      id: r.id as number, account_id: r.account_id as number, account_name: (r.account_name as string | null) ?? '', period: r.period as ClientReport['period'], period_start: r.period_start as string, period_end: r.period_end as string,
      title: r.title as string, body: r.body as string, data: parseJson<ReportData>(r.data_json, {} as ReportData), generator: r.generator as ClientReport['generator'], status: r.status as ClientReport['status'],
      kind: (r.kind as ClientReport['kind']) ?? 'standard', slack_draft: (r.slack_draft as string | null) ?? null, approved_at: (r.approved_at as string | null) ?? null, approved_by: (r.approved_by as string | null) ?? null, send_at: (r.send_at as string | null) ?? null,
      slack_channel: (r.slack_channel as string | null) ?? null, sent_at: (r.sent_at as string | null) ?? null, created_by: (r.created_by as string | null) ?? null, created_at: r.created_at as string, updated_at: r.updated_at as string,
    };
  }

  listReports(): ClientReport[] {
    return (this.db.prepare('SELECT r.*, a.name AS account_name FROM client_reports r JOIN accounts a ON a.id = r.account_id ORDER BY r.updated_at DESC LIMIT 200').all() as Row[]).map((r) => this.rowToReport(r));
  }

  getReport(id: number): ClientReport | null {
    const r = this.db.prepare('SELECT r.*, a.name AS account_name FROM client_reports r JOIN accounts a ON a.id = r.account_id WHERE r.id = ?').get(id) as Row | undefined;
    return r ? this.rowToReport(r) : null;
  }

  createReport(i: { account_id: number; period: 'weekly' | 'monthly'; period_start: string; period_end: string; title: string; body: string; data: ReportData; generator: 'claude' | 'template'; slack_channel: string | null; created_by: string | null; kind?: 'standard' | 'cruva'; slack_draft?: string | null }): ClientReport {
    const res = this.db.prepare(`INSERT INTO client_reports (account_id, period, period_start, period_end, title, body, data_json, generator, slack_channel, created_by, kind, slack_draft) VALUES (@account_id, @period, @period_start, @period_end, @title, @body, @data_json, @generator, @slack_channel, @created_by, @kind, @slack_draft)`)
      .run({ ...i, kind: i.kind ?? 'standard', slack_draft: i.slack_draft ?? null, data_json: JSON.stringify(i.data) });
    return this.getReport(Number(res.lastInsertRowid))!;
  }

  updateReport(id: number, patch: Partial<{ title: string; body: string; data: ReportData; generator: 'claude' | 'template'; status: ClientReport['status']; slack_channel: string | null; sent_at: string | null; slack_draft: string | null; approved_at: string | null; approved_by: string | null; send_at: string | null; kind: ClientReport['kind'] }>): ClientReport | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'data') { sets.push('data_json = @data_json'); params.data_json = JSON.stringify(v); continue; }
      sets.push(`${k} = @${k}`); params[k] = v;
    }
    if (sets.length) this.db.prepare(`UPDATE client_reports SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run(params);
    return this.getReport(id);
  }

  deleteReport(id: number): boolean {
    return this.db.prepare('DELETE FROM client_reports WHERE id = ?').run(id).changes > 0;
  }

  // ---- Cruva playbook ----

  private rowToPlaybook(r: Row): PlaybookItem {
    return { id: r.id as number, kind: r.kind as PlaybookKind, key: r.key as string, language: r.language as string, name: r.name as string, description: (r.description as string | null) ?? null, config: parseJson<Record<string, unknown>>(r.config_json, {}), enabled: Boolean(r.enabled), source: r.source as string, updated_at: r.updated_at as string };
  }

  listPlaybook(): PlaybookItem[] {
    return (this.db.prepare('SELECT * FROM cruva_playbook ORDER BY kind, key, language').all() as Row[]).map((r) => this.rowToPlaybook(r));
  }

  getPlaybookItem(id: number): PlaybookItem | null {
    const r = this.db.prepare('SELECT * FROM cruva_playbook WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToPlaybook(r) : null;
  }

  upsertPlaybookItem(i: { kind: PlaybookKind; key: string; language: string; name: string; description?: string | null; config: Record<string, unknown>; enabled?: boolean; source?: string }): PlaybookItem {
    this.db.prepare(`INSERT INTO cruva_playbook (kind, key, language, name, description, config_json, enabled, source) VALUES (@kind, @key, @language, @name, @description, @config_json, @enabled, @source)
      ON CONFLICT(kind, key, language) DO UPDATE SET name = excluded.name, description = excluded.description, config_json = excluded.config_json, enabled = excluded.enabled, source = excluded.source, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run({ kind: i.kind, key: i.key, language: i.language, name: i.name, description: i.description ?? null, config_json: JSON.stringify(i.config), enabled: i.enabled === false ? 0 : 1, source: i.source ?? 'manual' });
    return (this.db.prepare('SELECT * FROM cruva_playbook WHERE kind = ? AND key = ? AND language = ?').get(i.kind, i.key, i.language) as Row | undefined) ? this.rowToPlaybook(this.db.prepare('SELECT * FROM cruva_playbook WHERE kind = ? AND key = ? AND language = ?').get(i.kind, i.key, i.language) as Row) : (undefined as never);
  }

  seedPlaybookIfEmpty(items: Parameters<Queries['upsertPlaybookItem']>[0][]): number {
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM cruva_playbook').get() as { n: number }).n > 0) return 0;
    let n = 0;
    this.db.transaction(() => { for (const i of items) { this.upsertPlaybookItem({ ...i, source: 'seed' }); n += 1; } })();
    return n;
  }

  updatePlaybookItem(id: number, patch: Partial<{ name: string; description: string | null; config: Record<string, unknown>; enabled: boolean; language: string }>): PlaybookItem | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.name !== undefined) { sets.push('name = @name'); params.name = patch.name; }
    if (patch.description !== undefined) { sets.push('description = @description'); params.description = patch.description; }
    if (patch.config !== undefined) { sets.push('config_json = @config_json'); params.config_json = JSON.stringify(patch.config); }
    if (patch.enabled !== undefined) { sets.push('enabled = @enabled'); params.enabled = patch.enabled ? 1 : 0; }
    if (patch.language !== undefined) { sets.push('language = @language'); params.language = patch.language; }
    if (sets.length) this.db.prepare(`UPDATE cruva_playbook SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run(params);
    return this.getPlaybookItem(id);
  }

  deletePlaybookItem(id: number): boolean {
    return this.db.prepare('DELETE FROM cruva_playbook WHERE id = ?').run(id).changes > 0;
  }

  listPlaybookCells(): PlaybookSetupCell[] {
    return (this.db.prepare('SELECT * FROM cruva_setup').all() as Row[]).map((r) => ({ shop_id: r.shop_id as string, kind: r.kind as PlaybookKind, playbook_key: r.playbook_key as string, status: r.status as PlaybookSetupCell['status'], remote_id: (r.remote_id as string | null) ?? null, remote_name: (r.remote_name as string | null) ?? null, checked_at: (r.checked_at as string | null) ?? null, applied_at: (r.applied_at as string | null) ?? null, note: (r.note as string | null) ?? null, remote_copy: (r.remote_copy as string | null) ?? null }));
  }

  setPlaybookCellCopy(shopId: string, kind: PlaybookKind, key: string, copy: string | null): void {
    this.db.prepare('UPDATE cruva_setup SET remote_copy = ? WHERE shop_id = ? AND kind = ? AND playbook_key = ?').run(copy, shopId, kind, key);
  }

  setPlaybookCell(c: { shop_id: string; kind: PlaybookKind; playbook_key: string; status: PlaybookSetupCell['status']; remote_id?: string | null; remote_name?: string | null; checked_at?: string | null; applied_at?: string | null; note?: string | null }): void {
    const cur = this.db.prepare('SELECT * FROM cruva_setup WHERE shop_id = ? AND kind = ? AND playbook_key = ?').get(c.shop_id, c.kind, c.playbook_key) as Row | undefined;
    this.db.prepare(`INSERT INTO cruva_setup (shop_id, kind, playbook_key, status, remote_id, remote_name, checked_at, applied_at, note) VALUES (@shop_id, @kind, @playbook_key, @status, @remote_id, @remote_name, @checked_at, @applied_at, @note)
      ON CONFLICT(shop_id, kind, playbook_key) DO UPDATE SET status = excluded.status, remote_id = excluded.remote_id, remote_name = excluded.remote_name, checked_at = excluded.checked_at, applied_at = excluded.applied_at, note = excluded.note`)
      .run({ shop_id: c.shop_id, kind: c.kind, playbook_key: c.playbook_key, status: c.status, remote_id: c.remote_id !== undefined ? c.remote_id : ((cur?.remote_id as string | null) ?? null), remote_name: c.remote_name !== undefined ? c.remote_name : ((cur?.remote_name as string | null) ?? null), checked_at: c.checked_at !== undefined ? c.checked_at : ((cur?.checked_at as string | null) ?? null), applied_at: c.applied_at !== undefined ? c.applied_at : ((cur?.applied_at as string | null) ?? null), note: c.note !== undefined ? c.note : ((cur?.note as string | null) ?? null) });
  }

  replaceRemoteItems(shopId: string, kind: PlaybookKind, items: { remote_id: string; name: string; enabled: boolean; raw?: unknown }[]): number {
    const now = new Date().toISOString();
    const del = this.db.prepare('DELETE FROM cruva_remote_items WHERE shop_id = ? AND kind = ?');
    const ins = this.db.prepare('INSERT OR REPLACE INTO cruva_remote_items (shop_id, kind, remote_id, name, enabled, raw_json, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let n = 0;
    this.db.transaction(() => { del.run(shopId, kind); for (const i of items) n += ins.run(shopId, kind, i.remote_id, i.name, i.enabled ? 1 : 0, i.raw === undefined ? null : JSON.stringify(i.raw).slice(0, 20000), now).changes; })();
    return n;
  }

  /** The stored raw fields of a shop's remote objects (listing fields, detail, any copy fetched later). */
  listRemoteRaw(shopId: string, kind?: PlaybookKind): { remote_id: string; name: string; enabled: boolean; raw: Record<string, unknown> }[] {
    const rows = (kind ? this.db.prepare('SELECT remote_id, name, enabled, raw_json FROM cruva_remote_items WHERE shop_id = ? AND kind = ?').all(shopId, kind) : this.db.prepare('SELECT remote_id, name, enabled, raw_json FROM cruva_remote_items WHERE shop_id = ?').all(shopId)) as Row[];
    return rows.map((r) => ({ remote_id: r.remote_id as string, name: r.name as string, enabled: Boolean(r.enabled), raw: parseJson<Record<string, unknown>>(r.raw_json, {}) }));
  }

  patchRemoteRaw(shopId: string, kind: PlaybookKind, remoteId: string, patch: Record<string, unknown>): void {
    const r = this.db.prepare('SELECT raw_json FROM cruva_remote_items WHERE shop_id = ? AND kind = ? AND remote_id = ?').get(shopId, kind, remoteId) as Row | undefined;
    if (!r) return;
    this.db.prepare('UPDATE cruva_remote_items SET raw_json = ? WHERE shop_id = ? AND kind = ? AND remote_id = ?').run(JSON.stringify({ ...parseJson<Record<string, unknown>>(r.raw_json, {}), ...patch }), shopId, kind, remoteId);
  }

  // ---- Cruva content and profiles ----

  replaceContent(shopId: string, windowTo: string, rows: PlaybookContentVideo[]): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM cruva_content WHERE shop_id = ? AND window_to = ?').run(shopId, windowTo);
      const ins = this.db.prepare('INSERT INTO cruva_content (shop_id, window_to, video_id, row_json, gmv, top, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const v of rows) ins.run(shopId, windowTo, v.video_id, JSON.stringify(v), v.gmv, v.top ? 1 : 0, now);
      // Keep the last four windows per shop.
      const keep = (this.db.prepare('SELECT DISTINCT window_to FROM cruva_content WHERE shop_id = ? ORDER BY window_to DESC LIMIT 4').all(shopId) as { window_to: string }[]).map((r) => r.window_to);
      if (keep.length) this.db.prepare(`DELETE FROM cruva_content WHERE shop_id = ? AND window_to NOT IN (${keep.map(() => '?').join(',')})`).run(shopId, ...keep);
    })();
  }

  listContent(shopId: string, opts: { topOnly?: boolean; windowTo?: string } = {}): PlaybookContentVideo[] {
    const win = opts.windowTo ?? (this.db.prepare('SELECT MAX(window_to) AS w FROM cruva_content WHERE shop_id = ?').get(shopId) as { w: string | null }).w;
    if (!win) return [];
    return (this.db.prepare(`SELECT row_json FROM cruva_content WHERE shop_id = ? AND window_to = ?${opts.topOnly ? ' AND top = 1' : ''} ORDER BY gmv DESC`).all(shopId, win) as Row[]).map((r) => parseJson<PlaybookContentVideo>(r.row_json, {} as PlaybookContentVideo));
  }

  addProfile(shopId: string, profile: PlaybookProfile): void {
    this.db.prepare('INSERT INTO cruva_profiles (shop_id, learned_at, profile_json) VALUES (?, ?, ?)').run(shopId, profile.learned_at, JSON.stringify(profile));
    this.db.prepare('DELETE FROM cruva_profiles WHERE shop_id = ? AND id NOT IN (SELECT id FROM cruva_profiles WHERE shop_id = ? ORDER BY id DESC LIMIT 8)').run(shopId, shopId);
  }

  // ---- Airtable mirror ----

  upsertAirtableTable(t: { base_id: string; table_id: string; name: string; schema: unknown }): void {
    this.db.prepare('INSERT INTO airtable_tables (base_id, table_id, name, schema_json) VALUES (?, ?, ?, ?) ON CONFLICT (base_id, table_id) DO UPDATE SET name = excluded.name, schema_json = excluded.schema_json').run(t.base_id, t.table_id, t.name, JSON.stringify(t.schema));
  }

  markAirtableTableSynced(baseId: string, tableId: string, patch: { synced_at?: string; full_synced_at?: string; error?: string | null }): void {
    const records = (this.db.prepare('SELECT COUNT(*) AS n FROM airtable_records WHERE base_id = ? AND table_id = ?').get(baseId, tableId) as { n: number }).n;
    this.db.prepare('UPDATE airtable_tables SET synced_at = COALESCE(?, synced_at), full_synced_at = COALESCE(?, full_synced_at), error = ?, records = ? WHERE base_id = ? AND table_id = ?').run(patch.synced_at ?? null, patch.full_synced_at ?? null, patch.error ?? null, records, baseId, tableId);
  }

  listAirtableTables(baseId: string): AirtableTableRow[] {
    return (this.db.prepare('SELECT * FROM airtable_tables WHERE base_id = ? ORDER BY name').all(baseId) as Row[]).map((r) => ({ base_id: String(r.base_id), table_id: String(r.table_id), name: String(r.name), schema: parseJson<AirtableTableSchema>(r.schema_json, { id: String(r.table_id), name: String(r.name), primaryFieldId: '', fields: [] }), synced_at: (r.synced_at as string | null) ?? null, full_synced_at: (r.full_synced_at as string | null) ?? null, records: Number(r.records), error: (r.error as string | null) ?? null }));
  }

  upsertAirtableRecords(baseId: string, tableId: string, rows: { id: string; primary: string | null; fields: Record<string, unknown>; modified_at: string | null }[], syncedAt = new Date().toISOString()): void {
    const ins = this.db.prepare('INSERT INTO airtable_records (base_id, table_id, record_id, primary_value, fields_json, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (base_id, table_id, record_id) DO UPDATE SET primary_value = excluded.primary_value, fields_json = excluded.fields_json, modified_at = excluded.modified_at, synced_at = excluded.synced_at');
    this.db.transaction(() => { for (const r of rows) ins.run(baseId, tableId, r.id, r.primary, JSON.stringify(r.fields), r.modified_at, syncedAt); })();
  }

  /** After a full listing: drop the records Airtable no longer returns. */
  pruneAirtableRecords(baseId: string, tableId: string, keepIds: string[]): number {
    const have = (this.db.prepare('SELECT record_id FROM airtable_records WHERE base_id = ? AND table_id = ?').all(baseId, tableId) as { record_id: string }[]).map((r) => r.record_id);
    const keep = new Set(keepIds); const gone = have.filter((id) => !keep.has(id));
    const del = this.db.prepare('DELETE FROM airtable_records WHERE base_id = ? AND table_id = ? AND record_id = ?');
    this.db.transaction(() => { for (const id of gone) del.run(baseId, tableId, id); })();
    return gone.length;
  }

  airtableLatestModified(baseId: string, tableId: string): string | null {
    return (this.db.prepare('SELECT MAX(modified_at) AS m FROM airtable_records WHERE base_id = ? AND table_id = ?').get(baseId, tableId) as { m: string | null }).m;
  }

  listAirtableRecords(baseId: string, tableId: string, opts: { q?: string; limit?: number; offset?: number } = {}): { rows: AirtableRecordRow[]; total: number } {
    const like = opts.q ? `%${opts.q.toLowerCase()}%` : null;
    const where = `base_id = ? AND table_id = ?${like ? ' AND (LOWER(primary_value) LIKE ? OR LOWER(fields_json) LIKE ?)' : ''}`;
    const args: unknown[] = like ? [baseId, tableId, like, like] : [baseId, tableId];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM airtable_records WHERE ${where}`).get(...args) as { n: number }).n;
    const rows = (this.db.prepare(`SELECT * FROM airtable_records WHERE ${where} ORDER BY modified_at DESC, primary_value LIMIT ? OFFSET ?`).all(...args, opts.limit ?? 50, opts.offset ?? 0) as Row[]).map((r) => this.airtableRow(r));
    return { rows, total };
  }

  getAirtableRecord(baseId: string, tableId: string, recordId: string): AirtableRecordRow | null {
    const r = this.db.prepare('SELECT * FROM airtable_records WHERE base_id = ? AND table_id = ? AND record_id = ?').get(baseId, tableId, recordId) as Row | undefined;
    return r ? this.airtableRow(r) : null;
  }

  /** Primary values for a set of record ids across tables (resolving link fields to names). */
  airtablePrimaries(baseId: string, ids: string[]): Map<string, { table_id: string; primary: string | null }> {
    const out = new Map<string, { table_id: string; primary: string | null }>();
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of this.db.prepare(`SELECT table_id, record_id, primary_value FROM airtable_records WHERE base_id = ? AND record_id IN (${chunk.map(() => '?').join(',')})`).all(baseId, ...chunk) as Row[]) out.set(String(r.record_id), { table_id: String(r.table_id), primary: (r.primary_value as string | null) ?? null });
    }
    return out;
  }

  private airtableRow(r: Row): AirtableRecordRow {
    return { base_id: String(r.base_id), table_id: String(r.table_id), record_id: String(r.record_id), primary: (r.primary_value as string | null) ?? null, fields: parseJson<Record<string, unknown>>(r.fields_json, {}), modified_at: (r.modified_at as string | null) ?? null, synced_at: String(r.synced_at) };
  }

  // ---- MCP OAuth: registered clients, authorization codes, tokens (kind + id → json, with an expiry) ----

  oauthGet<T>(kind: string, id: string): T | null {
    const r = this.db.prepare('SELECT json, expires_at FROM mcp_oauth WHERE kind = ? AND id = ?').get(kind, id) as { json: string; expires_at: number | null } | undefined;
    if (!r) return null;
    if (r.expires_at !== null && r.expires_at < Date.now()) { this.oauthDelete(kind, id); return null; }
    return parseJson<T>(r.json, null as unknown as T);
  }

  oauthPut(kind: string, id: string, value: unknown, expiresAt: number | null): void {
    this.db.prepare('INSERT INTO mcp_oauth (kind, id, json, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET json = excluded.json, expires_at = excluded.expires_at').run(kind, id, JSON.stringify(value), expiresAt);
  }

  oauthDelete(kind: string, id: string): void { this.db.prepare('DELETE FROM mcp_oauth WHERE kind = ? AND id = ?').run(kind, id); }

  oauthPrune(now = Date.now()): number { return this.db.prepare('DELETE FROM mcp_oauth WHERE expires_at IS NOT NULL AND expires_at < ?').run(now).changes; }

  // ---- Sample requests ----

  private sampleRow(r: Row): SampleRequest { return parseJson<SampleRequest>(r.row_json, {} as SampleRequest); }

  listSampleRequests(shopId: string, status?: SampleRequest['status']): SampleRequest[] {
    const rows = (status ? this.db.prepare('SELECT row_json FROM sample_requests WHERE shop_id = ? AND status = ? ORDER BY score DESC, seen_at DESC').all(shopId, status) : this.db.prepare('SELECT row_json FROM sample_requests WHERE shop_id = ? ORDER BY score DESC, seen_at DESC').all(shopId)) as Row[];
    return rows.map((r) => this.sampleRow(r));
  }

  getSampleRequest(shopId: string, applyId: string): SampleRequest | null {
    const r = this.db.prepare('SELECT row_json FROM sample_requests WHERE shop_id = ? AND apply_id = ?').get(shopId, applyId) as Row | undefined;
    return r ? this.sampleRow(r) : null;
  }

  saveSampleRequest(req: SampleRequest): void {
    this.db.prepare('INSERT INTO sample_requests (shop_id, apply_id, handle, row_json, verdict, score, status, seen_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (shop_id, apply_id) DO UPDATE SET handle = excluded.handle, row_json = excluded.row_json, verdict = excluded.verdict, score = excluded.score, status = excluded.status, seen_at = excluded.seen_at, decided_at = excluded.decided_at').run(req.shop_id, req.apply_id, req.handle, JSON.stringify(req), req.verdict, req.score, req.status, req.seen_at, req.decided_at);
  }

  /** Pending rows the latest scan did not see are gone (approved, rejected or expired in Cruva). */
  markSampleRequestsGone(shopId: string, seenApplyIds: string[], at = new Date().toISOString()): number {
    const rows = this.db.prepare("SELECT row_json FROM sample_requests WHERE shop_id = ? AND status = 'pending'").all(shopId) as Row[];
    const seen = new Set(seenApplyIds); let n = 0;
    for (const r of rows) { const req = this.sampleRow(r); if (!seen.has(req.apply_id)) { this.saveSampleRequest({ ...req, status: 'gone', decided_at: req.decided_at ?? at }); n += 1; } }
    return n;
  }

  /** The newest research on a creator across shops, to reuse within a fortnight. */
  latestSampleResearch(handle: string): SampleResearch | null {
    const r = this.db.prepare('SELECT row_json FROM sample_requests WHERE handle = ? ORDER BY seen_at DESC LIMIT 5').all(handle) as Row[];
    for (const row of r) { const req = this.sampleRow(row); if (req.research) return req.research; }
    return null;
  }

  /** Accepted through here since a moment, per shop; auto only when asked. */
  countSampleAccepted(shopId: string, sinceIso: string, autoOnly = false): number {
    const rows = this.db.prepare("SELECT row_json FROM sample_requests WHERE shop_id = ? AND status = 'accepted' AND decided_at >= ?").all(shopId, sinceIso) as Row[];
    return rows.map((r) => this.sampleRow(r)).filter((x) => !autoOnly || x.decided_by === 'auto').length;
  }

  // ---- Competitors and the market read ----

  listShopCompetitors(shopId: string): PlaybookCompetitor[] {
    return (this.db.prepare("SELECT * FROM cruva_competitors WHERE shop_id = ? ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END, COALESCE(gmv, 0) DESC, id").all(shopId) as Row[]).map((r) => this.competitorRow(r));
  }

  private competitorRow(r: Row): PlaybookCompetitor {
    return { id: Number(r.id), shop_id: String(r.shop_id), brand_id: String(r.brand_id), name: String(r.name), region: String(r.region), gmv: r.gmv === null ? null : Number(r.gmv), creators: r.creators === null ? null : Number(r.creators), videos: r.videos === null ? null : Number(r.videos), category: (r.category as string | null) ?? null, status: String(r.status) as PlaybookCompetitor['status'], reason: (r.reason as string | null) ?? null, source: String(r.source) as PlaybookCompetitor['source'], added_at: String(r.added_at), scanned_at: (r.scanned_at as string | null) ?? null };
  }

  /** Insert or refresh a competitor; an existing row keeps its status (a rejected brand stays rejected) but takes the fresh numbers. */
  upsertShopCompetitor(c: Omit<PlaybookCompetitor, 'id' | 'added_at' | 'scanned_at'>): PlaybookCompetitor {
    const have = this.db.prepare('SELECT * FROM cruva_competitors WHERE shop_id = ? AND brand_id = ?').get(c.shop_id, c.brand_id) as Row | undefined;
    if (have) {
      this.db.prepare('UPDATE cruva_competitors SET name = ?, region = ?, gmv = ?, creators = ?, videos = ?, category = ?, reason = COALESCE(?, reason), status = CASE WHEN ? = \'manual\' AND status = \'suggested\' THEN \'confirmed\' ELSE status END WHERE id = ?').run(c.name, c.region, c.gmv, c.creators, c.videos, c.category, c.reason, c.source, have.id);
      return this.competitorRow(this.db.prepare('SELECT * FROM cruva_competitors WHERE id = ?').get(have.id) as Row);
    }
    const id = Number(this.db.prepare('INSERT INTO cruva_competitors (shop_id, brand_id, name, region, gmv, creators, videos, category, status, reason, source, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(c.shop_id, c.brand_id, c.name, c.region, c.gmv, c.creators, c.videos, c.category, c.status, c.reason, c.source, new Date().toISOString()).lastInsertRowid);
    return this.competitorRow(this.db.prepare('SELECT * FROM cruva_competitors WHERE id = ?').get(id) as Row);
  }

  setShopCompetitorStatus(id: number, status: PlaybookCompetitor['status']): PlaybookCompetitor | null {
    this.db.prepare('UPDATE cruva_competitors SET status = ? WHERE id = ?').run(status, id);
    const r = this.db.prepare('SELECT * FROM cruva_competitors WHERE id = ?').get(id) as Row | undefined;
    return r ? this.competitorRow(r) : null;
  }

  markCompetitorsScanned(ids: number[], at = new Date().toISOString()): void {
    if (!ids.length) return;
    this.db.prepare(`UPDATE cruva_competitors SET scanned_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(at, ...ids);
  }

  deleteShopCompetitor(id: number): void { this.db.prepare('DELETE FROM cruva_competitors WHERE id = ?').run(id); }

  addMarket(shopId: string, profile: PlaybookMarketProfile): void {
    this.db.prepare('INSERT INTO cruva_market (shop_id, learned_at, profile_json) VALUES (?, ?, ?)').run(shopId, profile.learned_at, JSON.stringify(profile));
    this.db.prepare('DELETE FROM cruva_market WHERE shop_id = ? AND id NOT IN (SELECT id FROM cruva_market WHERE shop_id = ? ORDER BY id DESC LIMIT 6)').run(shopId, shopId);
  }

  /** Newest first. */
  listMarkets(shopId: string, limit = 1): PlaybookMarketProfile[] {
    return (this.db.prepare('SELECT profile_json FROM cruva_market WHERE shop_id = ? ORDER BY id DESC LIMIT ?').all(shopId, limit) as Row[]).map((r) => parseJson<PlaybookMarketProfile>(r.profile_json, {} as PlaybookMarketProfile));
  }

  /** Newest first. */
  listProfiles(shopId: string, limit = 2): PlaybookProfile[] {
    return (this.db.prepare('SELECT profile_json FROM cruva_profiles WHERE shop_id = ? ORDER BY id DESC LIMIT ?').all(shopId, limit) as Row[]).map((r) => parseJson<PlaybookProfile>(r.profile_json, {} as PlaybookProfile));
  }

  listRemoteItems(shopId?: string): { shop_id: string; kind: PlaybookKind; remote_id: string; name: string; enabled: boolean; seen_at: string }[] {
    return ((shopId ? this.db.prepare('SELECT shop_id, kind, remote_id, name, enabled, seen_at FROM cruva_remote_items WHERE shop_id = ?').all(shopId) : this.db.prepare('SELECT shop_id, kind, remote_id, name, enabled, seen_at FROM cruva_remote_items').all()) as Row[]).map((r) => ({ shop_id: r.shop_id as string, kind: r.kind as PlaybookKind, remote_id: r.remote_id as string, name: r.name as string, enabled: Boolean(r.enabled), seen_at: r.seen_at as string }));
  }

  // ---- Cruva rollouts (bulk prepare) ----

  private rowToRollout(r: Row): PlaybookRollout {
    const counts = Object.fromEntries((['ready', 'needs_input', 'blocked', 'approved', 'skipped', 'done', 'error', 'undone'] as PlaybookDraftStatus[]).map((k) => [k, 0])) as Record<PlaybookDraftStatus, number>;
    for (const c of this.db.prepare('SELECT status, COUNT(*) AS n FROM cruva_drafts WHERE rollout_id = ? GROUP BY status').all(r.id) as { status: PlaybookDraftStatus; n: number }[]) counts[c.status] = c.n;
    return { id: r.id as number, created_at: r.created_at as string, created_by: (r.created_by as string | null) ?? null, status: r.status as PlaybookRollout['status'], shop_ids: parseJson<string[]>(r.shop_ids_json, []), note: (r.note as string | null) ?? null, counts, ran_at: (r.ran_at as string | null) ?? null };
  }

  listRollouts(limit = 30): PlaybookRollout[] {
    return (this.db.prepare('SELECT * FROM cruva_rollouts ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => this.rowToRollout(r));
  }

  getRollout(id: number): PlaybookRollout | null {
    const r = this.db.prepare('SELECT * FROM cruva_rollouts WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToRollout(r) : null;
  }

  createRollout(shopIds: string[], createdBy: string | null, note: string | null = null): PlaybookRollout {
    const id = Number(this.db.prepare('INSERT INTO cruva_rollouts (created_at, created_by, status, shop_ids_json, note) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), createdBy, 'draft', JSON.stringify(shopIds), note).lastInsertRowid);
    return this.getRollout(id)!;
  }

  setRolloutStatus(id: number, status: PlaybookRollout['status'], ranAt: string | null = null): void {
    this.db.prepare('UPDATE cruva_rollouts SET status = ?, ran_at = COALESCE(?, ran_at) WHERE id = ?').run(status, ranAt, id);
  }

  deleteRollout(id: number): boolean {
    return this.db.prepare('DELETE FROM cruva_rollouts WHERE id = ?').run(id).changes > 0;
  }

  private rowToRolloutDraft(r: Row): PlaybookDraft {
    return {
      id: r.id as number, rollout_id: r.rollout_id as number, shop_id: r.shop_id as string, shop_name: r.shop_name as string, account_id: (r.account_id as number | null) ?? null,
      kind: r.kind as PlaybookDraft['kind'], key: r.key as string, name: r.name as string, description: (r.description as string | null) ?? null, language: r.language as string,
      action: r.action as PlaybookDraft['action'], tool: r.tool as string, payload: parseJson<Record<string, unknown>>(r.payload_json, {}), copy: (r.copy as string | null) ?? null,
      blockers: parseJson<string[]>(r.blockers_json, []), status: r.status as PlaybookDraftStatus, start_after: Boolean(r.start_after), save_override: Boolean(r.save_override),
      remote_id: (r.remote_id as string | null) ?? null, remote_name: (r.remote_name as string | null) ?? null, result: (r.result as string | null) ?? null, order_no: Number(r.order_no ?? 0), updated_at: r.updated_at as string,
      existing_copy: (r.existing_copy as string | null) ?? null, tailored_at: (r.tailored_at as string | null) ?? null,
    };
  }

  listRolloutDrafts(rolloutId: number): PlaybookDraft[] {
    return (this.db.prepare('SELECT * FROM cruva_drafts WHERE rollout_id = ? ORDER BY shop_name, order_no, id').all(rolloutId) as Row[]).map((r) => this.rowToRolloutDraft(r));
  }

  getRolloutDraft(id: number): PlaybookDraft | null {
    const r = this.db.prepare('SELECT * FROM cruva_drafts WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToRolloutDraft(r) : null;
  }

  addRolloutDraft(d: Omit<PlaybookDraft, 'id' | 'updated_at' | 'remote_id' | 'remote_name' | 'result'> & { remote_id?: string | null; remote_name?: string | null }): PlaybookDraft {
    const id = Number(this.db.prepare(`INSERT INTO cruva_drafts (rollout_id, shop_id, shop_name, account_id, kind, key, name, description, language, action, tool, payload_json, copy, blockers_json, status, start_after, save_override, remote_id, remote_name, order_no, updated_at, existing_copy)
      VALUES (@rollout_id, @shop_id, @shop_name, @account_id, @kind, @key, @name, @description, @language, @action, @tool, @payload_json, @copy, @blockers_json, @status, @start_after, @save_override, @remote_id, @remote_name, @order_no, @updated_at, @existing_copy)`)
      .run({ existing_copy: d.existing_copy ?? null, rollout_id: d.rollout_id, shop_id: d.shop_id, shop_name: d.shop_name, account_id: d.account_id, kind: d.kind, key: d.key, name: d.name, description: d.description, language: d.language, action: d.action, tool: d.tool, payload_json: JSON.stringify(d.payload), copy: d.copy, blockers_json: JSON.stringify(d.blockers), status: d.status, start_after: d.start_after ? 1 : 0, save_override: d.save_override ? 1 : 0, remote_id: d.remote_id ?? null, remote_name: d.remote_name ?? null, order_no: d.order_no, updated_at: new Date().toISOString() }).lastInsertRowid);
    return this.getRolloutDraft(id)!;
  }

  updateRolloutDraft(id: number, patch: Partial<Pick<PlaybookDraft, 'payload' | 'copy' | 'blockers' | 'status' | 'start_after' | 'save_override' | 'remote_id' | 'remote_name' | 'result' | 'name' | 'existing_copy' | 'tailored_at'>>): PlaybookDraft | null {
    const sets: string[] = []; const params: Record<string, unknown> = { id, updated_at: new Date().toISOString() };
    if (patch.existing_copy !== undefined) { sets.push('existing_copy = @existing_copy'); params.existing_copy = patch.existing_copy; }
    if (patch.tailored_at !== undefined) { sets.push('tailored_at = @tailored_at'); params.tailored_at = patch.tailored_at; }
    if (patch.payload !== undefined) { sets.push('payload_json = @payload_json'); params.payload_json = JSON.stringify(patch.payload); }
    if (patch.copy !== undefined) { sets.push('copy = @copy'); params.copy = patch.copy; }
    if (patch.blockers !== undefined) { sets.push('blockers_json = @blockers_json'); params.blockers_json = JSON.stringify(patch.blockers); }
    if (patch.status !== undefined) { sets.push('status = @status'); params.status = patch.status; }
    if (patch.start_after !== undefined) { sets.push('start_after = @start_after'); params.start_after = patch.start_after ? 1 : 0; }
    if (patch.save_override !== undefined) { sets.push('save_override = @save_override'); params.save_override = patch.save_override ? 1 : 0; }
    if (patch.remote_id !== undefined) { sets.push('remote_id = @remote_id'); params.remote_id = patch.remote_id; }
    if (patch.remote_name !== undefined) { sets.push('remote_name = @remote_name'); params.remote_name = patch.remote_name; }
    if (patch.result !== undefined) { sets.push('result = @result'); params.result = patch.result; }
    if (patch.name !== undefined) { sets.push('name = @name'); params.name = patch.name; }
    if (sets.length) this.db.prepare(`UPDATE cruva_drafts SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
    return this.getRolloutDraft(id);
  }

  // ---- Reply audits ----

  private rowToAudit(r: Row): ReplyAudit {
    const empty: ReplyAuditSummary = { by_account: [], by_intent: [], by_language: [], by_rubric: [], red: [] };
    return { id: r.id as number, started_at: r.started_at as string, finished_at: (r.finished_at as string | null) ?? null, since: r.since as string, sampled: Number(r.sampled ?? 0), mean: r.mean === null || r.mean === undefined ? null : Number(r.mean), prev_mean: null, fail_rate: r.fail_rate === null || r.fail_rate === undefined ? null : Number(r.fail_rate), summary: parseJson<ReplyAuditSummary>(r.summary_json, empty), actions: parseJson<ReplyAuditAction[]>(r.actions_json, []), slack_posted_at: (r.slack_posted_at as string | null) ?? null, error: (r.error as string | null) ?? null };
  }

  createReplyAudit(since: string, startedAt = new Date().toISOString()): ReplyAudit {
    const info = this.db.prepare('INSERT INTO reply_audits (started_at, since) VALUES (?, ?)').run(startedAt, since);
    return this.getReplyAudit(Number(info.lastInsertRowid))!;
  }

  finishReplyAudit(id: number, r: { sampled: number; mean: number | null; fail_rate: number | null; summary: ReplyAuditSummary; actions: ReplyAuditAction[]; error: string | null }): ReplyAudit {
    this.db.prepare('UPDATE reply_audits SET finished_at = ?, sampled = ?, mean = ?, fail_rate = ?, summary_json = ?, actions_json = ?, error = ? WHERE id = ?').run(new Date().toISOString(), r.sampled, r.mean, r.fail_rate, JSON.stringify(r.summary), JSON.stringify(r.actions), r.error, id);
    return this.getReplyAudit(id)!;
  }

  setReplyAuditActions(id: number, actions: ReplyAuditAction[]): void { this.db.prepare('UPDATE reply_audits SET actions_json = ? WHERE id = ?').run(JSON.stringify(actions), id); }
  markReplyAuditPosted(id: number): void { this.db.prepare('UPDATE reply_audits SET slack_posted_at = ? WHERE id = ?').run(new Date().toISOString(), id); }

  /** Newest first; `prev_mean` is the mean of the finished run before each. */
  listReplyAudits(limit = 30): ReplyAudit[] {
    const rows = (this.db.prepare('SELECT * FROM reply_audits ORDER BY id DESC LIMIT ?').all(limit + 1) as Row[]).map((r) => this.rowToAudit(r));
    return rows.slice(0, limit).map((a, i) => ({ ...a, prev_mean: rows.slice(i + 1).find((p) => p.finished_at)?.mean ?? null }));
  }

  getReplyAudit(id: number): ReplyAudit | null {
    const r = this.db.prepare('SELECT * FROM reply_audits WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const a = this.rowToAudit(r);
    const prev = this.db.prepare('SELECT mean FROM reply_audits WHERE id < ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(id) as { mean: number | null } | undefined;
    return { ...a, prev_mean: prev?.mean ?? null };
  }

  private rowToAuditItem(r: Row): ReplyAuditItem {
    return { id: r.id as number, audit_id: r.audit_id as number, event_id: r.event_id as number, conversation_ref: r.conversation_ref as number, account_id: (r.account_id as number | null) ?? null, channel: r.channel as InboxChannel, intent: (r.intent as string | null) ?? null, language: (r.language as string | null) ?? null, decision: (r.decision as string) ?? 'auto_sent', scores: parseJson<Record<string, number>>(r.scores_json, {}), total: Number(r.total), fail: Boolean(r.fail), why: (r.why as string | null) ?? '', unverified_claim: (r.unverified_claim as string | null) ?? null, note_key: (r.note_key as string | null) ?? null, note: (r.note as string | null) ?? null, fault: (r.fault as string | null) ?? null, their_text: (r.their_text as string | null) ?? null, reply_text: (r.reply_text as string | null) ?? null, followup_text: (r.followup_text as string | null) ?? null, counterpart: (r.counterpart as string | null) ?? null, created_at: r.created_at as string };
  }

  addReplyAuditItem(i: Omit<ReplyAuditItem, 'id' | 'created_at'>): ReplyAuditItem {
    const info = this.db.prepare('INSERT INTO reply_audit_items (audit_id, event_id, conversation_ref, account_id, channel, intent, language, decision, scores_json, total, fail, why, unverified_claim, note_key, note, fault, their_text, reply_text, followup_text, counterpart, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.audit_id, i.event_id, i.conversation_ref, i.account_id, i.channel, i.intent, i.language, i.decision, JSON.stringify(i.scores), i.total, i.fail ? 1 : 0, i.why, i.unverified_claim, i.note_key, i.note, i.fault, i.their_text, i.reply_text, i.followup_text, i.counterpart, new Date().toISOString());
    return this.rowToAuditItem(this.db.prepare('SELECT * FROM reply_audit_items WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
  }

  listReplyAuditItems(auditId: number): ReplyAuditItem[] {
    return (this.db.prepare('SELECT * FROM reply_audit_items WHERE audit_id = ? ORDER BY total ASC, fail DESC, id').all(auditId) as Row[]).map((r) => this.rowToAuditItem(r));
  }

  /** The latest audit verdict per reply event, for the badges in the log. */
  auditForEvents(eventIds: number[]): Map<number, { audit_id: number; total: number; fail: boolean; why: string }> {
    const out = new Map<number, { audit_id: number; total: number; fail: boolean; why: string }>();
    const ids = [...new Set(eventIds)];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of this.db.prepare(`SELECT event_id, audit_id, total, fail, why FROM reply_audit_items WHERE event_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`).all(...chunk) as Row[]) out.set(Number(r.event_id), { audit_id: Number(r.audit_id), total: Number(r.total), fail: Boolean(r.fail), why: String(r.why ?? '') });
    }
    return out;
  }

  // ---- Translations ----

  getTranslations(hashes: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (let i = 0; i < hashes.length; i += 400) {
      const chunk = hashes.slice(i, i + 400);
      for (const r of this.db.prepare(`SELECT hash, english FROM translations WHERE hash IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { hash: string; english: string }[]) out.set(r.hash, r.english);
    }
    return out;
  }

  putTranslation(hash: string, text: string, english: string): void {
    this.db.prepare('INSERT OR REPLACE INTO translations (hash, text, english, created_at) VALUES (?, ?, ?, ?)').run(hash, text, english, new Date().toISOString());
  }

  // ---- Reply policies and events ----

  getReplyPolicy(accountId: number, channel: InboxChannel): ReplyPolicy | null {
    const r = this.db.prepare('SELECT * FROM reply_policies WHERE account_id = ? AND channel = ?').get(accountId, channel) as Row | undefined;
    if (!r) return null;
    return { account_id: accountId, channel, mode: r.mode as ReplyPolicy['mode'], daily_cap: r.daily_cap === null || r.daily_cap === undefined ? null : Number(r.daily_cap), answer_all: Boolean(r.answer_all), only: parseJson<string[]>(r.only_json, []), never: parseJson<string[]>(r.never_json, []), auto_intents: parseJson<string[]>(r.auto_intents_json, []), quiet_from: (r.quiet_from as string | null) ?? null, quiet_to: (r.quiet_to as string | null) ?? null, max_age_hours: Number(r.max_age_hours ?? 48), shops_off: parseJson<string[]>(r.shops_off_json, []), languages: parseJson<Record<string, string>>(r.languages_json, {}), updated_at: (r.updated_at as string | null) ?? null };
  }

  listReplyPolicies(): ReplyPolicy[] {
    return (this.db.prepare('SELECT account_id, channel FROM reply_policies').all() as { account_id: number; channel: InboxChannel }[]).map((r) => this.getReplyPolicy(r.account_id, r.channel)!).filter(Boolean);
  }

  saveReplyPolicy(p: ReplyPolicy): ReplyPolicy {
    this.db.prepare(`INSERT INTO reply_policies (account_id, channel, mode, daily_cap, answer_all, only_json, never_json, auto_intents_json, quiet_from, quiet_to, max_age_hours, shops_off_json, languages_json, updated_at) VALUES (@account_id, @channel, @mode, @daily_cap, @answer_all, @only_json, @never_json, @auto_intents_json, @quiet_from, @quiet_to, @max_age_hours, @shops_off_json, @languages_json, @updated_at)
      ON CONFLICT(account_id, channel) DO UPDATE SET mode = excluded.mode, daily_cap = excluded.daily_cap, answer_all = excluded.answer_all, only_json = excluded.only_json, never_json = excluded.never_json, auto_intents_json = excluded.auto_intents_json, quiet_from = excluded.quiet_from, quiet_to = excluded.quiet_to, max_age_hours = excluded.max_age_hours, shops_off_json = excluded.shops_off_json, languages_json = excluded.languages_json, updated_at = excluded.updated_at`)
      .run({ account_id: p.account_id, channel: p.channel, mode: p.mode, daily_cap: p.daily_cap, answer_all: p.answer_all ? 1 : 0, only_json: JSON.stringify(p.only), never_json: JSON.stringify(p.never), auto_intents_json: JSON.stringify(p.auto_intents), quiet_from: p.quiet_from, quiet_to: p.quiet_to, max_age_hours: p.max_age_hours, shops_off_json: JSON.stringify(p.shops_off ?? []), languages_json: JSON.stringify(p.languages ?? {}), updated_at: new Date().toISOString() });
    return this.getReplyPolicy(p.account_id, p.channel)!;
  }

  private rowToReplyEvent(r: Row): ReplyEvent {
    return { id: r.id as number, conversation_ref: r.conversation_ref as number, account_id: (r.account_id as number | null) ?? null, channel: r.channel as InboxChannel, message_id: (r.message_id as string | null) ?? null, needs_reply: Boolean(r.needs_reply), intent: (r.intent as string | null) ?? null, escalation: (r.escalation as string | null) ?? null, confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence), language: (r.language as string | null) ?? null, context: parseJson<ReplyEvent['context']>(r.context_json, { chips: [], their_text: null, reply_text: null, counterpart: null }), decision: r.decision as ReplyDecision, reply_id: (r.reply_id as number | null) ?? null, model: (r.model as string | null) ?? null, feedback: (r.feedback as ReplyEvent['feedback']) ?? null, feedback_note: (r.feedback_note as string | null) ?? null, created_at: r.created_at as string };
  }

  addReplyEvent(e: Omit<ReplyEvent, 'id' | 'created_at' | 'feedback' | 'feedback_note'>): ReplyEvent {
    const id = Number(this.db.prepare(`INSERT INTO reply_events (conversation_ref, account_id, channel, message_id, needs_reply, intent, escalation, confidence, language, context_json, decision, reply_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.conversation_ref, e.account_id, e.channel, e.message_id, e.needs_reply ? 1 : 0, e.intent, e.escalation, e.confidence, e.language, JSON.stringify(e.context), e.decision, e.reply_id, e.model, new Date().toISOString()).lastInsertRowid);
    return this.getReplyEvent(id)!;
  }

  getReplyEvent(id: number): ReplyEvent | null {
    const r = this.db.prepare('SELECT * FROM reply_events WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToReplyEvent(r) : null;
  }

  listReplyEvents(opts: { accountId?: number; channel?: InboxChannel; conversationRef?: number; since?: string; limit?: number } = {}): ReplyEvent[] {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.accountId !== undefined) { where.push('account_id = ?'); params.push(opts.accountId); }
    if (opts.channel) { where.push('channel = ?'); params.push(opts.channel); }
    if (opts.conversationRef !== undefined) { where.push('conversation_ref = ?'); params.push(opts.conversationRef); }
    if (opts.since) { where.push('created_at >= ?'); params.push(opts.since); }
    params.push(opts.limit ?? 300);
    return (this.db.prepare(`SELECT * FROM reply_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params) as Row[]).map((r) => this.rowToReplyEvent(r));
  }

  /** Has this exact message already been decided on (so a re-sync never answers twice)? */
  replyEventFor(conversationRef: number, messageId: string): ReplyEvent | null {
    const r = this.db.prepare('SELECT * FROM reply_events WHERE conversation_ref = ? AND message_id = ? ORDER BY id DESC LIMIT 1').get(conversationRef, messageId) as Row | undefined;
    return r ? this.rowToReplyEvent(r) : null;
  }

  /** Drop the error decisions on the threads' latest messages so the next pass reads them again. Returns the conversation refs. */
  clearReplyErrors(accountId: number, channel: InboxChannel, conversationRefs?: number[]): number[] {
    const rows = this.db.prepare(`SELECT e.id, e.conversation_ref FROM reply_events e JOIN inbox_conversations c ON c.id = e.conversation_ref WHERE e.account_id = ? AND e.channel = ? AND e.decision = 'error' AND e.message_id = c.last_message_id${conversationRefs?.length ? ` AND e.conversation_ref IN (${conversationRefs.map(() => '?').join(',')})` : ''}`).all(accountId, channel, ...(conversationRefs ?? [])) as { id: number; conversation_ref: number }[];
    const del = this.db.prepare('DELETE FROM reply_events WHERE id = ?');
    this.db.transaction(() => { for (const r of rows) del.run(r.id); })();
    return [...new Set(rows.map((r) => r.conversation_ref))];
  }

  countReplyEvents(accountId: number, channel: InboxChannel, decision: ReplyDecision, since: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reply_events WHERE account_id = ? AND channel = ? AND decision = ? AND created_at >= ?').get(accountId, channel, decision, since) as { n: number }).n;
  }

  setReplyFeedback(id: number, feedback: 'right' | 'wrong' | null, note: string | null): ReplyEvent | null {
    this.db.prepare('UPDATE reply_events SET feedback = ?, feedback_note = ? WHERE id = ?').run(feedback, note, id);
    return this.getReplyEvent(id);
  }

  /** Replies sent from the dashboard today (manual + auto), per account and channel. */
  countRepliesSentSince(accountId: number, channel: InboxChannel, since: string): { auto: number; manual: number } {
    const rows = this.db.prepare(`SELECT r.mode AS mode, COUNT(*) AS n FROM inbox_replies r JOIN inbox_conversations c ON c.id = r.conversation_ref LEFT JOIN tts_shops s ON s.id = c.tts_shop_id LEFT JOIN account_shops cs ON cs.shop_id = c.tts_shop_id WHERE COALESCE(s.account_id, cs.account_id) = ? AND c.channel = ? AND r.sent_at >= ? GROUP BY r.mode`).all(accountId, channel, since) as { mode: string; n: number }[];
    return { auto: rows.find((r) => r.mode === 'auto')?.n ?? 0, manual: rows.filter((r) => r.mode !== 'auto').reduce((n, r) => n + r.n, 0) };
  }

  /** The newest unsent draft on a conversation, if any. */
  pendingDraft(conversationRef: number): InboxReply | null {
    const r = this.db.prepare(`SELECT * FROM inbox_replies WHERE conversation_ref = ? AND sent_at IS NULL AND error_message IS NULL AND mode = 'draft' ORDER BY id DESC LIMIT 1`).get(conversationRef) as Row | undefined;
    return r ? this.rowToReply(r) : null;
  }

  // ---- FBT paperwork ----

  // ---- Report schedules ----

  listReportSchedules(): ReportSchedule[] {
    return (this.db.prepare('SELECT * FROM report_schedules').all() as Row[]).map((r) => this.rowToSchedule(r));
  }

  getReportSchedule(accountId: number): ReportSchedule | null {
    const r = this.db.prepare('SELECT * FROM report_schedules WHERE account_id = ?').get(accountId) as Row | undefined;
    return r ? this.rowToSchedule(r) : null;
  }

  private rowToSchedule(r: Row): ReportSchedule {
    const j = parseJson<Partial<ReportSchedule>>(r.json, {});
    return { account_id: r.account_id as number, enabled: Boolean(j.enabled), weekday: j.weekday ?? 1, hour: j.hour ?? 9, minute: j.minute ?? 0, period: j.period === 'monthly' ? 'monthly' : 'weekly', kind: j.kind === 'cruva' ? 'cruva' : 'standard', autosend: Boolean(j.autosend), pdf: j.pdf !== false, last_generated_at: (r.last_generated_at as string | null) ?? null, updated_at: (r.updated_at as string | null) ?? null };
  }

  saveReportSchedule(accountId: number, s: Partial<ReportSchedule>): ReportSchedule {
    const cur = this.getReportSchedule(accountId);
    const { account_id: _a, last_generated_at: _l, updated_at: _u, ...rest } = { ...(cur ?? {}), ...s } as ReportSchedule;
    this.db.prepare(`INSERT INTO report_schedules (account_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(accountId, JSON.stringify(rest), new Date().toISOString());
    return this.getReportSchedule(accountId)!;
  }

  markReportGenerated(accountId: number, at = new Date().toISOString()): void {
    this.db.prepare('UPDATE report_schedules SET last_generated_at = ? WHERE account_id = ?').run(at, accountId);
  }

  // ---- Ad hoc client tasks ----

  private rowToTask(r: Row): ClientTask {
    return {
      id: r.id as number, account_id: r.account_id as number, account_name: (r.account_name as string | null) ?? '', am_name: (r.am_name as string | null) ?? null, title: r.title as string, detail: (r.detail as string | null) ?? '',
      source: r.source as ClientTask['source'], source_ref: (r.source_ref as string | null) ?? null, source_url: (r.source_url as string | null) ?? null, due_date: (r.due_date as string | null) ?? null, due_source: r.due_source === 'context' ? 'context' : 'am',
      status: r.status as ClientTask['status'], created_by: (r.created_by as string | null) ?? null, created_at: r.created_at as string, updated_at: r.updated_at as string, completed_at: (r.completed_at as string | null) ?? null, completed_by: (r.completed_by as string | null) ?? null, dismissed_at: (r.dismissed_at as string | null) ?? null,
    };
  }

  /** Tasks that touch the window: open tasks (any date), plus tasks created, due, completed or dismissed within it. */
  listClientTasks(opts: { accountId?: number | null; from?: string; to?: string; includeOpen?: boolean } = {}): ClientTask[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.accountId) { where.push('t.account_id = ?'); params.push(opts.accountId); }
    if (opts.from && opts.to) {
      const f = opts.from, t = `${opts.to}T23:59:59.999Z`;
      const inWin = `(substr(t.created_at, 1, 10) BETWEEN ? AND ?) OR (t.due_date BETWEEN ? AND ?) OR (t.completed_at BETWEEN ? AND ?) OR (t.dismissed_at BETWEEN ? AND ?)`;
      where.push(opts.includeOpen === false ? `(${inWin})` : `(t.status = 'open' OR ${inWin})`);
      params.push(f, opts.to, f, opts.to, f, t, f, t);
    }
    return (this.db.prepare(`SELECT t.*, a.name AS account_name, a.am_name FROM client_tasks t JOIN accounts a ON a.id = t.account_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, t.due_date IS NULL, t.due_date, t.created_at DESC`).all(...params) as Row[]).map((r) => this.rowToTask(r));
  }

  getClientTask(id: number): ClientTask | null {
    const r = this.db.prepare('SELECT t.*, a.name AS account_name, a.am_name FROM client_tasks t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?').get(id) as Row | undefined;
    return r ? this.rowToTask(r) : null;
  }

  hasClientTask(accountId: number, sourceRef: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM client_tasks WHERE account_id = ? AND source_ref = ?').get(accountId, sourceRef));
  }

  /** Open or recent titles for one account, to keep the extractor from adding the same ask twice. */
  recentClientTaskTitles(accountId: number, days = 60): string[] {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return (this.db.prepare('SELECT title FROM client_tasks WHERE account_id = ? AND (status = ? OR created_at >= ?)').all(accountId, 'open', since) as { title: string }[]).map((r) => r.title);
  }

  createClientTask(i: { account_id: number; title: string; detail?: string | null; source?: ClientTask['source']; source_ref?: string | null; source_url?: string | null; due_date?: string | null; due_source?: ClientTask['due_source']; created_by?: string | null }): ClientTask {
    const res = this.db.prepare('INSERT INTO client_tasks (account_id, title, detail, source, source_ref, source_url, due_date, due_source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.account_id, i.title.trim().slice(0, 240), (i.detail ?? '').trim().slice(0, 6000), i.source ?? 'manual', i.source_ref ?? null, i.source_url ?? null, i.due_date ?? null, i.due_source ?? (i.due_date ? 'context' : 'am'), i.created_by ?? null);
    return this.getClientTask(Number(res.lastInsertRowid))!;
  }

  updateClientTask(id: number, patch: Partial<{ title: string; detail: string; due_date: string | null; due_source: ClientTask['due_source']; status: ClientTask['status']; completed_at: string | null; completed_by: string | null; dismissed_at: string | null }>): ClientTask | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = @${k}`); params[k] = v; }
    if (sets.length) this.db.prepare(`UPDATE client_tasks SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run(params);
    return this.getClientTask(id);
  }

  deleteClientTask(id: number): boolean {
    return this.db.prepare('DELETE FROM client_tasks WHERE id = ?').run(id).changes > 0;
  }

  // ---- Onboarding: targets ----

  getTargetState(leadId: number): { status: 'open' | 'ready' | 'lost'; am_person_id: number | null; analysis: TargetAnalysis | null; analysis_at: string | null; ready_at: string | null; ready_by: string | null; lost_at: string | null; seen_at: string | null } | null {
    const r = this.db.prepare('SELECT * FROM lead_targets WHERE lead_id = ?').get(leadId) as Row | undefined;
    if (!r) return null;
    return { status: (r.status as 'open' | 'ready' | 'lost') ?? 'open', am_person_id: (r.am_person_id as number | null) ?? null, analysis: r.analysis_json ? parseJson<TargetAnalysis | null>(r.analysis_json, null) : null, analysis_at: (r.analysis_at as string | null) ?? null, ready_at: (r.ready_at as string | null) ?? null, ready_by: (r.ready_by as string | null) ?? null, lost_at: (r.lost_at as string | null) ?? null, seen_at: (r.seen_at as string | null) ?? null };
  }

  listTargetStates(): Map<number, NonNullable<ReturnType<Queries['getTargetState']>>> {
    const out = new Map<number, NonNullable<ReturnType<Queries['getTargetState']>>>();
    for (const r of this.db.prepare('SELECT lead_id FROM lead_targets').all() as { lead_id: number }[]) { const st = this.getTargetState(r.lead_id); if (st) out.set(r.lead_id, st); }
    return out;
  }

  saveTargetState(leadId: number, patch: Partial<{ status: 'open' | 'ready' | 'lost'; am_person_id: number | null; analysis: TargetAnalysis | null; analysis_at: string | null; ready_at: string | null; ready_by: string | null; lost_at: string | null; seen_at: string | null }>): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO lead_targets (lead_id, updated_at) VALUES (?, ?)').run(leadId, now);
    const sets: string[] = [];
    const params: Record<string, unknown> = { lead_id: leadId, updated_at: now };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'analysis') { sets.push('analysis_json = @analysis_json'); params.analysis_json = v === null ? null : JSON.stringify(v); continue; }
      sets.push(`${k} = @${k}`); params[k] = v;
    }
    this.db.prepare(`UPDATE lead_targets SET ${[...sets, 'updated_at = @updated_at'].join(', ')} WHERE lead_id = @lead_id`).run(params);
  }

  // ---- Onboarding: checklists ----

  private rowToOnboarding(r: Row): Onboarding {
    const steps = parseJson<OnboardingStep[]>(r.steps_json, []);
    return {
      id: r.id as number, lead_id: (r.lead_id as number | null) ?? null, lead_name: (r.lead_name as string | null) ?? null, account_id: (r.account_id as number | null) ?? null, account_name: (r.account_name as string | null) ?? null,
      name: r.name as string, markets: (r.markets as string | null) ?? null, am_person_id: (r.am_person_id as number | null) ?? null, am_name: (r.am_name as string | null) ?? null, status: r.status === 'done' ? 'done' : 'active',
      steps, terms: { retainer: null, currency: 'EUR', commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, term_months: 3, notice_months: 1, start_date: null, markets: '', billing_entity: '', notes: '', ...parseJson<Partial<OnboardingTerms>>(r.terms_json, {}) },
      context: { summary: null, sources: [], poc: null, country: null, est_value: null, analysed_at: null, ...parseJson<Partial<OnboardingContext>>(r.context_json, {}) },
      notes: (r.notes as string | null) ?? null, created_by: (r.created_by as string | null) ?? null, created_at: r.created_at as string, updated_at: r.updated_at as string, completed_at: (r.completed_at as string | null) ?? null,
      done: steps.filter((st) => st.done_at).length, total: steps.length,
    };
  }

  private static ONB_SELECT = 'SELECT o.*, l.name AS lead_name, a.name AS account_name, p.name AS am_name FROM onboardings o LEFT JOIN leads l ON l.id = o.lead_id LEFT JOIN accounts a ON a.id = o.account_id LEFT JOIN people p ON p.id = o.am_person_id';

  listOnboardings(): Onboarding[] {
    return (this.db.prepare(`${Queries.ONB_SELECT} ORDER BY CASE o.status WHEN 'active' THEN 0 ELSE 1 END, o.updated_at DESC`).all() as Row[]).map((r) => this.rowToOnboarding(r));
  }

  getOnboarding(id: number): Onboarding | null {
    const r = this.db.prepare(`${Queries.ONB_SELECT} WHERE o.id = ?`).get(id) as Row | undefined;
    return r ? this.rowToOnboarding(r) : null;
  }

  onboardingForLead(leadId: number): Onboarding | null {
    const r = this.db.prepare(`${Queries.ONB_SELECT} WHERE o.lead_id = ?`).get(leadId) as Row | undefined;
    return r ? this.rowToOnboarding(r) : null;
  }

  createOnboarding(i: { lead_id?: number | null; account_id?: number | null; name: string; markets?: string | null; am_person_id?: number | null; steps: OnboardingStep[]; terms?: Partial<OnboardingTerms>; context?: Partial<OnboardingContext>; created_by?: string | null }): Onboarding {
    const res = this.db.prepare('INSERT INTO onboardings (lead_id, account_id, name, markets, am_person_id, steps_json, terms_json, context_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.lead_id ?? null, i.account_id ?? null, i.name, i.markets ?? null, i.am_person_id ?? null, JSON.stringify(i.steps), JSON.stringify(i.terms ?? {}), JSON.stringify(i.context ?? {}), i.created_by ?? null);
    return this.getOnboarding(Number(res.lastInsertRowid))!;
  }

  updateOnboarding(id: number, patch: Partial<{ name: string; markets: string | null; am_person_id: number | null; status: 'active' | 'done'; steps: OnboardingStep[]; terms: OnboardingTerms; context: OnboardingContext; notes: string | null; account_id: number | null; completed_at: string | null }>): Onboarding | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'steps' || k === 'terms' || k === 'context') { sets.push(`${k}_json = @${k}_json`); params[`${k}_json`] = JSON.stringify(v); continue; }
      sets.push(`${k} = @${k}`); params[k] = v;
    }
    if (sets.length) this.db.prepare(`UPDATE onboardings SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run(params);
    return this.getOnboarding(id);
  }

  deleteOnboarding(id: number): boolean {
    return this.db.prepare('DELETE FROM onboardings WHERE id = ?').run(id).changes > 0;
  }

  // ---- Pitch designer ----

  private rowToPitch(r: Row): Pitch {
    return {
      id: r.id as number, lead_id: (r.lead_id as number | null) ?? null, lead_name: (r.lead_name as string | null) ?? null, name: r.name as string, client: r.client as string,
      brief: parseJson<PitchBrief>(r.brief_json, {} as PitchBrief), research: r.research_json ? parseJson<PitchResearch | null>(r.research_json, null) : null, deck: r.deck_json ? parseJson<PitchDeck | null>(r.deck_json, null) : null,
      status: r.status === 'ready' ? 'ready' : 'draft', created_by: (r.created_by as string | null) ?? null, created_at: r.created_at as string, updated_at: r.updated_at as string,
    };
  }

  listPitches(): Pitch[] {
    return (this.db.prepare('SELECT p.*, l.name AS lead_name FROM pitches p LEFT JOIN leads l ON l.id = p.lead_id ORDER BY p.updated_at DESC').all() as Row[]).map((r) => this.rowToPitch(r));
  }

  getPitch(id: number): Pitch | null {
    const r = this.db.prepare('SELECT p.*, l.name AS lead_name FROM pitches p LEFT JOIN leads l ON l.id = p.lead_id WHERE p.id = ?').get(id) as Row | undefined;
    return r ? this.rowToPitch(r) : null;
  }

  createPitch(i: { lead_id?: number | null; name: string; client: string; brief: PitchBrief; created_by?: string | null }): Pitch {
    const res = this.db.prepare('INSERT INTO pitches (lead_id, name, client, brief_json, created_by) VALUES (?, ?, ?, ?, ?)').run(i.lead_id ?? null, i.name, i.client, JSON.stringify(i.brief), i.created_by ?? null);
    return this.getPitch(Number(res.lastInsertRowid))!;
  }

  updatePitch(id: number, patch: Partial<{ name: string; client: string; lead_id: number | null; brief: PitchBrief; research: PitchResearch | null; deck: PitchDeck | null; status: 'draft' | 'ready' }>): Pitch | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'brief' || k === 'research' || k === 'deck') { sets.push(`${k}_json = @${k}_json`); params[`${k}_json`] = v === null ? null : JSON.stringify(v); continue; }
      sets.push(`${k} = @${k}`); params[k] = v;
    }
    if (sets.length) this.db.prepare(`UPDATE pitches SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run(params);
    return this.getPitch(id);
  }

  deletePitch(id: number): boolean {
    return this.db.prepare('DELETE FROM pitches WHERE id = ?').run(id).changes > 0;
  }

  getFbtProfile(accountId: number, market: string): Partial<FbtProfile> & { updated_at: string | null } {
    const r = this.db.prepare('SELECT json, updated_at FROM fbt_profiles WHERE account_id = ? AND market = ?').get(accountId, market.toUpperCase()) as Row | undefined;
    return { ...parseJson<Partial<FbtProfile>>(r?.json, {}), updated_at: (r?.updated_at as string | null) ?? null };
  }

  saveFbtProfile(accountId: number, market: string, p: Partial<FbtProfile>): void {
    const { account_id: _a, market: _m, updated_at: _u, ...rest } = p;
    this.db.prepare(`INSERT INTO fbt_profiles (account_id, market, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, market) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(accountId, market.toUpperCase(), JSON.stringify(rest), new Date().toISOString());
  }

  listFbtSkuSpecs(shopId: string): FbtSkuSpec[] {
    return (this.db.prepare('SELECT * FROM fbt_sku_specs WHERE shop_id = ?').all(shopId) as Row[]).map((r) => ({ shop_id: r.shop_id as string, sku_id: r.sku_id as string, goods_id: null, barcode: null, units_per_carton: null, carton_length_cm: null, carton_width_cm: null, carton_height_cm: null, carton_weight_kg: null, cartons_per_pallet: null, expiry: null, lot: null, ...parseJson<Partial<FbtSkuSpec>>(r.json, {}), updated_at: (r.updated_at as string | null) ?? null }));
  }

  saveFbtSkuSpec(shopId: string, skuId: string, spec: Partial<FbtSkuSpec>): void {
    const cur = this.listFbtSkuSpecs(shopId).find((x) => x.sku_id === skuId);
    const { shop_id: _s, sku_id: _k, updated_at: _u, ...rest } = { ...(cur ?? {}), ...spec } as FbtSkuSpec;
    this.db.prepare(`INSERT INTO fbt_sku_specs (shop_id, sku_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, sku_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(shopId, skuId, JSON.stringify(rest), new Date().toISOString());
  }

  // ---- P&L ----

  getPnlInputs(accountId: number, month: string): Partial<PnlInputs> | null {
    const r = this.db.prepare('SELECT json FROM pnl_inputs WHERE account_id = ? AND month = ?').get(accountId, month) as Row | undefined;
    return r ? parseJson<Partial<PnlInputs>>(r.json, {}) : null;
  }

  /** The newest inputs on or before the month, so a new month starts from the last one entered. */
  latestPnlInputs(accountId: number, month: string): Partial<PnlInputs> | null {
    const r = this.db.prepare('SELECT json FROM pnl_inputs WHERE account_id = ? AND month <= ? ORDER BY month DESC LIMIT 1').get(accountId, month) as Row | undefined;
    return r ? parseJson<Partial<PnlInputs>>(r.json, {}) : null;
  }

  listPnlMonths(accountId: number): string[] {
    return (this.db.prepare('SELECT month FROM pnl_inputs WHERE account_id = ? ORDER BY month').all(accountId) as { month: string }[]).map((r) => r.month);
  }

  savePnlInputs(accountId: number, month: string, inputs: Partial<PnlInputs>): void {
    this.db.prepare(`INSERT INTO pnl_inputs (account_id, month, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, month) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(accountId, month, JSON.stringify(inputs), new Date().toISOString());
  }

  listPnlSkuCogs(accountId: number): PnlSkuCogs[] {
    return (this.db.prepare('SELECT * FROM pnl_sku_cogs WHERE account_id = ? ORDER BY label').all(accountId) as Row[]).map((r) => ({ account_id: r.account_id as number, key: r.key as string, label: r.label as string, cogs: Number(r.cogs), currency: r.currency as string, updated_at: (r.updated_at as string | null) ?? null }));
  }

  savePnlSkuCogs(accountId: number, key: string, label: string, cogs: number | null, currency: string): void {
    if (cogs === null) { this.db.prepare('DELETE FROM pnl_sku_cogs WHERE account_id = ? AND key = ?').run(accountId, key); return; }
    this.db.prepare(`INSERT INTO pnl_sku_cogs (account_id, key, label, cogs, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, key) DO UPDATE SET label = excluded.label, cogs = excluded.cogs, currency = excluded.currency, updated_at = excluded.updated_at`).run(accountId, key, label, cogs, currency, new Date().toISOString());
  }

  // ---- Client question copilot ----

  private rowToQuestion(r: Row): CopilotQuestion {
    return {
      id: r.id as number, account_id: (r.account_id as number | null) ?? null, account_name: (r.account_name as string | null) ?? null, source: r.source as CopilotQuestion['source'], channel: (r.channel as string | null) ?? null, thread_ts: (r.thread_ts as string | null) ?? null, external_id: (r.external_id as string | null) ?? null,
      audience: r.audience === 'internal' ? 'internal' : 'client', as_of: (r.as_of as string | null) ?? null, slack_text: null,
      asked_by: (r.asked_by as string | null) ?? null, question: r.question as string, answer: (r.answer as string | null) ?? null, sources: parseJson<CopilotSource[]>(r.sources_json, []), generator: (r.generator as CopilotQuestion['generator']) ?? null, status: r.status as CopilotQuestion['status'],
      created_by: (r.created_by as string | null) ?? null, created_at: r.created_at as string, answered_at: (r.answered_at as string | null) ?? null, sent_at: (r.sent_at as string | null) ?? null,
    };
  }

  listQuestions(limit = 200): CopilotQuestion[] {
    return (this.db.prepare('SELECT c.*, a.name AS account_name FROM copilot_questions c LEFT JOIN accounts a ON a.id = c.account_id ORDER BY c.created_at DESC LIMIT ?').all(limit) as Row[]).map((r) => this.rowToQuestion(r));
  }

  getQuestion(id: number): CopilotQuestion | null {
    const r = this.db.prepare('SELECT c.*, a.name AS account_name FROM copilot_questions c LEFT JOIN accounts a ON a.id = c.account_id WHERE c.id = ?').get(id) as Row | undefined;
    return r ? this.rowToQuestion(r) : null;
  }

  /** Returns null when a question with this source + external id already exists. */
  createQuestion(i: { account_id: number | null; source: CopilotQuestion['source']; channel?: string | null; thread_ts?: string | null; external_id?: string | null; asked_by?: string | null; question: string; created_by?: string | null; audience?: CopilotQuestion['audience']; as_of?: string | null }): CopilotQuestion | null {
    if (i.external_id && this.db.prepare('SELECT 1 FROM copilot_questions WHERE source = ? AND external_id = ?').get(i.source, i.external_id)) return null;
    const res = this.db.prepare('INSERT INTO copilot_questions (account_id, source, channel, thread_ts, external_id, asked_by, question, created_by, audience, as_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(i.account_id, i.source, i.channel ?? null, i.thread_ts ?? null, i.external_id ?? null, i.asked_by ?? null, i.question, i.created_by ?? null, i.audience ?? 'client', i.as_of ?? null);
    return this.getQuestion(Number(res.lastInsertRowid));
  }

  updateQuestion(id: number, patch: Partial<{ answer: string | null; sources: CopilotSource[]; generator: CopilotQuestion['generator']; status: CopilotQuestion['status']; answered_at: string | null; sent_at: string | null; account_id: number | null; question: string }>): CopilotQuestion | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'sources') { sets.push('sources_json = @sources_json'); params.sources_json = JSON.stringify(v); continue; }
      sets.push(`${k} = @${k}`); params[k] = v;
    }
    if (sets.length) this.db.prepare(`UPDATE copilot_questions SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getQuestion(id);
  }

  deleteQuestion(id: number): boolean {
    return this.db.prepare('DELETE FROM copilot_questions WHERE id = ?').run(id).changes > 0;
  }

  upsertEvidence(rows: { account_id: number | null; kind: string; ref: string; title: string; text: string; url?: string | null; occurred_at?: string | null }[]): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`INSERT INTO copilot_evidence (account_id, kind, ref, title, text, url, occurred_at, indexed_at) VALUES (@account_id, @kind, @ref, @title, @text, @url, @occurred_at, @indexed_at)
      ON CONFLICT(kind, ref) DO UPDATE SET account_id = excluded.account_id, title = excluded.title, text = excluded.text, url = excluded.url, occurred_at = excluded.occurred_at, indexed_at = excluded.indexed_at`);
    let n = 0;
    this.db.transaction(() => { for (const r of rows) n += stmt.run({ url: null, occurred_at: null, ...r, text: r.text.slice(0, 60000), indexed_at: now }).changes; })();
    return n;
  }

  listEvidence(opts: { accountId?: number | null; kinds?: string[]; from?: string | null; to?: string | null; ownOnly?: boolean } = {}): { id: number; account_id: number | null; kind: string; ref: string; title: string; text: string; url: string | null; occurred_at: string | null; indexed_at: string }[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.accountId !== undefined && opts.accountId !== null) { where.push(opts.ownOnly ? 'account_id = ?' : '(account_id = ? OR account_id IS NULL)'); params.push(opts.accountId); }
    if (opts.kinds?.length) { where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`); params.push(...opts.kinds); }
    if (opts.from) { where.push('occurred_at >= ?'); params.push(opts.from); }
    if (opts.to) { where.push('occurred_at <= ?'); params.push(`${opts.to}T23:59:59.999Z`); }
    return (this.db.prepare(`SELECT * FROM copilot_evidence ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC`).all(...params) as Row[]).map((r) => ({ id: r.id as number, account_id: (r.account_id as number | null) ?? null, kind: r.kind as string, ref: r.ref as string, title: r.title as string, text: r.text as string, url: (r.url as string | null) ?? null, occurred_at: (r.occurred_at as string | null) ?? null, indexed_at: r.indexed_at as string }));
  }

  /** Evidence rows without their text: for counts, titles and matching, where loading transcripts would be waste. */
  listEvidenceHeads(opts: { kinds?: string[]; from?: string | null; unmatchedOnly?: boolean } = {}): { id: number; account_id: number | null; kind: string; title: string; occurred_at: string | null }[] {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.kinds?.length) { where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`); params.push(...opts.kinds); }
    if (opts.from) { where.push('occurred_at >= ?'); params.push(opts.from); }
    if (opts.unmatchedOnly) where.push('account_id IS NULL');
    return (this.db.prepare(`SELECT id, account_id, kind, title, occurred_at FROM copilot_evidence ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC`).all(...params) as Row[]).map((r) => ({ id: Number(r.id), account_id: (r.account_id as number | null) ?? null, kind: String(r.kind), title: String(r.title), occurred_at: (r.occurred_at as string | null) ?? null }));
  }

  /** Rows per account, in one query (no text loaded). */
  evidenceCountByAccount(): Map<number, number> {
    const out = new Map<number, number>();
    for (const r of this.db.prepare('SELECT account_id, COUNT(*) AS n FROM copilot_evidence WHERE account_id IS NOT NULL GROUP BY account_id').all() as Row[]) out.set(Number(r.account_id), Number(r.n));
    return out;
  }

  /** Rows per account and kind since a date, in one query. */
  evidenceStats(from: string, kinds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.db.prepare(`SELECT account_id, kind, COUNT(*) AS n FROM copilot_evidence WHERE occurred_at >= ? AND kind IN (${kinds.map(() => '?').join(',')}) GROUP BY account_id, kind`).all(from, ...kinds) as Row[]) out.set(`${r.account_id ?? 'none'}:${r.kind}`, Number(r.n));
    return out;
  }

  hasEvidence(kind: string, ref: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM copilot_evidence WHERE kind = ? AND ref = ?').get(kind, ref));
  }

  evidenceCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT kind, COUNT(*) AS n FROM copilot_evidence GROUP BY kind').all() as { kind: string; n: number }[]) out[r.kind] = r.n;
    return out;
  }
  // ---- Competitor intelligence ----

  private rowToCompetitor(r: Row): Competitor {
    return {
      id: Number(r.id), name: String(r.name), domain: (r.domain as string | null) ?? null, linkedin_url: (r.linkedin_url as string | null) ?? null, tiktok_handle: (r.tiktok_handle as string | null) ?? null,
      markets: String(r.markets ?? '').split(',').map((m) => m.trim()).filter(Boolean), apollo_org_id: (r.apollo_org_id as string | null) ?? null,
      watch_urls: parseJson<string[]>(r.watch_urls_json, []), ats: parseJson<CompetitorAts[]>(r.ats_json, []), notes: (r.notes as string | null) ?? null, enabled: Boolean(r.enabled),
      last_checked_at: (r.last_checked_at as string | null) ?? null, last_error: (r.last_error as string | null) ?? null, created_at: String(r.created_at), updated_at: String(r.updated_at),
    };
  }

  listCompetitors(): Competitor[] {
    return (this.db.prepare('SELECT * FROM competitors ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => this.rowToCompetitor(r));
  }

  getCompetitor(id: number): Competitor | null {
    const r = this.db.prepare('SELECT * FROM competitors WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToCompetitor(r) : null;
  }

  createCompetitor(i: { name: string; domain?: string | null; linkedin_url?: string | null; tiktok_handle?: string | null; markets?: string[]; apollo_org_id?: string | null; watch_urls?: string[]; ats?: CompetitorAts[]; notes?: string | null; enabled?: boolean }): Competitor {
    const res = this.db.prepare('INSERT INTO competitors (name, domain, linkedin_url, tiktok_handle, markets, apollo_org_id, watch_urls_json, ats_json, notes, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.name, i.domain ?? null, i.linkedin_url ?? null, i.tiktok_handle ?? null, (i.markets ?? []).join(','), i.apollo_org_id ?? null, JSON.stringify(i.watch_urls ?? []), JSON.stringify(i.ats ?? []), i.notes ?? null, i.enabled === false ? 0 : 1);
    return this.getCompetitor(Number(res.lastInsertRowid))!;
  }

  updateCompetitor(id: number, patch: Partial<{ name: string; domain: string | null; linkedin_url: string | null; tiktok_handle: string | null; markets: string[]; apollo_org_id: string | null; watch_urls: string[]; ats: CompetitorAts[]; notes: string | null; enabled: boolean; last_checked_at: string | null; last_error: string | null }>): Competitor | null {
    const sets: string[] = []; const params: Record<string, unknown> = { id };
    const set = (col: string, v: unknown) => { sets.push(`${col} = @${col}`); params[col] = v; };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.domain !== undefined) set('domain', patch.domain);
    if (patch.linkedin_url !== undefined) set('linkedin_url', patch.linkedin_url);
    if (patch.tiktok_handle !== undefined) set('tiktok_handle', patch.tiktok_handle);
    if (patch.markets !== undefined) set('markets', patch.markets.join(','));
    if (patch.apollo_org_id !== undefined) set('apollo_org_id', patch.apollo_org_id);
    if (patch.watch_urls !== undefined) set('watch_urls_json', JSON.stringify(patch.watch_urls));
    if (patch.ats !== undefined) set('ats_json', JSON.stringify(patch.ats));
    if (patch.notes !== undefined) set('notes', patch.notes);
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.last_checked_at !== undefined) set('last_checked_at', patch.last_checked_at);
    if (patch.last_error !== undefined) set('last_error', patch.last_error);
    if (sets.length) this.db.prepare(`UPDATE competitors SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run(params);
    return this.getCompetitor(id);
  }

  deleteCompetitor(id: number): boolean {
    return this.db.prepare('DELETE FROM competitors WHERE id = ?').run(id).changes > 0;
  }

  private rowToCompetitorPerson(r: Row): CompetitorPerson {
    return { id: Number(r.id), competitor_id: Number(r.competitor_id), apollo_id: String(r.apollo_id), name: String(r.name), title: (r.title as string | null) ?? null, prev_title: (r.prev_title as string | null) ?? null, seniority: (r.seniority as string | null) ?? null, department: (r.department as string | null) ?? null, location: (r.location as string | null) ?? null, linkedin_url: (r.linkedin_url as string | null) ?? null, started_at: (r.started_at as string | null) ?? null, first_seen_at: String(r.first_seen_at), last_seen_at: String(r.last_seen_at), miss_count: Number(r.miss_count ?? 0), left_at: (r.left_at as string | null) ?? null };
  }

  listCompetitorPeople(competitorId: number, opts: { includeLeft?: boolean } = {}): CompetitorPerson[] {
    return (this.db.prepare(`SELECT * FROM competitor_people WHERE competitor_id = ? ${opts.includeLeft ? '' : 'AND left_at IS NULL'} ORDER BY left_at IS NOT NULL, name COLLATE NOCASE`).all(competitorId) as Row[]).map((r) => this.rowToCompetitorPerson(r));
  }

  upsertCompetitorPerson(p: { competitor_id: number; apollo_id: string; name: string; title: string | null; prev_title?: string | null; seniority: string | null; department: string | null; location: string | null; linkedin_url: string | null; started_at: string | null; seen_at: string; miss_count?: number; left_at?: string | null }): void {
    this.db.prepare(`INSERT INTO competitor_people (competitor_id, apollo_id, name, title, prev_title, seniority, department, location, linkedin_url, started_at, first_seen_at, last_seen_at, miss_count, left_at)
      VALUES (@competitor_id, @apollo_id, @name, @title, @prev_title, @seniority, @department, @location, @linkedin_url, @started_at, @seen_at, @seen_at, @miss_count, @left_at)
      ON CONFLICT(competitor_id, apollo_id) DO UPDATE SET name = excluded.name, title = excluded.title, prev_title = excluded.prev_title, seniority = excluded.seniority, department = excluded.department, location = excluded.location, linkedin_url = COALESCE(excluded.linkedin_url, competitor_people.linkedin_url), started_at = COALESCE(excluded.started_at, competitor_people.started_at), last_seen_at = excluded.last_seen_at, miss_count = excluded.miss_count, left_at = excluded.left_at`)
      .run({ ...p, prev_title: p.prev_title ?? null, miss_count: p.miss_count ?? 0, left_at: p.left_at ?? null });
  }

  markCompetitorPersonMissed(id: number, missCount: number, leftAt: string | null): void {
    this.db.prepare('UPDATE competitor_people SET miss_count = ?, left_at = ? WHERE id = ?').run(missCount, leftAt, id);
  }

  private rowToCompetitorJob(r: Row): CompetitorJob {
    return { id: Number(r.id), competitor_id: Number(r.competitor_id), source: String(r.source), ext_id: String(r.ext_id), title: String(r.title), location: (r.location as string | null) ?? null, url: (r.url as string | null) ?? null, posted_at: (r.posted_at as string | null) ?? null, first_seen_at: String(r.first_seen_at), last_seen_at: String(r.last_seen_at), closed_at: (r.closed_at as string | null) ?? null };
  }

  listCompetitorJobs(competitorId: number, opts: { includeClosed?: boolean } = {}): CompetitorJob[] {
    return (this.db.prepare(`SELECT * FROM competitor_jobs WHERE competitor_id = ? ${opts.includeClosed ? '' : 'AND closed_at IS NULL'} ORDER BY closed_at IS NOT NULL, COALESCE(posted_at, first_seen_at) DESC`).all(competitorId) as Row[]).map((r) => this.rowToCompetitorJob(r));
  }

  /** Upsert the open roles from one source; roles no longer listed by that source are closed. Returns what opened and what closed. */
  syncCompetitorJobs(competitorId: number, source: string, jobs: { ext_id: string; title: string; location: string | null; url: string | null; posted_at: string | null }[], now: string): { opened: CompetitorJob[]; closed: CompetitorJob[] } {
    const before = new Map(this.listCompetitorJobs(competitorId).filter((j) => j.source === source).map((j) => [j.ext_id, j]));
    const opened: CompetitorJob[] = [];
    const ins = this.db.prepare(`INSERT INTO competitor_jobs (competitor_id, source, ext_id, title, location, url, posted_at, first_seen_at, last_seen_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(competitor_id, source, ext_id) DO UPDATE SET title = excluded.title, location = excluded.location, url = excluded.url, posted_at = COALESCE(excluded.posted_at, competitor_jobs.posted_at), last_seen_at = excluded.last_seen_at, closed_at = NULL`);
    const seen = new Set<string>();
    this.db.transaction(() => {
      for (const j of jobs) {
        if (!j.ext_id || seen.has(j.ext_id)) continue; seen.add(j.ext_id);
        ins.run(competitorId, source, j.ext_id, j.title, j.location, j.url, j.posted_at, now, now);
        if (!before.has(j.ext_id)) opened.push(this.db.prepare('SELECT * FROM competitor_jobs WHERE competitor_id = ? AND source = ? AND ext_id = ?').get(competitorId, source, j.ext_id) as unknown as CompetitorJob);
      }
    })();
    const closed: CompetitorJob[] = [];
    for (const [ext, j] of before) if (!seen.has(ext)) { this.db.prepare('UPDATE competitor_jobs SET closed_at = ? WHERE id = ?').run(now, j.id); closed.push({ ...j, closed_at: now }); }
    return { opened: opened.map((r) => this.rowToCompetitorJob(r as unknown as Row)), closed };
  }

  latestCompetitorSnapshot(competitorId: number, url: string): { id: number; fetched_at: string; hash: string; text: string; error: string | null } | null {
    const r = this.db.prepare('SELECT id, fetched_at, hash, text, error FROM competitor_snapshots WHERE competitor_id = ? AND url = ? AND error IS NULL ORDER BY fetched_at DESC LIMIT 1').get(competitorId, url) as Row | undefined;
    return r ? { id: Number(r.id), fetched_at: String(r.fetched_at), hash: String(r.hash), text: String(r.text), error: (r.error as string | null) ?? null } : null;
  }

  addCompetitorSnapshot(s: { competitor_id: number; url: string; fetched_at: string; hash: string; text: string; error?: string | null }): void {
    this.db.prepare('INSERT INTO competitor_snapshots (competitor_id, url, fetched_at, hash, text, error) VALUES (?, ?, ?, ?, ?, ?)').run(s.competitor_id, s.url, s.fetched_at, s.hash, s.text, s.error ?? null);
    // Keep the last 6 per URL.
    this.db.prepare('DELETE FROM competitor_snapshots WHERE competitor_id = ? AND url = ? AND id NOT IN (SELECT id FROM competitor_snapshots WHERE competitor_id = ? AND url = ? ORDER BY fetched_at DESC LIMIT 6)').run(s.competitor_id, s.url, s.competitor_id, s.url);
  }

  listCompetitorSnapshots(competitorId: number): { url: string; fetched_at: string; error: string | null; chars: number }[] {
    return (this.db.prepare('SELECT url, MAX(fetched_at) AS fetched_at, error, LENGTH(text) AS chars FROM competitor_snapshots WHERE competitor_id = ? GROUP BY url ORDER BY url').all(competitorId) as Row[]).map((r) => ({ url: String(r.url), fetched_at: String(r.fetched_at), error: (r.error as string | null) ?? null, chars: Number(r.chars ?? 0) }));
  }

  private rowToCompetitorClient(r: Row): CompetitorClient {
    return { id: Number(r.id), competitor_id: Number(r.competitor_id), brand: String(r.brand), brand_key: String(r.brand_key), market: (r.market as string | null) ?? null, confidence: (r.confidence as CompetitorClient['confidence']) ?? 'medium', sources: parseJson<CompetitorClient['sources']>(r.sources_json, []), prospect_id: r.prospect_id === null || r.prospect_id === undefined ? null : Number(r.prospect_id), lead_id: r.lead_id === null || r.lead_id === undefined ? null : Number(r.lead_id), status: (r.status as CompetitorClient['status']) ?? 'active', first_seen_at: String(r.first_seen_at), last_seen_at: String(r.last_seen_at) };
  }

  listCompetitorClients(competitorId?: number): CompetitorClient[] {
    const rows = competitorId === undefined ? this.db.prepare("SELECT * FROM competitor_clients WHERE status = 'active' ORDER BY brand COLLATE NOCASE").all() : this.db.prepare('SELECT * FROM competitor_clients WHERE competitor_id = ? ORDER BY status, brand COLLATE NOCASE').all(competitorId);
    return (rows as Row[]).map((r) => this.rowToCompetitorClient(r));
  }

  /** Adds or refreshes a client attribution with one more source; returns the row and whether it is new. */
  upsertCompetitorClient(c: { competitor_id: number; brand: string; brand_key: string; market?: string | null; confidence?: CompetitorClient['confidence']; source: { url: string | null; evidence: string; at: string }; now: string }): { client: CompetitorClient; created: boolean } {
    const existing = this.db.prepare('SELECT * FROM competitor_clients WHERE competitor_id = ? AND brand_key = ?').get(c.competitor_id, c.brand_key) as Row | undefined;
    if (existing) {
      const sources = parseJson<CompetitorClient['sources']>(existing.sources_json, []);
      if (!sources.some((s) => s.url === c.source.url && s.evidence === c.source.evidence)) sources.push(c.source);
      const conf = sources.length >= 2 ? 'high' : (c.confidence ?? (existing.confidence as CompetitorClient['confidence']));
      this.db.prepare("UPDATE competitor_clients SET sources_json = ?, confidence = ?, market = COALESCE(?, market), last_seen_at = ?, status = 'active' WHERE id = ?").run(JSON.stringify(sources.slice(-8)), conf, c.market ?? null, c.now, existing.id);
      return { client: this.rowToCompetitorClient(this.db.prepare('SELECT * FROM competitor_clients WHERE id = ?').get(existing.id) as Row), created: false };
    }
    const res = this.db.prepare('INSERT INTO competitor_clients (competitor_id, brand, brand_key, market, confidence, sources_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(c.competitor_id, c.brand, c.brand_key, c.market ?? null, c.confidence ?? 'medium', JSON.stringify([c.source]), c.now, c.now);
    return { client: this.rowToCompetitorClient(this.db.prepare('SELECT * FROM competitor_clients WHERE id = ?').get(Number(res.lastInsertRowid)) as Row), created: true };
  }

  patchCompetitorClient(id: number, patch: Partial<{ prospect_id: number | null; lead_id: number | null; status: 'active' | 'removed'; market: string | null; confidence: CompetitorClient['confidence'] }>): void {
    const sets: string[] = []; const params: Record<string, unknown> = { id };
    for (const k of ['prospect_id', 'lead_id', 'status', 'market', 'confidence'] as const) if (patch[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = patch[k]; }
    if (sets.length) this.db.prepare(`UPDATE competitor_clients SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  deleteCompetitorClient(id: number): boolean {
    return this.db.prepare('DELETE FROM competitor_clients WHERE id = ?').run(id).changes > 0;
  }

  private rowToCompetitorSignal(r: Row): CompetitorSignal {
    return { id: Number(r.id), competitor_id: Number(r.competitor_id), kind: String(r.kind) as CompetitorSignalKind, summary: String(r.summary), evidence: (r.evidence as string | null) ?? null, url: (r.url as string | null) ?? null, observed_at: String(r.observed_at), created_at: String(r.created_at), seen_at: (r.seen_at as string | null) ?? null };
  }

  /** Insert once per dedupe key; returns null when the signal was already on record. */
  addCompetitorSignal(s: { competitor_id: number; kind: CompetitorSignalKind; summary: string; evidence?: string | null; url?: string | null; observed_at: string; dedupe_key: string }): CompetitorSignal | null {
    const res = this.db.prepare('INSERT OR IGNORE INTO competitor_signals (competitor_id, kind, summary, evidence, url, observed_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)').run(s.competitor_id, s.kind, s.summary, s.evidence ?? null, s.url ?? null, s.observed_at, s.dedupe_key);
    if (!res.changes) return null;
    return this.rowToCompetitorSignal(this.db.prepare('SELECT * FROM competitor_signals WHERE id = ?').get(Number(res.lastInsertRowid)) as Row);
  }

  listCompetitorSignals(opts: { competitorId?: number; since?: string | null; limit?: number; unseenOnly?: boolean } = {}): CompetitorSignal[] {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.competitorId !== undefined) { where.push('competitor_id = ?'); params.push(opts.competitorId); }
    if (opts.since) { where.push('observed_at >= ?'); params.push(opts.since); }
    if (opts.unseenOnly) where.push('seen_at IS NULL');
    return (this.db.prepare(`SELECT * FROM competitor_signals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY observed_at DESC, id DESC LIMIT ?`).all(...params, opts.limit ?? 200) as Row[]).map((r) => this.rowToCompetitorSignal(r));
  }

  markCompetitorSignalsSeen(competitorId: number | null, at: string): number {
    return competitorId === null ? this.db.prepare('UPDATE competitor_signals SET seen_at = ? WHERE seen_at IS NULL').run(at).changes : this.db.prepare('UPDATE competitor_signals SET seen_at = ? WHERE seen_at IS NULL AND competitor_id = ?').run(at, competitorId).changes;
  }

  competitorCounts(): Map<number, { people_active: number; joined_30d: number; left_30d: number; open_jobs: number; clients: number; overlap: number; new_signals: number; latest_signal_at: string | null }> {
    const out = new Map<number, { people_active: number; joined_30d: number; left_30d: number; open_jobs: number; clients: number; overlap: number; new_signals: number; latest_signal_at: string | null }>();
    const get = (id: number) => { let v = out.get(id); if (!v) { v = { people_active: 0, joined_30d: 0, left_30d: 0, open_jobs: 0, clients: 0, overlap: 0, new_signals: 0, latest_signal_at: null }; out.set(id, v); } return v; };
    const d30 = new Date(Date.now() - 30 * 86400000).toISOString();
    for (const r of this.db.prepare('SELECT competitor_id, COUNT(*) AS n FROM competitor_people WHERE left_at IS NULL GROUP BY competitor_id').all() as Row[]) get(Number(r.competitor_id)).people_active = Number(r.n);
    for (const r of this.db.prepare("SELECT competitor_id, COUNT(*) AS n FROM competitor_signals WHERE kind = 'joined' AND observed_at >= ? GROUP BY competitor_id").all(d30) as Row[]) get(Number(r.competitor_id)).joined_30d = Number(r.n);
    for (const r of this.db.prepare("SELECT competitor_id, COUNT(*) AS n FROM competitor_signals WHERE kind = 'left' AND observed_at >= ? GROUP BY competitor_id").all(d30) as Row[]) get(Number(r.competitor_id)).left_30d = Number(r.n);
    for (const r of this.db.prepare('SELECT competitor_id, COUNT(*) AS n FROM competitor_jobs WHERE closed_at IS NULL GROUP BY competitor_id').all() as Row[]) get(Number(r.competitor_id)).open_jobs = Number(r.n);
    for (const r of this.db.prepare("SELECT competitor_id, COUNT(*) AS n, SUM(CASE WHEN prospect_id IS NOT NULL OR lead_id IS NOT NULL THEN 1 ELSE 0 END) AS o FROM competitor_clients WHERE status = 'active' GROUP BY competitor_id").all() as Row[]) { const v = get(Number(r.competitor_id)); v.clients = Number(r.n); v.overlap = Number(r.o ?? 0); }
    for (const r of this.db.prepare('SELECT competitor_id, SUM(CASE WHEN seen_at IS NULL THEN 1 ELSE 0 END) AS n, MAX(observed_at) AS latest FROM competitor_signals GROUP BY competitor_id').all() as Row[]) { const v = get(Number(r.competitor_id)); v.new_signals = Number(r.n ?? 0); v.latest_signal_at = (r.latest as string | null) ?? null; }
    return out;
  }

  addCompetitorDigest(d: { week: string; sent_at: string; channel: string | null; text: string }): void {
    this.db.prepare('INSERT INTO competitor_digests (week, sent_at, channel, text) VALUES (?, ?, ?, ?)').run(d.week, d.sent_at, d.channel, d.text);
  }

  lastCompetitorDigest(): { week: string; sent_at: string; channel: string | null; text: string } | null {
    const r = this.db.prepare('SELECT week, sent_at, channel, text FROM competitor_digests ORDER BY sent_at DESC LIMIT 1').get() as Row | undefined;
    return r ? { week: String(r.week), sent_at: String(r.sent_at), channel: (r.channel as string | null) ?? null, text: String(r.text) } : null;
  }
  // ---- Claude usage ----

  addLlmCall(r: { feature: string; account_id: number | null; ref: string | null; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_usd: number; ms: number; ok: boolean; error: string | null }): void {
    this.db.prepare('INSERT INTO llm_calls (feature, account_id, ref, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.feature, r.account_id, r.ref, r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.cost_usd, r.ms, r.ok ? 1 : 0, r.error);
  }

  llmBucket(from: string, to?: string, opts: { feature?: string; model?: string } = {}): { calls: number; ok: number; input: number; output: number; cache_read: number; cost_usd: number } {
    const where = ['created_at >= ?']; const params: unknown[] = [from];
    if (to) { where.push('created_at < ?'); params.push(to); }
    if (opts.feature) { where.push('feature = ?'); params.push(opts.feature); }
    if (opts.model) { where.push('model = ?'); params.push(opts.model); }
    const r = this.db.prepare(`SELECT COUNT(*) AS calls, SUM(ok) AS ok, SUM(input_tokens + cache_write_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cost_usd) AS cost FROM llm_calls WHERE ${where.join(' AND ')}`).get(...params) as Row;
    return { calls: Number(r.calls ?? 0), ok: Number(r.ok ?? 0), input: Number(r.input ?? 0), output: Number(r.output ?? 0), cache_read: Number(r.cache_read ?? 0), cost_usd: Number(r.cost ?? 0) };
  }

  llmGroups(from: string, by: 'feature' | 'model'): ({ key: string } & { calls: number; ok: number; input: number; output: number; cache_read: number; cost_usd: number })[] {
    return (this.db.prepare(`SELECT ${by} AS key, COUNT(*) AS calls, SUM(ok) AS ok, SUM(input_tokens + cache_write_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cost_usd) AS cost FROM llm_calls WHERE created_at >= ? GROUP BY ${by} ORDER BY cost DESC`).all(from) as Row[])
      .map((r) => ({ key: String(r.key), calls: Number(r.calls ?? 0), ok: Number(r.ok ?? 0), input: Number(r.input ?? 0), output: Number(r.output ?? 0), cache_read: Number(r.cache_read ?? 0), cost_usd: Number(r.cost ?? 0) }));
  }

  /** Cost per ref (the newest successful call wins), for showing what one reply or one scan cost. */
  llmCostByRef(refs: string[]): Map<string, { usd: number; input: number; output: number; model: string }> {
    const out = new Map<string, { usd: number; input: number; output: number; model: string }>();
    const uniq = [...new Set(refs.filter(Boolean))];
    for (let i = 0; i < uniq.length; i += 400) {
      const chunk = uniq.slice(i, i + 400);
      for (const r of this.db.prepare(`SELECT ref, model, input_tokens + cache_read_tokens + cache_write_tokens AS input, output_tokens AS output, cost_usd FROM llm_calls WHERE ref IN (${chunk.map(() => '?').join(',')}) ORDER BY id`).all(...chunk) as Row[]) out.set(String(r.ref), { usd: Number(r.cost_usd ?? 0), input: Number(r.input ?? 0), output: Number(r.output ?? 0), model: String(r.model) });
    }
    return out;
  }

  llmLastError(): { at: string; feature: string; message: string } | null {
    const r = this.db.prepare('SELECT created_at, feature, error FROM llm_calls WHERE ok = 0 ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    return r ? { at: String(r.created_at), feature: String(r.feature), message: String(r.error ?? '') } : null;
  }

  llmLastOkAt(): string | null {
    const r = this.db.prepare('SELECT created_at FROM llm_calls WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    return r ? String(r.created_at) : null;
  }

  pruneLlmCalls(olderThan: string): number {
    return this.db.prepare('DELETE FROM llm_calls WHERE created_at < ?').run(olderThan).changes;
  }
}


