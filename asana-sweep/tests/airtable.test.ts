import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { AirtableClient, AirtableMirror, primaryOf, type Fetcher } from '../src/airtable/index';

/** A fake api.airtable.com with the real shape of Sofía's base: Deals linked to Accounts and Contacts, paged, with modified times. */
const SCHEMA = { tables: [
  { id: 'tblDeals', name: 'Deals', primaryFieldId: 'fldName', fields: [{ id: 'fldName', name: 'Deal name', type: 'singleLineText' }, { id: 'fldStage', name: 'Stage', type: 'singleSelect' }, { id: 'fldAcc', name: 'Account', type: 'multipleRecordLinks' }, { id: 'fldCon', name: 'Contacts', type: 'multipleRecordLinks' }, { id: 'fldMod', name: 'Last modified', type: 'lastModifiedTime' }, { id: 'fldUrg', name: 'Urgency', type: 'formula' }, { id: 'fldNeed', name: 'What they need', type: 'multilineText' }] },
  { id: 'tblAcc', name: 'Accounts', primaryFieldId: 'fldAName', fields: [{ id: 'fldAName', name: 'Account name', type: 'singleLineText' }, { id: 'fldBrief', name: 'Account brief', type: 'multilineText' }] },
  { id: 'tblCon', name: 'Contacts', primaryFieldId: 'fldCName', fields: [{ id: 'fldCName', name: 'Full name', type: 'singleLineText' }, { id: 'fldEmail', name: 'Email', type: 'email' }] },
] };
function fakeAirtable(state: { deals: Record<string, unknown>[]; calls: string[] }): Fetcher {
  const ok = (body: unknown) => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  return async (url) => {
    state.calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/meta/bases')) return ok({ bases: [{ id: 'appTEST', name: 'Brightform Leads Pipeline', permissionLevel: 'create' }] });
    if (u.pathname.endsWith('/tables')) return ok(SCHEMA);
    if (u.pathname.endsWith('/tblAcc')) return ok({ records: [{ id: 'recA1', createdTime: '2026-09-01T00:00:00.000Z', fields: { 'Account name': 'Suntory', 'Account brief': 'Decides in Düsseldorf; Genuine introduced by Gerard.' } }] });
    if (u.pathname.endsWith('/tblCon')) return ok({ records: [{ id: 'recC1', createdTime: '2026-09-01T00:00:00.000Z', fields: { 'Full name': 'Anna Beispiel', Email: 'anna@suntory.example' } }] });
    if (u.pathname.endsWith('/tblDeals')) {
      const filter = u.searchParams.get('filterByFormula');
      const since = filter?.match(/DATETIME_PARSE\('([^']+)'\)/)?.[1] ?? null;
      const rows = state.deals.filter((d) => !since || String((d.fields as Record<string, unknown>)['Last modified']) > since);
      const offset = u.searchParams.get('offset');
      if (!offset && rows.length > 1) return ok({ records: rows.slice(0, 1), offset: 'page2' });
      return ok({ records: offset ? rows.slice(1) : rows });
    }
    return { status: 404, json: async () => ({}), text: async () => 'nope' };
  };
}

