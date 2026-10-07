import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { PlaybookEngine } from '../src/playbook/index';
import type { McpCaller } from '../src/cruva/mcp';

describe('always-on outreach in the engine', () => {
  const setup = (opts: { live?: boolean; alwaysOn?: boolean } = {}) => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Bears With Benefits', markets: 'IT', am_name: 'Federica', aa_name: null, enabled: true, notes: null, commission_pct: 15, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const mcp: McpCaller = { configured: true, async call(tool, args) { calls.push({ tool, args }); if (tool === 'create_automation') return 'Created automation (ID: auto-new)'; if (tool.startsWith('list_')) return 'No results.'; return ''; } };
    const llmCalls: { system: string; user: string }[] = [];
    const llm = async (system: string, user: string) => { llmCalls.push({ system, user }); if (/in the brand's own voice/.test(system)) return 'Ciao [affiliate_name], ad ottobre Bears With Benefits ha le promo su TikTok Shop. Team Bears With Benefits'; return '{"competitors": []}'; };
    const engine = new PlaybookEngine(q, mcp, llm);
    engine.seed();
    engine.linkShop('shop-it', 'Bears With Benefits IT', a.id);
    q.replaceRemoteItems('shop-it', 'automation', [
      { remote_id: 'auto-1', name: 'September deals outreach', enabled: Boolean(opts.live), raw: { status: opts.live ? 'active' : 'stopped', audience: 'new_affiliates', copy: 'Ciao [affiliate_name], a settembre... Team Bears', sent: 12000, replies: 300, gmv: 900 } },
      { remote_id: 'auto-2', name: 'Sample sent', enabled: true, raw: { status: 'active', audience: 'groups', copy: 'Il tuo sample è in viaggio', sent: 500 } },
    ]);
    const now = new Date().toISOString();
    q.setPlaybookCell({ shop_id: 'shop-it', kind: 'automation', playbook_key: 'monthly_deals_outreach', status: opts.live ? 'set' : 'paused', remote_id: 'auto-1', remote_name: 'September deals outreach', checked_at: now, applied_at: null, note: null });
    if (opts.alwaysOn) q.setSetting('playbook_always_on_shop-it', '1');
    q.setSetting('playbook_learned_shop-it', JSON.stringify({ categories: ['Health'], products: ['Bears With Benefits Hair Vitamins'], contact_email: 'ciao@bears.it', timezone: 'Europe/Rome' }));
    q.createPromotion({ name: 'Ottobre -20%', activity_type: 'DIRECT_DISCOUNT' as never, product_level: 'PRODUCT' as never, discount_type: 'PERCENTAGE_OFF', discount_value: 20, begin_at: new Date(Date.now() - 86400000).toISOString(), end_at: new Date(Date.now() + 10 * 86400000).toISOString(), participation: 'BUYER_NO_LIMIT', products: {}, notes: null, targets: [{ account_id: a.id, market: 'IT' }] }, 'test');
    q.saveAccountCampaign({ account_id: a.id, market: 'IT', name: 'Halloween Sale', begin_at: new Date(Date.now() + 5 * 86400000).toISOString(), end_at: new Date(Date.now() + 12 * 86400000).toISOString(), participation: 'full', discount_pct: 25, sku_scope: 'gummies' });
    return { q, a, engine, calls, llmCalls };
  };

  it('reads the shop\'s outreach state and the season: month, live promotions and the TikTok campaigns it takes part in', () => {
    const { engine } = setup({ live: true });
    const shop = engine.shops().find((s) => s.shop_id === 'shop-it')!;
    expect(shop.outreach).toMatchObject({ live: 1, always_on: false, ended: null, dms_7d: null, silent_days: null });
    const facts = engine.seasonFacts(shop);
    expect(facts[0]).toMatch(/^Month: .* · market IT$/);
    expect(facts.join('\n')).toMatch(/Promotion "Ottobre -20%": 20% off, .* \(live\)/);
    expect(facts.join('\n')).toMatch(/TikTok campaign "Halloween Sale": full participation, 25% off, gummies/);
  });

  it('leaves a shop alone while its outreach runs, and drafts this month\'s campaign afresh, tailored to the season, when it has ended', async () => {
    const { q, engine, llmCalls } = setup({ live: false });
    const r = await engine.ensureOutreach();
    expect(r.drafted).toHaveLength(1);
    expect(r.drafted[0]).toMatchObject({ shop: 'Bears With Benefits IT', started: false, reason: 'no outreach automation is running' });
    const rollout = q.getRollout(r.drafted[0].rollout_id)!;
    expect(rollout.status).toBe('draft'); expect(rollout.note).toMatch(/^Always-on outreach: no outreach automation/);
    const drafts = q.listRolloutDrafts(rollout.id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ key: 'monthly_deals_outreach', action: 'create', remote_id: null, language: 'it' }); // a new campaign, not a restart of the old one
    expect(drafts[0].name).not.toMatch(/\[month\]/);
    expect(drafts[0].tailored_at).not.toBeNull();
    const tail = llmCalls.find((c) => /in the brand's own voice/.test(c.system))!;
    expect(tail.system).toMatch(/What is on right now for this shop/);
    expect(tail.system).toMatch(/Promotion "Ottobre -20%"/);
    expect(tail.system).toMatch(/TikTok campaign "Halloween Sale"/);
    expect(tail.system).toMatch(/Campaigns that work on this shop/); // the old outreach's numbers are the reference
    const shop = engine.shops().find((s) => s.shop_id === 'shop-it')!;
    expect(shop.outreach.ended).toMatchObject({ rollout_id: rollout.id, started: false, resolved_at: null });
    // The old cell is untouched (the new campaign sits next to it).
    expect(q.listPlaybookCells().find((c) => c.shop_id === 'shop-it' && c.playbook_key === 'monthly_deals_outreach')?.status).toBe('paused');
    // A second check while the replacement waits does nothing.
    const again = await engine.ensureOutreach();
    expect(again.drafted).toEqual([]);
    expect(q.listRollouts().filter((x) => x.note?.startsWith('Always-on')).length).toBe(1);
  });

  it('with Always-on on, approves and starts the fresh campaign itself, and marks the gap resolved once DMs flow again', async () => {
    const { q, engine, calls } = setup({ live: false, alwaysOn: true });
    const r = await engine.ensureOutreach();
    expect(q.listRolloutDrafts(r.drafted[0].rollout_id).map((d) => [d.status, d.blockers])).toEqual([['done', []]]);
    expect(r.drafted[0].started).toBe(true);
    const created = calls.find((c) => c.tool === 'create_automation')!;
    expect(created.args.shop_id).toBe('shop-it');
    expect(String((created.args.dm_messages as { content: string }[])[0].content)).toMatch(/ottobre|Bears With Benefits/);
    expect(q.getRollout(r.drafted[0].rollout_id)?.status).toBe('done');
    expect(engine.shops().find((s) => s.shop_id === 'shop-it')!.outreach.ended?.started).toBe(true);
    // Just started: the next check waits for Cruva to send.
    expect((await engine.ensureOutreach()).drafted).toEqual([]);
    // Once the check sees an outreach bot running, the gap is resolved and the flag clears.
    q.replaceRemoteItems('shop-it', 'automation', [{ remote_id: 'auto-new', name: 'Ottobre deals outreach', enabled: true, raw: { status: 'active', audience: 'new_affiliates', sent: 10 } }]);
    await engine.ensureOutreach({ now: Date.now() + 4 * 86400000 });
    expect(engine.shops().find((s) => s.shop_id === 'shop-it')!.outreach.ended?.resolved_at).not.toBeNull();
  });
});

describe('DMs going silent', () => {
  it('counts the days since the last DM in the pull and flags the shop on the monitor, critical from a week', async () => {
    const { daysFromStats, metricsFromDays } = await import('../src/cruva/pull');
    const { HealthEngine } = await import('../src/health/index');
    const NOW = Date.parse('2026-10-07T10:00:00Z');
    const day = (back: number) => new Date(NOW - back * 86400000).toISOString().slice(0, 10);
    const dms = Array.from({ length: 28 }, (_, i) => ({ date: day(27 - i), count: 27 - i >= 4 ? 40 : 0 })); // the last four days: nothing out
    const days = daysFromStats([{ key: 'dms_sent', title: '', total: 0, change_pct: null, days: dms }]);
    const m = metricsFromDays(days, NOW);
    expect(m.dms_silent_days).toBe(4);
    expect(m.dms_sent_7d).toBe(160); // four of the seven finished days had DMs
    expect(m.dms_sent_28d).toBe(24 * 40);
    expect(metricsFromDays(daysFromStats([{ key: 'dms_sent', title: '', total: 0, change_pct: null, days: dms.map((d) => ({ ...d, count: 0 })) }]), NOW).dms_silent_days).toBe(27);
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Bears With Benefits', markets: 'IT', am_name: null, aa_name: null, enabled: true, notes: null, commission_pct: 15, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    q.addShop(a.id, 'shop-it', 'Bears With Benefits IT', 'EUR', 'cruva');
    q.upsertHealthPull({ shop_id: 'shop-it', account_id: a.id, source: 'cruva', pull_date: day(0), ok: true, metrics: { ...m, automations_active: 2, sps: 4.5 } });
    q.setSetting('playbook_outreach_shop-it', JSON.stringify({ reason: 'no DM sent for 4 days while 2 outreach bot(s) show as active', name: 'Ottobre deals outreach', rollout_id: 7, started: false, at: new Date(NOW).toISOString(), resolved_at: null }));
    const engine = new HealthEngine(q);
    const flags = engine.cruvaFlags(new Set(['c_dms_silent', 'c_outreach_ended', 'c_dms_stopped']), NOW);
    const silent = flags.find((f) => f.code === 'c_dms_silent')!;
    expect(silent).toMatchObject({ severity: 'warn', shop_id: 'shop-it' });
    expect(silent.message).toMatch(/no DMs sent for 4 days while 2 automation\(s\) show as active/);
    expect(silent.detail).toBe('960 DMs in the last 28 days');
    const ended = flags.find((f) => f.code === 'c_outreach_ended')!;
    expect(ended.message).toMatch(/"Ottobre deals outreach" is drafted and waits for approval \(rollout #7\)/);
    expect(ended.detail).toMatch(/\/cruva\?rollout=7&shop=shop-it$/);
    q.upsertHealthPull({ shop_id: 'shop-it', account_id: a.id, source: 'cruva', pull_date: day(0), ok: true, metrics: { ...m, dms_silent_days: 9 } });
    expect(engine.cruvaFlags(new Set(['c_dms_silent']), NOW)[0].severity).toBe('crit');
    q.setSetting('playbook_outreach_shop-it', JSON.stringify({ reason: 'x', name: 'y', rollout_id: 7, started: true, at: new Date(NOW).toISOString(), resolved_at: new Date(NOW).toISOString() }));
    expect(engine.cruvaFlags(new Set(['c_outreach_ended']), NOW)).toEqual([]);
  });
});
