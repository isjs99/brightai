import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { LarkDraftJob, generateLarkMessage, larkFacts, pickLarkRecipient, spreadDates } from '../src/bd/lark';

function setup() {
  const q = new Queries(openTestDb());
  // A market with no seeded TikTok Shop contacts, so the test controls who is on file.
  const p = q.createProspect({ shop_name: 'glowlab.pt', brand: 'GlowLab', market: 'PT', category: 'Beauty', gmv_7d: 12000, gmv_total: 15000, currency: 'EUR', products: 14, rating: 4.8, source: 'manual' });
  const manager = q.saveTtsContact({ market: p.market, name: 'Mara Manager', role: 'TSP Partnerships Manager', lark: 'https://applink.larksuite.com/client/chat/open?openId=mara', is_agency_manager: true, notes: 'primary TSP contact' });
  const am = q.saveTtsContact({ market: p.market, name: 'Ana Am', role: 'Account Manager', category: p.category ?? 'Beauty', lark: 'https://applink.larksuite.com/client/chat/open?openId=ana', is_agency_manager: false });
  return { q, p, manager, am };
}

describe('Lark messages', () => {
  it('goes to the AM we know is on the account, else the TSP manager (never a guessed AM)', () => {
    const { q, p, manager, am } = setup();
    const unsure = pickLarkRecipient(q, q.getProspect(p.id)!);
    expect(unsure.confidence).toBe('tsp');
    expect(unsure.contact?.id).toBe(manager.id);
    expect(unsure.reason).toMatch(/TSP manager/);
    q.patchProspect(p.id, { tts_am_contact_id: am.id }, 'Isaac');
    expect(q.getProspect(p.id)!.tts_am_contact_id).toBe(am.id);
    const known = pickLarkRecipient(q, q.getProspect(p.id)!);
    expect(known.confidence).toBe('known');
    expect(known.contact?.id).toBe(am.id);
  });

  it('lists only verifiable facts and the template only uses them', async () => {
    const { q, p } = setup();
    const facts = larkFacts(q.getProspect(p.id)!);
    expect(facts[0]).toMatch(/^Brand: /);
    expect(facts.some((f) => f.startsWith('Market: '))).toBe(true);
    expect(facts.some((f) => /not contacted|We emailed/.test(f))).toBe(true);
    const r = pickLarkRecipient(q, q.getProspect(p.id)!);
    const g = await generateLarkMessage(q, q.getProspect(p.id)!, r);
    expect(g.generator).toBe('template');
    expect(g.body).toContain('Hi Mara');
    expect(g.body).toMatch(/who the AM is/);
    expect(g.facts).toEqual(facts);
  });

  it('spreads messages across days, skipping weekends when asked', () => {
    // 2026-10-02 is a Friday
    expect(spreadDates(5, 2, '2026-10-02', true)).toEqual(['2026-10-02', '2026-10-02', '2026-10-05', '2026-10-05', '2026-10-06']);
    expect(spreadDates(3, 1, '2026-10-02', false)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
    expect(spreadDates(0, 5, '2026-10-02', true)).toEqual([]);
  });

  it('drafts in bulk, skips shops that already have one, and stores the facts', async () => {
    const { q, p } = setup();
    const job = new LarkDraftJob(q, async (_q, prospect, r) => ({ body: `Hi ${r.contact?.name}, about ${prospect.shop_name}`, generator: 'claude' as const, facts: ['Brand: x'] }));
    job.start([p.id, 999999], { actor: 'Isaac' });
    await new Promise((res) => setTimeout(res, 50));
    expect(job.state.running).toBe(false);
    expect(job.state.drafted).toBe(1);
    const msgs = q.listLarkMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].contact_name).toBe('Mara Manager');
    expect(msgs[0].contact_lark).toMatch(/^https:/);
    expect(msgs[0].facts).toEqual(['Brand: x']);
    expect(msgs[0].created_by).toBe('Isaac');
    job.start([p.id], { actor: 'Isaac' });
    await new Promise((res) => setTimeout(res, 20));
    expect(q.listLarkMessages()).toHaveLength(1);
    job.start([p.id], { actor: 'Isaac', redo: true });
    await new Promise((res) => setTimeout(res, 50));
    expect(q.listLarkMessages()).toHaveLength(2);
  });

  it('edits, schedules, marks sent and discards through the queries', () => {
    const { q, p, manager } = setup();
    const m = q.createLarkMessage({ prospect_id: p.id, contact_id: manager.id, confidence: 'tsp', reason: 'r', body: 'Hi', facts: ['a'], generator: 'template', created_by: 'Isaac' });
    expect(q.updateLarkMessage(m.id, { body: 'Hi there', status: 'scheduled', scheduled_for: '2026-10-05' })).toMatchObject({ body: 'Hi there', status: 'scheduled', scheduled_for: '2026-10-05' });
    expect(q.updateLarkMessage(m.id, { status: 'sent', sent_at: '2026-10-05T09:00:00Z', sent_by: 'Isaac' })!.sent_by).toBe('Isaac');
    expect(q.listLarkMessages()[0].status).toBe('sent');
    expect(q.updateLarkMessage(m.id, { status: 'discarded' })!.status).toBe('discarded');
    expect(q.listLarkMessages()).toHaveLength(0);
    expect(q.listLarkMessages({ includeDiscarded: true })).toHaveLength(1);
    expect(q.deleteLarkMessage(m.id)).toBe(true);
    expect(q.getLarkMessage(m.id)).toBeNull();
  });
});
