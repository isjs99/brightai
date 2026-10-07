import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { dmMessagesFromDetail, idFromResult, inviteDetailsFromDetail, outreachFiltersFromDetail, parseListing, type McpCaller } from '../src/cruva/mcp';
import { brandOf, copyOf, draftBlockers, matchesItem, monthName, parseMcpListing, PlaybookEngine, withCopy } from '../src/playbook/index';
import { SEED_PLAYBOOK } from '../src/playbook/seed';

const account = (q: Queries, name: string) => q.createAccount({ name, markets: 'DE', am_name: 'Tamara', aa_name: 'DM', enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });

const SHOP_ID = '6a0000000000000000000001';

const AUTOMATIONS = `Automations (total: 4):

- Sample sent (ID: 699dd0cc90eea5de3df33a9e) | Status: active | Message: dm | Audience: groups | Sent: 1,750 | Replies: 226 | GMV: $269911.13
- Content not posted (ID: 69d66b77e5d1e931b1b4bf69) | Status: stopped | Message: dm | Audience: groups | Sent: 1,611 | Replies: 363 | GMV: $82515.13
- First outreach (ID: 698f586cf092fa0fb1bba9de) | Status: completed (run state: stopped) | Message: dm | Audience: new_affiliates | Sent: 1,114 | Replies: 136 | GMV: $154525.28
  Status note: Outreach to every available creator is done. Follow-up messages still send unless the automation is stopped.
- New outreach  (ID: 6ac384d2ad0fe635faef44fe) | Status: active | Message: dm | Audience: new_affiliates | Sent: 3,751 | Replies: 0 | GMV: $0 | Remaining: 285,957

(Call again with include_details=true to see message copy.)`;

const DETAIL = `Automations (total: 1):

- New outreach  (ID: 6ac384d2ad0fe635faef44fe) | Status: active | Message: dm | Audience: new_affiliates | Sent: 3,751
  Outreach filters: {"categories": ["Health", "Beauty & Personal Care"]}
  Content type: any
  Daily limits timezone: Europe/Berlin
  DM sequence (1 step(s)):
    [0] batch_product
        Content: Hi 👋 wir sind GreatVita
        Products: 1729709017358572218, 1729707486143683258
  dm_messages (ready for create_automation/update_automation):
    [{"type": "batch_product", "content": "Hi 👋 wir sind GreatVita", "products": ["1729709017358572218", "1729707486143683258"]}]
  Created: 2026-10-05 11:06:58 | Updated: 2026-10-05 11:07:45`;

const SAMPLE_DETAIL = (content: string) => `- Sample sent (ID: 699dd0cc90eea5de3df33a9e) | Status: active | Message: dm | Audience: groups
  dm_messages (ready for create_automation/update_automation):
    ${JSON.stringify([{ type: 'message', content }])}
  Created: 2026-01-01`;

const GROUPS = `Groups (total: 3):

- Content not posted (ID: 69d66b2b0a4a77be93629e90) | Creators: 58
- Sample sent (ID: 699dd0882bedb17d3f17b861) | Creators: 21
- Top creators (ID: 6a22c5dd8866086a4e017477) | Creators: 120`;

const LISTS = `Lists (total: 2):

- [75930] PlantDEA | Top 20 Creators | affiliates: 20 | emails: 10 | created: 2026-08-12
- [77602] Top 20 creator | affiliates: 20 | emails: 4 | created: 2026-06-10`;

const SHOPS = `- Kijimea IT (ID: 6936d165342cc96175676f97, plan: scale)
- Clearly DE (ID: 6973a15e06f8df59ef3f02eb, plan: scale)
- SACHEU Beauty [External] (ID: 68fa9f502b5226e201512366, plan: scale)
- Mystery Brand FR (ID: 6a0000000000000000000001, plan: scale)`;

