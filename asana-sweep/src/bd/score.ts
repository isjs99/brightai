// Pure helpers for the BD pipeline. No Node-only imports.

/** Share of a shop's lifetime GMV that happened in the last 7 days. 0.35 means a third of everything it ever sold was this week. */
export function riseScore(gmv7d: number | null | undefined, gmvTotal: number | null | undefined): number | null {
  if (gmv7d === null || gmv7d === undefined || !gmvTotal || gmvTotal <= 0) return null;
  return Math.min(1, gmv7d / gmvTotal);
}

export type RiseBand = 'surging' | 'rising' | 'steady' | 'unknown';

export function riseBand(score: number | null): RiseBand {
  if (score === null) return 'unknown';
  if (score >= 0.15) return 'surging';
  if (score >= 0.05) return 'rising';
  return 'steady';
}

/** Outreach is only complete when all three channels have been used. */
export function outreachComplete(o: { outreach_tts_am: boolean; outreach_gmail: boolean; outreach_linkedin: boolean }): boolean {
  return o.outreach_tts_am && o.outreach_gmail && o.outreach_linkedin;
}

/** Best-effort company domain from a website or handle-free brand name. */
export function normaliseDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

/** Days of selling implied by the 7-day run-rate: lifetime GMV / (7d GMV / 7). Null when either is missing. */
export function ageEstimateDays(gmv7d: number | null | undefined, gmvTotal: number | null | undefined): number | null {
  if (!gmv7d || gmv7d <= 0 || !gmvTotal || gmvTotal <= 0) return null;
  return Math.round(gmvTotal / (gmv7d / 7));
}

export function withinDays(date: string | null | undefined, days: number, now = Date.now()): boolean {
  if (!date) return false;
  const t = Date.parse(date);
  return Number.isFinite(t) && now - t <= days * 86400000 && t <= now + 86400000;
}

/**
 * Launch signals. "New shop" needs a known creation date. "GMV started / took off" uses a known
 * first-sale date when we have one, otherwise the 7-day share of lifetime GMV (a shop that made
 * everything it ever sold in the last month has an implied selling age of at most 30 days).
 */
export function launchFlags(p: { launched_at: string | null; gmv_started_at: string | null; gmv_7d: number | null; gmv_total: number | null }, now = Date.now()): { new_shop_30d: boolean; gmv_started_30d: boolean; age_estimate_days: number | null } {
  const age = ageEstimateDays(p.gmv_7d, p.gmv_total);
  const gmvStarted = p.gmv_started_at ? withinDays(p.gmv_started_at, 30, now) : age !== null && age <= 30;
  return { new_shop_30d: withinDays(p.launched_at, 30, now), gmv_started_30d: gmvStarted, age_estimate_days: age };
}

export const fastmossShopUrl = (sellerId: string | null | undefined): string | null => (sellerId ? `https://www.fastmoss.com/shop-marketing/detail/${sellerId}` : null);

/** Loose match between a FastMoss shop name and a roster account name ("Bears with Benefits Italia" ~ "Bears With Benefits"). */
export function matchesAccountName(shopName: string, accountName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = norm(accountName);
  const b = norm(shopName);
  if (!a || a.length < 4) return false;
  return b === a || b.startsWith(a + ' ') || b.includes(' ' + a + ' ') || b.endsWith(' ' + a);
}
