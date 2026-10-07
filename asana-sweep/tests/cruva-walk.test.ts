import { expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { PlaybookEngine } from '../src/playbook/index';
import { fromEnglishPrompt, WALK_STEPS, walkIndexOf } from '../src/playbook/walk';
import type { McpCaller } from '../src/cruva/mcp';

it('orders the walk the way a creator meets the pieces, keeps each shop\'s position, and renders edited English back into the shop language', async () => {
  // Groups first, then the brief, first contact, the lifecycle bots in lifecycle order, pushes, email, flows, hygiene.
  expect(walkIndexOf('group', 'first_sale')).toBeLessThan(walkIndexOf('brief', 'creator_brief'));
  expect(walkIndexOf('brief', 'creator_brief')).toBeLessThan(walkIndexOf('automation', 'first_outreach'));
  expect(walkIndexOf('automation', 'sample_sent')).toBeLessThan(walkIndexOf('automation', 'delivered'));
  expect(walkIndexOf('automation', 'delivered')).toBeLessThan(walkIndexOf('automation', 'first_sale'));
  expect(walkIndexOf('automation', 'rejected')).toBeLessThan(walkIndexOf('email_campaign', 'creator_newsletter'));
  expect(walkIndexOf('tag', 'vip')).toBe(WALK_STEPS.length - 1);
  expect(walkIndexOf('automation', 'unknown_thing')).toBe(1000);
  expect(new Set(WALK_STEPS.map((s) => s.key)).size).toBe(WALK_STEPS.length);

  const q = new Queries(openTestDb());
  const a = q.createAccount({ name: 'Mystery Brand', markets: 'FR', am_name: 'Elena', aa_name: null, enabled: true, notes: null, commission_pct: 12, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
  const calls: { system: string; user: string }[] = [];
  const llm = async (system: string, user: string) => { calls.push({ system, user }); return system.includes('Translate') ? `FR(${user})` : '["EN of the draft"]'; };
  const mcp: McpCaller = { configured: true, async call() { return 'ok'; } };
  const engine = new PlaybookEngine(q, mcp, llm);
  engine.seed();
  engine.linkShop('shop-fr', 'Mystery Brand FR', a.id);
  q.setPlaybookCell({ shop_id: 'shop-fr', kind: 'group', playbook_key: 'first_sale', status: 'missing', remote_id: null, remote_name: null, checked_at: new Date().toISOString(), applied_at: null, note: null });
  q.setPlaybookCell({ shop_id: 'shop-fr', kind: 'automation', playbook_key: 'first_sale', status: 'missing', remote_id: null, remote_name: null, checked_at: new Date().toISOString(), applied_at: null, note: null });
  const { rollout, drafts } = engine.prepare({ shop_ids: ['shop-fr'], keys: ['group:first_sale', 'automation:first_sale'], created_by: 'Isaac' });
  const bot = drafts.find((d) => d.kind === 'automation' && d.key === 'first_sale')!;
  expect(bot.language).toBe('fr');

  // The walk position is kept per shop and comes back with the rollout.
  expect(engine.drafts(rollout.id).walk).toEqual({});
  engine.setWalkIndex(rollout.id, 'shop-fr', 1);
  expect(engine.drafts(rollout.id).walk).toEqual({ 'shop-fr': 1 });
  expect(engine.drafts(rollout.id).steps).toBe(WALK_STEPS);

  // English for the reviewer, then an edit rendered back into French with the placeholders kept.
  const en = await engine.englishForDraft(bot.id);
  expect(en.english).toBe('EN of the draft');
  const group = drafts.find((d) => d.kind === 'group')!;
  expect((await engine.englishForDraft(group.id)).english).toBeNull();
  const after = await engine.copyFromEnglish(bot.id, 'Hi [affiliate_name], well done on the first sale for [brand]!');
  expect(after.copy).toBe('FR(Hi [affiliate_name], well done on the first sale for [brand]!)');
  expect(calls.at(-1)!.system).toMatch(/French/);
  expect(calls.at(-1)!.system).toMatch(/\[affiliate_name\]/);
  // The edited English is remembered as the translation of the new copy: no further call.
  const n = calls.length;
  expect((await engine.englishForDraft(bot.id)).english).toBe('Hi [affiliate_name], well done on the first sale for [brand]!');
  expect(calls.length).toBe(n);
  const p = fromEnglishPrompt('de', 'Hello', 'Acme');
  expect(p.system).toMatch(/German/);
  expect(p.user).toBe('Hello');
});
