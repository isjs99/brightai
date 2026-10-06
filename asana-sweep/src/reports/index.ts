import { Queries } from '../db/queries.js';
import { daysInMonth, monthRange, pct, previousMonth, workdaysInMonth } from '../checklist/calendar.js';
import { todayIn } from '../checklist/checker.js';
import { attainmentOf, bonusTarget, growthPct, projectMonth, requiredGrowthPct, type BonusRule } from '../gmv/grading.js';
import { cruva } from '../gmv/cruva.js';
import { windsor } from '../gmv/windsor.js';
import { DEFAULT_REPORT_CURRENCY, parseFx, toReportCurrency } from '../gmv/currency.js';
import type { AlertCalendar, AlertDay, AlertDayAccount, AlertLight, CheckStatus,
  Account,
  BonusStatus,
  CalendarAccountRow,
  CalendarAmRow,
  CalendarCell,
  CalendarData,
  Check,
  GmvAccountRow,
  GmvAmRow,
  GmvData,
  GmvExplore,
  GmvExploreRow,
  GmvSettings,
  GmvShopRow,
} from '../sweep/types.js';

const COUNTABLE = new Set(['complete', 'partial', 'none']);

function accountsByAm(accounts: Account[]): Map<string, Account[]> {
  const out = new Map<string, Account[]>();
  for (const a of accounts) {
    const key = a.am_name ?? 'Unassigned';
    out.set(key, [...(out.get(key) ?? []), a]);
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b))));
}

// ---- Calendar ----

export function buildCalendar(q: Queries, month: string): CalendarData {
  const tz = q.getSetting('check_timezone', 'Europe/Madrid');
  const today = todayIn(tz);
  const workdays = workdaysInMonth(month);
  const { from, to } = monthRange(month);
  const checks = q.listChecksBetween(from, to);
  const byAccountDate = new Map<string, Check>();
  for (const c of checks) byAccountDate.set(`${c.account_id}:${c.check_date}`, c);
  const accounts = q.listAccounts().filter((a) => a.enabled);

  const accountRow = (account: Account): CalendarAccountRow => {
    const cells: CalendarCell[] = workdays.map((date) => {
      const c = byAccountDate.get(`${account.id}:${date}`);
      return {
        date,
        status: c?.status ?? null,
        combined_complete: c?.combined_complete ?? false,
        am_complete: c?.am_complete ?? false,
        aa_complete: c?.aa_complete ?? false,
        am_done: c?.am_done ?? 0,
        am_total: c?.am_total ?? 0,
        aa_done: c?.aa_done ?? 0,
        aa_total: c?.aa_total ?? 0,
      };
    });
    const scored = cells.filter((c) => c.status && COUNTABLE.has(c.status));
    const complete = scored.filter((c) => c.combined_complete).length;
    return { account, cells, checked_days: scored.length, complete_days: complete, missed: scored.length - complete, compliance: pct(complete, scored.length) };
  };

  const ams: CalendarAmRow[] = [...accountsByAm(accounts).entries()].map(([am_name, list]) => {
    const rows = list.map(accountRow);
    const checked = rows.reduce((n, r) => n + r.checked_days, 0);
    const complete = rows.reduce((n, r) => n + r.complete_days, 0);
    return { am_name, accounts: rows, checked_days: checked, complete_days: complete, missed: checked - complete, compliance: pct(complete, checked) };
  });
  const checked = ams.reduce((n, r) => n + r.checked_days, 0);
  const complete = ams.reduce((n, r) => n + r.complete_days, 0);
  return { month, workdays, today, target: 100, ams, totals: { checked_days: checked, complete_days: complete, missed: checked - complete, compliance: pct(complete, checked) } };
}

// ---- Alerts calendar ----

/**
 * One cell per calendar day: the traffic light (red = a critical incident or flag was open, amber = a warning,
 * green = nothing open and the checklist complete, grey = nothing recorded), with the incidents, flags and
 * checklist state per account behind it.
 */
