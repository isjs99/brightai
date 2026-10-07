import { expect, it } from 'vitest';
import { DEFAULT_SECTION_URLS, marketsOf, regionCode, sectionUrl } from '../src/checklist/links';

it('builds the Seller Center link per section and country, with the UK on its own host and GB code', () => {
  expect(marketsOf('DE/UK, fr')).toEqual(['DE', 'UK', 'FR']);
  expect(regionCode('uk')).toBe('GB');
  expect(sectionUrl('Orders', 'DE')).toBe('https://seller-eu.tiktok.com/order?shop_region=DE');
  expect(sectionUrl('Orders', 'UK')).toBe('https://seller-uk.tiktok.com/order?shop_region=GB');
  expect(sectionUrl('Affiliate', 'FR')).toMatch(/^https:\/\/affiliate-eu\.tiktok\.com\//);
  expect(sectionUrl('Cruva', 'IT')).toBe('https://app.cruva.com/');
  expect(sectionUrl('Nope', 'DE')).toBeNull();
  // A saved template wins over the default and keeps the placeholders.
  expect(sectionUrl('Orders', 'ES', { Orders: '{sc}/order/list?shop_region={region}&tab=all' })).toBe('https://seller-eu.tiktok.com/order/list?shop_region=ES&tab=all');
  expect(Object.keys(DEFAULT_SECTION_URLS)).toContain('Account health');
});
