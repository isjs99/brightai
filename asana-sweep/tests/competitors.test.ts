import { describe, expect, it } from 'vitest';
import { Queries } from '../src/db/queries';
import { openTestDb } from '../src/db/index';
import type { ApolloClient, ApolloOrgPerson } from '../src/bd/apollo';
import { Competitors, SEED_COMPETITORS, addedLines, atsUrl, brandKey, diffPeople, digestText, extractRules, matchOverlap, overlapIndex, parseAtsFeed, parseExtraction, textOfHtml } from '../src/intel/competitors';
import type { CompetitorPerson, CompetitorSignal } from '../src/sweep/types';

const person = (over: Partial<ApolloOrgPerson>): ApolloOrgPerson => ({ id: 'p1', name: 'Anna K', title: 'Account Manager', email: null, linkedin_url: null, phone: null, organization: 'Genuine', email_status: null, city: 'London', country: 'United Kingdom', organization_id: 'o1', seniority: 'manager', departments: ['master_sales'], started_at: '2026-09-01', ...over });
const had = (over: Partial<CompetitorPerson>): CompetitorPerson => ({ id: 1, competitor_id: 1, apollo_id: 'p1', name: 'Anna K', title: 'Account Manager', prev_title: null, seniority: 'manager', department: 'sales', location: 'London', linkedin_url: null, started_at: '2026-09-01', first_seen_at: '2026-09-01T00:00:00.000Z', last_seen_at: '2026-09-29T00:00:00.000Z', miss_count: 0, left_at: null, ...over });