describe('Cruva MCP listings', () => {
  it('parses automations, groups, lists and shops', () => {
    const a = parseListing(AUTOMATIONS);
    expect(a).toHaveLength(4);
    expect(a[0]).toMatchObject({ remote_id: '699dd0cc90eea5de3df33a9e', name: 'Sample sent', enabled: true, status: 'active' });
    expect(a[1].enabled).toBe(false);
    expect(a[2].enabled).toBe(false);
    expect(a[2].detail).toContain('Status note');
    expect(a[3].fields.audience).toBe('new_affiliates');
    expect(a[3].fields.gmv).toBe('$0');
    const l = parseListing(LISTS);
    expect(l[0]).toMatchObject({ remote_id: '75930', name: 'PlantDEA | Top 20 Creators' });
    expect(l[1].fields.affiliates).toBe('20');
    const s = parseListing(SHOPS);
    expect(s[1]).toMatchObject({ remote_id: '6973a15e06f8df59ef3f02eb', name: 'Clearly DE' });
    expect(s[1].fields.plan).toBe('scale');
    expect(parseListing('{"result": "- X (ID: abc) | Status: stopped"}')[0]).toMatchObject({ remote_id: 'abc', enabled: false });
  });
  it('reads details, ids and the sectioned paste format', () => {
    const d = parseListing(DETAIL)[0].detail;
    expect(outreachFiltersFromDetail(d)?.categories).toEqual(['Health', 'Beauty & Personal Care']);
    expect(dmMessagesFromDetail(d)?.[0]).toMatchObject({ type: 'batch_product' });
    expect(inviteDetailsFromDetail('invite_details (ready for create_automation/update_automation):\n    {"title": "T", "products": [{"product_id": "1"}]}\n  Created')?.title).toBe('T');
    expect(idFromResult('Created automation "Sample sent" (ID: 6ab1234567890) paused.')).toBe('6ab1234567890');
    expect(idFromResult('Created list [172309] Memo with 2 creators')).toBe('172309');
    const rows = parseMcpListing(`${AUTOMATIONS}\n\n${GROUPS}`);
    expect(rows.filter((r) => r.kind === 'group')).toHaveLength(3);
    expect(rows.filter((r) => r.kind === 'automation')).toHaveLength(4);
  });
  it('matches library names to how shops name things', () => {
    expect(matchesItem('sample_sent', 'Sample sent', 'CRM sample sent')).toBe(true);
    expect(matchesItem('sample_sent', 'Sample sent', 'Sample Shipped')).toBe(true);
    expect(matchesItem('content_not_posted', 'Content unfulfilled (7 days)', 'No Content Posted')).toBe(true);
    expect(matchesItem('deals_info_existing', '[month] deals info', 'September Deals Info')).toBe(true);
    expect(matchesItem('first_outreach', 'First outreach', 'Big first outreach')).toBe(true);
    expect(matchesItem('first_outreach', 'First outreach', 'Coffee outreach')).toBe(false);
    expect(brandOf('Clearly DE')).toBe('Clearly');
    expect(brandOf('Vaseline - DE')).toBe('Vaseline');
    expect(brandOf('Sacheu Beauty UK [External]')).toBe('Sacheu Beauty');
    expect(brandOf("Mother's Earth")).toBe("Mother's Earth");
    expect(monthName('de', new Date('2026-10-05T00:00:00Z'))).toBe('Oktober');
  });
  it('library: every key has one entry per language or a wildcard, and the core bots name their group', () => {
    const groups = new Set(SEED_PLAYBOOK.filter((i) => i.kind === 'group').map((i) => i.key));
    for (const i of SEED_PLAYBOOK.filter((x) => x.kind === 'automation' && x.config.outreach_audience === 'groups')) expect(groups.has(String(i.config.group_key))).toBe(true);
    const keys = new Map<string, Set<string>>();
    for (const i of SEED_PLAYBOOK) { const k = `${i.kind}:${i.key}`; keys.set(k, new Set([...(keys.get(k) ?? []), i.language])); }
    for (const [k, langs] of keys) expect(langs.has('*') || langs.size === 5, k).toBe(true);
    expect(copyOf({ dm_messages: [{ type: 'invite_card' }, { type: 'message', content: 'hello' }, { type: 'followup', content: 'again' }] })).toBe('hello');
    expect(withCopy({ email_body: 'x' }, 'y').email_body).toBe('y');
    expect(draftBlockers({ outreach_audience: 'groups' }, 'automation', 'create').hard[0]).toMatch(/group/);
    expect(draftBlockers({ sender_emails: [] }, 'email_campaign', 'create').hard[0]).toMatch(/sender/);
  });
});

