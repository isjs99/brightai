import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { PlaybookEngine } from '../src/playbook/index';
import { parseVideos, pullContent, rankContent, topCount } from '../src/playbook/content';
import { materialChange, parseProfile, parseVoice, profilePrompt, voicePrompt } from '../src/playbook/profile';
import { VIDEOS_COUNT, VIDEOS_PAGE } from './fixtures/cruva-videos';
import type { McpCaller } from '../src/cruva/mcp';

describe('top videos', () => {
  it('reads Cruva\'s search_videos as it really answers, ranks by GMV and by GMV per view, and sizes the top slice', () => {
    const vids = parseVideos(VIDEOS_PAGE);
    expect(vids).toHaveLength(5);
    expect(vids[0]).toMatchObject({ video_id: '7666225241760288033', handle: 'kristina_rihard', gmv: 2526.22, units: 76, views: 349786, gmv_per_view: 0.0072, product_id: '1729569344482875607' });
    expect(vids[0].hooks[0]).toMatchObject({ hook: '13 Tage und alle Schwellungen sind weg.', score: 8 });
    expect(vids[0].transcript).toMatch(/53 Bakterienstaemme/);
    expect(vids[1].hooks).toEqual([]);
    expect(topCount(596, 5)).toBe(30);
    expect(topCount(40, 5)).toBe(5);
    expect(topCount(3, 5)).toBe(3);
    expect(topCount(2000, 5)).toBe(40);
    const ranked = rankContent(vids, 5);
    expect(ranked.filter((v) => v.top).map((v) => v.handle)).toContain('kristina_rihard');
    expect(ranked.find((v) => v.handle === 'quietone')!.top).toBe(false); // no GMV never tops
    expect(ranked.find((v) => v.handle === 'coolestfind')!.rank_eff).toBe(1); // best GMV per view
    expect(parseVideos('No videos found.')).toEqual([]);
  });

  it('pulls the count and the pages through the MCP and stops once the top slice is covered', async () => {
    const calls: Record<string, unknown>[] = [];
    const mcp: McpCaller = { configured: true, async call(tool, args) { calls.push(args); if (args.just_count) return VIDEOS_COUNT; return VIDEOS_PAGE; } };
    const r = await pullContent(mcp, 'shop-1', { from: '2026-09-09', to: '2026-10-07', pct: 5 });
    expect(r.total).toBe(596);
    expect(r.videos).toHaveLength(5); // the same page comes back, deduped by video id
    expect(calls[0]).toMatchObject({ just_count: true, timeseries: true });
    expect(calls.some((c) => c.sort_by === 'avg_gmv_per_view' && c.min_view_count === 2000)).toBe(true);
  });
});