describe('the Airtable mirror', () => {
  it('pulls the schema and every page, resolves links, syncs only what changed afterwards, and prunes on a full sync', async () => {
    const q = new Queries(openTestDb());
    q.setSetting('airtable_base_id', 'appTEST');
    const state = { calls: [] as string[], deals: [
      { id: 'recD1', createdTime: '2026-09-01T00:00:00.000Z', fields: { 'Deal name': 'Suntory · DE', Stage: 'Proposal sent', Account: ['recA1'], Contacts: ['recC1'], 'Last modified': '2026-10-01T10:00:00.000Z', Urgency: '🔴 Urgent', 'What they need': 'Creators for a Q4 launch' } },
      { id: 'recD2', createdTime: '2026-09-02T00:00:00.000Z', fields: { 'Deal name': 'Old Brand · ES', Stage: 'Closed lost', 'Last modified': '2026-09-20T10:00:00.000Z' } },
    ] };
    const mirror = new AirtableMirror(q, new AirtableClient('pat-test', fakeAirtable(state), 0));
    const first = await mirror.sync({ full: true });
    expect(first).toMatchObject({ tables: 3, records: 4, removed: 0, errors: [] });
    expect(state.calls.some((c) => c.includes('offset=page2'))).toBe(true); // paged
    const d = mirror.data();
    expect(d.base_name).toBe('Brightform Leads Pipeline');
    expect(d.tables.map((t) => [t.name, t.records])).toEqual([['Accounts', 1], ['Contacts', 1], ['Deals', 2]]);
    const { rows, total } = mirror.records('tblDeals', { q: 'suntory' });
    expect(total).toBe(1);
    expect(rows[0].primary).toBe('Suntory · DE');
    expect(rows[0].resolved).toEqual({ Account: ['Suntory'], Contacts: ['Anna Beispiel'] });
    expect(rows[0].modified_at).toBe('2026-10-01T10:00:00.000Z');
    // The deal view joins the account, contacts and activities.
    const deal = mirror.deal('suntory') as Record<string, unknown>;
    expect(deal.Stage).toBe('Proposal sent');
    expect(deal.Account).toEqual(['Suntory']);
    expect((deal.account as { 'Account brief': string }[])[0]['Account brief']).toMatch(/Genuine/);
    expect((deal.contacts as { Email: string }[])[0].Email).toBe('anna@suntory.example');
    expect(deal.url).toBe('https://airtable.com/appTEST/tblDeals/recD1');
    expect(mirror.deal('nobody')).toBeNull();
    // Search finds the field that matched.
    const hits = mirror.search('Q4 launch');
    expect(hits).toHaveLength(1); expect(hits[0]).toMatchObject({ table: 'Deals', primary: 'Suntory · DE', snippet: 'What they need: Creators for a Q4 launch' });
    // Incremental: the next sync asks only for records modified since the last pull, and the old deal is not refetched.
    state.calls.length = 0;
    (state.deals[0].fields as Record<string, unknown>).Stage = 'Negotiation'; (state.deals[0].fields as Record<string, unknown>)['Last modified'] = new Date(Date.now() + 1000).toISOString();
    const second = await mirror.sync();
    expect(second.records).toBe(3); // one changed deal plus the two small tables (no modified field, so every row)
    expect(state.calls.find((c) => c.includes('/tblDeals'))).toMatch(/filterByFormula=IS_AFTER%28LAST_MODIFIED_TIME%28%29/);
    expect(mirror.records('tblDeals').rows.find((r) => r.record_id === 'recD1')?.fields.Stage).toBe('Negotiation');
    expect(mirror.records('tblDeals').total).toBe(2);
    // A record deleted in Airtable goes on the next full sync.
    state.deals.pop();
    const third = await mirror.sync({ full: true });
    expect(third.removed).toBe(1);
    expect(mirror.records('tblDeals').total).toBe(1);
    expect(primaryOf(SCHEMA.tables[0], { 'Deal name': ['a', { name: 'b' }] })).toBe('a, b');
  });

  it('refuses without a token and reports an API error per table without stopping the others', async () => {
    const q = new Queries(openTestDb());
    q.setSetting('airtable_base_id', 'appTEST');
    await expect(new AirtableMirror(q, new AirtableClient('', fakeAirtable({ deals: [], calls: [] }), 0)).sync()).rejects.toThrow(/AIRTABLE_TOKEN/);
    const broken: Fetcher = async (url, init) => { const u = new URL(url); if (u.pathname.endsWith('/tblDeals')) return { status: 403, json: async () => ({}), text: async () => '{"error":"NOT_AUTHORIZED"}' }; return fakeAirtable({ deals: [], calls: [] })(url, init); };
    const mirror = new AirtableMirror(q, new AirtableClient('pat', broken, 0));
    const r = await mirror.sync({ full: true });
    expect(r.tables).toBe(2);
    expect(r.errors).toEqual(['Deals: Airtable 403: {"error":"NOT_AUTHORIZED"}']);
    expect(mirror.data().tables.find((t) => t.name === 'Deals')?.error).toMatch(/403/);
    expect(mirror.data().last_error).toMatch(/Deals: Airtable 403/);
  });
});

