import { describe, expect, it } from 'vitest';
import { Queries } from '../src/db/queries';
import { openTestDb } from '../src/db/index';
import { Targets, gatherTargetContext, parseTargetJson, rulesAnalysis, stageOf } from '../src/onboarding/targets';
import { Onboardings, defaultSteps } from '../src/onboarding/steps';
import type { Lead } from '../src/sweep/types';

const lead = (over: Partial<Lead> = {}): Lead => ({ id: 1, name: 'Neuro Gum', poc: 'Ognen', stage: 'Proposal sent', country: 'DE', last_contact: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10), notes: 'neurogum.com', est_value: 4000, priority: 'A', row_no: 1, added_on: '2026-09-28', sourced_by_id: null, sourced_by_name: null, onboarding_id: null, onboarding_name: null, signed: false, signed_at: null, first_seen_at: '2026-09-28T10:00:00.000Z', last_seen_at: '2026-10-05T10:00:00.000Z', removed_at: null, updated_at: '2026-10-05T10:00:00.000Z', ...over });

describe('targets', () => {
  it('maps lead stages to progress and next steps', () => {
    expect(stageOf('Proposal sent')).toMatchObject({ pct: 60, label: 'Proposal sent' });
    expect(stageOf('Negotiating MoR terms').pct).toBe(80);
    expect(stageOf('Signed').pct).toBe(100);
    expect(stageOf('Closed lost').lost).toBe(true);
    expect(stageOf(null).pct).toBe(0);
  });

  it('rates a deal with the rules and keeps internal calls out of the context', () => {
    const q = new Queries(openTestDb());
    q.upsertEvidence([
      { account_id: null, kind: 'call', ref: 'c1', title: 'Brightform DE x Neuro', text: 'Ognen asked for the proposal and the P&L forecast for neurogum.com by Friday.', occurred_at: '2026-10-01T12:00:00.000Z' },
      { account_id: null, kind: 'call', ref: 'c2', title: 'Founders weekly catch-up', text: 'Private discussion that mentions Neuro Gum in passing, Neuro Gum, Neuro Gum.', occurred_at: '2026-10-02T12:00:00.000Z' },
      { account_id: null, kind: 'email', ref: 'e1', title: 'Email: Re: Neuro Gum proposal', text: 'Hi Isaac, thanks for the deck. Pricing looks fine, legal will review the contract next week.', occurred_at: '2026-10-03T12:00:00.000Z' },
    ]);
    const ctx = gatherTargetContext(q, lead());
    expect(ctx.sources.some((s) => s.title.includes('Founders weekly'))).toBe(false);
    expect(ctx.sources.map((s) => s.kind).sort()).toEqual(['call', 'email']);
    const a = rulesAnalysis(lead(), ctx);
    expect(a).toMatchObject({ light: 'green', progress_pct: 60, stage_label: 'Proposal sent', generator: 'rules' });
    expect(a.blockers).toContain('No AM assigned to handle the deal');
    const stale = rulesAnalysis(lead({ last_contact: '2026-08-01' }), { sources: [], prospect: null });
    expect(stale.light).toBe('red');
    expect(stale.blockers.some((b) => /No contact for/.test(b))).toBe(true);
    const parsed = parseTargetJson('{"progress_pct": 72, "light": "amber", "summary": "Legal review next week.", "next_steps": ["Chase legal on Tuesday"], "blockers": [], "signals": ["Pricing accepted 3 Oct"]}', a);
    expect(parsed).toMatchObject({ progress_pct: 72, light: 'amber', generator: 'claude', next_steps: ['Chase legal on Tuesday'] });
    expect(parseTargetJson('garbage', a)).toBe(a);
  });

  it('lists the month, assigns the AM, and moves a ready deal into onboarding with the terms applied on completion', async () => {
    const q = new Queries(openTestDb());
    const db = (q as unknown as { db: import('better-sqlite3').Database }).db;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO leads (key, name, poc, stage, country, last_contact, notes, est_value, priority, row_no, first_seen_at, last_seen_at, updated_at, added_on) VALUES ('neuro', 'Neuro Gum', 'Ognen', 'Proposal sent', 'DE', ?, 'neurogum.com', 4000, 'A', 1, ?, ?, ?, ?)").run(now.slice(0, 10), now, now, now, now.slice(0, 10));
    db.prepare("INSERT INTO leads (key, name, stage, country, first_seen_at, last_seen_at, updated_at, removed_at) VALUES ('old', 'Old Brand', 'Closed lost', 'UK', '2026-05-01T00:00:00.000Z', '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z')").run();
    const person = q.listPeople()[0] ?? q.createPerson({ name: 'Ana', role: 'am', email: null, slack_user_id: null, notify: true });
    const t = new Targets(q, { llm: null });
    const r = await t.refresh();
    expect(r.analysed).toBe(1);
    const d = t.data(now.slice(0, 7), 'Isaac');
    const row = d.rows.find((x) => x.lead.name === 'Neuro Gum')!;
    expect(row.analysis?.stage_label).toBe('Proposal sent');
    expect(row.is_new).toBe(true);
    expect(d.rows.some((x) => x.lead.name === 'Old Brand')).toBe(false);
    expect(t.data('2026-05', 'Isaac').rows.find((x) => x.lead.name === 'Old Brand')?.closed_in_month).toBe('lost');
    q.saveTargetState(row.lead.id, { am_person_id: person.id });
    expect(t.data(undefined, 'Isaac').rows[0].am_name).toBe(person.name);
    const onb = new Onboardings(q);
    const o = onb.start({ lead: row.lead, am_person_id: person.id, actor: 'Isaac' });
    q.saveTargetState(row.lead.id, { status: 'ready', ready_at: now, ready_by: 'Isaac' });
    expect(o.steps.length).toBe(defaultSteps().length);
    expect(o.context.poc).toBe('Ognen');
    expect(onb.start({ lead: row.lead }).id).toBe(o.id); // idempotent
    expect(t.data(undefined, 'Isaac').rows.find((x) => x.lead.id === row.lead.id)).toMatchObject({ status: 'ready', onboarding_id: o.id });
    expect(() => onb.complete(o.id, 'Isaac')).toThrow(/still open/);
    for (const s of o.steps) onb.tick(o.id, s.key, true, 'Ana');
    onb.setTerms(o.id, { retainer: 2750, commission_pct: 5, commission_basis: 'gmv', markets: 'DE' });
    const done = onb.complete(o.id, 'Isaac');
    expect(done.status).toBe('done');
    const account = q.listAccounts().find((a) => a.name === 'Neuro Gum')!;
    expect(account).toMatchObject({ commission_pct: 5, commission_basis: 'gmv', markets: 'DE', am_name: person.name });
    expect(q.getOnboarding(o.id)?.account_id).toBe(account.id);
    expect(q.latestPnlInputs(account.id, '9999-12')?.agency_fee).toBe(2750);
    const custom = onb.addStep(o.id, '6. Launch', 'Shoot launch creative', null);
    expect(custom.steps.find((s) => s.custom)?.group).toBe('6. Launch');
    expect(onb.removeStep(o.id, custom.steps.find((s) => s.custom)!.key).steps.some((s) => s.custom)).toBe(false);
  });
});
