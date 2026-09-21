import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { checkAccount, refreshLive } from '../src/checklist/checker';
import { CHECKLIST_TEMPLATE } from '../src/checklist/template';
import { isDue } from '../src/checklist/evaluate';

const TZ = 'Europe/Madrid';
const account = (q: Queries, name = 'GreatVita') => q.createAccount({ name, markets: 'DE', am_name: 'Elena', aa_name: 'DM', enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });

describe('native checklist', () => {
  it('seeds the template from the Asana boards: 14 sections with their action items', () => {
    const q = new Queries(openTestDb());
    const tpl = q.listTemplateItems();
    const tops = tpl.filter((i) => i.parent_id === null);
    expect(tops).toHaveLength(CHECKLIST_TEMPLATE.length);
    expect(tops.map((t) => t.name)).toContain('Cruva - AM daily checks');
    expect(tpl.filter((i) => i.parent_id !== null).length).toBe(CHECKLIST_TEMPLATE.reduce((n, t) => n + t.subtasks.length, 0));
    const weekly = tpl.find((i) => i.name === 'Affiliate - AM weekly checks')!;
    expect(weekly.frequency).toBe('weekly');
    expect(weekly.weekday).toBe(1);
    expect(weekly.role).toBe('aa');
    expect(tpl.find((i) => i.name.startsWith('Homepage'))!.guidance).toMatch(/GMV, orders, visitors/);
  });

  it('every account follows the template until it gets its own list, and can go back', () => {
    const q = new Queries(openTestDb());
    const a = account(q);
    expect(q.checklistSource(a.id).source).toBe('template');
    const own = q.customiseChecklist(a.id);
    expect(own.length).toBe(q.listTemplateItems().length);
    expect(own.every((i) => i.account_id === a.id)).toBe(true);
    const parent = own.find((i) => i.name.startsWith('Cruva'))!;
    expect(own.filter((i) => i.parent_id === parent.id)).toHaveLength(5);
    q.createChecklistItem({ account_id: a.id, section: 'Custom', name: 'Check the Estrid launch tracker', role: 'am' });
    expect(q.checklistSource(a.id)).toEqual({ source: 'custom', items: own.length + 1 });
    // The template itself is untouched.
    expect(q.listTemplateItems().some((i) => i.name.includes('Estrid'))).toBe(false);
    expect(q.resetChecklist(a.id)).toBe(own.length + 1);
    expect(q.checklistSource(a.id).source).toBe('template');
  });

  it('ticks drive the live status and the day record, and unticking reverts', () => {
    const q = new Queries(openTestDb());
    const a = account(q);
    const date = '2026-09-16'; // Wednesday
    const first = checkAccount(q, a, { trigger: 'live', tz: TZ, date });
    expect(first.status).toBe('none');
    const dueTop = q.checklistItemsFor(a.id).filter((i) => i.parent_id === null && i.enabled && isDue(i, date));
    expect(first.am_total + first.aa_total).toBeGreaterThan(dueTop.length);
    // Tick every AM line.
    for (const i of dueTop.filter((x) => x.role === 'am')) q.setTick(a.id, i.id, date, true, 'Elena');
    const mid = checkAccount(q, a, { trigger: 'live', tz: TZ, date });
    expect(mid.am_complete).toBe(true); // the AM's own lines are done
    expect(mid.aa_complete).toBe(false); // the AA action items underneath are still open
    expect(mid.status).toBe('partial');
    expect(mid.am_done).toBe(dueTop.filter((x) => x.role === 'am').length);
    // Tick everything else that is due.
    for (const i of q.checklistItemsFor(a.id).filter((x) => x.enabled && isDue(x, date))) q.setTick(a.id, i.id, date, true, 'DM');
    const done = checkAccount(q, a, { trigger: 'live', tz: TZ, date });
    expect(done.status).toBe('complete');
    expect(done.combined_complete).toBe(true);
    expect(done.items.find((i) => i.name.startsWith('Homepage'))!.assignee_name).toBe('Elena');
    // Untick one and the day is partial again; the stored check for that date follows.
    const home = dueTop.find((i) => i.name.startsWith('Homepage'))!;
    expect(q.setTick(a.id, home.id, date, false, 'Elena')).toBeNull();
    const after = checkAccount(q, a, { trigger: 'live', tz: TZ, date });
    expect(after.status).toBe('partial');
    expect(q.getCheckForDate(a.id, date)!.status).toBe('partial');
    expect(q.listTicks(a.id, date)).toHaveLength(q.checklistItemsFor(a.id).filter((x) => x.enabled && isDue(x, date)).length - 1);
  });

  it('a locked snapshot is not overwritten by later ticks, but the live view moves', () => {
    const q = new Queries(openTestDb());
    const a = account(q);
    const tz = TZ;
    const locked = checkAccount(q, a, { trigger: 'schedule', tz, final: true });
    expect(locked.final).toBe(true);
    expect(locked.status).toBe('none');
    const item = q.checklistItemsFor(a.id).find((i) => i.parent_id === null && i.role === 'am')!;
    q.setTick(a.id, item.id, locked.check_date, true, 'Elena');
    const live = checkAccount(q, a, { trigger: 'live', tz });
    expect(live.am_done).toBe(1);
    expect(q.getCheckForDate(a.id, locked.check_date)!.status).toBe('none');
    expect(refreshLive(q)).toBeGreaterThan(0);
  });
});