/** A Cruva that behaves like the real one for two shops. */
function fakeMcp(state: { autos: string; groups?: string; created: { tool: string; args: Record<string, unknown> }[] }): McpCaller {
  return {
    configured: true,
    async call(tool, args) {
      if (tool === 'list_shops') return SHOPS;
      if (tool === 'list_automations') { if (args.campaign_id === '6ac384d2ad0fe635faef44fe') return DETAIL; if (args.campaign_id === '699dd0cc90eea5de3df33a9e') return SAMPLE_DETAIL('Something completely different about nothing'); return state.autos; }
      if (tool === 'list_groups') return state.groups ?? GROUPS;
      if (tool === 'list_lists') return LISTS;
      if (tool === 'list_workflows') return 'No workflows found.';
      if (tool === 'list_email_campaigns') return 'No email campaigns found.';
      if (tool === 'list_creator_briefs') return 'No creator briefs found.';
      if (tool === 'list_sender_emails') return 'No sender emails linked.';
      if (tool === 'list_tags') return 'No tags yet.';
      if (tool.startsWith('create_') || tool.startsWith('toggle_') || tool.startsWith('update_') || tool.startsWith('delete_')) { state.created.push({ tool, args }); return `Created ${tool} "${String(args.title ?? args.name ?? '')}" (ID: new_${state.created.length}) paused. Link: https://cruva.com/brief/abc`; }
      throw new Error(`unexpected ${tool}`);
    },
  };
}

