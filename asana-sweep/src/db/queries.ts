import type Database from 'better-sqlite3';
import type {
  Account,
  AccountInput,
  AccountShop,
  Check,
  CheckItem,
  CheckStatus,
  CheckWithItems,
  Completion,
  GmvMaxPatch,
  GmvMaxRow,
  GmvSync,
  Promotion,
  PromotionInput,
  PromotionTarget,
  TtsShopRow,
  Person,
  PersonInput,
  Rule,
  RuleInput,
  Run,
  RunItem,
  RunItemAction,
  RunStatus,
} from '../sweep/types.js';

type Row = Record<string, unknown>;

function rowToRule(r: Row): Rule {
  return {
    id: r.id as number,
    name: r.name as string,
    asana_project_gid: r.asana_project_gid as string,
    asana_project_name: r.asana_project_name as string,
    enabled: Boolean(r.enabled),
    cron: r.cron as string,
    timezone: r.timezone as string,
    dry_run: Boolean(r.dry_run),
    min_age_hours: r.min_age_hours as number,
    require_section_match: Boolean(r.require_section_match),
    max_deletes_per_run: r.max_deletes_per_run as number,
    notify_slack_webhook: (r.notify_slack_webhook as string | null) || null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function rowToRun(r: Row): Run {
  let warnings: string[] = [];
  try {
    warnings = JSON.parse((r.warnings as string) || '[]');
  } catch {
    warnings = [];
  }
  return {
    id: r.id as number,
    rule_id: r.rule_id as number,
    started_at: r.started_at as string,
    finished_at: (r.finished_at as string | null) ?? null,
    status: r.status as RunStatus,
    trigger: r.trigger as Run['trigger'],
    dry_run: Boolean(r.dry_run),
    scanned_count: r.scanned_count as number,
    matched_count: r.matched_count as number,
    deleted_count: r.deleted_count as number,
    error_message: (r.error_message as string | null) ?? null,
    warnings,
  };
}

function rowToItem(r: Row): RunItem {
  return {
    id: r.id as number,
    run_id: r.run_id as number,
    task_gid: r.task_gid as string,
    task_name: r.task_name as string,
    section_name: (r.section_name as string | null) ?? null,
    completed_at: (r.completed_at as string | null) ?? null,
    num_subtasks: (r.num_subtasks as number) ?? 0,
    action: r.action as RunItemAction,
    reason: (r.reason as string) ?? '',
  };
}

function rowToAccount(r: Row): Account {
  return {
    id: r.id as number,
    name: r.name as string,
    markets: (r.markets as string | null) || null,
    am_name: (r.am_name as string | null) || null,
    aa_name: (r.aa_name as string | null) || null,
    asana_project_gid: (r.asana_project_gid as string | null) || null,
    asana_project_name: (r.asana_project_name as string) ?? '',
    enabled: Boolean(r.enabled),
    notes: (r.notes as string | null) || null,
    commission_pct: r.commission_pct === null || r.commission_pct === undefined ? null : Number(r.commission_pct),
    commission_basis: r.commission_basis === 'mor' ? 'mor' : 'gmv',
    settlement_pct: r.settlement_pct === null || r.settlement_pct === undefined ? 100 : Number(r.settlement_pct),
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
        `INSERT INTO accounts (name, markets, am_name, aa_name, asana_project_gid, asana_project_name, enabled, notes, commission_pct, commission_basis, settlement_pct)
         VALUES (@name, @markets, @am_name, @aa_name, @asana_project_gid, @asana_project_name, @enabled, @notes, @commission_pct, @commission_basis, @settlement_pct)`,
      )
      .run({ ...input, enabled: input.enabled ? 1 : 0 });
    return this.getAccount(Number(res.lastInsertRowid))!;
  }

  updateAccount(id: number, input: AccountInput): Account | null {
    const res = this.db
      .prepare(
        `UPDATE accounts SET name=@name, markets=@markets, am_name=@am_name, aa_name=@aa_name, asana_project_gid=@asana_project_gid,
            asana_project_name=@asana_project_name, enabled=@enabled, notes=@notes,
            commission_pct=@commission_pct, commission_basis=@commission_basis, settlement_pct=@settlement_pct,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=@id`,
      )
      .run({ ...input, id, enabled: input.enabled ? 1 : 0 });
    return res.changes ? this.getAccount(id) : null;
  }

  setAccountProjectName(id: number, name: string): void {
    this.db.prepare('UPDATE accounts SET asana_project_name = ? WHERE id = ? AND asana_project_name <> ?').run(name, id, name);
  }

  deleteAccount(id: number): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }

  ruleExistsForProject(gid: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM rules WHERE asana_project_gid = ? LIMIT 1').get(gid));
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

  // ---- Rules ----

  listRules(): Rule[] {
    return this.db.prepare('SELECT * FROM rules ORDER BY id').all().map((r) => rowToRule(r as Row));
  }

  getRule(id: number): Rule | null {
    const r = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToRule(r) : null;
  }

  createRule(input: RuleInput): Rule {
    const res = this.db
      .prepare(
        `INSERT INTO rules (name, asana_project_gid, asana_project_name, enabled, cron, timezone, dry_run,
                            min_age_hours, require_section_match, max_deletes_per_run, notify_slack_webhook)
         VALUES (@name, @asana_project_gid, @asana_project_name, @enabled, @cron, @timezone, @dry_run,
                 @min_age_hours, @require_section_match, @max_deletes_per_run, @notify_slack_webhook)`,
      )
      .run({
        ...input,
        enabled: input.enabled ? 1 : 0,
        dry_run: input.dry_run ? 1 : 0,
        require_section_match: input.require_section_match ? 1 : 0,
        notify_slack_webhook: input.notify_slack_webhook || null,
      });
    return this.getRule(Number(res.lastInsertRowid))!;
  }

  updateRule(id: number, input: RuleInput): Rule | null {
    const res = this.db
      .prepare(
        `UPDATE rules SET name=@name, asana_project_gid=@asana_project_gid, asana_project_name=@asana_project_name,
            enabled=@enabled, cron=@cron, timezone=@timezone, dry_run=@dry_run, min_age_hours=@min_age_hours,
            require_section_match=@require_section_match, max_deletes_per_run=@max_deletes_per_run,
            notify_slack_webhook=@notify_slack_webhook, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=@id`,
      )
      .run({
        ...input,
        id,
        enabled: input.enabled ? 1 : 0,
        dry_run: input.dry_run ? 1 : 0,
        require_section_match: input.require_section_match ? 1 : 0,
        notify_slack_webhook: input.notify_slack_webhook || null,
      });
    return res.changes ? this.getRule(id) : null;
  }

  setRuleProjectName(id: number, name: string): void {
    this.db.prepare('UPDATE rules SET asana_project_name = ? WHERE id = ? AND asana_project_name <> ?').run(name, id, name);
  }

  deleteRule(id: number): boolean {
    return this.db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0;
  }

  // ---- Runs ----

  createRun(ruleId: number, trigger: Run['trigger'], dryRun: boolean): Run {
    const res = this.db
      .prepare(`INSERT INTO runs (rule_id, started_at, status, trigger, dry_run) VALUES (?, ?, 'running', ?, ?)`)
      .run(ruleId, new Date().toISOString(), trigger, dryRun ? 1 : 0);
    return this.getRun(Number(res.lastInsertRowid))!;
  }

  finishRun(
    id: number,
    patch: { status: RunStatus; scanned_count: number; matched_count: number; deleted_count: number; error_message: string | null; warnings: string[] },
  ): Run {
    this.db
      .prepare(
        `UPDATE runs SET finished_at=?, status=?, scanned_count=?, matched_count=?, deleted_count=?, error_message=?, warnings=? WHERE id=?`,
      )
      .run(
        new Date().toISOString(),
        patch.status,
        patch.scanned_count,
        patch.matched_count,
        patch.deleted_count,
        patch.error_message,
        JSON.stringify(patch.warnings),
        id,
      );
    return this.getRun(id)!;
  }

  getRun(id: number): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToRun(r) : null;
  }

  listRuns(ruleId: number, limit = 100): Run[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE rule_id = ? ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(ruleId, limit)
      .map((r) => rowToRun(r as Row));
  }

  lastRun(ruleId: number): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE rule_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(ruleId) as Row | undefined;
    return r ? rowToRun(r) : null;
  }

  /** Mark any runs left in 'running' (e.g. after a crash) as errored. Called at startup. */
  failStaleRuns(): number {
    return this.db
      .prepare(`UPDATE runs SET status='error', finished_at=?, error_message='Process restarted while the run was in progress.' WHERE status='running'`)
      .run(new Date().toISOString()).changes;
  }

  addRunItems(runId: number, items: Omit<RunItem, 'id' | 'run_id'>[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO run_items (run_id, task_gid, task_name, section_name, completed_at, num_subtasks, action, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const it of items) {
        stmt.run(runId, it.task_gid, it.task_name, it.section_name, it.completed_at, it.num_subtasks, it.action, it.reason);
      }
    })();
  }

  listRunItems(runId: number): RunItem[] {
    return this.db.prepare('SELECT * FROM run_items WHERE run_id = ? ORDER BY action, task_name').all(runId).map((r) => rowToItem(r as Row));
  }

  deleteRun(id: number): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
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

  // ---- Completions the sweep deleted (so the checklist check still counts them) ----

  recordCompletions(rows: Completion[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO completions (task_gid, project_gid, parent_gid, name, section_name, assignee_name, completed, completed_at, num_subtasks, deleted_at, run_id)
       VALUES (@task_gid, @project_gid, @parent_gid, @name, @section_name, @assignee_name, @completed, @completed_at, @num_subtasks, @deleted_at, @run_id)
       ON CONFLICT(task_gid) DO UPDATE SET completed = excluded.completed, completed_at = excluded.completed_at, deleted_at = excluded.deleted_at, run_id = excluded.run_id`,
    );
    this.db.transaction(() => {
      for (const r of rows) stmt.run({ ...r, completed: r.completed ? 1 : 0 });
    })();
  }

  /** Deleted tasks of a project whose completion (or deletion) happened on or after `sinceIso`. */
  listCompletionsSince(projectGid: string, sinceIso: string): Completion[] {
    return (
      this.db
        .prepare('SELECT * FROM completions WHERE project_gid = ? AND (completed_at >= ? OR deleted_at >= ?)')
        .all(projectGid, sinceIso, sinceIso) as (Omit<Completion, 'completed'> & { completed: number })[]
    ).map((r) => ({ ...r, completed: Boolean(r.completed) }));
  }

  pruneCompletions(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    return this.db.prepare('DELETE FROM completions WHERE deleted_at < ?').run(cutoff).changes;
  }

  pruneRuns(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    return this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(cutoff).changes;
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
}