describe('competitor helpers', () => {
  it('keys brands so spellings and suffixes match', () => {
    expect(brandKey('Waterdrop GmbH')).toBe('waterdrop');
    expect(brandKey('WATERDROP Official Store DE')).toBe('waterdrop');
    expect(brandKey('Neuro Gum & Mints Ltd')).toBe('neuro gum and mints');
    expect(brandKey('Kijimea DE')).toBe('kijimea');
  });

  it('turns a page into lines and finds what was added', () => {
    const html = '<html><head><title>Clients</title><style>.x{}</style><script>var a=1</script></head><body><nav><a>Home</a></nav><h1>Our clients</h1><ul><li>Waterdrop</li><li>Neuro Gum</li></ul><img alt="Kijimea logo"><p>We&amp;re hiring: Anna joins as Head of TikTok Shop DE</p><footer>legal</footer></body></html>';
    const text = textOfHtml(html);
    expect(text.split('\n')).toEqual(['Our clients', 'Waterdrop', 'Neuro Gum', 'Kijimea logo', "We&re hiring: Anna joins as Head of TikTok Shop DE"]);
    expect(addedLines('Our clients\nWaterdrop', text)).toEqual(['Neuro Gum', 'Kijimea logo', "We&re hiring: Anna joins as Head of TikTok Shop DE"]);
  });

  it('parses the public ATS feeds', () => {
    expect(atsUrl('greenhouse', 'acme')).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=false');
    expect(parseAtsFeed('greenhouse', { jobs: [{ id: 11, title: 'Account Manager', location: { name: 'Berlin' }, absolute_url: 'https://g/11', updated_at: '2026-09-30T10:00:00Z' }] }, 'acme')).toEqual([{ ext_id: '11', title: 'Account Manager', location: 'Berlin', url: 'https://g/11', posted_at: '2026-09-30' }]);
    expect(parseAtsFeed('lever', [{ id: 'abc', text: 'Creator Lead', categories: { location: 'London' }, hostedUrl: 'https://l/abc', createdAt: Date.UTC(2026, 8, 30, 12) }], 'acme')).toEqual([{ ext_id: 'abc', title: 'Creator Lead', location: 'London', url: 'https://l/abc', posted_at: '2026-09-30' }]);
    expect(parseAtsFeed('workable', { jobs: [{ shortcode: 'X1', title: 'TikTok Shop Manager', city: 'Madrid', country: 'Spain', url: 'https://w/X1', published_on: '2026-10-01' }] }, 'acme')).toEqual([{ ext_id: 'X1', title: 'TikTok Shop Manager', location: 'Madrid, Spain', url: 'https://w/X1', posted_at: '2026-10-01' }]);
    expect(parseAtsFeed('personio', [{ id: 9, name: 'Werkstudent Social Commerce', office: 'Köln', createdAt: '2026-10-02' }], 'adb')).toEqual([{ ext_id: '9', title: 'Werkstudent Social Commerce', location: 'Köln', url: 'https://adb.jobs.personio.de/job/9', posted_at: '2026-10-02' }]);
    expect(parseAtsFeed('greenhouse', null, 'acme')).toEqual([]);
  });

  it('diffs people: joined, title change, and left only on the second miss', () => {
    const prev = [had({}), had({ id: 2, apollo_id: 'p2', name: 'Ben', title: 'Head of Sales' }), had({ id: 3, apollo_id: 'p3', name: 'Cara', miss_count: 1 }), had({ id: 4, apollo_id: 'p4', name: 'Gone', left_at: '2026-08-01T00:00:00.000Z' })];
    const next = [person({ title: 'Senior Account Manager' }), person({ id: 'p5', name: 'Dan', title: 'Founder', seniority: 'founder' })];
    const d = diffPeople(prev, next);
    expect(d.joined.map((p) => p.id)).toEqual(['p5']);
    expect(d.changed.map((c) => `${c.person.name}:${c.from}>${c.to}`)).toEqual(['Anna K:Account Manager>Senior Account Manager']);
    expect(d.missed.map((p) => p.name)).toEqual(['Ben']);
    expect(d.left.map((p) => p.name)).toEqual(['Cara']);
  });

  it('extracts with rules and parses the Claude JSON', () => {
    const ex = extractRules(['Our clients', 'Waterdrop', 'Welcome Lena Fischer, who joins as Head of TikTok Shop DE', 'Join us at the TikTok Shop Summit Berlin', 'Genuine wins TikTok Shop Partner of the Year award for the second time'], [{ name: 'Waterdrop GmbH', key: 'waterdrop' }, { name: 'Neuro Gum', key: 'neuro gum' }]);
    expect(ex.clients).toEqual([{ brand: 'Waterdrop GmbH', market: null, evidence: 'Waterdrop' }]);
    expect(ex.hires[0]).toMatchObject({ name: 'Lena Fischer,', title: 'Head of TikTok Shop DE' });
    expect(ex.events[0].title).toMatch(/Summit/);
    expect(ex.press[0].title).toMatch(/award/);
    const parsed = parseExtraction('Sure:\n{"clients":[{"brand":"Neuro Gum","market":"de","evidence":"Neuro Gum: 3x GMV in 90 days"},{"brand":"","evidence":"x"}],"hires":[{"name":"Lena Fischer","title":"Head of TikTok Shop DE","evidence":"Welcome Lena"}],"markets":[{"market":"ES","evidence":"Now live in Spain"}],"events":[],"press":[]}');
    expect(parsed).toEqual({ clients: [{ brand: 'Neuro Gum', market: 'DE', evidence: 'Neuro Gum: 3x GMV in 90 days' }], hires: [{ name: 'Lena Fischer', title: 'Head of TikTok Shop DE', evidence: 'Welcome Lena' }], markets: [{ market: 'ES', evidence: 'Now live in Spain' }], events: [], press: [] });
    expect(parseExtraction('nope')).toBeNull();
  });

  it('writes the digest grouped by competitor with the quiet ones at the end', () => {
    const comps = [{ id: 1, name: 'Genuine', markets: ['UK'], enabled: true }, { id: 2, name: 'AdBaker', markets: ['DE'], enabled: true }, { id: 3, name: 'Old', markets: [], enabled: false }] as never;
    const sig = (over: Partial<CompetitorSignal>): CompetitorSignal => ({ id: 1, competitor_id: 1, kind: 'joined', summary: 'x', evidence: null, url: null, observed_at: '2026-10-05T10:00:00.000Z', created_at: '2026-10-05T10:00:00.000Z', seen_at: null, ...over });
    const text = digestText(comps, [sig({ summary: 'Anna K, Head of TikTok Shop DE' }), sig({ id: 2, kind: 'overlap', summary: 'Waterdrop is a Genuine client and on our BD pipeline (contacted)', url: 'https://g/clients' }), sig({ id: 3, kind: 'job_closed', summary: 'closed role' })], { since: '2026-09-29T00:00:00.000Z', until: '2026-10-06T00:00:00.000Z', link: 'https://ops/competitors', timezone: 'Europe/Madrid' });
    expect(text.split('\n')).toEqual(['*Competitor movements · 29 Sept to 6 Oct*', '', '*Genuine* (UK)', '• In our pipeline: Waterdrop is a Genuine client and on our BD pipeline (contacted) <https://g/clients|source>', '• Joined: Anna K, Head of TikTok Shop DE', '', '_No changes seen for AdBaker._', '', '<https://ops/competitors|Open Competitors in the dashboard>']);
  });
});