export function buildAlertCalendar(q: Queries, month: string): AlertCalendar {
  const tz = q.getSetting('check_timezone', 'Europe/Madrid');
  const today = todayIn(tz);
  const { from, to } = monthRange(month);
  const accounts = q.listAccounts().filter((a) => a.enabled);
  const incidents = q.listIncidentsBetween(from, to);
  const flags = q.listFlagsBetween(from, to);
  const checks = q.listChecksBetween(from, to);
  const checkOf = new Map<string, Check>();
  for (const c of checks) checkOf.set(`${c.account_id}:${c.check_date}`, c);
  const days: AlertDay[] = [];
  const d0 = Date.parse(from + 'T12:00:00Z'); const d1 = Date.parse(to + 'T12:00:00Z');
  const openOn = (date: string, created: string, resolved: string | null) => created.slice(0, 10) <= date && (!resolved || resolved.slice(0, 10) >= date);
  for (let t = d0; t <= d1; t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const perAccount: AlertDayAccount[] = accounts.map((a) => {
      const inc = incidents.filter((i) => i.account_id === a.id && openOn(date, i.created_at, i.resolved_at)).map((i) => ({ id: i.id, kind: i.kind, title: i.title, severity: i.severity, message: i.message, slack_channel: i.slack_channel, posted_at: i.posted_at, resolved_at: i.resolved_at, opened_today: i.created_at.slice(0, 10) === date }));
      const fl = flags.filter((f) => f.account_id === a.id && openOn(date, f.first_seen_at, f.resolved_at)).map((f) => ({ code: f.code, severity: f.severity, message: f.message, opened_today: f.first_seen_at.slice(0, 10) === date, resolved_at: f.resolved_at }));
      const c = checkOf.get(`${a.id}:${date}`);
      const checklist = c ? { status: c.status, combined_complete: c.combined_complete, am_done: c.am_done, am_total: c.am_total, aa_done: c.aa_done, aa_total: c.aa_total } : null;
      const crit = inc.some((i) => i.severity === 'crit') || fl.some((f) => f.severity === 'crit');
      const warn = inc.some((i) => i.severity === 'warn') || fl.some((f) => f.severity === 'warn');
      const light: AlertLight = date > today ? 'none' : crit ? 'crit' : warn ? 'warn' : inc.length || fl.length || checklist ? 'good' : 'none';
      return { account_id: a.id, account_name: a.name, am_name: a.am_name, light, incidents: inc, flags: fl, checklist };
    });
    const count = (sev: 'crit' | 'warn' | 'info') => perAccount.reduce((n, a) => n + a.incidents.filter((i) => i.severity === sev && i.opened_today).length + a.flags.filter((f) => f.severity === sev && f.opened_today).length, 0);
    const resolved = perAccount.reduce((n, a) => n + a.incidents.filter((i) => i.resolved_at?.slice(0, 10) === date).length + a.flags.filter((f) => f.resolved_at?.slice(0, 10) === date).length, 0);
    const checked = perAccount.filter((a) => a.checklist && COUNTABLE.has(a.checklist.status as CheckStatus)).length;
    const complete = perAccount.filter((a) => a.checklist?.combined_complete).length;
    const light: AlertLight = date > today ? 'none' : perAccount.some((a) => a.light === 'crit') ? 'crit' : perAccount.some((a) => a.light === 'warn') ? 'warn' : perAccount.some((a) => a.light === 'good') ? 'good' : 'none';
    days.push({ date, light, crit: count('crit'), warn: count('warn'), info: count('info'), resolved, checklist_complete: complete, checklist_checked: checked, accounts: perAccount.filter((a) => a.light !== 'none' || a.checklist) });
  }
  const past = days.filter((d) => d.date <= today);
  return {
    month, today, days,
    totals: { crit: days.reduce((n, d) => n + d.crit, 0), warn: days.reduce((n, d) => n + d.warn, 0), info: days.reduce((n, d) => n + d.info, 0), resolved: days.reduce((n, d) => n + d.resolved, 0), days_red: past.filter((d) => d.light === 'crit').length, days_amber: past.filter((d) => d.light === 'warn').length, days_green: past.filter((d) => d.light === 'good').length },
    channels: accounts.map((a) => ({ id: a.id, name: a.name, slack_channel: a.slack_channel })),
    default_channel: q.getSetting('incidents_default_channel', ''),
  };
}

// ---- GMV ----

export function gmvSettings(q: Queries): GmvSettings {
  return {
    report_currency: q.getSetting('report_currency', DEFAULT_REPORT_CURRENCY),
    fx_to_eur: parseFx(q.getSetting('fx_to_eur', '{}')),
    bonus_threshold: Number(q.getSetting('bonus_threshold', '30000')) || 30000,
    bonus_growth_below: Number(q.getSetting('bonus_growth_below', '100')),
    bonus_growth_above: Number(q.getSetting('bonus_growth_above', '40')),
    am_share_pct: Number(q.getSetting('am_share_pct', '10')),
  };
}

/**
 * GMV for a month, per shop in the market currency and per account / AM in the report currency.
 * While the month is running, "to date" excludes today (today's figures are still moving).
 * Each account's target is the bonus rule applied to last month's GMV unless a manual target is set.
 */
