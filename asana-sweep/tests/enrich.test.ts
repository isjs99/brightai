import { describe, it, expect } from 'vitest';
import { ApolloClient, organizationMatches, rankPeople, titleScore, type ApolloPerson } from '../src/bd/apollo';
import { companyQuery, EnrichJob, enrichProspect } from '../src/bd/enrich';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';

const person = (o: Partial<ApolloPerson> & { id: string }): ApolloPerson => ({ name: `P ${o.id}`, title: null, email: null, linkedin_url: null, phone: null, organization: null, email_status: null, city: null, country: null, ...o });

describe('apollo ranking and matching', () => {
  it('scores TikTok / e-commerce leads above founders above generic marketing, and penalises juniors', () => {
    expect(titleScore('Head of TikTok Shop Europe')).toBeGreaterThan(titleScore('Founder & CEO'));
    expect(titleScore('Founder & CEO')).toBeGreaterThan(titleScore('Brand Manager'));
    expect(titleScore('E-commerce Director DACH', 'DE')).toBeGreaterThan(titleScore('E-commerce Director', 'DE'));
    expect(titleScore('Marketing Intern')).toBeLessThan(0);
    expect(titleScore('Software Engineer')).toBeLessThan(0);
    expect(titleScore(null)).toBe(0);
  });

  it('ranks people by title, market and email availability', () => {
    const ranked = rankPeople([
      person({ id: 'a', title: 'Brand Manager' }),
      person({ id: 'b', title: 'Head of Ecommerce UK', country: 'United Kingdom' }),
      person({ id: 'c', title: 'Founder' }),
      person({ id: 'd', title: 'Assistant' }),
    ], 'UK');
    expect(ranked.map((p) => p.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('matches organisations loosely by name or domain', () => {
    expect(organizationMatches('Halara DE', { name: 'Halara', domain: 'halara.com' })).toBe(true);
    expect(organizationMatches('Nutrition Geeks', { name: 'Nutrition Geeks Ltd', domain: 'nutritiongeeks.co' })).toBe(true);
    expect(organizationMatches('Wellgard', { name: 'Bayagan Group', domain: 'wellgard.co.uk' })).toBe(true);
    expect(organizationMatches('Displayz', { name: 'Apollo', domain: 'apollo.io' })).toBe(false);
    expect(organizationMatches('', { name: 'X', domain: null })).toBe(false);
  });

  it('builds the company query from the brand or a cleaned shop name', () => {
    expect(companyQuery({ shop_name: 'Ninja Kitchen DE', brand: null })).toBe('Ninja Kitchen');
    expect(companyQuery({ shop_name: 'VEVOR Store ES', brand: 'VEVOR' })).toBe('VEVOR');
    expect(companyQuery({ shop_name: 'ulefone.fr', brand: null })).toBe('ulefone');
    expect(companyQuery({ shop_name: 'PUFFIT.UK.SHOP', brand: null })).toBe('PUFFIT');
    expect(companyQuery({ shop_name: 'XBJ ES', brand: null })).toBe('XBJ');
  });
});

const fakeApollo = (calls: { path: string; body: Record<string, unknown> }[], opts: { orgs?: Record<string, unknown>[]; people?: Record<string, unknown>[]; matches?: Record<string, unknown>[] } = {}) => {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.apollo.io/api/v1', '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    if (path === '/mixed_companies/search') return new Response(JSON.stringify({ organizations: opts.orgs ?? [] }));
    if (path === '/mixed_people/api_search') return new Response(JSON.stringify({ people: opts.people ?? [] }));
    if (path === '/people/bulk_match') {
      const ids = (body.details as { id: string }[]).map((d) => d.id);
      return new Response(JSON.stringify({ matches: ids.map((id) => (opts.matches ?? []).find((m) => m.id === id) ?? null) }));
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return new ApolloClient('key', 'https://api.apollo.io/api/v1', fetchFn);
};

describe('apollo client', () => {
  it('chunks bulk match by ten and maps results by id', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const ids = Array.from({ length: 12 }, (_, i) => `id${i}`);
    const client = fakeApollo(calls, { matches: ids.map((id) => ({ id, name: `N ${id}`, email: `${id}@x.com` })) });
    const out = await client.bulkMatch(ids);
    expect(calls.filter((c) => c.path === '/people/bulk_match').length).toBe(2);
    expect((calls[0].body.details as unknown[]).length).toBe(10);
    expect(out.size).toBe(12);
    expect(out.get('id11')?.email).toBe('id11@x.com');
  });

  it('finds an organisation by name and searches people by its id', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeApollo(calls, { orgs: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Halara', primary_domain: 'halara.com' }], people: [{ id: 'p1', first_name: 'Ann', last_name_obfuscated: 'Sm***h', title: 'Head of Ecommerce' }] });
    const org = await client.findOrganization('Halara DE');
    expect(org).toEqual({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Halara', domain: 'halara.com', website: null });
    const people = await client.searchPeople({ organizationId: org!.id, market: 'DE' });
    expect(calls[1].body.organization_ids).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa']);
    expect((calls[1].body.person_titles as string[])).toContain('tiktok');
    expect(people[0].name).toBe('Ann Sm***h');
  });
});

describe('prospect enrichment', () => {
  it('resolves the company, stores domain and org id, keeps ranked people and reveals the top ones', async () => {
    const q = new Queries(openTestDb());
    const p = q.listProspects().find((x) => x.shop_name === 'Halara DE')!;
    expect(p.contacts.length).toBe(0);
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeApollo(calls, {
      orgs: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Halara', primary_domain: 'halara.com' }],
      people: [
        { id: 'p1', first_name: 'Cindy', last_name_obfuscated: 'Na***n', title: 'Sr. Marketing Manager' },
        { id: 'p2', first_name: 'Chuhe', last_name_obfuscated: 'Ta***r', title: 'Ecommerce Manager - TikTok Live' },
        { id: 'p3', first_name: 'Joyce', last_name_obfuscated: 'Zh***g', title: 'Founder & CEO' },
        { id: 'p4', first_name: 'Bob', last_name_obfuscated: 'X', title: 'Intern' },
      ],
      matches: [
        { id: 'p2', name: 'Chuhe Tanner', title: 'Ecommerce Manager - TikTok Live', email: 'chuhe@halara.com', linkedin_url: 'https://linkedin.com/in/chuhe', email_status: 'verified' },
        { id: 'p3', name: 'Joyce Zhang', title: 'Founder & CEO', email: null, linkedin_url: 'https://linkedin.com/in/joyce' },
      ],
    });
    const r = await enrichProspect(q, p.id, { reveal: 2 }, client);
    expect(r).toMatchObject({ matched: true, company: 'Halara', domain: 'halara.com', found: 4, kept: 4, revealed: 2 });
    const after = q.getProspect(p.id)!;
    expect(after.domain).toBe('halara.com');
    expect(after.apollo_org_id).toBe('bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(after.contacts.map((c) => c.name)).toEqual(['Chuhe Tanner', 'Joyce Zhang', 'Cindy Na***n', 'Bob X']);
    expect(after.contacts[0]).toMatchObject({ email: 'chuhe@halara.com', enriched: true });
    expect(after.contacts[1]).toMatchObject({ email: null, linkedin_url: 'https://linkedin.com/in/joyce', enriched: true });
    expect(after.contacts[2].enriched).toBe(false);
    // A second run reuses the stored org id instead of resolving again.
    await enrichProspect(q, p.id, { reveal: 0 }, client);
    expect(calls.filter((c) => c.path === '/mixed_companies/search').length).toBe(1);
    expect(q.getProspect(p.id)!.contacts.length).toBe(4); // deduped by apollo id
  });

  it('bulk job visits only prospects without contacts and reports progress', async () => {
    const q = new Queries(openTestDb());
    q.markExistingClients();
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeApollo(calls, { orgs: [], people: [] });
    const job = new EnrichJob(q, client);
    const all = q.listProspects();
    const expected = all.filter((p) => !p.is_client && p.contacts.length === 0).length;
    expect(job.candidates().length).toBe(expected);
    const first = job.candidates().slice(0, 2).map((p) => p.id);
    const state = job.start({ ids: first, reveal: 0 });
    expect(state.running).toBe(true);
    expect(state.total).toBe(2);
    await new Promise((r) => setTimeout(r, 1200));
    expect(job.state.running).toBe(false);
    expect(job.state.done).toBe(2);
    expect(job.state.matched).toBe(0);
    expect(job.state.finished_at).not.toBeNull();
  });
});
