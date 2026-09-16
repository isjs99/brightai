// Market → currency for Cruva shops. Shops are named per market ("Kijimea UK", "Estrid PL"), and
// TikTok Shop reports GMV in the market's local currency. No USD markets at the moment.

const BY_MARKET: Record<string, string> = {
  UK: 'GBP',
  GB: 'GBP',
  PL: 'PLN',
  AU: 'AUD',
  CH: 'CHF',
  SE: 'SEK',
  DK: 'DKK',
  NO: 'NOK',
  CZ: 'CZK',
  HU: 'HUF',
  US: 'USD',
};

export const DEFAULT_REPORT_CURRENCY = 'EUR';

/** Rates to EUR: 1 unit of the key = value EUR. Editable in the dashboard; these are just starting points. */
export const DEFAULT_FX_TO_EUR: Record<string, number> = {
  EUR: 1,
  GBP: 1.16,
  PLN: 0.235,
  AUD: 0.6,
  CHF: 1.05,
  SEK: 0.088,
  DKK: 0.134,
  NOK: 0.085,
  CZK: 0.04,
  HUF: 0.0025,
  USD: 0.86,
};

export function currencyForShop(shopName: string): string {
  const tokens = shopName
    .toUpperCase()
    .replace(/[()\-–_,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const t of tokens) if (BY_MARKET[t]) return BY_MARKET[t];
  return 'EUR';
}

export function toReportCurrency(amount: number, currency: string, fx: Record<string, number>): number {
  const rate = fx[currency] ?? (currency === DEFAULT_REPORT_CURRENCY ? 1 : null);
  if (rate === null) return amount; // unknown currency: pass through rather than drop the figure
  return amount * rate;
}

export function parseFx(json: string): Record<string, number> {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) if (Number.isFinite(Number(v)) && Number(v) > 0) out[k.toUpperCase()] = Number(v);
    return { ...DEFAULT_FX_TO_EUR, ...out };
  } catch {
    return { ...DEFAULT_FX_TO_EUR };
  }
}
