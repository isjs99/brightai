import { Queries } from '../db/queries.js';
import { daysInMonth, monthRange, pct, previousMonth, workdaysInMonth } from '../checklist/calendar.js';
import { todayIn } from '../checklist/checker.js';
import { attainmentOf, bonusTarget, gradeOf, growthPct, projectMonth, requiredGrowthPct, scoreOf, type BonusRule } from '../gmv/grading.js';
import { cruva } from '../gmv/cruva.js';
import { windsor } from '../gmv/windsor.js';
import { DEFAULT_REPORT_CURRENCY, parseFx, toReportCurrency } from '../gmv/currency.js';
import type {
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
  GmvSettings,
  GmvShopRow,
  GradeRow,
  GradesData,
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

  const bonusStatus = (gmv: number, projected: number | null, target: number | null, hasData: boolean): BonusStatus => {
    if (target === null) return hasData ? 'no_base' : 'no_data';
    if (closed) return gmv >= target ? 'eligible' : 'behind';
    if (!hasData || projected === null) return 'no_data';
    return projected >= target ? 'on_track' : 'behind';
  };

  const accounts = q.listAccounts();
  const accountRows: GmvAccountRow[] = accounts
    .map((account) => {
      const mine = shops.filter((s) => s.account_id === account.id);
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

// ---- Grades ----

export function buildGrades(q: Queries, month: string): GradesData {
  const weight = Number(q.getSetting('grade_weight_checklist', '50')) || 50;
  const cal = buildCalendar(q, month);
  const gmv = buildGmv(q, month);
  const gmvByAccount = new Map(gmv.accounts.map((r) => [r.account.id, r]));

  const accounts: GradeRow[] = cal.ams.flatMap((am) =>
    am.accounts.map((row) => {
      const g = gmvByAccount.get(row.account.id);
      // Use projected attainment for the current month so mid-month grades are not all F.
      const attainment = g ? (g.projected_attainment ?? g.attainment) : null;
      const score = scoreOf({ compliance: row.compliance, attainment, weightChecklist: weight });
      return {
        name: row.account.name,
        am_name: row.account.am_name,
        account_id: row.account.id,
        compliance: row.compliance,
        missed: row.missed,
        checked_days: row.checked_days,
        gmv: g?.gmv ?? 0,
        target: g?.target ?? null,
        attainment,
        score,
        grade: gradeOf(score),
      };
    }),
  );

  const ams: GradeRow[] = cal.ams.map((am) => {
    const g = gmv.ams.find((r) => r.am_name === am.am_name);
    const attainment = g ? (g.projected_attainment ?? g.attainment) : null;
    const score = scoreOf({ compliance: am.compliance, attainment, weightChecklist: weight });
    return {
      name: am.am_name,
      am_name: am.am_name,
      account_id: null,
      compliance: am.compliance,
      missed: am.missed,
      checked_days: am.checked_days,
      gmv: g?.gmv ?? 0,
      target: g?.target ?? null,
      attainment,
      score,
      grade: gradeOf(score),
    };
  });

  const byScore = (a: GradeRow, b: GradeRow) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name);
  return { month, weight_checklist: weight, ams: ams.sort(byScore), accounts: accounts.sort(byScore) };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
