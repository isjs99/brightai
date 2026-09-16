import { Queries } from '../db/queries.js';
import { daysInMonth, monthRange, pct, workdaysInMonth } from '../checklist/calendar.js';
import { todayIn } from '../checklist/checker.js';
import { attainmentOf, gradeOf, projectMonth, scoreOf } from '../gmv/grading.js';
import { cruva } from '../gmv/cruva.js';
import type { Account, CalendarAccountRow, CalendarAmRow, CalendarCell, CalendarData, Check, GmvAccountRow, GmvAmRow, GmvData, GradeRow, GradesData } from '../sweep/types.js';

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

export function buildGmv(q: Queries, month: string): GmvData {
  const tz = q.getSetting('check_timezone', 'Europe/Madrid');
  const today = todayIn(tz);
  const { from, to } = monthRange(month);
  const dim = daysInMonth(month);
  const elapsed = month === today.slice(0, 7) ? Math.max(1, Number(today.slice(8, 10))) : today > to ? dim : 0;
  const rows = q.listGmvBetween(from, to);
  const targets = q.getTargets(month);
  const currency = q.getSetting('gmv_currency', '$');
  const shops = q.listShops();
  const byShop = new Map<string, typeof rows>();
  for (const r of rows) byShop.set(r.shop_id, [...(byShop.get(r.shop_id) ?? []), r]);

  const accounts = q.listAccounts();
  const accountRows: GmvAccountRow[] = accounts
    .map((account) => {
      const mine = shops.filter((s) => s.account_id === account.id);
      const shopRows = mine.map((shop) => {
        const list = byShop.get(shop.shop_id) ?? [];
        return {
          shop,
          gmv: sum(list.map((r) => r.total_gmv)),
          affiliate_gmv: sum(list.map((r) => r.affiliate_gmv)),
          units: sum(list.map((r) => r.units)),
          last_synced: list.length ? list.map((r) => r.synced_at).sort().at(-1)! : null,
        };
      });
      const dailyMap = new Map<string, number>();
      for (const shop of mine) for (const r of byShop.get(shop.shop_id) ?? []) dailyMap.set(r.date, (dailyMap.get(r.date) ?? 0) + r.total_gmv);
      const gmv = round2(sum(shopRows.map((s) => s.gmv)));
      const target = targets.get(account.id) ?? null;
      const projected = projectMonth(gmv, elapsed, dim);
      return {
        account,
        shops: shopRows,
        gmv,
        affiliate_gmv: round2(sum(shopRows.map((s) => s.affiliate_gmv))),
        units: sum(shopRows.map((s) => s.units)),
        target,
        attainment: attainmentOf(gmv, target),
        projected,
        projected_attainment: projected === null ? null : attainmentOf(projected, target),
        daily: [...dailyMap.entries()].sort().map(([date, g]) => ({ date, gmv: round2(g) })),
      };
    })
    .filter((r) => r.shops.length > 0 || r.target !== null);

  const ams: GmvAmRow[] = [...accountsByAm(accounts).entries()]
    .map(([am_name, list]) => {
      const rows = accountRows.filter((r) => list.some((a) => a.id === r.account.id));
      const gmv = round2(sum(rows.map((r) => r.gmv)));
      const targeted = rows.filter((r) => r.target !== null);
      const target = targeted.length ? sum(targeted.map((r) => r.target!)) : null;
      const projected = projectMonth(gmv, elapsed, dim);
      return { am_name, accounts: rows.length, gmv, target, attainment: attainmentOf(gmv, target), projected, projected_attainment: projected === null ? null : attainmentOf(projected, target) };
    })
    .filter((r) => r.accounts > 0);

  const gmv = round2(sum(accountRows.map((r) => r.gmv)));
  const targeted = accountRows.filter((r) => r.target !== null);
  const target = targeted.length ? sum(targeted.map((r) => r.target!)) : null;
  return {
    month,
    from,
    to,
    days_in_month: dim,
    days_elapsed: elapsed,
    currency,
    accounts: accountRows,
    ams,
    totals: { gmv, target, attainment: attainmentOf(gmv, target), projected: projectMonth(gmv, elapsed, dim) },
    last_sync: q.lastGmvSync(),
    cruva_configured: cruva.configured,
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
