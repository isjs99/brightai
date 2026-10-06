import { describe, expect, it } from 'vitest';
import { Queries } from '../src/db/queries';
import { openTestDb } from '../src/db/index';
import { ClientTasks, dueDateFrom, heuristicTasks, parseExtracted } from '../src/tasks/client-tasks';

const acct = (q: Queries) => q.createAccount({ name: 'Nutori', markets: 'ES', am_name: 'Ana', aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: '#ext-nutori', client_domain: 'nutori.com' });

describe('client tasks', () => {
  it('reads due dates out of the conversation', () => {
    expect(dueDateFrom('can you send the samples by Friday', '2026-10-05')).toBe('2026-10-09'); // Monday → Friday
    expect(dueDateFrom('need this tomorrow please', '2026-10-05')).toBe('2026-10-06');
    expect(dueDateFrom('by 12 October latest', '2026-10-05')).toBe('2026-10-12');
    expect(dueDateFrom('end of month', '2026-10-05')).toBe('2026-10-31');
    expect(dueDateFrom('next week would be fine', '2026-10-05')).toBe('2026-10-16');
    expect(dueDateFrom('thanks for the update', '2026-10-05')).toBeNull();
  });

  it('falls back to pattern matching when Claude is not configured', () => {
    const t = heuristicTasks('Marta: Hi team. Can you send over the Q4 sample plan by Friday? Also thanks for the report. We will share the new creative next week.', '2026-10-05');
    expect(t.map((x) => x.title)).toEqual(['Send over the Q4 sample plan by Friday', 'We will share the new creative next week']);
    expect(t[0].due_date).toBe('2026-10-09');
  });

  it('parses Claude output and fills missing dates from the text', () => {
    const out = parseExtracted('Here you go:\n[{"title":"Send EPR certificate","detail":"Client asked for the EPR certificate by Wednesday.","due_date":null},{"title":"x"}]', '2026-10-05');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'Send EPR certificate', due_date: '2026-10-07' });
  });

  it('turns new client evidence into tasks once, with a dismissed marker when nothing is actionable', async () => {
    const q = new Queries(openTestDb());
    const a = acct(q);
    q.upsertEvidence([
      { account_id: a.id, kind: 'slack', ref: 'C1:2026-10-05', title: 'Slack #ext-nutori on 2026-10-05', text: 'marta: Could you share the updated price list by Thursday?', occurred_at: '2026-10-05T12:00:00.000Z' },
      { account_id: a.id, kind: 'email', ref: 'm2', title: 'Email: Re: shoot', text: 'Thanks a lot, all good here.', occurred_at: '2026-10-04T12:00:00.000Z' },
    ]);
    const ct = new ClientTasks(q, { llm: null });
    const r = await ct.scan({ sinceDays: 30 });
    expect(r.scanned).toBe(2);
    expect(r.added).toBe(1);
    const tasks = q.listClientTasks({ accountId: a.id });
    const real = tasks.filter((t) => t.status === 'open');
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ title: 'Share the updated price list by Thursday', source: 'slack', due_date: '2026-10-08', due_source: 'context' });
    expect(tasks.find((t) => t.source_ref === 'email:m2#0')?.status).toBe('dismissed');
    // Second scan: nothing new.
    expect((await ct.scan({ sinceDays: 30 })).added).toBe(0);
    // Window listing: open tasks always show; a done task shows in the range it was completed.
    q.updateClientTask(real[0].id, { status: 'done', completed_at: '2026-10-06T10:00:00.000Z' });
    expect(q.listClientTasks({ accountId: a.id, from: '2026-10-06', to: '2026-10-06' }).filter((t) => t.status === 'done')).toHaveLength(1);
    expect(q.listClientTasks({ accountId: a.id, from: '2026-11-01', to: '2026-11-02' }).filter((t) => t.status === 'done')).toHaveLength(0);
    const d = ct.data({ from: '2026-10-01', to: '2026-10-31' });
    expect(d.tasks.length).toBeGreaterThan(0);
  });
});
