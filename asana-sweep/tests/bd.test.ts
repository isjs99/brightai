import { describe, it, expect } from 'vitest';
import { normaliseDomain, outreachComplete, riseBand, riseScore } from '../src/bd/score';
import { openDb } from '../src/db/index';
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

  it('normalises domains', () => {
    expect(normaliseDomain('https://www.Brand.com/shop?x=1')).toBe('brand.com');
    expect(normaliseDomain('brand')).toBeNull();
    expect(normaliseDomain('')).toBeNull();
  });
});

describe('BD prospects', () => {
  const setup = () => new Queries(openDb(':memory:'));

  it('seeds FastMoss shops per market with contacts', () => {
    const q = setup();
    const all = q.listProspects();
    expect(all.length).toBe(150);
    expect(new Set(all.map((p) => p.market))).toEqual(new Set(['DE', 'UK', 'FR', 'IT', 'ES']));
    const geeks = all.find((p) => p.shop_name === 'Nutrition Geeks')!;
    expect(geeks.currency).toBe('GBP');
    expect(geeks.contacts.map((c) => c.title)).toEqual(['Co-Founder', 'Co-Founder', 'Co-Founder']);
    expect(geeks.contacts[0].enriched).toBe(false);
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