describe('profile and voice', () => {
  it('keeps only claims with known video ids, computes product and creator numbers itself, and spots a material change', () => {
    const vids = rankContent(parseVideos(VIDEOS_PAGE), 5);
    const { system, user } = profilePrompt({ shop_name: 'Kijimea DE', language: 'de', market: 'DE', top: vids.filter((v) => v.top), all: vids, total: 596, window_from: '2026-09-09', window_to: '2026-10-07' });
    expect(system).toMatch(/video ids/);
    expect(user).toMatch(/kristina_rihard/);
    expect(user).toMatch(/no sales in the window \(ids\): 1729999999999999999/);
    const raw = JSON.stringify({ summary: 'Problem-first hooks on K53 sell.', hooks: [{ group: 'problem first', example: '13 Tage und alle Schwellungen sind weg.', language: 'de', video_ids: ['7666225241760288033', 'made-up'] }, { group: 'price or deal', example: 'x', video_ids: ['nope'] }], formats: [{ name: 'talking head', video_ids: ['7666225241760288033', '7657070075328924960'] }], products_carry: [{ product_id: '1729569344482875607', gmv: 1, videos: 1 }, { product_id: '1729999999999999999', gmv: 0, videos: 1 }], products_no_gmv: ['1729999999999999999'], creator_shape: { follower_band: 'mid', niches: ['gut health'], first_video_share: 0.5, video_ids: [] }, timing: { best_days: ['Friday'], best_hours: ['evening'], video_ids: ['7666225241760288033'] }, offer: 'Sommer Deals', example_scripts: [{ handle: 'brillen.queen', video_id: '7657070075328924960', lines: 'Kauft es nicht in der Apotheke.' }, { handle: 'x', video_id: 'nope', lines: 'y' }], content_ideas: ['Vorher/Nachher nach 13 Tagen'], top_creators: [] });
    const p = parseProfile(raw, vids, { window_from: '2026-09-09', window_to: '2026-10-07', total: 596 });
    expect(p.hooks).toHaveLength(1);
    expect(p.hooks[0].video_ids).toEqual(['7666225241760288033']);
    expect(p.products_carry[0]).toMatchObject({ product_id: '1729569344482875607', videos: 4 });
    expect(p.products_carry[0].gmv).toBe(Math.round(2526.22 + 2492.8 + 2096.02 + 825.18));
    expect(p.example_scripts).toHaveLength(1);
    expect(p.example_scripts[0].link).toMatch(/brillen.queen/);
    expect(p.top_creators[0].handle).toBe('kristina_rihard');
    expect(p.top_count).toBe(vids.filter((v) => v.top).length);
    expect(materialChange(null, p)).toEqual(['first profile']);
    expect(materialChange(p, p)).toEqual([]);
    expect(materialChange(p, { ...p, offer: null })).toEqual(['the offer changed']);
    expect(materialChange(p, { ...p, hooks: [{ ...p.hooks[0], group: 'unboxing' }] })[0]).toMatch(/leading hook moved/);

    const samples = [{ name: 'September Deals', kind: 'automation', sent: 351674, replies: 457, copy: 'Hey [affiliate_name],\n\nGROSSE NEUIGKEITEN! 🚨 ...\n\nTeam Kijimea 🤍' }];
    expect(voicePrompt({ shop_name: 'Kijimea DE', language: 'de', samples }).user).toMatch(/sent 351674/);
    const v = parseVoice('{"summary": "Warm, du, emoji-led bullet lists, closes with Team Kijimea.", "greeting": "Hey [affiliate_name],", "signoff": "Team Kijimea 🤍", "register": "du", "emoji": "light: ✨ 🚨 🤍", "length": "medium", "phrases": ["GROSSE NEUIGKEITEN"], "avoid": ["formal Sie"]}', samples);
    expect(v).toMatchObject({ greeting: 'Hey [affiliate_name],', register: 'du', phrases: ['GROSSE NEUIGKEITEN'] });
    expect(v.samples).toBe(samples);
  });
});