/**
 * An account can be linked to both a Windsor shop (TikTok orders) and a Cruva shop for the same market. Windsor is
 * the primary source when it has rows; Cruva fills in only for the accounts (or markets) Windsor does not cover.
 */
export function shopsForGmv<T extends { shop_id: string; shop_name: string; source: 'cruva' | 'windsor' }>(mine: T[], hasRows: (shopId: string) => boolean): T[] {
  const windsor = mine.filter((s) => s.source === 'windsor' && hasRows(s.shop_id));
  if (!windsor.length) return mine;
  const covered = new Set(windsor.map((s) => marketOfShopName(s.shop_name) ?? '*'));
  return mine.filter((s) => s.source === 'windsor' || (!covered.has('*') && !covered.has(marketOfShopName(s.shop_name) ?? '*')));
}

import { marketOfShopName } from '../gmv/market.js';
export { marketOfShopName };

export function buildGmv(q: Queries, month: string): GmvData {
  const tz = q.getSetting('check_timezone', 'Europe/Madrid');
  const today = todayIn(tz);
  const settings = gmvSettings(q);
  const rule: BonusRule = { threshold: settings.bonus_threshold, growthBelowPct: settings.bonus_growth_below, growthAbovePct: settings.bonus_growth_above };
  const fx = settings.fx_to_eur;
  const currency = settings.report_currency;

  const { from, to: monthEnd } = monthRange(month);
  const dim = daysInMonth(month);
  const running = month === today.slice(0, 7);
  const closed = today > monthEnd;
  // Yesterday is the last complete day while the month runs.
  const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  const to = running ? (yesterday >= from ? yesterday : from) : monthEnd;
  const elapsed = running ? (yesterday >= from ? Number(yesterday.slice(8, 10)) : 0) : closed ? dim : 0;

  const prevMonth = previousMonth(month);
  const prevRange = monthRange(prevMonth);
  const rows = running || closed ? q.listGmvBetween(from, to) : [];
  const prevRows = q.listGmvBetween(prevRange.from, prevRange.to);
  const manualTargets = q.getTargets(month);
  const settlements = q.getSettlements(month);
  const shops = q.listShops();
  const byShop = new Map<string, typeof rows>();
  for (const r of rows) byShop.set(r.shop_id, [...(byShop.get(r.shop_id) ?? []), r]);
  const prevByShop = new Map<string, number>();
  for (const r of prevRows) prevByShop.set(r.shop_id, (prevByShop.get(r.shop_id) ?? 0) + r.total_gmv);
  // Same number of elapsed days last month, for the like-for-like pace (month to date vs the same days last month).
  const prevSameByShop = new Map<string, number>();
  for (const r of prevRows) if (Number(r.date.slice(8, 10)) <= elapsed) prevSameByShop.set(r.shop_id, (prevSameByShop.get(r.shop_id) ?? 0) + r.total_gmv);

  const bonusStatus = (gmv: number, projected: number | null, target: number | null, hasData: boolean): BonusStatus => {
    if (target === null) return hasData ? 'no_base' : 'no_data';
    if (closed) return gmv >= target ? 'eligible' : 'behind';
    if (!hasData || projected === null) return 'no_data';
    return projected >= target ? 'on_track' : 'behind';
  };

  const accounts = q.listAccounts();
  const accountRows: GmvAccountRow[] = accounts
    .map((account) => {
      const mine = shopsForGmv(shops.filter((s) => s.account_id === account.id), (id) => byShop.has(id) || prevByShop.has(id));
      const shopRows: GmvShopRow[] = mine.map((shop) => {
        const list = byShop.get(shop.shop_id) ?? [];
        const gmv = round2(sum(list.map((r) => r.total_gmv)));
        return {
          shop,
          gmv,
          affiliate_gmv: round2(sum(list.map((r) => r.affiliate_gmv))),
          units: sum(list.map((r) => r.units)),
          gmv_report: round2(toReportCurrency(gmv, shop.currency, fx)),
          prev_gmv: round2(toReportCurrency(prevByShop.get(shop.shop_id) ?? 0, shop.currency, fx)),
          last_synced: list.length ? list.map((r) => r.synced_at).sort().at(-1)! : null,
        };
      });
      const dailyMap = new Map<string, number>();
      for (const shop of mine) for (const r of byShop.get(shop.shop_id) ?? []) dailyMap.set(r.date, (dailyMap.get(r.date) ?? 0) + toReportCurrency(r.total_gmv, shop.currency, fx));
      const gmv = round2(sum(shopRows.map((s) => s.gmv_report)));
      const hasPrev = mine.some((s) => prevByShop.has(s.shop_id));
      const prev_gmv = hasPrev ? round2(sum(shopRows.map((s) => s.prev_gmv))) : null;
      const prev_same_days = hasPrev && elapsed > 0 ? round2(sum(mine.map((s) => toReportCurrency(prevSameByShop.get(s.shop_id) ?? 0, s.currency, fx)))) : null;
      const manual = manualTargets.get(account.id) ?? null;
      const ruleTarget = bonusTarget(prev_gmv, rule);
      const target = manual ?? ruleTarget;
      const projected = projectMonth(gmv, elapsed, dim);
      const hasData = shopRows.some((s) => s.last_synced !== null);

      // Commission: on actual GMV, or on the net settlement amount (actual if entered, else an estimate).
      const net_settlement = settlements.get(account.id) ?? null;
      let base_amount: number | null = null;
      let base_source: GmvAccountRow['base_source'] = null;
      if (account.commission_basis === 'mor') {
        if (net_settlement !== null) {
          base_amount = net_settlement;
          base_source = 'settlement_actual';
        } else if (hasData) {
          base_amount = round2((gmv * account.settlement_pct) / 100);
          base_source = 'settlement_estimate';
        }
      } else if (hasData) {
        base_amount = gmv;
        base_source = 'gmv';
      }
      const agency_billing = account.commission_pct !== null && base_amount !== null ? round2((base_amount * account.commission_pct) / 100) : null;
      const am_share = agency_billing !== null ? round2((agency_billing * settings.am_share_pct) / 100) : null;
      return {
        account,
        shops: shopRows,
        gmv,
        commission_basis: account.commission_basis,
        commission_pct: account.commission_pct,
        settlement_pct: account.settlement_pct,
        net_settlement,
        base_amount,
        base_source,
        agency_billing,
        am_share,
        affiliate_gmv: round2(sum(shopRows.map((s) => toReportCurrency(s.affiliate_gmv, s.shop.currency, fx)))),
        units: sum(shopRows.map((s) => s.units)),
        prev_gmv,
        required_growth_pct: manual !== null ? growthPct(manual, prev_gmv) : requiredGrowthPct(prev_gmv, rule),
        target,
        target_source: (manual !== null ? 'manual' : ruleTarget !== null ? 'rule' : null) as GmvAccountRow['target_source'],
        attainment: attainmentOf(gmv, target),
        projected,
        projected_attainment: projected === null ? null : attainmentOf(projected, target),
        growth_pct: growthPct(closed ? gmv : (projected ?? gmv), prev_gmv),
        prev_same_days,
        pace_pct: prev_same_days !== null && prev_same_days > 0 ? round2(((gmv - prev_same_days) / prev_same_days) * 100) : null,
        bonus: bonusStatus(gmv, projected, target, hasData),
        daily: [...dailyMap.entries()].sort().map(([date, g]) => ({ date, gmv: round2(g) })),
      };
    })
    .filter((r) => r.shops.length > 0 || r.target !== null);

  const aggregate = (list: GmvAccountRow[]) => {
    const gmv = round2(sum(list.map((r) => r.gmv)));
    const withPrev = list.filter((r) => r.prev_gmv !== null);
    const prev_gmv = withPrev.length ? round2(sum(withPrev.map((r) => r.prev_gmv!))) : null;
    const targeted = list.filter((r) => r.target !== null);
    const target = targeted.length ? sum(targeted.map((r) => r.target!)) : null;
    const projected = projectMonth(gmv, elapsed, dim);
    return {
      gmv,
      prev_gmv,
      target,
      attainment: attainmentOf(gmv, target),
      projected,
      projected_attainment: projected === null ? null : attainmentOf(projected, target),
      growth_pct: growthPct(closed ? gmv : (projected ?? gmv), prev_gmv),
      eligible: list.filter((r) => r.bonus === 'eligible').length,
      on_track: list.filter((r) => r.bonus === 'on_track').length,
      agency_billing: list.some((r) => r.agency_billing !== null) ? round2(sum(list.map((r) => r.agency_billing ?? 0))) : null,
      am_share: list.some((r) => r.am_share !== null) ? round2(sum(list.map((r) => r.am_share ?? 0))) : null,
    };
  };

  const ams: GmvAmRow[] = [...accountsByAm(accounts).entries()]
    .map(([am_name, list]) => {
      const rows = accountRows.filter((r) => list.some((a) => a.id === r.account.id));
      return { am_name, accounts: rows.length, ...aggregate(rows) };
    })
    .filter((r) => r.accounts > 0);

  return {
    month,
    prev_month: prevMonth,
    from,
    to,
    month_closed: closed,
    days_in_month: dim,
    days_elapsed: elapsed,
    currency,
    settings,
    accounts: accountRows,
    ams,
    totals: aggregate(accountRows),
    last_sync: q.lastGmvSync(),
    cruva_configured: cruva.configured,
    windsor_configured: windsor.configured,
  };
}

