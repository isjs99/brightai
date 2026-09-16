import { describe, it, expect } from 'vitest';
import { isSignedStage, leadsFromCsv, matchPerson, parseCsv, parseMoney, parseSheetDate } from '../src/leads/sheet';
import { amSummary } from '../src/leads/points';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import type { Lead, Person } from '../src/sweep/types';

const CSV = `"","","","","","","","","","",""
"Client Name","POC","Stage","Country","Last Contact","Notes","Est. Value P/M","@dropdown","Priorities","",""
"Honor","","Proposal Sent","Germany","","Chase","5,900","","","",""
"Marble","Anna, Ops","Contract Signed","Germany","","Send ""the"" contract","3,500","","","Close Rate of Lead List",""
"Nestle","","Pre-Contact & TikTok Vouched","","","Big G","25000","","Sofia Brian","",""
"","","","","","","","","","14.44%",""
"Cetaphil","","","","","","","","","",""
`;

describe('lead sheet parsing', () => {
  it('parses quoted CSV with escaped quotes', () => {
    expect(parseCsv('a,"b ""c""",d\r\n1,2,3\n')).toEqual([['a', 'b "c"', 'd'], ['1', '2', '3']]);
  });

  it('finds the header row, ignores summary cells and rows without a name', () => {
    const { leads, columns } = leadsFromCsv(CSV);
    expect(leads.map((l) => l.name)).toEqual(['Honor', 'Marble', 'Nestle', 'Cetaphil']);
    expect(leads[0].est_value).toBe(5900);
    expect(leads[1].notes).toBe('Send "the" contract');
    expect(leads[1].poc).toBe('Anna, Ops');
    expect(leads[2].priority).toBe('Sofia Brian');
    expect(columns).toContain('stage');
    expect(columns).not.toContain('sourced_by');
  });

  it('picks up optional sourced-by / onboarding columns', () => {
    const { leads } = leadsFromCsv('Client Name,Stage,Sourced By,Onboarding AM\nAcme,Contract Signed,Feds,Elena\n');
    expect(leads[0].sourced_by).toBe('Feds');
    expect(leads[0].onboarding).toBe('Elena');
  });

  it('parses money and stages', () => {
    expect(parseMoney('£5,517.92')).toBe(5517.92);
    expect(parseMoney('3500')).toBe(3500);
    expect(parseMoney('')).toBeNull();
    expect(isSignedStage('Contract Signed')).toBe(true);
    expect(isSignedStage('Proposal Sent')).toBe(false);
    expect(isSignedStage(null)).toBe(false);
  });

  it('parses sheet dates as ISO, EU day-first, or US when unambiguous', () => {
    expect(parseSheetDate('2026-09-16')).toBe('2026-09-16');
    expect(parseSheetDate('2026-9-6')).toBe('2026-09-06');
    expect(parseSheetDate('16/09/2026')).toBe('2026-09-16');
    expect(parseSheetDate('09/16/2026')).toBe('2026-09-16');
    expect(parseSheetDate('3/4/26')).toBe('2026-04-03');
    expect(parseSheetDate('16.09.2026')).toBe('2026-09-16');
    expect(parseSheetDate('32/13/2026')).toBeNull();
    expect(parseSheetDate('')).toBeNull();
    expect(parseSheetDate('nonsense')).toBeNull();
  });

  it('reads a date-added column', () => {
    const { leads } = leadsFromCsv('Client Name,Stage,Date Added\nAcme,Proposal Sent,01/09/2026\nBeta,In Contact,\n');
    expect(leads[0].added_on).toBe('2026-09-01');
    expect(leads[1].added_on).toBeNull();
  });

  it('matches sheet names to people loosely', () => {
    const people = [{ id: 1, name: 'Federica' }, { id: 2, name: 'Elena' }];
    expect(matchPerson('Feds', people)?.id).toBe(1);
    expect(matchPerson('elena', people)?.id).toBe(2);
    expect(matchPerson('Nobody', people)).toBeNull();
  });
});

