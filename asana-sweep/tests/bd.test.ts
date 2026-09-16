import { describe, it, expect } from 'vitest';
import { ageEstimateDays, fastmossShopUrl, launchFlags, matchesAccountName, normaliseDomain, outreachComplete, riseBand, riseScore, withinDays } from '../src/bd/score';
import { parseProspectInput } from '../src/bd/import';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';

describe('BD scoring', () => {
  it('rise score is the 7-day share of lifetime GMV', () => {
    expect(riseScore(250, 1000)).toBe(0.25);
    expect(riseScore(0, 1000)).toBe(0);
    expect(riseScore(50, 0)).toBeNull();
    expect(riseScore(null, 100)).toBeNull();
    expect(riseScore(2000, 1000)).toBe(1);
    expect(riseBand(0.2)).toBe('surging');
    expect(riseBand(0.07)).toBe('rising');
    expect(riseBand(0.01)).toBe('steady');
    expect(riseBand(null)).toBe('unknown');
  });

  it('outreach is complete only with all three channels', () => {
    expect(outreachComplete({ outreach_tts_am: true, outreach_gmail: true, outreach_linkedin: true })).toBe(true);
    expect(outreachComplete({ outreach_tts_am: true, outreach_gmail: true, outreach_linkedin: false })).toBe(false);
  });

  it('launch signals: known dates first, then the run-rate estimate', () => {
    const now = Date.parse('2026-09-16T12:00:00Z');
    expect(ageEstimateDays(700, 2100)).toBe(21);
    expect(ageEstimateDays(0, 2100)).toBeNull();
    expect(ageEstimateDays(700, null)).toBeNull();
    expect(withinDays('2026-09-01', 30, now)).toBe(true);
    expect(withinDays('2026-08-01', 30, now)).toBe(false);
    expect(withinDays('not a date', 30, now)).toBe(false);
    expect(withinDays(null, 30, now)).toBe(false);
    expect(launchFlags({ launched_at: '2026-09-10', gmv_started_at: '2026-09-12', gmv_7d: 10, gmv_total: 10000 }, now)).toEqual({ new_shop_30d: true, gmv_started_30d: true, age_estimate_days: 7000 });
    expect(launchFlags({ launched_at: '2025-01-01', gmv_started_at: '2025-02-01', gmv_7d: 1000, gmv_total: 1000 }, now)).toEqual({ new_shop_30d: false, gmv_started_30d: false, age_estimate_days: 7 });
    expect(launchFlags({ launched_at: null, gmv_started_at: null, gmv_7d: 700, gmv_total: 2100 }, now)).toEqual({ new_shop_30d: false, gmv_started_30d: true, age_estimate_days: 21 });
    expect(launchFlags({ launched_at: null, gmv_started_at: null, gmv_7d: 70, gmv_total: 21000 }, now).gmv_started_30d).toBe(false);
    expect(fastmossShopUrl('123')).toBe('https://www.fastmoss.com/shop-marketing/detail/123');
    expect(fastmossShopUrl(null)).toBeNull();
  });

  it('matches shop names to roster accounts loosely', () => {
    expect(matchesAccountName('Bears with Benefits Italia', 'Bears With Benefits')).toBe(true);
    expect(matchesAccountName('Wellgard', 'Wellgard')).toBe(true);
    expect(matchesAccountName('The Laka Store', 'Laka')).toBe(true);
    expect(matchesAccountName('Lakaland', 'Laka')).toBe(false);
    expect(matchesAccountName('BiFi Shop', 'BiFi')).toBe(true);
    expect(matchesAccountName('Anything', 'Bi')).toBe(false);
  });

  it('parses raw FastMoss rows into prospect inputs', () => {
    const row = parseProspectInput({ seller_id: 7, shop_name: ' Acme ', market: 'de', gmv_7d: '12.5', gmv_total: 100, shop: { shop_created_date: '2026-09-01 10:00:00' }, first_sale_date: '2026-09-03', website: 'https://acme.de/x' });
    expect(row).toMatchObject({ seller_id: '7', shop_name: 'Acme', market: 'DE', gmv_7d: 12.5, gmv_total: 100, launched_at: '2026-09-01', gmv_started_at: '2026-09-03' });
    expect(() => parseProspectInput({ market: 'DE' })).toThrow();
  });

  it('normalises domains', () => {
    expect(normaliseDomain('https://www.Brand.com/shop?x=1')).toBe('brand.com');
    expect(normaliseDomain('brand')).toBeNull();
    expect(normaliseDomain('')).toBeNull();
  });
});