describe('Cruva rollout engine', () => {
  it('syncs shops to accounts by name, checks a shop and reads set / paused / drift / missing / manual', async () => {
    const q = new Queries(openTestDb());
    const mystery = account(q, 'Mystery Brand');
    const state = { autos: AUTOMATIONS, created: [] as { tool: string; args: Record<string, unknown> }[] };
    const engine = new PlaybookEngine(q, fakeMcp(state), null);
    engine.seed();
    const sync = await engine.syncShops();
    expect(sync.linked).toBe(1); // Mystery Brand FR → the Mystery Brand account; the external shop waits, the rest were already known
    expect(engine.data().unlinked.some((u) => /External/.test(u.shop_name))).toBe(true);
    const data = engine.data();
    const shop = data.shops.find((s) => s.shop_id === SHOP_ID)!;
    expect(shop).toMatchObject({ account_id: mystery.id, language: 'fr', plan: 'scale', market: 'FR' });
    const r = await engine.check(SHOP_ID, true);
    expect(r.errors).toEqual([]);
    const cells = engine.data().cells.filter((c) => c.shop_id === SHOP_ID);
    const st = (kind: string, key: string) => cells.find((c) => c.kind === kind && c.playbook_key === key)?.status;
    // The shop's own Sample sent copy is nothing like the library's: it is adopted as the shop's standard (a shop-level library item), kept on the cell, and reads as set rather than drift.
    expect(st('automation', 'sample_sent')).toBe('set');
    expect(cells.find((c) => c.kind === 'automation' && c.playbook_key === 'sample_sent')!.remote_copy).toMatch(/Something completely different/);
    const adopted = engine.data().items.find((i) => i.kind === 'automation' && i.key === 'sample_sent' && i.language === `shop:${SHOP_ID}`)!;
    expect(adopted.source).toBe('cruva');
    expect(String((adopted.config.dm_messages as { content?: string }[])[0]?.content)).toMatch(/Something completely different/);
    expect(st('automation', 'content_not_posted')).toBe('paused');
    expect(st('automation', 'first_outreach')).toBe('set'); // "New outreach" is active; "First outreach" completed is ignored
    expect(st('automation', 'delivered')).toBe('missing');
    expect(st('group', 'sample_sent')).toBe('set');
    expect(st('group', 'top_creators')).toBe('set');
    expect(st('group', 'first_sale')).toBe('missing');
    expect(st('list', 'ai_search_list')).toBe('set');
    expect(st('brief', 'creator_brief')).toBe('missing');
    expect(st('sender', 'sender_email')).toBe('manual');
    expect(st('manual', 'auto_review')).toBe('manual');
    expect(st('workflow', 'sample_chase')).toBe('manual');
    const after = engine.data().shops.find((s) => s.shop_id === SHOP_ID)!;
    expect(after.learned?.categories).toEqual(['Health', 'Beauty & Personal Care']);
    expect(after.learned?.products).toEqual(['1729709017358572218', '1729707486143683258']);
    expect(after.learned?.timezone).toBe('Europe/Berlin');
    expect(after.learned?.contact_email).toBe('team+mysterybrand@brightform.agency');
    const cov = engine.coverageByAccount().get(mystery.id)!;
    expect(cov.missing_core.length).toBeGreaterThan(0);
    expect(cov.paused_core.some((x) => /unfulfilled/i.test(x))).toBe(true);
  });

  it('prepares drafts in order with references, lets the reviewer amend, rolls out through the MCP and can undo', async () => {
    const q = new Queries(openTestDb());
    account(q, 'Mystery Brand');
    const state = { autos: AUTOMATIONS, created: [] as { tool: string; args: Record<string, unknown> }[] };
    const engine = new PlaybookEngine(q, fakeMcp(state), async () => 'Salut [affiliate_name], réécrit.');
    engine.seed();
    q.setSetting('playbook_adopt_existing', '0'); // keep the drift so the update path is exercised
    await engine.syncShops();
    await engine.check(SHOP_ID, true);
    const shopId = SHOP_ID;
    const { rollout, drafts } = engine.prepare({ shop_ids: [shopId], created_by: 'Isaac', tailor: false });
    expect(rollout.status).toBe('draft');
    const byKey = (kind: string, key: string) => drafts.find((d) => d.kind === kind && d.key === key)!;
    // Groups come before the bots that need them, and the bot references the group drafted in this rollout.
    expect(drafts.findIndex((d) => d.kind === 'group' && d.key === 'first_sale')).toBeLessThan(drafts.findIndex((d) => d.kind === 'automation' && d.key === 'first_sale'));
    expect(byKey('automation', 'first_sale').payload.group_id).toBe('[group:first_sale]');
    expect(byKey('automation', 'first_sale').status).toBe('ready');
    expect(byKey('automation', 'first_sale').language).toBe('fr');
    expect(byKey('automation', 'first_sale').copy).toMatch(/Mystery Brand/);
    // Paused bot becomes a start, drifted bot an update.
    expect(byKey('automation', 'content_not_posted').action).toBe('start');
    expect(byKey('automation', 'sample_sent').action).toBe('update');
    expect(byKey('automation', 'sample_sent').tool).toBe('update_automation');
    // The deals bot carries the month, the rejected bot the entry-date guard, the email is blocked without a sender.
    expect(byKey('automation', 'deals_info_existing').name).toMatch(/^[A-Z][a-zé]+ deals info$/);
    expect(byKey('automation', 'rejected').payload.entry_date_threshold).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(byKey('email_campaign', 'creator_newsletter').status).toBe('blocked');
    // "New outreach" counts as the first outreach, so nothing is drafted for it; products, list and categories learnt from the shop land in the other outreach drafts.
    expect(drafts.some((d) => d.key === 'first_outreach')).toBe(false);
    const collab = byKey('automation', 'top_creators_collab');
    const inv = collab.payload.invite_details as { products: { product_id: string; commission: number }[]; contact_email: string };
    expect(inv.products[0]).toMatchObject({ product_id: '1729709017358572218', commission: 20 });
    expect(inv.contact_email).toBe('team+mysterybrand@brightform.agency');
    expect(collab.payload.list_ids).toEqual([75930]);
    expect(collab.status).toBe('ready');
    expect((byKey('automation', 'monthly_deals_outreach').payload.outreach_filters as { categories: string[] }).categories).toEqual(['Health', 'Beauty & Personal Care']);
    // Review: amend copy, rewrite with the LLM, approve a few.
    const edited = engine.updateDraft(byKey('automation', 'first_sale').id, { copy: 'Merci [affiliate_name] !' });
    expect(copyOf(edited.payload)).toBe('Merci [affiliate_name] !');
    const rewritten = await engine.rewriteDraft(byKey('automation', 'delivered').id);
    expect(rewritten.copy).toBe('Salut [affiliate_name], réécrit.');
    expect(() => engine.updateDraft(byKey('email_campaign', 'creator_newsletter').id, { status: 'approved' })).toThrow(/sender/);
    for (const key of ['first_sale'] as const) { engine.updateDraft(byKey('group', key).id, { status: 'approved' }); engine.updateDraft(byKey('automation', key).id, { status: 'approved', start_after: true }); }
    engine.updateDraft(byKey('automation', 'content_not_posted').id, { status: 'approved' });
    engine.updateDraft(byKey('brief', 'creator_brief').id, { status: 'approved' });
    const run = await engine.runRollout(rollout.id, 'Isaac');
    expect(run.errors).toEqual([]);
    expect(run.done).toBe(4);
    const calls = state.created.map((c) => c.tool);
    expect(calls.slice(0, 2)).toEqual(['create_group', 'create_creator_brief']);
    const bot = state.created.find((c) => c.tool === 'create_automation')!;
    expect(bot.args.group_id).toBe('new_1'); // the group created a moment earlier
    expect(state.created.some((c) => c.tool === 'toggle_automation' && c.args.status === 'active')).toBe(true);
    const after = engine.drafts(rollout.id);
    expect(after.rollout.status).toBe('done');
    expect(after.drafts.filter((d) => d.status === 'done')).toHaveLength(4);
    expect(after.drafts.find((d) => d.kind === 'group' && d.key === 'first_sale')?.remote_id).toBe('new_1');
    expect(after.drafts.find((d) => d.kind === 'automation' && d.key === 'first_sale')?.remote_id).toMatch(/^new_/);
    expect(engine.data().shops.find((s) => s.shop_id === SHOP_ID)!.learned?.brief_link).toBe('https://cruva.com/brief/abc');
    const undo = await engine.undoRollout(rollout.id);
    expect(undo.undone).toBe(4);
    expect(state.created.filter((c) => c.tool.startsWith('delete_'))).toHaveLength(3);
    expect(state.created.filter((c) => c.tool === 'toggle_automation' && c.args.status === 'stopped')).toHaveLength(1);
  });
});

