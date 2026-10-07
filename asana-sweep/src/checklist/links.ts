/**
 * Where each checklist section lives in Seller Center (or the affiliate centre, or Cruva), per country, so the
 * AM opens the right tab with one click while ticking. Templates are editable under Checklists › Settings:
 * {sc} is the Seller Center host for the market, {affiliate} the affiliate centre, {region} the market code
 * TikTok uses (GB for the UK), {cruva} the Cruva app.
 */

export const DEFAULT_SECTION_URLS: Record<string, string> = {
  'Homepage': '{sc}/homepage?shop_region={region}',
  'Orders': '{sc}/order?shop_region={region}',
  'Growth': '{sc}/growth?shop_region={region}',
  'LIVE & video Analytics': '{sc}/compass/live-video?shop_region={region}',
  'Affiliate': '{affiliate}/platform/data/overview?shop_region={region}',
  'CS / Returns / Aftercare': '{sc}/customer-service/chat?shop_region={region}',
  'Products': '{sc}/product/manage?shop_region={region}',
  'Finance': '{sc}/finance/transactions?shop_region={region}',
  'Cruva': '{cruva}/',
  'Logistics': '{sc}/order?tab=to_ship&shop_region={region}',
  'Analytics': '{sc}/compass/home?shop_region={region}',
  'Marketing': '{sc}/promotion?shop_region={region}',
  'Account health': '{sc}/account-health?shop_region={region}',
};

/** The market code TikTok uses in Seller Center URLs (the UK is GB). */
export const regionCode = (market: string): string => { const m = market.trim().toUpperCase(); return m === 'UK' ? 'GB' : m; };

export function sectionUrl(section: string, market: string, templates: Record<string, string> = {}): string | null {
  const tpl = templates[section] ?? DEFAULT_SECTION_URLS[section];
  if (!tpl) return null;
  const region = regionCode(market);
  const uk = region === 'GB';
  return tpl
    .replace(/\{sc\}/g, uk ? 'https://seller-uk.tiktok.com' : 'https://seller-eu.tiktok.com')
    .replace(/\{affiliate\}/g, uk ? 'https://affiliate.tiktok.com' : 'https://affiliate-eu.tiktok.com')
    .replace(/\{region\}/g, region)
    .replace(/\{cruva\}/g, 'https://app.cruva.com');
}

/** The markets an account runs, from its "DE/UK" style field. */
export const marketsOf = (markets: string | null | undefined): string[] => [...new Set((markets ?? '').toUpperCase().split(/[\/,\s]+/).filter((m) => /^[A-Z]{2}$/.test(m)))];