describe('BD prospects', () => {
  const setup = () => new Queries(openTestDb());

  it('seeds FastMoss shops per market with contacts', () => {
    const q = setup();
    const all = q.listProspects();
    expect(all.length).toBe(150);
    expect(new Set(all.map((p) => p.market))).toEqual(new Set(['DE', 'UK', 'FR', 'IT', 'ES']));
    const geeks = all.find((p) => p.shop_name === 'Nutrition Geeks')!;
    expect(geeks.currency).toBe('GBP');
    expect(geeks.contacts.map((c) => c.title)).toEqual(['Co-Founder', 'Co-Founder', 'Co-Founder']);
    expect(geeks.contacts[0].enriched).toBe(true);
    expect(geeks.contacts[0].email).toBe('rishi@nutritiongeeks.co');
    expect(geeks.fastmoss_url).toBe(`https://www.fastmoss.com/shop-marketing/detail/${geeks.seller_id}`);
  });

  it('exposes launch signals and the FastMoss shop page', () => {
    const q = setup();
    const all = q.listProspects();
    const philips = all.find((p) => p.shop_name === 'philips.maison')!;
    expect(philips.launched_at).toBe('2026-07-25');
    expect(philips.gmv_started_at).toBe('2026-08-07');
    expect(philips.new_shop_30d).toBe(false); // created 53 days before today
    const displayz = all.find((p) => p.shop_name === 'Displayz')!;
    expect(displayz.gmv_started_at).toBeNull();
    expect(displayz.age_estimate_days).toBeLessThanOrEqual(30);
    expect(displayz.gmv_started_30d).toBe(true); // estimated from the 7-day share of lifetime GMV
    const fresh = q.createProspect({ shop_name: 'Fresh Shop', market: 'UK', launched_at: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) });
    expect(fresh.new_shop_30d).toBe(true);
    expect(fresh.fastmoss_url).toBeNull();
    expect(q.listProspects().filter((p) => p.new_shop_30d).map((p) => p.shop_name)).toEqual(['Fresh Shop']);
  });

  it('marks roster accounts that show up as prospects as existing clients', () => {
    const q = setup();
    expect(q.listProspects().filter((p) => p.is_client)).toEqual([]);
    const n = q.markExistingClients();
    expect(n).toBeGreaterThanOrEqual(1);
    const bwb = q.listProspects().find((p) => p.shop_name === 'Bears with Benefits Italia')!;
    expect(bwb.is_client).toBe(true);
    expect(bwb.status).toBe('won');
    expect(bwb.notes).toBe('Existing client (Bears With Benefits on the roster)');
    expect(q.markExistingClients()).toBe(0); // idempotent
    // a re-import of the same shop keeps the client marking
    q.upsertProspects([{ seller_id: bwb.seller_id, shop_name: bwb.shop_name, market: 'IT', gmv_7d: 1 }]);
    expect(q.getProspect(bwb.id)!.is_client).toBe(true);
  });

  it('keeps an outreach history per prospect', () => {
    const q = setup();
    const p = q.listProspects()[0];
    q.patchProspect(p.id, { outreach_linkedin: true, outreach_note: 'DM to the founder', outreach_contact: 'Ann Smith' }, 'admin');
    q.patchProspect(p.id, { outreach_linkedin: true }); // no change, no event
    q.patchProspect(p.id, { status: 'replied' }, 'am');
    q.patchProspect(p.id, { outreach_note: 'Call booked Thursday' });
    q.patchProspect(p.id, { outreach_linkedin: false });
    const log = q.getProspect(p.id)!.outreach_log;
    expect(log.map((e) => [e.channel, e.action, e.note])).toEqual([
      ['linkedin', 'uncontacted', null],
      [null, 'note', 'Call booked Thursday'],
      [null, 'replied', 'Status: new → replied'],
      ['linkedin', 'contacted', 'DM to the founder'],
    ]);
    expect(log[3]).toMatchObject({ contact_name: 'Ann Smith', actor: 'admin' });
    expect(q.deleteOutreachEvent(log[1].id)).toBe(true);
    expect(q.getProspect(p.id)!.outreach_log.length).toBe(3);
    const manual = q.logOutreach(p.id, { channel: 'gmail', action: 'contacted', note: null });
    expect(manual.channel).toBe('gmail');
  });

  it('refreshes numbers on re-import but keeps status, owner and outreach', () => {
    const q = setup();
    const p = q.listProspects().find((x) => x.shop_name === 'Displayz')!;
    q.patchProspect(p.id, { status: 'contacted', outreach_gmail: true, notes: 'keep me' });
    const r = q.upsertProspects([{ seller_id: p.seller_id, shop_name: 'Displayz', market: 'FR', gmv_7d: 999, gmv_total: 5000, source: 'fastmoss', pulled_at: '2026-10-01T00:00:00.000Z' }, { shop_name: 'Brand New', market: 'DE' }]);
    expect(r).toEqual({ added: 1, updated: 1 });
    const after = q.getProspect(p.id)!;
    expect(after.gmv_7d).toBe(999);
    expect(after.status).toBe('contacted');
    expect(after.outreach_gmail).toBe(true);
    expect(after.outreach_gmail_at).not.toBeNull();
    expect(after.notes).toBe('keep me');
    expect(after.pulled_at).toBe('2026-10-01T00:00:00.000Z');
  });

  it('outreach ticks keep their first timestamp and clear when unticked', () => {
    const q = setup();
    const p = q.listProspects()[0];
    const a = q.patchProspect(p.id, { outreach_tts_am: true, outreach_gmail: true, outreach_linkedin: true })!;
    expect(a.outreach_complete).toBe(true);
    const firstAt = a.outreach_tts_am_at;
    const b = q.patchProspect(p.id, { outreach_tts_am: true })!;
    expect(b.outreach_tts_am_at).toBe(firstAt);
    const c = q.patchProspect(p.id, { outreach_linkedin: false })!;
    expect(c.outreach_complete).toBe(false);
    expect(c.outreach_linkedin_at).toBeNull();
  });

  it('contacts dedupe by apollo id', () => {
    const q = setup();
    const p = q.listProspects()[0];
    q.addContact(p.id, { name: 'Ann Sm***h', title: 'CEO', source: 'apollo', apollo_id: 'abc' });
    q.addContact(p.id, { name: 'Ann Smith', email: 'ann@x.com', source: 'apollo', apollo_id: 'abc', enriched: true });
    const contacts = q.getProspect(p.id)!.contacts;
    expect(contacts.length).toBe(1);
    expect(contacts[0]).toMatchObject({ name: 'Ann Smith', title: 'CEO', email: 'ann@x.com', enriched: true });
  });
});