describe('matching her base to our pipeline', () => {
  const SCHEMA2 = { tables: [
    { id: 'tblAcc', name: 'Accounts', primaryFieldId: 'fA', fields: [{ id: 'fA', name: 'Account name', type: 'singleLineText' }, { id: 'fD', name: 'Email domains', type: 'multilineText' }, { id: 'fW', name: 'Website', type: 'url' }, { id: 'fDeals', name: 'Deals', type: 'multipleRecordLinks' }, { id: 'fT', name: 'TikTok Shop status', type: 'singleSelect' }] },
    { id: 'tblDeals', name: 'Deals', primaryFieldId: 'fN', fields: [{ id: 'fN', name: 'Deal name', type: 'singleLineText' }, { id: 'fS', name: 'Stage', type: 'singleSelect' }, { id: 'fAS', name: 'Action state', type: 'singleSelect' }, { id: 'fAcc', name: 'Account', type: 'multipleRecordLinks' }, { id: 'fO', name: 'Owner', type: 'multipleRecordLinks' }, { id: 'fNA', name: 'Next action', type: 'singleLineText' }] },
    { id: 'tblTI', name: 'Target Intelligence', primaryFieldId: 'fTg', fields: [{ id: 'fTg', name: 'Target', type: 'singleLineText' }, { id: 'fCS', name: 'CRM status', type: 'singleSelect' }] },
    { id: 'tblCon', name: 'Contacts', primaryFieldId: 'fC', fields: [{ id: 'fC', name: 'Full name', type: 'singleLineText' }, { id: 'fE', name: 'Email', type: 'email' }, { id: 'fCA', name: 'Account', type: 'multipleRecordLinks' }] },
    { id: 'tblTeam', name: 'Team', primaryFieldId: 'fTN', fields: [{ id: 'fTN', name: 'Name', type: 'singleLineText' }] },
  ] };
  const RECORDS: Record<string, { id: string; createdTime: string; fields: Record<string, unknown> }[]> = {
    tblAcc: [
      { id: 'recAcc1', createdTime: '2026-09-01T00:00:00.000Z', fields: { 'Account name': 'Kijimea GmbH', 'Email domains': 'kijimea.de\nsynformulas.com', Website: 'https://www.kijimea.de/', Deals: ['recDeal1'], 'TikTok Shop status': 'Live' } },
      { id: 'recAcc2', createdTime: '2026-09-01T00:00:00.000Z', fields: { 'Account name': 'Bears with Benefits', Deals: [] } },
      { id: 'recAcc3', createdTime: '2026-09-01T00:00:00.000Z', fields: { 'Account name': 'Nova Labs', Deals: [] } },
    ],
    tblDeals: [
      { id: 'recDeal1', createdTime: '2026-09-01T00:00:00.000Z', fields: { 'Deal name': 'Kijimea · DE', Stage: 'Proposal sent', 'Action state': 'Waiting on client', Account: ['recAcc1'], Owner: ['recTeam1'], 'Next action': 'Chase on Friday' } },
      { id: 'recDeal2', createdTime: '2026-09-01T00:00:00.000Z', fields: { 'Deal name': 'Sunday Natural · DE', Stage: 'First contact' } },
    ],
    tblTI: [{ id: 'recTI1', createdTime: '2026-09-01T00:00:00.000Z', fields: { Target: 'Beauty Pie', 'CRM status': 'Not contacted' } }],
    tblCon: [{ id: 'recCon1', createdTime: '2026-09-01T00:00:00.000Z', fields: { 'Full name': 'Ben Bär', Email: 'ben@bearswithbenefits.com', Account: ['recAcc2'] }, }],
    tblTeam: [{ id: 'recTeam1', createdTime: '2026-09-01T00:00:00.000Z', fields: { Name: 'Sofía' } }],
  };
  const fetcher: Fetcher = async (url) => {
    const ok = (body: unknown) => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const u = new URL(url);
    if (u.pathname.endsWith('/meta/bases')) return ok({ bases: [] });
    if (u.pathname.endsWith('/tables')) return ok(SCHEMA2);
    const table = u.pathname.split('/').pop() ?? '';
    if (RECORDS[table]) return ok({ records: RECORDS[table] });
    return { status: 404, json: async () => ({}), text: async () => 'nope' };
  };

  it('labels prospects and leads that are in her base, by domain or brand name, keeps loose matches for review, and never adds rows', async () => {
    const q = new Queries(openTestDb());
    q.setSetting('airtable_base_id', 'appTEST');
    const before = q.listProspects(false).length;
    const kiji = q.createProspect({ shop_name: 'KIJIMEA Official Shop', market: 'DE', website: 'https://kijimea.de' }); // domain + name
    const bears = q.createProspect({ shop_name: 'BWB TikTok', market: 'DE' }); // only the decision maker's email ties it
    q.addContact(bears.id, { name: 'Ben Bär', email: 'ben@bearswithbenefits.com' });
    const sunday = q.createProspect({ shop_name: 'Sunday Natural Products GmbH', market: 'DE' }); // "sunday natural" inside "sunday natural products" → review
    const nova = q.createProspect({ shop_name: 'Supernova', market: 'FR' }); // "nova" is too short to match "nova labs"
    const other = q.createProspect({ shop_name: 'Unrelated Brand', market: 'ES' });
    q.upsertLeads([{ name: 'Beauty Pie', poc: null, stage: 'Intro call', country: 'UK', last_contact: null, notes: null, est_value: null, priority: null, sourced_by: null, onboarding: null, added_on: null, row_no: 1 }, { name: 'Nobody Ltd', poc: null, stage: null, country: null, last_contact: null, notes: null, est_value: null, priority: null, sourced_by: null, onboarding: null, added_on: null, row_no: 2 }]);
    const mirror = new AirtableMirror(q, new AirtableClient('pat', fetcher, 0));
    await mirror.sync({ full: true });
    // The sync matched on its own.
    const d = mirror.data();
    const mine = new Set([kiji.id, bears.id, sunday.id, nova.id, other.id]);
    const seeded = Object.entries(mirror.linksFor('prospect')).filter(([id, ls]) => !mine.has(Number(id)) && ls.some((l) => l.status === 'auto')).length; // the seeded Kijimea shop matches too
    expect(d.matches).toMatchObject({ prospects: 2 + seeded, leads: 1, review: 1 });
    expect(q.listProspects(false).length).toBe(before + 5); // nothing created from Airtable
    expect(q.listLeads(false).length).toBe(2);
    const crm = mirror.linksFor('prospect');
    const k = crm[kiji.id];
    expect(k.map((l) => [l.table, l.primary, l.status])).toEqual([['Deals', 'Kijimea · DE', 'auto'], ['Accounts', 'Kijimea GmbH', 'auto']]);
    expect(k[0]).toMatchObject({ stage: 'Proposal sent', detail: 'Waiting on client', owner: 'Sofía', next_action: 'Chase on Friday', url: 'https://airtable.com/appTEST/tblDeals/recDeal1' });
    expect(k[1].how).toMatch(/same domain kijimea\.de/);
    expect(crm[bears.id].map((l) => [l.table, l.how])).toEqual([['Accounts', 'same domain bearswithbenefits.com']]);
    expect(crm[sunday.id]).toHaveLength(1);
    expect(crm[sunday.id][0]).toMatchObject({ table: 'Deals', status: 'review', confidence: 0.6, local_name: 'Sunday Natural Products GmbH' });
    expect(crm[nova.id]).toBeUndefined();
    expect(crm[other.id]).toBeUndefined();
    const leads = mirror.linksFor('lead');
    expect(Object.values(leads).flat().map((l) => [l.local_name, l.table, l.stage])).toEqual([['Beauty Pie', 'Target Intelligence', 'Not contacted']]);
    expect(d.review.map((l) => l.local_name)).toEqual(['Sunday Natural Products GmbH']);
    // A person settles the loose one; the next pass leaves their answer alone. A rejected label stays gone.
    const sundayLink = crm[sunday.id][0];
    expect(mirror.setLinkStatus(sundayLink.id, 'confirmed')?.status).toBe('confirmed');
    expect(mirror.match()).toMatchObject({ prospects: 3 + seeded, review: 0, changed: 0 });
    expect(mirror.linksFor('prospect')[sunday.id][0].status).toBe('confirmed');
    mirror.setLinkStatus(k[1].id, 'rejected');
    mirror.match();
    expect(mirror.linksFor('prospect')[kiji.id].map((l) => l.table)).toEqual(['Deals']);
    expect(mirror.data().matches.prospects).toBe(3 + seeded);
    // A prospect added later is picked up by the next pass; one removed loses its links.
    const late = q.createProspect({ shop_name: 'Beauty Pie', market: 'UK' });
    expect(mirror.match().changed).toBe(1);
    expect(mirror.linksFor('prospect')[late.id][0]).toMatchObject({ table: 'Target Intelligence', how: 'same name "beauty pie"' });
  });

  it('normalises brand names and domains the way the pipeline writes them', async () => {
    const { nameKey, domainKey } = await import('../src/airtable/match');
    expect(nameKey('Kijimea · DE')).toBe('kijimea');
    expect(nameKey('KIJIMEA GmbH')).toBe('kijimea');
    expect(nameKey('kijimea_official')).toBe('kijimea');
    expect(nameKey('Bears with Benefits Official Store')).toBe('bears with benefits');
    expect(nameKey('Beauty Pie')).toBe('beauty pie');
    expect(nameKey('Berlin Brands Group')).toBe('berlin brands');
    expect(nameKey('Sunday Natural (Germany)')).toBe('sunday natural');
    expect(nameKey('DE')).toBe('');
    expect(domainKey('https://www.Kijimea.de/shop?x=1')).toBe('kijimea.de');
    expect(domainKey('Ben@BearsWithBenefits.com')).toBe('bearswithbenefits.com');
    expect(domainKey('someone@gmail.com')).toBe('');
    expect(domainKey('not a domain')).toBe('');
  });
});