// ---- GMV explorer: any date range, per account and shop, against the same-length period before ----

export function buildGmvExplore(q: Queries, from: string, to: string, opts: { accountId?: number | null } = {}): GmvExplore {
  const settings = gmvSettings(q);
  const fx = settings.fx_to_eur;
  const day = (s: string) => Date.parse(s + 'T12:00:00Z');
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const days = Math.round((day(to) - day(from)) / 86400000) + 1;
  const prevTo = iso(day(from) - 86400000);
  const prevFrom = iso(day(prevTo) - (days - 1) * 86400000);
  const shops = q.listShops().filter((s) => opts.accountId === null || opts.accountId === undefined || s.account_id === opts.accountId);
  const cur = q.listGmvBetween(from, to);
  const prev = q.listGmvBetween(prevFrom, prevTo);
  const accounts = q.listAccounts();
  const conv = (v: number, shop: { currency: string }) => toReportCurrency(v, shop.currency, fx);
  const change = (a: number, b: number): number | null => (b > 0 ? round2(((a - b) / b) * 100) : null);
  const rows: GmvExploreRow[] = accounts
    .filter((a) => opts.accountId === null || opts.accountId === undefined || a.id === opts.accountId)
    .map((a) => {
      const mine = shopsForGmv(shops.filter((s) => s.account_id === a.id), (id) => cur.some((r) => r.shop_id === id) || prev.some((r) => r.shop_id === id));
      const shopRows = mine.map((s) => {
        const c = cur.filter((r) => r.shop_id === s.shop_id);
        const p = prev.filter((r) => r.shop_id === s.shop_id);
        return { shop_id: s.shop_id, shop_name: s.shop_name, source: s.source, gmv: round2(conv(sum(c.map((r) => r.total_gmv)), s)), prev_gmv: round2(conv(sum(p.map((r) => r.total_gmv)), s)), units: sum(c.map((r) => r.units)) };
      });
      const daily = new Map<string, number>();
      for (const s of mine) for (const r of cur.filter((x) => x.shop_id === s.shop_id)) daily.set(r.date, (daily.get(r.date) ?? 0) + conv(r.total_gmv, s));
      const gmv = round2(sum(shopRows.map((s) => s.gmv)));
      const prev_gmv = round2(sum(shopRows.map((s) => s.prev_gmv)));
      return { account_id: a.id, account_name: a.name, shops: shopRows, gmv, affiliate_gmv: round2(sum(mine.map((s) => conv(sum(cur.filter((r) => r.shop_id === s.shop_id).map((r) => r.affiliate_gmv)), s)))), units: sum(shopRows.map((s) => s.units)), prev_gmv, change_pct: change(gmv, prev_gmv), daily: [...daily.entries()].sort().map(([date, g]) => ({ date, gmv: round2(g) })) };
    })
    .filter((r) => r.shops.length > 0)
    .sort((a, b) => b.gmv - a.gmv);
  const totalDaily = new Map<string, { gmv: number; prev_gmv: number }>();
  for (let i = 0; i < days; i += 1) {
    const d = iso(day(from) + i * 86400000);
    const pd = iso(day(prevFrom) + i * 86400000);
    const g = sum(shops.map((s) => conv(sum(cur.filter((r) => r.shop_id === s.shop_id && r.date === d).map((r) => r.total_gmv)), s)));
    const pg = sum(shops.map((s) => conv(sum(prev.filter((r) => r.shop_id === s.shop_id && r.date === pd).map((r) => r.total_gmv)), s)));
    totalDaily.set(d, { gmv: round2(g), prev_gmv: round2(pg) });
  }
  const gmv = round2(sum(rows.map((r) => r.gmv)));
  const prev_gmv = round2(sum(rows.map((r) => r.prev_gmv)));
  const synced = cur.map((r) => r.synced_at).sort().at(-1) ?? null;
  return { from, to, prev_from: prevFrom, prev_to: prevTo, days, currency: settings.report_currency, rows, totals: { gmv, prev_gmv, change_pct: change(gmv, prev_gmv), units: sum(rows.map((r) => r.units)), daily: [...totalDaily.entries()].map(([date, v]) => ({ date, ...v })) }, last_synced: synced };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
