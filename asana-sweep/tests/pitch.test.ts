import { describe, expect, it } from 'vitest';
import { Queries } from '../src/db/queries';
import { openTestDb } from '../src/db/index';
import type { FastmossClient } from '../src/bd/fastmoss';
import type { CruvaMcp } from '../src/cruva/mcp';
import { parseAmazon, parseCruvaBrand, parseCruvaCreators, parsePage, researchPitch } from '../src/pitch/research';
import { DEFAULT_BRIEF, applyDeckJson, buildDeck, deckHtml, normaliseBrief, paletteFor, templateDeck } from '../src/pitch/deck';
import type { Pitch, PitchResearch } from '../src/sweep/types';

const CRUVA_CREATORS = `Found 3 creators:
- @glowwithanna (Anna K.) | 20,220 followers | 30d GMV $10333.0 | engagement 1.2% | similarity 0.91 | Beauty, Skincare
  video: https://www.tiktok.com/@glowwithanna/video/1
- @fitmax.de | 1,200 followers | 30d GMV $0 | engagement 4.5% | Fitness
- @nothing here
`;

describe('pitch research parsers', () => {
  it('reads the Cruva creator and brand lines', () => {
    const c = parseCruvaCreators(CRUVA_CREATORS);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ handle: 'glowwithanna', name: 'Anna K.', followers: 20220, gmv_30d: 10333, engagement: 1.2, categories: 'Beauty, Skincare', video_url: 'https://www.tiktok.com/@glowwithanna/video/1', source: 'cruva' });
    expect(c[1]).toMatchObject({ handle: 'fitmax.de', name: null, followers: 1200, gmv_30d: 0, categories: 'Fitness', video_url: null });
    expect(parseCruvaBrand('Neuro Gum (brand_id: 4411) - GMV: $16,196.73 | Creators: 646 | Videos: 305 | Category: Health', 'DE')).toEqual({ name: 'Neuro Gum', gmv: 16196.73, creators: 646, videos: 305, region: 'DE' });
    expect(parseCruvaBrand('No brands found', 'DE')).toBeNull();
  });

  it('pulls title, description, theme colour, price and product images out of a page', () => {
    const html = `<html><head><title>Neuro Gum &amp; Mints</title><meta property="og:title" content="Neuro Gum"><meta name="description" content="Energy and focus gum."><meta name="theme-color" content="#ff5a1f"><meta property="og:image" content="/img/hero.jpg"><meta property="product:price:amount" content="19,90"></head>
<body><img src="/img/logo.png" width="80"><img src="/img/pack.jpg" width="800" height="800"><img data-src="https://cdn.x/pack2.webp"><img src="/img/icon-cart.png"><img src="/tiny.jpg" width="40" height="40"></body></html>`;
    const p = parsePage(html, 'https://neurogum.com/products/gum');
    expect(p).toMatchObject({ title: 'Neuro Gum', description: 'Energy and focus gum.', theme_colour: '#ff5a1f', price: 19.9, og_image: 'https://neurogum.com/img/hero.jpg' });
    expect(p.images).toEqual(['https://neurogum.com/img/hero.jpg', 'https://neurogum.com/img/pack.jpg', 'https://cdn.x/pack2.webp']);
    expect(parsePage('<html><title>Plain</title></html>', 'https://x.y').title).toBe('Plain');
  });

  it('reads Amazon result cards best effort', () => {
    const card = (asin: string, title: string, price: string | null) => `<div data-asin="${asin}" class="s-result-item"><h2 class="a-size"><a><span>${title}</span></a></h2>${price ? `<span class="a-price"><span class="a-offscreen">${price}</span></span>` : ''}</div>`;
    const items = parseAmazon(card('B0ABCDEFGH', 'Neuro Gum Energy &amp; Focus 54 pieces', '€19,90') + card('B0ABCDEFGI', 'Neuro Gum Energy &amp; Focus 54 pieces', '€18,00') + card('B0ZZZZZZZZ', 'Neuro Mints', null), 'https://www.amazon.de');
    expect(items).toEqual([{ title: 'Neuro Gum Energy & Focus 54 pieces', price: '€19,90', url: 'https://www.amazon.de/dp/B0ABCDEFGH' }, { title: 'Neuro Mints', price: null, url: 'https://www.amazon.de/dp/B0ZZZZZZZZ' }]);
    expect(parseAmazon('<html>Robot check</html>', 'https://www.amazon.de')).toEqual([]);
  });
});

