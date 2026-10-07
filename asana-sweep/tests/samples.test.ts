import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { PlaybookEngine } from '../src/playbook/index';
import { categoryMatch, DEFAULT_RULES, judge, lightFor, parseAffiliate, parseCreatorBrands, parsePending, parseRelevance, relevancePrompt, SampleEngine } from '../src/samples/index';
import { AFFILIATE_LUNA, AFFILIATE_ZHINA, BRANDS_LUNA, BRANDS_ZHINA, PENDING_PAGE_1, PENDING_PAGE_2 } from './fixtures/cruva-samples';
import type { McpCaller } from '../src/cruva/mcp';
import type { SampleResearch, SampleShop } from '../src/sweep/types';

const research = (over: Partial<SampleResearch> = {}): SampleResearch => ({ creator_id: '1', categories: [], category_splits: {}, bio: null, content_quality: null, brand_collaborations: null, language: null, brands: [], competitor: null, category_match: null, relevant: 0, risk: 'none', note: null, researched_at: new Date().toISOString(), ...over });

describe('sample parsing and judging', () => {
  it('reads the pending queue as Cruva prints it, the affiliate record and the brands a creator sold for', () => {
    const p1 = parsePending(PENDING_PAGE_1);
    expect(p1.total).toBe(35); expect(p1.more).toBe(true);
    expect(p1.rows).toHaveLength(2);
    expect(p1.rows[0]).toMatchObject({ apply_id: '8071195658133805660', handle: 'lunaita._', name: 'Jumashop', followers: 5063, gmv_30d: 1236, engagement: 0.6, post_rate: 100, product_id: '1729569344482875607', variant: '14 Kapseln', submitted: '2026-10-04', commission: 15, videos: [] });
    expect(p1.rows[0].product).toMatch(/^Kijimea K53 Advance/);
    expect(p1.rows[1].videos).toEqual([{ url: 'https://www.tiktok.com/@zhina.gsp/video/7689768256151801120', views: 142 }, { url: 'https://www.tiktok.com/@zhina.gsp/video/7689567539638144288', views: 720 }]);
    const p2 = parsePending(PENDING_PAGE_2);
    expect(p2.more).toBe(false);
    expect(p2.rows[1]).toMatchObject({ handle: 'ukraris1313', name: null, followers: 924, gmv_30d: 0, engagement: null, post_rate: null });
    const aff = parseAffiliate(AFFILIATE_ZHINA)!;
    expect(aff.creator_id).toBe('7495576365264767105');
    expect(aff.category).toEqual(['Womenswear & Underwear', 'Kitchenware', 'Home Supplies']);
    expect(parseAffiliate('API error 404: No affiliate found')).toBeNull();
    expect(parseCreatorBrands(BRANDS_ZHINA)[1]).toEqual({ name: 'Evolsin', id: '7496147298848508435', gmv: 2034.65, videos: 3 });
    expect(categoryMatch(['Health', 'Food & Beverages'], { categories: ['Health'], products: [] })).toBe('Health');
    expect(categoryMatch(['Womenswear & Underwear'], { categories: ['Health'], products: ['Kijimea K53 Darm'] })).toBeNull();
    expect(categoryMatch(['Home Supplies'], { categories: ['Kitchen Supplies'], products: [] })).toBeNull(); // "supplies" alone is not a match
  });

  it('judges by the numbers first, then the research, and scores the shortlist', () => {
    const rows = parsePending(PENDING_PAGE_1).rows;
    const r = { ...DEFAULT_RULES, min_gmv: 500, min_engagement: 0, min_post_rate: 60, min_followers: 1000 };
    expect(judge(rows[0], null, r)).toMatchObject({ verdict: 'accept' });
    expect(judge(rows[0], null, { ...r, min_engagement: 2 })).toMatchObject({ verdict: 'skip', reasons: ['engagement 0.6% under 2%'] });
    expect(judge(parsePending(PENDING_PAGE_2).rows[0], null, r).reasons).toEqual(['30d GMV 0 under 500']);
    const noData = judge(parsePending(PENDING_PAGE_2).rows[1], null, { ...r, min_gmv: 0, min_followers: 0 });
    expect(noData.verdict).toBe('review'); expect(noData.reasons).toContain('no post rate yet');
    expect(judge(rows[0], null, { ...r, relevance: 'require' })).toMatchObject({ verdict: 'review', reasons: ['not researched yet'] });
    expect(judge(rows[0], research({ relevant: 0 }), { ...r, relevance: 'require' }).verdict).toBe('review');
    expect(judge(rows[0], research({ relevant: 0 }), { ...r, relevance: 'prefer' }).verdict).toBe('accept');
    const comp = judge(rows[0], research({ competitor: 'OmniBiotic', relevant: 2 }), r);
    expect(comp.verdict).toBe('accept'); expect(comp.reasons).toContain('sold for OmniBiotic'); expect(comp.score).toBeGreaterThan(judge(rows[0], null, r).score);
    expect(judge(rows[0], research({ risk: 'high', note: 'reseller account' }), r)).toMatchObject({ verdict: 'skip', reasons: ['brand risk: reseller account'] });
    expect(judge(rows[0], research({ risk: 'some', note: 'medical claims in bio' }), r).verdict).toBe('review');
    const { system, user } = relevancePrompt({ brand: 'Kijimea', market: 'DE', products: ['K53'], categories: ['Health'], competitors: ['OmniBiotic'], creators: [{ handle: 'zhina.gsp', bio: 'beauty', categories: ['Womenswear'], brands: ['ORNARTO'], followers: 18156, language: 'english' }] });
    expect(system).toMatch(/brand risk/); expect(user).toMatch(/Direct competitors: OmniBiotic/); expect(user).toMatch(/@zhina.gsp .* sold for: ORNARTO/);
    const v = parseRelevance('{"creators": [{"handle": "@zhina.gsp", "relevant": 1, "risk": "none", "note": null}, {"handle": "x", "relevant": 5, "risk": "HIGH", "note": "adult content"}]}');
    expect(v.get('zhina.gsp')).toEqual({ relevant: 1, risk: 'none', note: null });
    expect(v.get('x')).toEqual({ relevant: 2, risk: 'high', note: 'adult content' });
    expect(parseRelevance('nope').size).toBe(0);
  });

  it('lights the account from the queue age, the week against its targets and the shortlist', () => {
    const base: SampleShop = { shop_id: 's', shop_name: 'S', market: 'DE', account_id: 1, pending: 10, oldest_days: 1, shortlist: [], review: [], skipped: [], accepted: [], accepted_week: 0, auto_week: 0, cap: null, cap_source: null, min_target: null, scanned_at: '2026-10-07T08:00:00Z', error: null };
    const tue = Date.UTC(2026, 9, 6, 12); // a Tuesday: two days of the week elapsed
    expect(lightFor([{ ...base, scanned_at: null }]).light).toBe('grey');
    expect(lightFor([], tue)).toMatchObject({ light: 'grey', summary: 'No Cruva shop linked' });
    expect(lightFor([base], tue).light).toBe('green');
    expect(lightFor([{ ...base, oldest_days: 6 }], tue)).toMatchObject({ light: 'red' });
    expect(lightFor([{ ...base, shortlist: [{} as SampleShop['shortlist'][number]] }], tue)).toMatchObject({ light: 'amber', summary: '1 ready to accept · 10 to review · 1 shortlisted · 0 accepted this week' });
    expect(lightFor([{ ...base, cap: 14, cap_source: 'target', accepted_week: 1 }], tue).light).toBe('amber'); // 2 of 7 days gone, under 4
    expect(lightFor([{ ...base, cap: 14, cap_source: 'target', accepted_week: 4 }], tue).light).toBe('green');
    expect(lightFor([{ ...base, min_target: 7, accepted_week: 0 }], tue)).toMatchObject({ light: 'red' });
    expect(lightFor([{ ...base, error: 'boom' }], tue)).toMatchObject({ light: 'red', summary: 'Scan failed: boom' });
  });
});