describe('Cruva check resilience', () => {
  it('records why a shop failed, keeps checking the others and clears the error on the next good check', async () => {
    const q = new Queries(openTestDb());
    const state = { autos: AUTOMATIONS, created: [] as { tool: string; args: Record<string, unknown> }[] };
    const inner = fakeMcp(state);
    let failFor: string | null = '6a57569b37ac6b1106c48355';
    const mcp: McpCaller = { configured: true, call: async (tool, args) => { if (tool === 'list_groups' && args.shop_id === failFor) throw new Error('SSE stream disconnected'); return inner.call(tool, args); } };
    const engine = new PlaybookEngine(q, mcp, null);
    engine.seed();
    const r = await engine.check(undefined, false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/Bears With Benefits IT: SSE stream disconnected/);
    expect(r.shops).toBe(engine.shops().length - 1);
    const d = engine.data();
    expect(d.last_error).toMatch(/1 of \d+ shop\(s\) failed/);
    expect(d.shops.find((s) => s.shop_id === '6a57569b37ac6b1106c48355')!.error).toBe('SSE stream disconnected');
    expect(d.shops.find((s) => s.shop_id === '69f1ffa88fa9bee8204e773d')!.error).toBeNull();
    expect(d.cells.filter((c) => c.shop_id === '69f1ffa88fa9bee8204e773d').length).toBeGreaterThan(10);
    failFor = null;
    await engine.check('6a57569b37ac6b1106c48355', false);
    expect(engine.data().shops.find((s) => s.shop_id === '6a57569b37ac6b1106c48355')!.error).toBeNull();
    expect(engine.data().last_error).toBeNull();
  });
});