describe('pitch brief and palette', () => {
  it('normalises a partial brief with the defaults and drops bad values', () => {
    const b = normaliseBrief({ client: '  Neuro Gum ', markets: ['de', 'uk'], colours: { primary: '#FF5A1F', secondary: 'red', accent: '#1e8f4e' }, pricing: { retainer: '3000', commission_pct: null, commission_basis: 'mor', term_months: 6 } as never, forecast: { months: 99, start_gmv: '20000' } as never, products: [{ name: 'Gum', price: '19.9', url: 'https://neurogum.com/p/gum' }, { name: '' }] as never, pdp_images: ['https://cdn/x.jpg', 'javascript:alert(1)'], options: { amazon: false } as never });
    expect(b.client).toBe('Neuro Gum');
    expect(b.markets).toEqual(['DE', 'UK']);
    expect(b.colours).toEqual({ primary: '#ff5a1f', secondary: DEFAULT_BRIEF.colours.secondary, accent: '#1e8f4e' });
    expect(b.pricing).toMatchObject({ retainer: 3000, commission_pct: null, commission_basis: 'mor', term_months: 6, currency: 'EUR' });
    expect(b.forecast.months).toBe(24);
    expect(b.forecast.start_gmv).toBe(20000);
    expect(b.products).toEqual([{ name: 'Gum', price: 19.9, url: 'https://neurogum.com/p/gum', image: null }]);
    expect(b.pdp_images).toEqual(['https://cdn/x.jpg']);
    expect(b.options).toMatchObject({ amazon: false, creators: true });
    expect(normaliseBrief(null)).toEqual(DEFAULT_BRIEF);
  });

  it('derives a dark ink and a light paper from the client primary', () => {
    const pal = paletteFor({ primary: '#ff5a1f', secondary: '#1d3df0', accent: '#1e8f4e' });
    expect(pal.primary).toBe('#ff5a1f');
    expect(pal.ink).toMatch(/^#[0-9a-f]{6}$/);
    expect(pal.paper).toMatch(/^#[0-9a-f]{6}$/);
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(pal.ink)).toBeLessThan(120);
    expect(lum(pal.paper)).toBeGreaterThan(700);
  });
});

const research = (): PitchResearch => ({
  fetched_at: '2026-10-06T10:00:00.000Z', errors: [], site: { title: 'Neuro Gum', description: 'Energy and focus gum.', theme_colour: '#ff5a1f', images: ['https://neurogum.com/img/hero.jpg'] }, products: [{ name: 'Gum', price: 19.9, image: 'https://neurogum.com/img/pack.jpg', url: 'https://neurogum.com/p/gum' }],
  context: [{ kind: 'call', title: 'Brightform x Neuro Gum', occurred_at: '2026-10-01T12:00:00.000Z', url: null, snippet: 'They want DE first, then UK.' }],
  tiktok: { brand: { name: 'Neuro Gum', gmv: 16196, creators: 646, videos: 305, region: 'DE' }, shops: [{ shop_name: 'Neuro Gum Official', region: 'DE', gmv_7d: 4000, total_gmv: 90000, seller_id: '1' }, { shop_name: 'VitaReseller', region: 'DE', gmv_7d: 300, total_gmv: 2000, seller_id: '2' }], top_products: [{ name: 'Focus gum 54', region: 'DE', gmv: 12000, units: 500, price: 19.9, shop: 'Neuro Gum Official' }], market: [{ market: 'DE', prospects: 120, surging: 9, leaders: ['Kijimea', 'Nutori'] }] },
  creators: [{ handle: 'glowwithanna', name: 'Anna K.', followers: 20220, gmv_30d: 10333, engagement: 1.2, categories: 'Beauty, Skincare', video_url: null, source: 'cruva' }],
  amazon: { reachable: true, items: [{ title: 'Neuro Gum 54 pieces', price: '€19,90', url: 'https://www.amazon.de/dp/B0ABCDEFGH' }] },
  resellers: [{ name: 'VitaReseller', region: 'DE', gmv_7d: 300, note: 'sells the brand' }],
});

describe('pitch deck', () => {
  it('builds the template deck from the brief and the research, honouring the options', () => {
    const q = new Queries(openTestDb());
    const brief = normaliseBrief({ client: 'Neuro Gum', website: 'neurogum.com', category: 'focus gum', markets: ['DE'] });
    const deck = templateDeck(q, brief, research());
    const keys = deck.slides.map((s) => s.key);
    expect(keys).toEqual(['cover', 'agenda', 'about', 'market', 'presence', 'products', 'opportunity', 'forecast', 'creators', 'content', 'livestream', 'case_studies', 'pricing', 'roadmap', 'next']);
    const by = (k: string) => deck.slides.find((s) => s.key === k)!;
    expect(by('cover').title).toBe('Neuro Gum x Brightform');
    expect(by('cover').images).toEqual(['https://neurogum.com/img/pack.jpg']);
    expect(by('presence').stats[0]).toMatchObject({ label: 'Brand GMV, last 30 days (DE)' });
    expect(by('presence').bullets.some((b) => b.startsWith('VitaReseller'))).toBe(true);
    expect(by('presence').bullets.some((b) => b.startsWith('Amazon:'))).toBe(true);
    expect(by('market').stats[0]).toMatchObject({ value: '120', note: '9 surging this week' });
    expect(by('creators').bullets.some((b) => b.includes('@glowwithanna') && b.includes('20k followers'))).toBe(true);
    expect(by('forecast').stats).toHaveLength(3);
    expect(by('forecast').title).toBe('12-month forecast');
    expect(by('pricing').stats.map((s) => s.label)).toEqual(['Retainer', 'Commission', 'Initial term']);
    expect(deck.palette.primary).toBe(DEFAULT_BRIEF.colours.primary);
    expect(deck.generator).toBe('template');

    const lean = templateDeck(q, normaliseBrief({ client: 'X', options: { forecasts: false, livestream: false, market: false, case_studies: false, creators: false, pdp_imagery: false } as never, pricing: { retainer: null, commission_pct: 8, commission_basis: 'mor' } as never }), null);
    expect(lean.slides.map((s) => s.key)).toEqual(['cover', 'agenda', 'about', 'presence', 'opportunity', 'content', 'pricing', 'roadmap', 'next']);
    expect(lean.slides.find((s) => s.key === 'pricing')!.stats.map((s) => s.label)).toEqual(['Commission', 'Initial term']);
    expect(lean.slides.find((s) => s.key === 'presence')!.body).toMatch(/Run the research/);
  });

  it('applies Claude copy by slide key, keeps custom slides across a rebuild, and falls back on bad JSON', async () => {
    const q = new Queries(openTestDb());
    const brief = normaliseBrief({ client: 'Neuro Gum' });
    const deck = templateDeck(q, brief, null);
    const out = applyDeckJson('Here you go:\n{"slides": [{"key": "cover", "title": "Neuro Gum, live on TikTok Shop DE", "subtitle": null, "bullets": [], "notes": "Open warm."}, {"key": "nope", "title": "x"}, {"key": "about", "bullets": ["One", "Two"]}]}', deck);
    expect(out.generator).toBe('claude');
    expect(out.slides[0]).toMatchObject({ title: 'Neuro Gum, live on TikTok Shop DE', subtitle: null, notes: 'Open warm.' });
    expect(out.slides[0].bullets).toEqual(deck.slides[0].bullets);
    expect(out.slides.find((s) => s.key === 'about')!.bullets).toEqual(['One', 'Two']);
    expect(applyDeckJson('not json', deck)).toBe(deck);

    const prev = { ...deck, slides: [...deck.slides, { key: 'custom-1', kind: 'custom' as const, enabled: true, title: 'Our ask', subtitle: null, bullets: ['Sign by Friday'], stats: [], images: [], body: null, notes: null }] };
    const rebuilt = await buildDeck(q, brief, null, prev, async () => '{"slides": [{"key": "next", "title": "Let us start"}]}');
    expect(rebuilt.slides.at(-1)).toMatchObject({ key: 'custom-1', title: 'Our ask' });
    expect(rebuilt.slides.find((s) => s.key === 'next')!.title).toBe('Let us start');
    const noLlm = await buildDeck(q, brief, null, null, null);
    expect(noLlm.generator).toBe('template');
  });

  it('renders the deck as a standalone HTML page with the palette and the enabled slides', () => {
    const q = new Queries(openTestDb());
    const brief = normaliseBrief({ client: 'Neuro <Gum>', colours: { primary: '#ff5a1f', secondary: '#1d3df0', accent: '#1e8f4e' } });
    const deck = templateDeck(q, brief, research());
    deck.slides.find((s) => s.key === 'livestream')!.enabled = false;
    const pitch: Pitch = { id: 1, lead_id: null, lead_name: null, name: 'Neuro Gum DE', client: brief.client, brief, research: research(), deck, status: 'draft', created_by: 'Isaac', created_at: '', updated_at: '' };
    const html = deckHtml(pitch);
    expect(html).toContain('--primary: #ff5a1f');
    expect(html).toContain('Neuro &lt;Gum&gt; x Brightform');
    expect((html.match(/<section class="slide /g) ?? []).length).toBe(deck.slides.length - 1);
    expect(html).not.toContain('class="slide livestream');
    expect(html).toContain('class="slide forecast');
    expect(html).toContain('https://neurogum.com/img/pack.jpg');
    expect(deckHtml({ ...pitch, deck: null })).toContain('Build the deck first');
  });
});

describe('researchPitch', () => {
  it('gathers the site, PDPs, context, FastMoss, Cruva and Amazon, and reports what failed without throwing', async () => {
    const q = new Queries(openTestDb());
    q.upsertEvidence([
      { account_id: null, kind: 'call', ref: 'c1', title: 'Brightform x Neuro Gum pitch', text: 'Neuro Gum want to launch in DE with a creator programme and a forecast.', occurred_at: '2026-10-01T12:00:00.000Z' },
      { account_id: null, kind: 'call', ref: 'c2', title: 'Founders weekly catch-up', text: 'Neuro Gum margins and our own plans, private. Neuro Gum.', occurred_at: '2026-10-02T12:00:00.000Z' },
    ]);
    const fetched: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url); fetched.push(u);
      if (u.includes('amazon')) return new Response('<html>Robot check</html>', { status: 503 });
      if (u.includes('/p/gum')) return new Response('<html><head><meta property="og:title" content="Focus Gum"><meta property="og:image" content="/pack.jpg"><meta property="product:price:amount" content="19.90"></head></html>');
      return new Response('<html><head><title>Neuro Gum</title><meta name="description" content="Energy gum."><meta name="theme-color" content="#ff5a1f"></head><body><img src="/hero.jpg" width="900"></body></html>');
    }) as typeof fetch;
    const fmCalls: string[] = [];
    const fm = { configured: true, callTool: async (name: string, args: { keywords: string }) => { fmCalls.push(`${name}:${args.keywords}`); if (name === 'shop_search') return { list: [{ shop_name: 'Neuro Gum Official Store', day7_gmv: '4000', total_gmv: 90000, seller_id: 's1' }, { shop_name: 'VitaReseller', day7_gmv: 300, total_gmv: 2000, seller_id: 's2' }] }; if (name === 'product_search') return { data: { list: [{ product: { title: 'Focus gum 54', price: 19.9 }, sales_summary: { day28_gmv: 12000, day28_units_sold: 500 }, shop: { shop_name: 'Neuro Gum Official Store' } }] } }; return { list: [{ creator: { unique_id: 'fitmax.de', nickname: 'Max', follower_count: 1200, category: 'Fitness' }, commerce_summary: { day28_gmv: 900 } }] }; } } as unknown as FastmossClient;
    const crCalls: string[] = [];
    const cruva = { configured: true, call: async (tool: string, args: Record<string, unknown>) => { crCalls.push(`${tool}:${args.region ?? args.shop_id}`); if (tool === 'search_marketplace_brands') return 'Neuro Gum (brand_id: 4411) - GMV: $16,196.73 | Creators: 646 | Videos: 305'; return CRUVA_CREATORS; } } as unknown as CruvaMcp;
    const brief = normaliseBrief({ client: 'Neuro Gum', website: 'neurogum.com', category: 'focus gum', markets: ['DE', 'UK'], products: [{ name: '', url: 'https://neurogum.com/p/gum' }] as never });
    const r = await researchPitch(q, brief, null, { fastmoss: fm, cruva, fetchFn, cruvaShopId: 'shop-1' });
    expect(r.site).toMatchObject({ title: 'Neuro Gum', theme_colour: '#ff5a1f', images: ['https://neurogum.com/hero.jpg'] });
    expect(r.products).toEqual([{ name: 'Focus Gum', price: 19.9, image: 'https://neurogum.com/pack.jpg', url: 'https://neurogum.com/p/gum' }]);
    expect(r.context.map((c) => c.title)).toEqual(['Brightform x Neuro Gum pitch']);
    expect(r.tiktok.brand).toMatchObject({ name: 'Neuro Gum', gmv: 16196.73, region: 'DE' });
    expect(r.tiktok.shops.map((s) => s.shop_name)).toEqual(['Neuro Gum Official Store', 'VitaReseller', 'Neuro Gum Official Store', 'VitaReseller']);
    expect(r.resellers.map((x) => `${x.name}/${x.region}`)).toEqual(['VitaReseller/DE', 'VitaReseller/UK']);
    expect(r.tiktok.top_products[0]).toMatchObject({ name: 'Focus gum 54', gmv: 12000, units: 500, shop: 'Neuro Gum Official Store' });
    expect(r.creators.map((c) => `${c.handle}:${c.source}`)).toEqual(['glowwithanna:cruva', 'fitmax.de:fastmoss']);
    expect(r.tiktok.market.map((m) => m.market)).toEqual(['DE', 'UK']);
    expect(r.amazon).toEqual({ reachable: false, items: [] });
    expect(r.errors.some((e) => e.startsWith('Amazon: HTTP 503'))).toBe(true);
    expect(fmCalls).toEqual(['shop_search:Neuro Gum', 'product_search:focus gum', 'creator_search:focus gum', 'shop_search:Neuro Gum', 'product_search:focus gum', 'creator_search:focus gum']);
    expect(crCalls).toEqual(['search_marketplace_brands:de', 'ai_search_creators:shop-1']);
    expect(fetched[0]).toBe('https://neurogum.com');
    expect(fetched.at(-1)).toBe('https://www.amazon.de/s?k=Neuro%20Gum');
  });
});