describe('competitor seed', () => {
  it('adds the seeds that are missing and leaves the registry alone otherwise', () => {
    const q = new Queries(openTestDb());
    const comp = new Competitors(q, { llm: null });
    q.createCompetitor({ name: 'genuine', domain: 'wearegenuine.com', markets: ['UK', 'IE'], notes: 'edited by the team' });
    expect(comp.seed()).toBe(SEED_COMPETITORS.length - 1);
    expect(comp.seed()).toBe(0);
    const all = q.listCompetitors();
    expect(all).toHaveLength(SEED_COMPETITORS.length);
    expect(all.find((c) => c.name === 'genuine')).toMatchObject({ markets: ['UK', 'IE'], notes: 'edited by the team' });
    expect(all.find((c) => c.name === 'Superb')).toMatchObject({ domain: null, watch_urls: [] });
    expect(all.find((c) => c.name === 'SAMY')!.markets).toEqual(['ES', 'DE', 'IT', 'UK']);
    expect(new Set(SEED_COMPETITORS.map((c) => c.name.toLowerCase())).size).toBe(SEED_COMPETITORS.length);
  });
});

describe('competitor sweep', () => {
  const setup = () => {
    const q = new Queries(openTestDb());
    const db = (q as unknown as { db: import('better-sqlite3').Database }).db;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO leads (key, name, stage, country, first_seen_at, last_seen_at, updated_at) VALUES ('wd', 'Waterdrop', 'Proposal sent', 'DE', ?, ?, ?)").run(now, now, now);
    q.upsertProspects([{ shop_name: 'Neuro Gum Official Store', brand: 'Neuro Gum', market: 'DE', seller_id: 'ng1', gmv_7d: 1000, total_gmv: 5000, status: 'new' }] as never);
    const idx = overlapIndex(q);
    return { q, idx };
  };

  it('matches competitor clients to our prospects and leads', () => {
    const { idx } = setup();
    expect(matchOverlap('waterdrop', 'DE', idx)).toMatchObject({ prospect_id: null, lead_id: expect.any(Number) });
    expect(matchOverlap('neuro gum', null, idx)).toMatchObject({ prospect_id: expect.any(Number), lead_id: null });
    expect(matchOverlap('xx', null, idx)).toEqual({ prospect_id: null, lead_id: null });
  });

  it('baselines on the first sweep, then reports joiners, leavers, roles, new clients and overlap, and sends the digest', async () => {
    const { q } = setup();
    let week = 0;
    const people: Record<number, ApolloOrgPerson[]> = {
      0: [person({}), person({ id: 'p2', name: 'Ben', title: 'Head of Sales', seniority: 'head' })],
      1: [person({}), person({ id: 'p3', name: 'Cara', title: 'Founder', seniority: 'founder', started_at: '2019-01-01' })],
      2: [person({ title: 'Senior Account Manager' }), person({ id: 'p3', name: 'Cara', title: 'Founder', seniority: 'founder', started_at: '2019-01-01' })],
    };
    const apollo = { configured: true, enrichOrganization: async () => ({ id: 'org1', name: 'Genuine', domain: 'wearegenuine.com', website: null, linkedin_url: 'https://linkedin.com/company/genuine' }), peopleAtOrganization: async () => ({ people: people[week] ?? people[2], total: (people[week] ?? people[2]).length }) } as unknown as ApolloClient;
    const pages: Record<number, string> = {
      0: '<html><body><h1>Clients</h1><ul><li>Waterdrop</li></ul></body></html>',
      1: '<html><body><h1>Clients</h1><ul><li>Waterdrop</li><li>Neuro Gum</li></ul><p>Welcome Lena Fischer, who joins as Head of TikTok Shop DE</p></body></html>',
    };
    const jobs: Record<number, unknown> = { 0: { jobs: [{ id: 1, title: 'Account Manager', location: { name: 'London' }, absolute_url: 'https://g/1' }] }, 1: { jobs: [{ id: 1, title: 'Account Manager', location: { name: 'London' }, absolute_url: 'https://g/1' }, { id: 2, title: 'Head of TikTok Shop DE', location: { name: 'Berlin' }, absolute_url: 'https://g/2' }] } };
    const fetchFn = (async (url: string | URL | Request) => { const u = String(url); if (u.includes('greenhouse')) return new Response(JSON.stringify(jobs[week] ?? jobs[1])); return new Response(pages[week] ?? pages[1]); }) as typeof fetch;
    const posted: { channel: string; text: string }[] = [];
    const slack = { configured: true, post: async (channel: string, text: string) => { posted.push({ channel, text }); }, channelId: async (c: string) => c };
    const comp = new Competitors(q, { apollo, fetchFn, llm: null, slack });
    q.setSetting('competitors_channel', '#bd');
    const c = q.createCompetitor({ name: 'Genuine', domain: 'wearegenuine.com', markets: ['UK'], watch_urls: ['https://wearegenuine.com/clients'], ats: [{ kind: 'greenhouse', slug: 'genuine' }] });

    // Week 0: baseline. People and clients recorded, no signals except the overlap we can already see.
    let r = await comp.sweep({ useLlm: false });
    expect(r).toMatchObject({ swept: 1, errors: [] });
    expect(q.getCompetitor(c.id)!.apollo_org_id).toBe('org1');
    expect(q.listCompetitorPeople(c.id).map((p) => p.name)).toEqual(['Anna K', 'Ben']);
    expect(q.listCompetitorJobs(c.id)).toHaveLength(1);
    expect(q.listCompetitorClients(c.id).map((x) => `${x.brand}:${x.lead_id !== null}`)).toEqual(['Waterdrop:true']);
    expect(q.listCompetitorSignals({ competitorId: c.id }).map((s) => s.kind)).toEqual(['overlap']);
    expect(comp.data().overlap).toHaveLength(1);

    // Week 1: Cara appears, Ben is missing once (not left yet), a role opens, Neuro Gum and a hire show up on the page.
    week = 1;
    r = await comp.sweep({ useLlm: false });
    const kinds = () => q.listCompetitorSignals({ competitorId: c.id }).map((s) => `${s.kind}:${s.summary}`);
    expect(kinds()).toEqual(expect.arrayContaining([expect.stringMatching(/^joined:Cara, Founder \(started 2019-01\) · senior · newly listed, started earlier$/), 'hiring:Head of TikTok Shop DE · Berlin', 'new_client:Neuro Gum', expect.stringMatching(/^joined:Lena Fischer.*from their website/), expect.stringMatching(/^overlap:Neuro Gum is a Genuine client and on our BD pipeline/)]));
    expect(kinds().some((k) => k.startsWith('left:'))).toBe(false);
    expect(q.listCompetitorPeople(c.id, { includeLeft: true }).find((p) => p.name === 'Ben')!.miss_count).toBe(1);

    // Week 2: Ben missing again → left; Anna's title changed; nothing new on the page.
    week = 2;
    r = await comp.sweep({ useLlm: false });
    expect(kinds()).toEqual(expect.arrayContaining(['left:Ben, Head of Sales · senior', 'title_change:Anna K: Account Manager → Senior Account Manager']));
    expect(q.listCompetitorPeople(c.id).map((p) => p.name).sort()).toEqual(['Anna K', 'Cara']);
    const d = comp.detail(c.id)!;
    expect(d.leavers.map((p) => p.name)).toEqual(['Ben']);
    expect(d.people.find((p) => p.name === 'Anna K')!.prev_title).toBe('Account Manager');
    const view = comp.data().competitors[0];
    expect(view).toMatchObject({ people_active: 2, joined_30d: 2, left_30d: 1, open_jobs: 2, clients: 2, overlap: 2 });
    expect(view.new_signals).toBeGreaterThan(0);

    const sent = await comp.sendDigest();
    expect(sent.sent).toBe(true);
    expect(posted[0].channel).toBe('#bd');
    expect(posted[0].text).toContain('*Genuine* (UK)');
    expect(posted[0].text).toContain('• Left: Ben, Head of Sales · senior');
    expect(comp.data().last_digest_at).not.toBeNull();
    expect(comp.markSeen(c.id)).toBe(view.new_signals);
    expect(comp.data().competitors[0].new_signals).toBe(0);
    expect((await comp.sendDigest({ sinceDays: 0 })).sent).toBe(false);
  });

  it('adds a client by hand with its overlap and keeps going when a source fails', async () => {
    const { q } = setup();
    const apollo = { configured: false } as unknown as ApolloClient;
    const fetchFn = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const comp = new Competitors(q, { apollo, fetchFn, llm: null, slack: { configured: false, post: async () => undefined, channelId: async (c: string) => c } });
    q.setSetting('competitors_channel', '#bd');
    const c = q.createCompetitor({ name: 'AdBaker', domain: 'adbaker.de', markets: ['DE'] });
    const r = await comp.sweep();
    expect(r.swept).toBe(1);
    expect(r.errors.join(' ')).toMatch(/Apollo is not configured/);
    expect(r.errors.join(' ')).toMatch(/HTTP 503/);
    expect(q.getCompetitor(c.id)!.last_error).toMatch(/HTTP 503/);
    const client = comp.addClient(c.id, { brand: 'Waterdrop', market: 'DE', evidence: 'Said on the call', actor: 'Isaac' });
    expect(client.lead_id).not.toBeNull();
    expect(client.confidence).toBe('high');
    expect(q.listCompetitorSignals({ competitorId: c.id }).map((s) => s.kind).sort()).toEqual(['new_client', 'overlap']);
    expect((await comp.sendDigest()).reason).toMatch(/Slack bot is not configured/);
    expect(comp.digestText()).toContain('• New client: Waterdrop (DE) (added by Isaac)');
  });
});
