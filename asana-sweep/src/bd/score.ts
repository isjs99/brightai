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
