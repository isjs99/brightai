import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { briefFromLearning, PlaybookEngine } from '../src/playbook/index';
import { makeThrottle, marketChange, marketFacts, marketPrompt, parseBrandCreators, parseBrands, parseBrandVideos, parseMarket, parseSuggestions, parseVideoTotal, pickBrand, pullMarket, rankMarket, scriptFromSubtitles, suggestPrompt } from '../src/playbook/competitors';
import { BRAND_CREATORS, BRAND_VIDEOS, BRANDS, BRANDS_OMNI, SCRIPT } from './fixtures/cruva-market';
import { VIDEOS_COUNT, VIDEOS_PAGE } from './fixtures/cruva-videos';
import type { McpCaller } from '../src/cruva/mcp';
import type { PlaybookCompetitor } from '../src/sweep/types';

const comp = (over: Partial<PlaybookCompetitor> = {}): PlaybookCompetitor => ({ id: 1, shop_id: 'shop-de', brand_id: '8001', name: 'OmniBiotic', region: 'de', gmv: 9120, creators: 210, videos: 140, category: 'Health', status: 'confirmed', reason: null, source: 'manual', added_at: '2026-10-07T00:00:00.000Z', scanned_at: null, ...over });

describe('marketplace parsing', () => {
  it('reads brands, picks the brand that was asked for, reads a brand\'s videos and creators and a FastMoss script', () => {
    expect(parseBrands(BRANDS)).toEqual([{ name: 'Kijimea', brand_id: '7496168849371662551', gmv: 16931.76, creators: 646, videos: 319, category: null }]);
    const omni = parseBrands(BRANDS_OMNI);
    expect(omni).toHaveLength(3);
    expect(omni[2]).toMatchObject({ name: 'Omni-Biotic Stress', brand_id: '8003', category: 'Health' });
    expect(pickBrand('OmniBiotic', omni)?.brand_id).toBe('8001'); // exact beats the big store that merely contains the word
    expect(pickBrand('Omni-Biotic', omni)?.brand_id).toBe('8001'); // punctuation does not matter
    expect(pickBrand('Omni', omni)?.brand_id).toBe('8002'); // no exact match: the biggest near match
    expect(pickBrand('Kijimea', omni)).toBeNull();
    const vids = parseBrandVideos(BRAND_VIDEOS, { brand_id: '8001', name: 'OmniBiotic' });
    expect(vids).toHaveLength(2);
    expect(vids[0]).toMatchObject({ video_id: '7692508899269774625', handle: 'lissy_gala', gmv: 215.94, views: 13200, likes: 71, comments: 1, posted: '2026-10-03', product_id: '1729573925553543383', link: 'https://tiktok.com/@lissy_gala/video/7692508899269774625', brand_name: 'OmniBiotic' });
    expect(vids[0].product).toMatch(/^OmniBiotic Magen/);
    expect(vids[1]).toMatchObject({ overview: 'Creator shows her morning routine and the sachet in a glass of water.', hook: 'Ich habe 3 Wochen lang jeden Morgen das hier getrunken.' });
    const creators = parseBrandCreators(BRAND_CREATORS, { brand_id: '8001', name: 'OmniBiotic' });
    expect(creators).toHaveLength(2);
    expect(creators[0]).toMatchObject({ handle: 'nebras.akeel8', creator_id: '7495439929099324058', brand_gmv: 32317.92, platform_gmv_30d: 7240, followers: 32625, ours: false });
    expect(parseVideoTotal(BRAND_VIDEOS)).toBe(344);
    expect(parseVideoTotal('Videos for brand 1:\n')).toBeNull();
    const ranked = rankMarket(vids, 10, 344); // top 10% of 344 = 35 slots, both videos make it; the 66k-view one also by GMV per view
    expect(ranked.every((v) => v.top)).toBe(true);
    expect(rankMarket([{ ...vids[0], gmv: 0 }], 10, 1)[0].top).toBe(false);
    expect(scriptFromSubtitles(SCRIPT)).toBe('ребят у кого изжога рекомендую\nблин офигенно классная штука\nссылочка снизу');
    expect(scriptFromSubtitles({ data: [] })).toBeNull();
    expect(scriptFromSubtitles('nope')).toBeNull();
  });

  it('spaces the marketplace calls out to two a second and marks the creators we already have', async () => {
    const waits: number[] = []; let clock = 0;
    const throttle = makeThrottle(600, async (ms) => { waits.push(ms); clock += ms; });
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const mcp: McpCaller = { configured: true, async call(tool, args) { calls.push({ tool, args }); if (tool === 'list_marketplace_brand_videos') return BRAND_VIDEOS; if (tool === 'list_brand_creators') return BRAND_CREATORS; return ''; } };
    const scripts = async (id: string) => (id === '7692508899269774625' ? 'ребят у кого изжога' : null);
    const r = await pullMarket(mcp, [comp()], { from: '2026-09-09', to: '2026-10-07', region: 'de', throttle, scripts, ourHandles: new Set(['Lissy_Gala']) });
    expect(calls.map((c) => c.tool)).toEqual(['list_marketplace_brand_videos', 'list_brand_creators']);
    expect(calls[0].args).toMatchObject({ brand_id: '8001', region: 'de', sort: 'gmv', ts_start: '2026-09-09', ts_end: '2026-10-07' });
    expect(r.total).toBe(344);
    expect(r.videos[0].script).toBe('ребят у кого изжога');
    expect(r.videos[1].script).toBeNull();
    expect(r.creators.find((c) => c.handle === 'lissy_gala')!.ours).toBe(true);
    expect(r.creators.find((c) => c.handle === 'nebras.akeel8')!.ours).toBe(false);
    expect(r.errors).toEqual([]);
    expect(clock).toBeGreaterThan(0); // the second call waited its turn
  });
});

