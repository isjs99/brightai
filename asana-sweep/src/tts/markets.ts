/** Market codes an account is active in, from the roster's "DE/IT/FR" text. */
export function marketsOf(markets: string | null): string[] {
  if (!markets) return [];
  return [...new Set(markets.toUpperCase().split(/[\/,\s]+/).map((m) => m.trim()).filter((m) => /^[A-Z]{2}$/.test(m)))];
}

export const EU_MARKETS = ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'IE', 'AT', 'PL', 'UK'];

/** TikTok Shop region code → market code used across the dashboard. */
export function marketFromRegion(region: string): string {
  const r = region.toUpperCase();
  return r === 'GB' ? 'UK' : r;
}

export function currencyForMarket(market: string): string {
  return market === 'UK' ? 'GBP' : market === 'PL' ? 'PLN' : 'EUR';
}
