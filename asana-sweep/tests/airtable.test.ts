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