describe('competitor prompts', () => {
  it('asks for direct competitors only, verifies claims against the videos read and keeps creators that are not ours', () => {
    const sp = suggestPrompt({ shop_name: 'Kijimea DE', brand: 'Kijimea', market: 'DE', products: ['Kijimea K53 Advance'], categories: ['Health'], profile_summary: 'Problem-first hooks sell K53.', known: ['OmniBiotic'] });
    expect(sp.system).toMatch(/compete directly/);
    expect(sp.user).toMatch(/do not repeat\): OmniBiotic/);
    expect(parseSuggestions('{"competitors": [{"name": "Omni-Biotic", "why": "Probiotic sachets, same price", "direct": true}, {"name": "", "why": ""}, {"name": "Symbiolact", "why": "Capsules", "direct": false}]}')).toEqual([{ name: 'Omni-Biotic', why: 'Probiotic sachets, same price', direct: true }, { name: 'Symbiolact', why: 'Capsules', direct: false }]);
    expect(() => parseSuggestions('sorry')).toThrow(/JSON/);

    const videos = parseBrandVideos(BRAND_VIDEOS, { brand_id: '8001', name: 'OmniBiotic' });
    const creators = parseBrandCreators(BRAND_CREATORS, { brand_id: '8001', name: 'OmniBiotic' }); creators[1].ours = true;
    const mp = marketPrompt({ shop_name: 'Kijimea DE', brand: 'Kijimea', market: 'DE', language: 'de', competitors: [comp()], videos, creators, ours: null, window_from: '2026-09-09', window_to: '2026-10-07' });
    expect(mp.user).toMatch(/@nebras.akeel8 .* not ours/);
    expect(mp.user).toMatch(/@lissy_gala .* ours too/);
    expect(mp.user).toMatch(/hook: "Ich habe 3 Wochen/);
    const raw = JSON.stringify({ summary: 'Morning-routine sachet videos carry OmniBiotic.', trends: [{ name: 'Morning routine', detail: 'sachet in water on camera', brands: ['OmniBiotic'], video_ids: ['7690571915383164193', 'nope'] }, { name: 'Made up', detail: 'x', brands: [], video_ids: ['nope'] }], hooks: [{ group: 'routine', example: 'Ich habe 3 Wochen lang jeden Morgen das hier getrunken.', brand: 'OmniBiotic', video_ids: ['7690571915383164193'] }], formats: [{ name: 'talking head', video_ids: ['7692508899269774625', '7690571915383164193'] }], products: [{ name: 'OmniBiotic Magen', brand: 'OmniBiotic', gmv: 999999, angle: 'heartburn after meals', video_ids: ['7692508899269774625'] }], gaps: ['Nobody films the sachet for us'], ideas: ['Morgenroutine mit dem Sachet'], creators_to_approach: [{ handle: '@nebras.akeel8', brand: 'OmniBiotic', why: 'Biggest seller for them' }, { handle: 'lissy_gala', brand: 'OmniBiotic', why: 'already ours' }, { handle: 'ghost', brand: 'x', why: 'y' }] });
    const m = parseMarket(raw, { competitors: [comp()], videos, creators, window_from: '2026-09-09', window_to: '2026-10-07' });
    expect(m.trends).toHaveLength(1);
    expect(m.trends[0].video_ids).toEqual(['7690571915383164193']);
    expect(m.products[0].gmv).toBe(216); // computed from the videos, not the model's number
    expect(m.creators_to_approach.map((c) => c.handle)).toEqual(['nebras.akeel8']); // ours and unknown creators dropped
    expect(m.creators_to_approach[0]).toMatchObject({ creator_id: '7495439929099324058', brand_gmv: 32318, followers: 32625 });
    expect(m.competitors[0]).toMatchObject({ name: 'OmniBiotic', videos_read: 2, creators_read: 2 });
    expect(m.videos[0].gmv).toBe(215.94);
    const facts = marketFacts(m);
    expect(facts[0]).toMatch(/^The market right now: Morning-routine/);
    expect(facts.join('\n')).toMatch(/Trends in competitor videos: Morning routine/);
    expect(facts.join('\n')).toMatch(/What competitors do that this shop does not: Nobody films/);
    expect(marketFacts(null)).toEqual([]);
    expect(m.videos_total).toBe(2);
    expect(marketChange(null, m)).toEqual(['first market read']);
    expect(marketChange(m, m)).toEqual([]);
    expect(marketChange(m, { ...m, trends: [] })[0]).toMatch(/leading trend moved from Morning routine to none/);
  });
});