describe('learning in the engine', () => {
  const setup = () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Kijimea', markets: 'DE', am_name: 'Federica', aa_name: null, enabled: true, notes: null, commission_pct: 15, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    const mcpCalls: { tool: string; args: Record<string, unknown> }[] = [];
    const mcp: McpCaller = { configured: true, async call(tool, args) { mcpCalls.push({ tool, args }); if (tool === 'search_videos') return args.just_count ? VIDEOS_COUNT : VIDEOS_PAGE; if (tool === 'tag_creators') return 'Tagged 1 creators.'; if (tool.startsWith('update_') || tool.startsWith('create_')) return `Updated (ID: ${String(args.campaign_id ?? 'new1')})`; if (tool === 'list_automations') return 'Automations (total: 2):\n\n- September Deals - Big Outreach (ID: auto-1) | Status: active | Message: dm | Audience: new_affiliates | Sent: 351,674 | Replies: 457 | GMV: $2246\n- Sample sent (ID: auto-2) | Status: active | Message: dm | Audience: groups | Sent: 900 | Replies: 40 | GMV: $500\n'; if (tool === 'list_groups') return 'Groups (total: 1):\n\n- Delivered (ID: g-2) | 12 creators\n'; if (tool.startsWith('list_')) return 'No results.'; return ''; } };
    const llmCalls: { system: string; user: string }[] = [];
    const llm = async (system: string, user: string) => {
      llmCalls.push({ system, user });
      if (/describe how the brand/.test(system)) return '{"summary": "Warm du, emoji bullets, closes with Team Kijimea.", "greeting": "Hey [affiliate_name] 👋", "signoff": "Team Kijimea 🤍", "register": "du", "emoji": "light", "length": "medium", "phrases": ["Das ist für dich drin"], "avoid": ["Sie"]}';
      if (/study the TikTok Shop affiliate videos/.test(system)) return JSON.stringify({ summary: 'Problem-first hooks sell K53.', hooks: [{ group: 'problem first', example: '13 Tage und alle Schwellungen sind weg.', language: 'de', video_ids: ['7666225241760288033'] }], formats: [], products_carry: [{ product_id: '1729569344482875607' }], products_no_gmv: [], creator_shape: { follower_band: 'mid', niches: [], first_video_share: null, video_ids: [] }, timing: { best_days: ['Friday'], best_hours: [], video_ids: [] }, offer: user.includes('OFFER-B') ? 'Herbst Deals' : 'Sommer Deals', example_scripts: [], content_ideas: ['Vorher/Nachher'], top_creators: [] });
      if (/in the brand's own voice/.test(system)) return `TAILORED(${user.slice(-30).replace(/\n/g, ' ')})`;
      return 'x';
    };
    const engine = new PlaybookEngine(q, mcp, llm);
    engine.seed();
    engine.linkShop('shop-de', 'Kijimea DE', a.id);
    // What the check would have stored: two automations with their copy.
    q.replaceRemoteItems('shop-de', 'automation', [
      { remote_id: 'auto-1', name: 'September Deals - Big Outreach', enabled: true, raw: { copy: 'Hey [affiliate_name],\n\nGROSSE NEUIGKEITEN! 🚨\n\nTeam Kijimea 🤍', sent: 351674, replies: 457, gmv: 2246 } },
      { remote_id: 'auto-2', name: 'Sample sent', enabled: true, raw: { copy: 'Hey [affiliate_name] 👋 dein Sample ist unterwegs. Team Kijimea 🤍', sent: 900, replies: 40, gmv: 500 } },
    ]);
    const now = new Date().toISOString();
    q.setPlaybookCell({ shop_id: 'shop-de', kind: 'automation', playbook_key: 'sample_sent', status: 'set', remote_id: 'auto-2', remote_name: 'Sample sent', checked_at: now, applied_at: null, note: null });
    q.setPlaybookCellCopy('shop-de', 'automation', 'sample_sent', 'Hey [affiliate_name] 👋 dein Sample ist unterwegs. Team Kijimea 🤍');
    q.setPlaybookCell({ shop_id: 'shop-de', kind: 'group', playbook_key: 'content_pending', status: 'set', remote_id: 'g-2', remote_name: 'Delivered', checked_at: now, applied_at: null, note: null });
    q.setPlaybookCell({ shop_id: 'shop-de', kind: 'automation', playbook_key: 'delivered', status: 'missing', remote_id: null, remote_name: null, checked_at: now, applied_at: null, note: null });
    return { q, engine, mcpCalls, llmCalls };
  };

  it('learns the voice from the copy the shop runs and the profile from its top videos, and both show on the shop', async () => {
    const { q, engine, llmCalls } = setup();
    const r = await engine.learnShop('shop-de');
    expect(r.errors).toEqual([]);
    expect(r.voice).toMatchObject({ register: 'du', signoff: 'Team Kijimea 🤍' });
    expect(r.voice!.samples[0].name).toBe('September Deals - Big Outreach'); // strongest first
    expect(llmCalls[0].user).toMatch(/GROSSE NEUIGKEITEN/);
    expect(r.profile).toMatchObject({ videos: 596, offer: 'Sommer Deals' });
    expect(r.profile!.products_carry[0].product_id).toBe('1729569344482875607');
    const shop = engine.shops().find((s) => s.shop_id === 'shop-de')!;
    expect(shop.voice?.summary).toMatch(/Warm du/);
    expect(shop.profile?.hooks[0].group).toBe('problem first');
    expect(q.listContent('shop-de', { topOnly: true }).length).toBeGreaterThan(0);
  });

  it('a prepared draft carries the shop\'s existing copy, is rewritten in the voice with what sells, and keeps that as the shop\'s own library copy', async () => {
    const { q, engine, llmCalls } = setup();
    await engine.learnShop('shop-de');
    const { rollout, drafts } = engine.prepare({ shop_ids: ['shop-de'], keys: ['automation:delivered'], created_by: 'Isaac', tailor: false });
    const d = drafts.find((x) => x.key === 'delivered')!;
    expect(d.existing_copy).toMatch(/^September Deals - Big Outreach:/); // nearest existing message as the reference
    expect(d.tailored_at ?? null).toBeNull();
    const before = llmCalls.length;
    const t = await engine.tailorDraft(d.id);
    expect(t.copy).toMatch(/^TAILORED\(/);
    expect(t.tailored_at).toBeTruthy();
    expect(t.save_override).toBe(true);
    const sys = llmCalls[before].system;
    expect(sys).toMatch(/Team Kijimea/); // the voice
    expect(sys).toMatch(/problem first/); // what sells
    expect(sys).toMatch(/September Deals - Big Outreach/); // the existing message
    expect(sys).toMatch(/\[affiliate_name\]/);
    // tailorRollout skips what is already tailored.
    expect((await engine.tailorRollout(rollout.id)).tailored).toBe(0);
  });

  it('Monday: learns again, and where the profile moved redoes the live bots as an update rollout, applied on its own when the shop allows it', async () => {
    const { q, engine, mcpCalls } = setup();
    await engine.learnShop('shop-de');
    // Same profile again: nothing to do.
    let r = await engine.weeklyUpdate({ shopIds: ['shop-de'] });
    expect(r).toMatchObject({ shops: 1, learned: 1, rollouts: [] });
    // The offer changes: the live Sample sent bot gets an update draft, tailored, waiting for approval.
    q.setSetting('playbook_top_pct_shop-de', '5');
    const origCall = engine['mcp'].call.bind(engine['mcp']);
    engine['mcp'].call = async (tool: string, args: Record<string, unknown>) => { const t = await origCall(tool, args); return tool === 'search_videos' && !args.just_count ? t.replace('Hier koennt ihr sparen', 'OFFER-B') : t; };
    r = await engine.weeklyUpdate({ shopIds: ['shop-de'] });
    expect(r.rollouts).toHaveLength(1);
    expect(r.rollouts[0]).toMatchObject({ shop: 'Kijimea DE', auto: false, done: 0 });
    expect(r.rollouts[0].reasons).toEqual(['the offer changed']);
    const drafts = q.listRolloutDrafts(r.rollouts[0].rollout_id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ key: 'sample_sent', action: 'update', tool: 'update_automation', status: 'ready' });
    expect(drafts[0].existing_copy).toMatch(/dein Sample ist unterwegs/);
    expect(drafts[0].copy).toMatch(/^TAILORED\(/);
    expect(q.getRollout(r.rollouts[0].rollout_id)!.note).toMatch(/Weekly learning: the offer changed/);
    // The team approves and rolls that one out; the bot is live again with the new copy.
    for (const d of drafts) engine.updateDraft(d.id, { status: 'approved' });
    expect((await engine.runRollout(r.rollouts[0].rollout_id, 'Isaac')).done).toBe(1);
    // With automatic updates on, the next material change is approved and applied without anyone.
    q.setSetting('playbook_auto_update_shop-de', '1');
    engine['mcp'].call = async (tool: string, args: Record<string, unknown>) => { const t = await origCall(tool, args); return tool === 'search_videos' && !args.just_count ? t : t; };
    r = await engine.weeklyUpdate({ shopIds: ['shop-de'] });
    expect(r.rollouts[0]).toMatchObject({ auto: true, done: 1 });
    expect(mcpCalls.filter((c) => c.tool === 'update_automation')).toHaveLength(2);
    expect(mcpCalls.filter((c) => c.tool === 'update_automation').every((c) => c.args.campaign_id === 'auto-2')).toBe(true);
  });
});
