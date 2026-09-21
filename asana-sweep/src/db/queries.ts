import type Database from 'better-sqlite3';
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
  WatchlistEntry,
  BdAlert,
  BdActivity,
  BdActivityRow,
  MonitorFlag,
  CruvaOutreach,
  StockSku,
  Incident,
  ClientReport,
  ReportData,
  PlaybookItem,
  PlaybookKind,
  PlaybookSetupCell,
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
} from '../sweep/types.js';
import { isSignedStage, leadKey, matchPerson, type SheetLead } from '../leads/sheet.js';
import { fastmossShopUrl, launchFlags, matchesAccountName, outreachComplete, riseScore } from '../bd/score.js';

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
      access_token: r.access_token as string,
      refresh_token: r.refresh_token as string,
    };
  }

  listTtsShops(): TtsShopRow[] {
    return this.db.prepare('SELECT * FROM tts_shops ORDER BY name').all().map((r) => {
      const { access_token: _a, refresh_token: _b, ...rest } = this.rowToTtsShop(r as Row);
      return rest;
    });
  }

  getTtsShop(id: string): (TtsShopRow & { access_token: string; refresh_token: string }) | null {
    const r = this.db.prepare('SELECT * FROM tts_shops WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToTtsShop(r) : null;
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

  updateTarget(id: number, patch: Partial<Pick<PromotionTarget, 'status' | 'tts_shop_id' | 'tts_activity_id' | 'tts_status' | 'error_message' | 'pushed_at'>>): void {
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

  listShops(): AccountShop[] {
    return this.db.prepare('SELECT * FROM account_shops ORDER BY shop_name COLLATE NOCASE').all().map((r) => this.rowToShop(r as Row));
  }

  private rowToShop(r: Row): AccountShop {
    return {
      id: r.id as number,
      account_id: r.account_id as number,
      shop_id: r.shop_id as string,
      shop_name: r.shop_name as string,
      currency: (r.currency as string) || 'EUR',
    };
  }

  addShop(accountId: number, shopId: string, shopName: string, currency = 'EUR'): AccountShop {
    this.db
      .prepare(
        `INSERT INTO account_shops (account_id, shop_id, shop_name, currency) VALUES (?, ?, ?, ?)
         ON CONFLICT(shop_id) DO UPDATE SET account_id = excluded.account_id, shop_name = excluded.shop_name, currency = excluded.currency`,
      )
      .run(accountId, shopId, shopName, currency);
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

  private rowToProspect(r: Row, contacts: BdContact[], outreachLog: BdOutreachEvent[] = []): BdProspect {
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
    };
  }

  private static PROSPECT_SELECT = `SELECT p.*, o.name AS owner_name, (p.notes LIKE 'Existing client%') AS is_client FROM bd_prospects p LEFT JOIN people o ON o.id = p.owner_id`;

  listProspects(includeArchived = false): BdProspect[] {
    const contacts = new Map<number, BdContact[]>();
    for (const r of this.db.prepare('SELECT * FROM bd_contacts ORDER BY enriched DESC, id').all() as Row[]) {
      const c = this.rowToContact(r);
      contacts.set(c.prospect_id, [...(contacts.get(c.prospect_id) ?? []), c]);
    }
    const logs = new Map<number, BdOutreachEvent[]>();
    for (const r of this.db.prepare('SELECT * FROM bd_outreach_log ORDER BY created_at DESC, id DESC').all() as Row[]) {
      const e = this.rowToOutreach(r);
      logs.set(e.prospect_id, [...(logs.get(e.prospect_id) ?? []), e]);
    }
    const where = includeArchived ? '' : 'WHERE p.archived = 0';
    return (this.db.prepare(`${Queries.PROSPECT_SELECT} ${where} ORDER BY p.market, p.gmv_7d DESC, p.shop_name COLLATE NOCASE`).all() as Row[]).map((r) => this.rowToProspect(r, contacts.get(r.id as number) ?? [], logs.get(r.id as number) ?? []));
  }

  getProspect(id: number): BdProspect | null {
    const r = this.db.prepare(`${Queries.PROSPECT_SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
    if (!r) return null;
    const contacts = (this.db.prepare('SELECT * FROM bd_contacts WHERE prospect_id = ? ORDER BY enriched DESC, id').all(id) as Row[]).map((c) => this.rowToContact(c));
    const log = (this.db.prepare('SELECT * FROM bd_outreach_log WHERE prospect_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(id) as Row[]).map((e) => this.rowToOutreach(e));
    return this.rowToProspect(r, contacts, log);
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
    const simple: (keyof BdProspectPatch)[] = ['status', 'owner_id', 'notes', 'domain', 'website', 'launched_at', 'gmv_started_at', 'apollo_org_id', 'company_industry', 'company_employees', 'company_linkedin', 'company_location', 'company_description', 'enriched_at', 'enrich_note'];
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
      to_name: r.to_name as string, to_email: r.to_email as string, subject: r.subject as string, body: r.body as string,
      language: r.language as string, style: r.style as BdEmailDraft['style'], status: r.status as BdEmailDraft['status'], generator: r.generator as BdEmailDraft['generator'],
      kind: ((r.kind as string | null) ?? 'cold') as BdEmailDraft['kind'], meeting_id: (r.meeting_id as string | null) ?? null, meeting_title: (r.meeting_title as string | null) ?? null,
      gmail_draft_id: (r.gmail_draft_id as string | null) ?? null, gmail_message_id: (r.gmail_message_id as string | null) ?? null, gmail_url: (r.gmail_url as string | null) ?? null,
      created_by: (r.created_by as string | null) ?? null, created_at: r.created_at as string, updated_at: r.updated_at as string,
    };
  }

  private static DRAFT_SELECT = `SELECT d.*, p.shop_name, p.market FROM bd_email_drafts d JOIN bd_prospects p ON p.id = d.prospect_id`;

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

  updateDraft(id: number, patch: Partial<Pick<BdEmailDraft, 'subject' | 'body' | 'language' | 'style' | 'status' | 'generator' | 'gmail_draft_id' | 'gmail_message_id' | 'gmail_url' | 'to_email' | 'to_name'>>): BdEmailDraft | null {
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
  applyScan(found: { account_id: number | null; shop_id: string | null; code: string; severity: MonitorFlag['severity']; message: string; detail?: string | null }[], scope: { account_ids?: number[] } = {}): { opened: number; resolved: number } {
    const now = new Date().toISOString();
    const open = this.listFlags(false).filter((f) => !scope.account_ids || (f.account_id !== null && scope.account_ids.includes(f.account_id)));
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
      market: (r.market as string | null) ?? null,
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

  private static CONV_SELECT = `SELECT c.*, s.name AS shop_name, s.account_id, s.market, a.name AS account_name, a.auto_reply_cs, a.auto_reply_affiliate
    FROM inbox_conversations c JOIN tts_shops s ON s.id = c.tts_shop_id LEFT JOIN accounts a ON a.id = s.account_id`;

  listConversations(opts: { channel?: InboxConversation['channel']; accountId?: number; limit?: number } = {}): InboxConversation[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.channel) {
      where.push('c.channel = ?');
      params.push(opts.channel);
    }
    if (opts.accountId) {
      where.push('s.account_id = ?');
      params.push(opts.accountId);
    }
    const sql = `${Queries.CONV_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT ?`;
    params.push(opts.limit ?? 500);
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.rowToConversation(r));
  }

  getConversation(id: number): InboxConversation | null {
    const r = this.db.prepare(`${Queries.CONV_SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
    return r ? this.rowToConversation(r) : null;
  }

  /** Insert or refresh a conversation from a TikTok listing. Returns its row id and whether the newest message changed. */
  upsertConversation(c: { tts_shop_id: string; channel: InboxConversation['channel']; conversation_id: string; counterpart_name?: string | null; counterpart_id?: string | null; unread_count?: number; can_send?: boolean; last_message_at?: string | null; last_message_text?: string | null; last_sender?: InboxConversation['last_sender']; last_message_id?: string | null }, now = new Date().toISOString()): { id: number; changed: boolean } {
    const prev = this.db.prepare('SELECT id, last_message_id, status FROM inbox_conversations WHERE tts_shop_id = ? AND channel = ? AND conversation_id = ?').get(c.tts_shop_id, c.channel, c.conversation_id) as { id: number; last_message_id: string | null; status: string } | undefined;
    const changed = !prev || (c.last_message_id !== undefined && c.last_message_id !== prev.last_message_id);
    if (!prev) {
      const info = this.db
        .prepare(`INSERT INTO inbox_conversations (tts_shop_id, channel, conversation_id, counterpart_name, counterpart_id, unread_count, can_send, last_message_at, last_message_text, last_sender, last_message_id, status, synced_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
        .run(c.tts_shop_id, c.channel, c.conversation_id, c.counterpart_name ?? null, c.counterpart_id ?? null, c.unread_count ?? 0, c.can_send === false ? 0 : 1, c.last_message_at ?? null, c.last_message_text ?? null, c.last_sender ?? null, c.last_message_id ?? null, now, now);
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

  replaceStockSnapshot(shopId: string, accountId: number | null, rows: Omit<StockSku, 'shop_id' | 'account_id' | 'captured_at' | 'velocity_override' | 'exclude' | 'note'>[], capturedAt = new Date().toISOString()): number {
    const del = this.db.prepare('DELETE FROM stock_snapshots WHERE shop_id = ?');
    const ins = this.db.prepare(`INSERT INTO stock_snapshots (shop_id, account_id, product_id, product_title, sku_id, sku_name, seller_sku, product_status, on_hand, sold_7d, sold_30d, captured_at)
      VALUES (@shop_id, @account_id, @product_id, @product_title, @sku_id, @sku_name, @seller_sku, @product_status, @on_hand, @sold_7d, @sold_30d, @captured_at)
      ON CONFLICT(shop_id, sku_id) DO UPDATE SET product_title = excluded.product_title, sku_name = excluded.sku_name, seller_sku = excluded.seller_sku, product_status = excluded.product_status, on_hand = excluded.on_hand, sold_7d = excluded.sold_7d, sold_30d = excluded.sold_30d, captured_at = excluded.captured_at, account_id = excluded.account_id`);
    let n = 0;
    this.db.transaction(() => {
      del.run(shopId);
      for (const r of rows) n += ins.run({ ...r, shop_id: shopId, account_id: accountId, captured_at: capturedAt }).changes;
    })();
    return n;
  }

  listStock(shopId?: string): StockSku[] {
    const rows = (shopId
      ? this.db.prepare('SELECT s.*, o.velocity AS velocity_override, o.exclude AS exclude, o.note AS note FROM stock_snapshots s LEFT JOIN stock_overrides o ON o.shop_id = s.shop_id AND o.sku_id = s.sku_id WHERE s.shop_id = ? ORDER BY s.product_title COLLATE NOCASE, s.sku_name COLLATE NOCASE').all(shopId)
      : this.db.prepare('SELECT s.*, o.velocity AS velocity_override, o.exclude AS exclude, o.note AS note FROM stock_snapshots s LEFT JOIN stock_overrides o ON o.shop_id = s.shop_id AND o.sku_id = s.sku_id ORDER BY s.shop_id, s.product_title COLLATE NOCASE').all()) as Row[];
    return rows.map((r) => ({
      shop_id: r.shop_id as string, account_id: (r.account_id as number | null) ?? null, product_id: r.product_id as string, product_title: r.product_title as string, sku_id: r.sku_id as string, sku_name: (r.sku_name as string | null) ?? null, seller_sku: (r.seller_sku as string | null) ?? null, product_status: (r.product_status as string | null) ?? null,
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

  createReport(i: { account_id: number; period: 'weekly' | 'monthly'; period_start: string; period_end: string; title: string; body: string; data: ReportData; generator: 'claude' | 'template'; slack_channel: string | null; created_by: string | null }): ClientReport {
    const res = this.db.prepare(`INSERT INTO client_reports (account_id, period, period_start, period_end, title, body, data_json, generator, slack_channel, created_by) VALUES (@account_id, @period, @period_start, @period_end, @title, @body, @data_json, @generator, @slack_channel, @created_by)`)
      .run({ ...i, data_json: JSON.stringify(i.data) });
    return this.getReport(Number(res.lastInsertRowid))!;
  }

  updateReport(id: number, patch: Partial<{ title: string; body: string; data: ReportData; generator: 'claude' | 'template'; status: 'draft' | 'sent'; slack_channel: string | null; sent_at: string | null }>): ClientReport | null {
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
    return (this.db.prepare('SELECT * FROM cruva_setup').all() as Row[]).map((r) => ({ shop_id: r.shop_id as string, kind: r.kind as PlaybookKind, playbook_key: r.playbook_key as string, status: r.status as PlaybookSetupCell['status'], remote_id: (r.remote_id as string | null) ?? null, remote_name: (r.remote_name as string | null) ?? null, checked_at: (r.checked_at as string | null) ?? null, applied_at: (r.applied_at as string | null) ?? null, note: (r.note as string | null) ?? null }));
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

  listRemoteItems(shopId?: string): { shop_id: string; kind: PlaybookKind; remote_id: string; name: string; enabled: boolean; seen_at: string }[] {
    return ((shopId ? this.db.prepare('SELECT shop_id, kind, remote_id, name, enabled, seen_at FROM cruva_remote_items WHERE shop_id = ?').all(shopId) : this.db.prepare('SELECT shop_id, kind, remote_id, name, enabled, seen_at FROM cruva_remote_items').all()) as Row[]).map((r) => ({ shop_id: r.shop_id as string, kind: r.kind as PlaybookKind, remote_id: r.remote_id as string, name: r.name as string, enabled: Boolean(r.enabled), seen_at: r.seen_at as string }));
  }

  // ---- Client question copilot ----

  private rowToQuestion(r: Row): CopilotQuestion {
    return {
      id: r.id as number, account_id: (r.account_id as number | null) ?? null, account_name: (r.account_name as string | null) ?? null, source: r.source as CopilotQuestion['source'], channel: (r.channel as string | null) ?? null, thread_ts: (r.thread_ts as string | null) ?? null, external_id: (r.external_id as string | null) ?? null,
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
  createQuestion(i: { account_id: number | null; source: CopilotQuestion['source']; channel?: string | null; thread_ts?: string | null; external_id?: string | null; asked_by?: string | null; question: string; created_by?: string | null }): CopilotQuestion | null {
    if (i.external_id && this.db.prepare('SELECT 1 FROM copilot_questions WHERE source = ? AND external_id = ?').get(i.source, i.external_id)) return null;
    const res = this.db.prepare('INSERT INTO copilot_questions (account_id, source, channel, thread_ts, external_id, asked_by, question, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(i.account_id, i.source, i.channel ?? null, i.thread_ts ?? null, i.external_id ?? null, i.asked_by ?? null, i.question, i.created_by ?? null);
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

  listEvidence(opts: { accountId?: number | null; kinds?: string[] } = {}): { id: number; account_id: number | null; kind: string; ref: string; title: string; text: string; url: string | null; occurred_at: string | null; indexed_at: string }[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.accountId !== undefined && opts.accountId !== null) { where.push('(account_id = ? OR account_id IS NULL)'); params.push(opts.accountId); }
    if (opts.kinds?.length) { where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`); params.push(...opts.kinds); }
    return (this.db.prepare(`SELECT * FROM copilot_evidence ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC`).all(...params) as Row[]).map((r) => ({ id: r.id as number, account_id: (r.account_id as number | null) ?? null, kind: r.kind as string, ref: r.ref as string, title: r.title as string, text: r.text as string, url: (r.url as string | null) ?? null, occurred_at: (r.occurred_at as string | null) ?? null, indexed_at: r.indexed_at as string }));
  }

  hasEvidence(kind: string, ref: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM copilot_evidence WHERE kind = ? AND ref = ?').get(kind, ref));
  }

  evidenceCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT kind, COUNT(*) AS n FROM copilot_evidence GROUP BY kind').all() as { kind: string; n: number }[]) out[r.kind] = r.n;
    return out;
  }
}