describe('competitors in the engine', () => {
  const setup = () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Kijimea', markets: 'DE', am_name: 'Federica', aa_name: null, enabled: true, notes: null, commission_pct: 15, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    const mcpCalls: { tool: string; args: Record<string, unknown> }[] = [];
    const mcp: McpCaller = { configured: true, async call(tool, args) {
      mcpCalls.push({ tool, args });
      if (tool === 'search_marketplace_brands') return /kijimea/i.test(String(args.search)) ? BRANDS : /omni/i.test(String(args.search)) ? BRANDS_OMNI : 'No brands found.';
      if (tool === 'list_marketplace_brand_videos') return BRAND_VIDEOS;
      if (tool === 'list_brand_creators') return BRAND_CREATORS;
      if (tool === 'search_videos') return args.just_count ? VIDEOS_COUNT : VIDEOS_PAGE;
      if (tool === 'tag_creators') return 'Tagged.';
      if (tool.startsWith('list_')) return 'No results.';
      return '';
    } };
    const llmCalls: { system: string; user: string }[] = [];
    const llm = async (system: string, user: string) => {
      llmCalls.push({ system, user });
      if (/compete directly/.test(system)) return '{"competitors": [{"name": "Omni-Biotic", "why": "Probiotic sachets at the same price", "direct": true}, {"name": "Kijimea", "why": "itself", "direct": true}, {"name": "Nowhere Brand", "why": "x", "direct": false}]}';
      if (/direct competitors of/.test(system)) return JSON.stringify({ summary: 'Morning-routine sachet videos carry OmniBiotic.', trends: [{ name: 'Morning routine', detail: 'sachet in water', brands: ['OmniBiotic'], video_ids: ['7690571915383164193'] }], hooks: [{ group: 'routine', example: 'Ich habe 3 Wochen lang jeden Morgen das hier getrunken.', brand: 'OmniBiotic', video_ids: ['7690571915383164193'] }], formats: [], products: [], gaps: ['Nobody films the sachet for us'], ideas: ['Morgenroutine mit dem Sachet'], creators_to_approach: [{ handle: 'nebras.akeel8', brand: 'OmniBiotic', why: 'Biggest seller for them' }] });
      if (/describe how the brand/.test(system)) return '{"summary": "Warm du.", "greeting": null, "signoff": "Team Kijimea", "register": "du", "emoji": "light", "length": "short", "phrases": [], "avoid": []}';
      if (/study the TikTok Shop affiliate videos/.test(system)) return JSON.stringify({ summary: 'Problem-first hooks sell K53.', hooks: [], formats: [], products_carry: [], products_no_gmv: [], creator_shape: { follower_band: null, niches: [], first_video_share: null, video_ids: [] }, timing: { best_days: [], best_hours: [], video_ids: [] }, offer: null, example_scripts: [], content_ideas: [], top_creators: [] });
      if (/in the brand's own voice/.test(system)) return `TAILORED(${/direct competitors are doing/.test(system) ? 'with market' : 'no market'})`;
      return 'x';
    };
    const scripts = async (id: string) => (id === '7692508899269774625' ? 'ребят у кого изжога' : null);
    const engine = new PlaybookEngine(q, mcp, llm, scripts);
    engine.seed();
    engine.linkShop('shop-de', 'Kijimea DE', a.id);
    q.replaceRemoteItems('shop-de', 'automation', [{ remote_id: 'auto-1', name: 'September Deals', enabled: true, raw: { copy: 'Hey [affiliate_name], Team Kijimea', sent: 100, replies: 5, gmv: 50 } }]);
    return { q, engine, mcpCalls, llmCalls };
  };

  it('suggests direct competitors, verifies each in the marketplace index, never lists the shop itself, and lets the team confirm, add and reject', async () => {
    const { q, engine, mcpCalls } = setup();
    const r = await engine.suggestCompetitors('shop-de');
    expect(r.added.map((c) => c.name)).toEqual(['OmniBiotic']); // "Omni-Biotic" matched the exact brand, not the big store
    expect(r.added[0]).toMatchObject({ brand_id: '8001', gmv: 9120, creators: 210, status: 'suggested', source: 'claude', region: 'de' });
    expect(r.added[0].reason).toMatch(/^Direct: Probiotic sachets/);
    expect(r.unmatched).toEqual(['Nowhere Brand']);
    expect(q.getSetting('playbook_brand_id_shop-de', '')).toBe('7496168849371662551'); // our own brand id, looked up once
    expect(mcpCalls.filter((c) => c.tool === 'search_marketplace_brands').every((c) => c.args.region === 'de')).toBe(true);
    // Suggesting again repeats nothing.
    const again = await engine.suggestCompetitors('shop-de');
    expect(again.added).toEqual([]);
    const c = engine.competitors('shop-de');
    expect(c.competitors).toHaveLength(1);
    expect(c.brand_id).toBe('7496168849371662551');
    engine.setCompetitorStatus('shop-de', c.competitors[0].id, 'rejected');
    expect(engine.competitors('shop-de').competitors[0].status).toBe('rejected');
    // Added by name: confirmed straight away, and a rejected brand added by name becomes confirmed.
    const added = await engine.addCompetitor('shop-de', 'OmniBiotic');
    expect(added.status).toBe('confirmed');
    await expect(engine.addCompetitor('shop-de', 'Nowhere')).rejects.toThrow(/No brand called "Nowhere"/);
    engine.removeCompetitor('shop-de', added.id);
    expect(engine.competitors('shop-de').competitors).toEqual([]);
    expect(engine.shops().find((s) => s.shop_id === 'shop-de')!.competitors).toBe(0);
  });

  it('scans the confirmed competitors, writes the market read with the creators to approach, and the read goes into learning and tailoring', async () => {
    const { q, engine, llmCalls, mcpCalls } = setup();
    expect(await engine.scanMarket('shop-de')).toBeNull(); // nothing to read yet
    const r = await engine.learnShop('shop-de'); // first learning: suggests, then scans the suggestions
    expect(r.errors).toEqual([]);
    expect(r.market?.summary).toMatch(/Morning-routine/);
    expect(r.market?.creators_to_approach[0]).toMatchObject({ handle: 'nebras.akeel8', brand: 'OmniBiotic', brand_gmv: 32318 });
    expect(r.market?.videos[0].script).toBe('ребят у кого изжога'); // through the script reader (FastMoss)
    const scan = llmCalls.find((c) => /direct competitors of/.test(c.system))!;
    expect(scan.user).toMatch(/This shop's own profile: Problem-first hooks sell K53/);
    expect(mcpCalls.find((c) => c.tool === 'list_marketplace_brand_videos')!.args).toMatchObject({ brand_id: '8001', region: 'de', page_size: 15 });
    const shop = engine.shops().find((s) => s.shop_id === 'shop-de')!;
    expect(shop.market_read?.learned_at).toBe(r.market?.learned_at);
    expect(shop.competitors).toBe(1);
    expect(engine.competitors('shop-de').competitors[0].scanned_at).not.toBeNull();
    // Confirm it; a scan after that reads only confirmed brands.
    const { competitors } = engine.competitors('shop-de');
    engine.setCompetitorStatus('shop-de', competitors[0].id, 'confirmed');
    engine.setCompetitorStatus('shop-de', (await engine.addCompetitor('shop-de', 'Omni')).id, 'suggested');
    mcpCalls.length = 0;
    await engine.scanMarket('shop-de');
    expect(mcpCalls.filter((c) => c.tool === 'list_marketplace_brand_videos').map((c) => c.args.brand_id)).toEqual(['8001']);
    expect(engine.competitors('shop-de').history.length).toBeGreaterThanOrEqual(2); // the link also queued a background learn
    // The initial drafts carry it too: the creator brief's hooks and do-rules come from the shop's own profile and the market read.
    const { rollout: first } = engine.prepare({ shop_ids: ['shop-de'], keys: ['brief:creator_brief'], created_by: 'test', tailor: false });
    const brief = q.listRolloutDrafts(first.id).find((x) => x.kind === 'brief')!;
    expect(brief.payload.top_hooks).toEqual(['Ich habe 3 Wochen lang jeden Morgen das hier getrunken.']);
    expect((brief.payload.guidelines as { type: string; description: string }[]).some((g) => g.type === 'do' && g.description === 'Morgenroutine mit dem Sachet')).toBe(true);
    expect(briefFromLearning({ top_hooks: ['generic'], guidelines: [] }, { profile: null, market_read: null })).toEqual({ top_hooks: ['generic'], guidelines: [] });
    // Tailoring now carries the market read.
    const { rollout } = engine.prepare({ shop_ids: ['shop-de'], keys: ['automation:delivered'], created_by: 'test', tailor: false });
    const d = q.listRolloutDrafts(rollout.id).find((x) => x.copy)!;
    const t = await engine.tailorDraft(d.id);
    expect(t.copy).toBe('TAILORED(with market)');
    const tail = llmCalls.filter((c) => /in the brand's own voice/.test(c.system)).pop()!;
    expect(tail.system).toMatch(/never name a competitor/);
    expect(tail.system).toMatch(/What competitors do that this shop does not: Nobody films/);
  });
});