describe('the samples engine', () => {
  const setup = (opts: { llm?: boolean } = {}) => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Kijimea', markets: 'DE', am_name: 'Federica', aa_name: null, enabled: true, notes: null, commission_pct: 15, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const mcp: McpCaller = { configured: true, async call(tool, args) {
      calls.push({ tool, args });
      if (tool === 'ai_search_sample_requests') return args.page === 1 ? PENDING_PAGE_1 : PENDING_PAGE_2;
      if (tool === 'get_affiliate_data') return args.handle === 'zhina.gsp' ? AFFILIATE_ZHINA : args.handle === 'lunaita._' ? AFFILIATE_LUNA : 'API error 404: No affiliate found';
      if (tool === 'list_creator_brands') return args.creator_id === '7001' ? BRANDS_LUNA : BRANDS_ZHINA;
      if (tool === 'search_sample_requests') return 'Sample requests (total: 2):\n';
      if (tool === 'approve_samples') return `Approved ${(args.apply_ids as string[]).length} sample request(s).`;
      if (tool === 'search_videos') return 'No videos found.';
      if (tool.startsWith('list_')) return 'No results.';
      return '';
    } };
    const playbook = new PlaybookEngine(q, mcp, null);
    playbook.seed();
    playbook.linkShop('shop-de', 'Kijimea DE', a.id);
    q.setSetting('playbook_learned_shop-de', JSON.stringify({ categories: ['Health'], products: ['Kijimea K53 Advance'] }));
    q.upsertShopCompetitor({ shop_id: 'shop-de', brand_id: '8001', name: 'OmniBiotic', region: 'de', gmv: 1, creators: 1, videos: 1, category: null, status: 'confirmed', reason: null, source: 'manual' });
    const llm = opts.llm === false ? null : async (_s: string, user: string) => JSON.stringify({ creators: [{ handle: 'zhina.gsp', relevant: 0, risk: 'none', note: 'fashion and kitchen, not gut health' }, ...(user.includes('@natalia.natalia880') ? [{ handle: 'natalia.natalia880', relevant: 1, risk: 'some', note: 'bio mentions a pharmacy resale' }] : [])] });
    const engine = new SampleEngine(q, playbook, mcp, llm, { minGapMs: 0 });
    return { q, a, engine, calls };
  };

  it('scans the queue, researches what clears the numbers, shortlists by the rules and the cap from Targets, and accepts in bulk only once', async () => {
    const { q, a, engine, calls } = setup();
    q.setAccountTarget(a.id, '', 'samples_per_week', 10, 'test');
    engine.setRules(a.id, { min_gmv: 500, min_engagement: 0, min_post_rate: 60, min_followers: 1000, relevance: 'prefer' });
    const s = await engine.scanShop('shop-de');
    expect(calls.filter((c) => c.tool === 'ai_search_sample_requests')).toHaveLength(2); // both pages
    expect(s.pending).toBe(5);
    expect(s.cap).toBe(10); expect(s.cap_source).toBe('target'); expect(s.accepted_week).toBe(2); // Cruva's count of approvals this week
    expect(s.shortlist.map((r) => r.handle)).toEqual(['lunaita._', 'zhina.gsp', 'natalia.natalia880'].filter((h) => s.shortlist.some((r) => r.handle === h)));
    const luna = s.shortlist.find((r) => r.handle === 'lunaita._')!;
    expect(luna.research?.competitor).toBe('OmniBiotic'); expect(luna.research?.category_match).toBe('Health'); expect(luna.research?.relevant).toBe(2);
    expect(luna.reasons).toContain('sold for OmniBiotic');
    const zhina = s.shortlist.find((r) => r.handle === 'zhina.gsp')!;
    expect(zhina.research?.note).toBe('fashion and kitchen, not gut health'); expect(zhina.research?.relevant).toBe(0);
    expect(luna.score).toBeGreaterThan(zhina.score);
    expect(s.review.map((r) => r.handle)).toEqual(['natalia.natalia880']); // Claude said check first
    expect(s.skipped.map((r) => r.handle).sort()).toEqual(['patiencebeer', 'ukraris1313']);
    // Research is not repeated within a fortnight, and only for creators that clear the numbers.
    expect(calls.filter((c) => c.tool === 'get_affiliate_data').map((c) => c.args.handle).sort()).toEqual(['lunaita._', 'natalia.natalia880', 'zhina.gsp']);
    calls.length = 0;
    await engine.scanShop('shop-de');
    expect(calls.filter((c) => c.tool === 'get_affiliate_data')).toHaveLength(0);
    // Bulk accept: approve_samples gets exactly the pending ids, a second accept of the same id is skipped.
    const r = await engine.accept('shop-de', [luna.apply_id, 'nope'], 'isaac');
    expect(r.accepted.map((x) => x.handle)).toEqual(['lunaita._']); expect(r.skipped).toEqual(['nope']);
    expect(calls.find((c) => c.tool === 'approve_samples')!.args).toEqual({ shop_id: 'shop-de', apply_ids: [luna.apply_id] });
    const again = await engine.accept('shop-de', [luna.apply_id], 'isaac');
    expect(again.accepted).toEqual([]); expect(calls.filter((c) => c.tool === 'approve_samples')).toHaveLength(1);
    const acc = engine.data().accounts.find((x) => x.name === 'Kijimea')!;
    expect(acc.light).toBe('red'); expect(acc.summary).toMatch(/waiting \d+ days/); // a request from 2026-09-28 still sits in the queue
    expect(acc.shops[0].accepted.map((x) => x.handle)).toEqual(['lunaita._']);
    expect(acc.shops[0].accepted_week).toBe(3); // Cruva's 2 plus the one just approved here
    // Rescanning after Cruva dropped the approved request keeps it as accepted, not pending.
    await engine.scanShop('shop-de');
    expect(q.getSampleRequest('shop-de', luna.apply_id)?.status).toBe('accepted');
  });

  it('auto-accepts the top of the shortlist up to the weekly number and never past the cap', async () => {
    const { q, a, engine, calls } = setup();
    q.setAccountTarget(a.id, 'DE', 'samples_per_week', 3, 'test'); // market-specific target wins; Cruva already counts 2 this week
    engine.setRules(a.id, { min_gmv: 500, min_engagement: 0, min_post_rate: 60, min_followers: 1000, relevance: 'prefer', auto_accept: true, auto_per_week: 5 });
    const s = await engine.scanShop('shop-de');
    const approved = calls.filter((c) => c.tool === 'approve_samples');
    expect(approved).toHaveLength(1);
    expect((approved[0].args.apply_ids as string[])).toHaveLength(1); // room under the cap: 3 - 2
    expect(s.accepted[0].handle).toBe('lunaita._'); expect(s.accepted[0].decided_by).toBe('auto'); expect(s.auto_week).toBe(1);
    expect(engine.data().accounts.find((x) => x.name === 'Kijimea')!.rules.auto_accept).toBe(true);
    // The cap override replaces the target.
    engine.setRules(a.id, { cap_override: 20 });
    const d = engine.data().accounts.find((x) => x.name === 'Kijimea')!.shops[0];
    expect(d.cap).toBe(20); expect(d.cap_source).toBe('override');
  });

  it('works without Claude: relevance from the competitor and category match alone', async () => {
    const { a, engine } = setup({ llm: false });
    engine.setRules(a.id, { min_gmv: 500, min_engagement: 0, min_post_rate: 60, min_followers: 1000, relevance: 'require' });
    const s = await engine.scanShop('shop-de');
    expect(s.shortlist.map((r) => r.handle)).toEqual(['lunaita._', 'natalia.natalia880'].filter((h) => s.shortlist.some((r) => r.handle === h)));
    expect(s.review.find((r) => r.handle === 'zhina.gsp')?.reasons).toContain('not clearly relevant to the brand');
  });
});