describe('lead upserts', () => {
  const setup = () => {
    const q = new Queries(openTestDb());
    const people = q.listPeople();
    return { q, people };
  };

  it('inserts, updates, stamps signed_at once and marks vanished rows removed', () => {
    const { q, people } = setup();
    const fed = people.find((p) => p.name === 'Federica')!;
    const r1 = q.upsertLeads(leadsFromCsv('Client Name,Stage,Onboarding AM\nAcme,Proposal Sent,Feds\nBeta,In Contact,\n').leads, '2026-09-01T00:00:00.000Z');
    expect(r1).toMatchObject({ added: 2, updated: 0, removed: 0, newly_signed: [] });
    let acme = q.listLeads().find((l) => l.name === 'Acme')!;
    expect(acme.onboarding_id).toBe(fed.id);
    expect(acme.signed).toBe(false);

    const r2 = q.upsertLeads(leadsFromCsv('Client Name,Stage\nAcme,Contract Signed\n').leads, '2026-09-02T00:00:00.000Z');
    expect(r2).toMatchObject({ added: 0, updated: 1, removed: 1, newly_signed: ['Acme'] });
    acme = q.listLeads().find((l) => l.name === 'Acme')!;
    expect(acme.signed).toBe(true);
    expect(acme.signed_at).toBe('2026-09-02T00:00:00.000Z');
    expect(acme.onboarding_id).toBe(fed.id); // dashboard assignment survives a sheet without that column
    expect(q.listLeads().map((l) => l.name)).toEqual(['Acme']);
    expect(q.listLeads(true).find((l) => l.name === 'Beta')!.removed_at).not.toBeNull();

    q.upsertLeads(leadsFromCsv('Client Name,Stage\nAcme,Contract Signed\n').leads, '2026-09-03T00:00:00.000Z');
    expect(q.listLeads()[0].signed_at).toBe('2026-09-02T00:00:00.000Z');
  });

  it('stamps added_on from the sheet when present, else first seen, and lets admins override it', () => {
    const { q } = setup();
    q.upsertLeads(leadsFromCsv('Client Name,Stage,Date Added\nAcme,Proposal Sent,20/08/2026\nBeta,In Contact,\n').leads, '2026-09-01T00:00:00.000Z');
    const byName = () => Object.fromEntries(q.listLeads().map((l) => [l.name, l]));
    expect(byName().Acme.added_on).toBe('2026-08-20');
    expect(byName().Beta.added_on).toBe('2026-09-01');
    // a later sync without the column keeps the dates
    q.upsertLeads(leadsFromCsv('Client Name,Stage\nAcme,Proposal Sent\nBeta,In Contact\n').leads, '2026-09-05T00:00:00.000Z');
    expect(byName().Acme.added_on).toBe('2026-08-20');
    expect(byName().Beta.added_on).toBe('2026-09-01');
    const beta = q.patchLead(byName().Beta.id, { added_on: '2026-07-15' })!;
    expect(beta.added_on).toBe('2026-07-15');
    // the sheet wins again next sync when it carries a date
    q.upsertLeads(leadsFromCsv('Client Name,Stage,Date Added\nAcme,Proposal Sent,20/08/2026\nBeta,In Contact,2026-07-01\n').leads, '2026-09-06T00:00:00.000Z');
    expect(byName().Beta.added_on).toBe('2026-07-01');
  });
});

describe('AM points', () => {
  const lead = (o: Partial<Lead>): Lead => ({ id: 1, name: 'x', poc: null, stage: null, country: null, last_contact: null, notes: null, est_value: null, priority: null, row_no: 1, sourced_by_id: null, sourced_by_name: null, onboarding_id: null, onboarding_name: null, signed: false, signed_at: null, first_seen_at: '', last_seen_at: '', removed_at: null, updated_at: '', added_on: null, ...o });
  const people: Person[] = [{ id: 1, name: 'Elena', role: 'am', email: null, slack_user_id: null, notify: true }, { id: 2, name: 'Federica', role: 'am', email: null, slack_user_id: null, notify: true }];

  it('scores signed deals for onboarding and sourcing AMs, ignoring removed leads', () => {
    const leads = [
      lead({ id: 1, onboarding_id: 1, sourced_by_id: 2, signed: true, est_value: 3000 }),
      lead({ id: 2, onboarding_id: 1, signed: false, est_value: 1000 }),
      lead({ id: 3, onboarding_id: 2, sourced_by_id: 2, signed: true, est_value: 500, removed_at: '2026-01-01' }),
    ];
    const rows = amSummary(leads, people, { points_signed: 1, points_sourced: 0.5 });
    expect(rows[0]).toMatchObject({ name: 'Elena', points: 1, onboarding_total: 2, onboarding_signed: 1, signed_value: 3000, pipeline_value: 1000 });
    expect(rows[1]).toMatchObject({ name: 'Federica', points: 0.5, sourced_total: 1, sourced_signed: 1 });
  });
});
