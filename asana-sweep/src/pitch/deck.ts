import type { Queries } from '../db/queries.js';
import type { Account, Pitch, PitchBrief, PitchDeck, PitchResearch, PitchSlide, PitchStat } from '../sweep/types.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { computeMonth, forecastMonths, PNL_DEFAULTS } from '../pnl/index.js';
import { gmvSettings, shopsForGmv } from '../reports/index.js';
import { toReportCurrency } from '../gmv/currency.js';
import { money } from '../bd/outreach.js';

/**
 * The pitch deck: slides built from the brief and the research in the Brightform template, with the
 * client's colours, the forecast from the P&L engine, case studies from our own accounts' numbers, and the
 * creator strategy from the creators found. Claude writes the copy (template fallback); every slide is
 * editable in the UI and the deck renders as a standalone HTML page (present it, print it to PDF, or take
 * it into Claude Design).
 */

export const DEFAULT_BRIEF: PitchBrief = {
  client: '', website: '', markets: ['DE'], category: '', creator_query: '', products: [], pdp_images: [], logo_url: '',
  colours: { primary: '#0f0f10', secondary: '#1d3df0', accent: '#1e8f4e' },
  options: { pdp_imagery: true, livestream: true, forecasts: true, case_studies: true, creators: true, market: true, amazon: true, resellers: true },
  pricing: { retainer: 2750, currency: 'EUR', commission_pct: 5, commission_basis: 'gmv', term_months: 3, creator_video_fee: 300, live_rate: 225 },
  forecast: { start_gmv: 15000, aov: 26, cogs_pct: 25, discount_pct: 10, growth_pct: 25, ad_spend: 3000, ad_roi: 2.5, samples_per_month: 100, sample_gmv_each: 60, months: 12 },
  case_studies: [], notes: '', instructions: '',
};

export function normaliseBrief(raw: Partial<PitchBrief> | null | undefined, base: PitchBrief = DEFAULT_BRIEF): PitchBrief {
  const r = raw ?? {};
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v.slice(0, 4000) : d);
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const nn = (v: unknown, d: number | null) => (v === undefined ? d : v === null || v === '' ? null : n(v, d ?? 0));
  const hex = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
  const o = { ...base.options, ...(r.options ?? {}) };
  return {
    client: str(r.client, base.client).trim(), website: str(r.website, base.website).trim(), markets: Array.isArray(r.markets) ? r.markets.map((m) => String(m).toUpperCase().trim()).filter(Boolean).slice(0, 6) : base.markets, category: str(r.category, base.category), creator_query: str(r.creator_query, base.creator_query),
    products: Array.isArray(r.products) ? r.products.filter((p) => p && typeof p === 'object').map((p) => ({ name: str((p as { name?: unknown }).name, ''), price: nn((p as { price?: unknown }).price, null), url: str((p as { url?: unknown }).url, '') || null, image: str((p as { image?: unknown }).image, '') || null })).filter((p) => p.name || p.url).slice(0, 20) : base.products,
    pdp_images: Array.isArray(r.pdp_images) ? r.pdp_images.map(String).filter((u) => /^https?:\/\//i.test(u)).slice(0, 40) : base.pdp_images, logo_url: str(r.logo_url, base.logo_url),
    colours: { primary: hex(r.colours?.primary, base.colours.primary), secondary: hex(r.colours?.secondary, base.colours.secondary), accent: hex(r.colours?.accent, base.colours.accent) },
    options: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Boolean(v)])) as PitchBrief['options'],
    pricing: { retainer: nn(r.pricing?.retainer, base.pricing.retainer), currency: str(r.pricing?.currency, base.pricing.currency).toUpperCase().slice(0, 3) || 'EUR', commission_pct: nn(r.pricing?.commission_pct, base.pricing.commission_pct), commission_basis: r.pricing?.commission_basis === 'mor' ? 'mor' : 'gmv', term_months: n(r.pricing?.term_months, base.pricing.term_months), creator_video_fee: nn(r.pricing?.creator_video_fee, base.pricing.creator_video_fee), live_rate: nn(r.pricing?.live_rate, base.pricing.live_rate) },
    forecast: { start_gmv: n(r.forecast?.start_gmv, base.forecast.start_gmv), aov: n(r.forecast?.aov, base.forecast.aov), cogs_pct: n(r.forecast?.cogs_pct, base.forecast.cogs_pct), discount_pct: n(r.forecast?.discount_pct, base.forecast.discount_pct), growth_pct: n(r.forecast?.growth_pct, base.forecast.growth_pct), ad_spend: n(r.forecast?.ad_spend, base.forecast.ad_spend), ad_roi: n(r.forecast?.ad_roi, base.forecast.ad_roi), samples_per_month: n(r.forecast?.samples_per_month, base.forecast.samples_per_month), sample_gmv_each: n(r.forecast?.sample_gmv_each, base.forecast.sample_gmv_each), months: Math.min(24, Math.max(3, Math.round(n(r.forecast?.months, base.forecast.months)))) },
    case_studies: Array.isArray(r.case_studies) ? r.case_studies.map(String).slice(0, 6) : base.case_studies, notes: str(r.notes, base.notes), instructions: str(r.instructions, base.instructions),
  };
}

// ---- Colours ----

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2; const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, s, l];
}
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}
/** A palette from the client's colours: a dark ink and a light paper that still read as the brand. */
export function paletteFor(c: PitchBrief['colours']): PitchDeck['palette'] {
  const [h, s] = hexToHsl(c.primary);
  const ink = hslToHex(h, Math.min(s, 0.35), 0.09);
  const paper = hslToHex(h, Math.min(s, 0.25), 0.965);
  return { primary: c.primary, secondary: c.secondary, accent: c.accent, ink, paper };
}

// ---- Numbers ----

const fmt = (n: number, cur: string) => money(n, cur);
const pct = (n: number) => `${Math.round(n)}%`;

export function forecastFor(q: Queries, brief: PitchBrief): { months: { month: string; gmv: number; net: number; billing: number; units: number }[]; total_gmv: number; total_net: number; total_billing: number; month12_gmv: number } {
  const f = brief.forecast;
  const pseudo: Account = { id: 0, name: brief.client, markets: brief.markets.join(','), am_name: null, aa_name: null, enabled: true, notes: null, commission_pct: brief.pricing.commission_pct, commission_basis: brief.pricing.commission_basis, settlement_pct: 85, slack_channel: null, client_slack_channel: null, client_domain: null, created_at: '', updated_at: '' };
  const inputs = { ...PNL_DEFAULTS, cogs_pct: f.cogs_pct, agency_fee: brief.pricing.retainer ?? 0, agency_commission_pct: brief.pricing.commission_pct ?? 0, ad_spend: f.ad_spend, samples_sent: f.samples_per_month, sample_unit_cost: Math.round(f.aov * (f.cogs_pct / 100) * 100) / 100 };
  const start = new Date().toISOString().slice(0, 7);
  const first = computeMonth({ account: pseudo, month: start, actual: false, inputs, gmv: f.start_gmv, affiliate_gmv: f.start_gmv * 0.6, units: f.aov > 0 ? Math.round(f.start_gmv / f.aov) : 0, days_with_data: 0, skus: [], prices: [], fx: {}, settlement: null });
  const rest = forecastMonths(q, pseudo, first, { months: f.months - 1, gmv_growth_pct: f.growth_pct, ad_spend: f.ad_spend, ad_roi: f.ad_roi, samples_per_month: f.samples_per_month, sample_gmv_each: f.sample_gmv_each, keep_fees: true }, [], [], {});
  const months = [first, ...rest].map((m) => ({ month: m.month, gmv: Math.round(m.gmv), net: Math.round(m.net), billing: Math.round(m.agency_billing), units: m.units }));
  return { months, total_gmv: months.reduce((n, m) => n + m.gmv, 0), total_net: months.reduce((n, m) => n + m.net, 0), total_billing: months.reduce((n, m) => n + m.billing, 0), month12_gmv: months[months.length - 1]?.gmv ?? 0 };
}

/** Our own accounts as case studies: GMV over the last 90 days against the 90 before, affiliate share. */
export function caseStudies(q: Queries, names: string[]): { name: string; markets: string | null; gmv_90d: number; prev_90d: number; growth_pct: number | null; affiliate_share: number | null; currency: string }[] {
  const settings = gmvSettings(q);
  const fx = settings.fx_to_eur;
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const prevFrom = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const rows = q.listGmvBetween(prevFrom, today);
  const has = new Set(rows.map((r) => r.shop_id));
  const accounts = q.listAccounts().filter((a) => a.enabled && (!names.length || names.some((n) => n.toLowerCase() === a.name.toLowerCase())));
  const out = accounts.map((a) => {
    const shops = shopsForGmv(q.listShops().filter((s) => s.account_id === a.id), (id) => has.has(id));
    const ids = new Map(shops.map((s) => [s.shop_id, s]));
    let gmv = 0, prev = 0, aff = 0;
    for (const r of rows) { const sh = ids.get(r.shop_id); if (!sh) continue; const v = toReportCurrency(r.total_gmv, sh.currency, fx); if (r.date >= from) { gmv += v; aff += toReportCurrency(r.affiliate_gmv, sh.currency, fx); } else prev += v; }
    return { name: a.name, markets: a.markets, gmv_90d: Math.round(gmv), prev_90d: Math.round(prev), growth_pct: prev > 0 ? Math.round(((gmv - prev) / prev) * 100) : null, affiliate_share: gmv > 0 ? Math.round((aff / gmv) * 100) : null, currency: settings.report_currency };
  }).filter((c) => c.gmv_90d > 0);
  return (names.length ? out : out.sort((a, b) => b.gmv_90d - a.gmv_90d).slice(0, 3));
}

// ---- Slides ----

const S = (key: PitchSlide['key'], kind: PitchSlide['kind'], title: string, extra: Partial<PitchSlide> = {}): PitchSlide => ({ key, kind, enabled: true, title, subtitle: null, bullets: [], stats: [], images: [], body: null, notes: null, ...extra });

export function templateDeck(q: Queries, brief: PitchBrief, research: PitchResearch | null): PitchDeck {
  const cur = brief.pricing.currency;
  const mk = brief.markets.join(', ');
  const images = [...brief.pdp_images, ...(research?.products.map((p) => p.image).filter((x): x is string => Boolean(x)) ?? []), ...(research?.site?.images ?? [])].filter((v, i, a) => a.indexOf(v) === i);
  const fc = brief.options.forecasts ? forecastFor(q, brief) : null;
  const cs = brief.options.case_studies ? caseStudies(q, brief.case_studies) : [];
  const creators = (research?.creators ?? []).slice(0, 8);
  const market = research?.tiktok.market ?? [];
  const slides: PitchSlide[] = [
    S('cover', 'cover', `${brief.client} x Brightform`, { subtitle: `TikTok Shop growth plan · ${mk}`, images: images.slice(0, 1), body: new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) }),
    S('agenda', 'agenda', 'What we will cover', { bullets: ['Where TikTok Shop is in your markets', `${brief.client} on TikTok Shop today`, 'The opportunity and the forecast', 'Creator strategy', 'Content and live', 'Case studies', 'Commercials and next steps'] }),
    S('about', 'about', 'Brightform', { subtitle: 'TikTok Shop Partner agency', bullets: ['Affiliate and creator programme: outreach, samples, briefs, retention', 'Shop management: listings, promotions, logistics, policy, P&L', 'GMV Max and paid: full-funnel, creative testing', 'Content and live: shoppable videos, live selling', 'Merchant of Record: sell in the EU without a local entity', 'Weekly reporting and a named account manager'] }),
  ];
  if (brief.options.market) slides.push(S('market', 'market', `TikTok Shop in ${mk}`, { stats: market.map((m) => ({ label: `${m.market} shops we track`, value: String(m.prospects), note: `${m.surging} surging this week` })), bullets: [...market.map((m) => `${m.market} leaders this week: ${m.leaders.slice(0, 4).join(', ') || 'n/a'}`), ...(research?.tiktok.top_products.slice(0, 4).map((p) => `${p.name}${p.gmv !== null ? ` · ${fmt(p.gmv, cur)} in 28 days` : ''}${p.shop ? ` (${p.shop})` : ''}`) ?? [])] }));
  slides.push(S('presence', 'presence', `${brief.client} on TikTok Shop today`, {
    stats: ([research?.tiktok.brand ? { label: `Brand GMV, last 30 days (${research.tiktok.brand.region})`, value: fmt(research.tiktok.brand.gmv ?? 0, 'USD'), note: `${research.tiktok.brand.creators ?? 0} creators · ${research.tiktok.brand.videos ?? 0} videos` } : null, research?.tiktok.shops.length ? { label: 'Shops selling the brand', value: String(research.tiktok.shops.length), note: research.resellers.length ? `${research.resellers.length} reseller(s)` : null } : null, research?.amazon.items.length ? { label: 'Amazon listings found', value: String(research.amazon.items.length), note: research.amazon.items[0]?.price ? `from ${research.amazon.items[0].price}` : null } : null] as (PitchStat | null)[]).filter((x): x is PitchStat => x !== null),
    bullets: [...(research?.resellers.slice(0, 5).map((r) => `${r.name} (${r.region})${r.gmv_7d !== null ? ` · ${fmt(r.gmv_7d, cur)} last 7 days` : ''}`) ?? []), ...(research?.amazon.items.slice(0, 3).map((i) => `Amazon: ${i.title.slice(0, 70)}${i.price ? ` · ${i.price}` : ''}`) ?? [])],
    body: research ? null : 'Run the research to fill this slide with the brand’s shops, resellers and Amazon presence.',
  }));
  if (brief.options.pdp_imagery) slides.push(S('products', 'products', 'The products', { bullets: (research?.products.length ? research.products : brief.products).map((p) => `${p.name}${p.price !== null ? ` · ${fmt(p.price, cur)}` : ''}`), images: images.slice(0, 6) }));
  slides.push(S('opportunity', 'opportunity', 'The opportunity', { bullets: [`Launch ${brief.client} on TikTok Shop ${mk} with a creator-led programme from day one`, 'Affiliate GMV first: hundreds of small and mid creators posting consistently beats a few big names', 'Standing discount and GMV Max to convert the traffic the creators bring', 'Live selling once the creator base is there', 'Brightform runs the shop day to day: listings, logistics, policy, customer service'] }));
  if (fc) slides.push(S('forecast', 'forecast', `${fc.months.length}-month forecast`, { stats: [{ label: `GMV over ${fc.months.length} months`, value: fmt(fc.total_gmv, cur), note: `${pct(brief.forecast.growth_pct)} monthly growth` }, { label: `Month ${fc.months.length} GMV`, value: fmt(fc.month12_gmv, cur), note: `from ${fmt(brief.forecast.start_gmv, cur)} in month 1` }, { label: 'Client net profit', value: fmt(fc.total_net, cur), note: `COGS ${pct(brief.forecast.cogs_pct)}, ads ${fmt(brief.forecast.ad_spend, cur)} a month` }], bullets: [`AOV ${fmt(brief.forecast.aov, cur)} with a ${pct(brief.forecast.discount_pct)} standing discount`, `Ad ROI ${brief.forecast.ad_roi}x on ${fmt(brief.forecast.ad_spend, cur)} a month`, `${brief.forecast.samples_per_month} samples a month, each worth ${fmt(brief.forecast.sample_gmv_each, cur)} in GMV`], body: fc.months.map((m) => `${new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })} ${fmt(m.gmv, cur)}`).join(' · ') }));
  if (brief.options.creators) slides.push(S('creators', 'creators', 'Creator strategy', { bullets: [`Target profile: ${brief.creator_query || `${brief.category || brief.client} content creators in ${mk}`}`, 'Outreach in waves through Cruva: open plan, target collab tiers for the top sellers, samples within 48 hours', 'Brief with hooks and CTAs per product; retention plan for anyone who sells', ...creators.slice(0, 6).map((c) => `@${c.handle}${c.followers !== null ? ` · ${Math.round(c.followers / 1000)}k followers` : ''}${c.gmv_30d !== null ? ` · ${fmt(c.gmv_30d, 'USD')} GMV in 30 days` : ''}${c.categories ? ` · ${c.categories.split(',')[0]}` : ''}`)], body: creators.length ? `${creators.length} example creators found (Cruva and FastMoss); the full list goes into the Cruva automation at launch.` : 'Run the research to pull example creators with followers and GMV.' }));
  slides.push(S('content', 'content', 'Content that sells', { bullets: ['Shoppable videos: hook in the first second, product in use, one clear CTA', 'UGC batches every month from the creators who convert', 'Trend and sound utilisation, competitor CVR analysis', 'Every piece compliant with TikTok Shop and advertising policy'], images: images.slice(1, 4) }));
  if (brief.options.livestream) slides.push(S('livestream', 'livestream', 'Live selling', { bullets: ['Weekly live sessions once the creator base is active', 'Hosted lives with top affiliates, product bundles and live-only offers', `Brightform live production${brief.pricing.live_rate !== null ? ` at ${fmt(brief.pricing.live_rate, cur)} an hour` : ''}, or TikTok-funded where the programme applies`, 'Live GMV typically adds 10 to 25% on top of video GMV at scale'] }));
  if (brief.options.case_studies) slides.push(S('case_studies', 'case_studies', 'Case studies', { stats: cs.map((c) => ({ label: `${c.name}${c.markets ? ` (${c.markets})` : ''}`, value: fmt(c.gmv_90d, c.currency), note: `last 90 days${c.growth_pct !== null ? ` · ${c.growth_pct >= 0 ? '+' : ''}${c.growth_pct}% vs the 90 before` : ''}${c.affiliate_share !== null ? ` · ${c.affiliate_share}% affiliate` : ''}` })), body: cs.length ? null : 'Pick case studies in the brief (our accounts with GMV on record) or add custom ones here.' }));
  const pricingStats: (PitchStat | null)[] = [brief.pricing.retainer !== null ? { label: 'Retainer', value: `${fmt(brief.pricing.retainer, cur)} / month`, note: 'per store, per country' } : null, brief.pricing.commission_pct !== null ? { label: 'Commission', value: `${brief.pricing.commission_pct}%`, note: brief.pricing.commission_basis === 'mor' ? 'of net settlement (MoR)' : 'of GMV' } : null, { label: 'Initial term', value: `${brief.pricing.term_months} months`, note: 'then monthly' }];
  slides.push(S('pricing', 'pricing', 'Commercials', { stats: pricingStats.filter((x): x is PitchStat => x !== null), bullets: [brief.pricing.creator_video_fee !== null ? `Creator videos ${fmt(brief.pricing.creator_video_fee, cur)} each, on approval` : '', brief.pricing.live_rate !== null ? `Live production ${fmt(brief.pricing.live_rate, cur)} an hour` : '', 'Retainer billed in advance, commission in arrears on the month’s GMV', brief.pricing.commission_basis === 'mor' ? 'Merchant of Record: Brightform Social Media UG sells into the EU and settles net of platform fees, refunds and cancellations' : ''].filter(Boolean) }));
  slides.push(S('roadmap', 'roadmap', 'First 90 days', { bullets: ['Weeks 1 to 2: contract, onboarding forms, shop and TSP binding, compliance, listings', 'Weeks 3 to 4: first 200 creators contacted, samples out, GMV Max live, standing discount set', 'Month 2: creator retention plan, UGC batch one, first live', 'Month 3: scale what converts, weekly report rhythm, forecast review'] }));
  slides.push(S('next', 'next', 'Next steps', { bullets: ['Agree the scope and markets', 'Sign the SLA on DocuSign', 'Kick-off call and onboarding forms', 'Go live in four weeks'], body: 'hello@brightform.agency · brightform.agency' }));
  return { palette: paletteFor(brief.colours), slides, generator: 'template', built_at: new Date().toISOString() };
}

export function renderDeckPrompt(brief: PitchBrief, research: PitchResearch | null, deck: PitchDeck): { system: string; user: string } {
  const system = [
    `You write pitch decks for Brightform, a TikTok Shop Partner agency, for the client ${brief.client}. British English, confident, specific, no hype, no exclamation marks. Short lines that fit a slide: titles up to 8 words, bullets up to 16 words, 3 to 6 bullets a slide.`,
    'You get the current slides (template copy) and the research. Rewrite the copy of each slide so it is about this client and this market, using only the facts given; keep the numbers exactly; never invent creators, figures or names. Keep the slide keys and kinds. Keep stats as given (you may reword labels and notes). Do not touch images.',
    'Return JSON only: {"slides": [{"key": "...", "title": "...", "subtitle": "...|null", "bullets": ["..."], "body": "...|null", "notes": "<speaker notes, one or two lines>"}, ...]}.',
  ].join('\n');
  const u = [
    `## Brief\nClient: ${brief.client} · markets: ${brief.markets.join(', ')} · category: ${brief.category || 'n/a'} · website: ${brief.website || 'n/a'}${brief.notes ? `\nNotes: ${brief.notes}` : ''}${brief.instructions ? `\nInstructions: ${brief.instructions}` : ''}`,
    research ? `## Research\n${research.site?.description ? `Site: ${research.site.title ?? ''} — ${research.site.description}\n` : ''}${research.tiktok.brand ? `Brand on TikTok Shop: GMV $${research.tiktok.brand.gmv} in 30 days, ${research.tiktok.brand.creators} creators, ${research.tiktok.brand.videos} videos\n` : ''}${research.resellers.length ? `Resellers: ${research.resellers.map((r) => `${r.name} (${r.region})`).join(', ')}\n` : ''}${research.amazon.items.length ? `Amazon: ${research.amazon.items.slice(0, 3).map((i) => `${i.title} ${i.price ?? ''}`).join('; ')}\n` : ''}${research.creators.length ? `Creators: ${research.creators.slice(0, 8).map((c) => `@${c.handle} ${c.followers ?? '?'} followers, $${c.gmv_30d ?? '?'} 30d GMV`).join('; ')}\n` : ''}${research.context.length ? `What the client said (pitch call, emails, Slack):\n${research.context.slice(0, 5).map((c) => `- ${c.title}: ${c.snippet.slice(0, 300)}`).join('\n')}` : ''}` : '## Research\n(none yet)',
    '## Slides', JSON.stringify(deck.slides.map((s) => ({ key: s.key, kind: s.kind, title: s.title, subtitle: s.subtitle, bullets: s.bullets, stats: s.stats, body: s.body }))),
    '', 'Return the JSON now.',
  ].join('\n');
  return { system, user: u };
}

export function applyDeckJson(text: string, deck: PitchDeck): PitchDeck {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < 0) return deck;
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as { slides?: Partial<PitchSlide>[] };
    if (!Array.isArray(j.slides)) return deck;
    const by = new Map(j.slides.filter((s) => s && typeof s.key === 'string').map((s) => [s.key as string, s]));
    return { ...deck, generator: 'claude', slides: deck.slides.map((s) => { const n = by.get(s.key); if (!n) return s; return { ...s, title: typeof n.title === 'string' && n.title.trim() ? n.title.trim().slice(0, 120) : s.title, subtitle: n.subtitle === null ? null : typeof n.subtitle === 'string' ? n.subtitle.slice(0, 160) : s.subtitle, bullets: Array.isArray(n.bullets) && n.bullets.length ? n.bullets.map(String).slice(0, 8) : s.bullets, body: n.body === null ? null : typeof n.body === 'string' ? n.body.slice(0, 600) : s.body, notes: typeof n.notes === 'string' ? n.notes.slice(0, 400) : s.notes }; }) };
  } catch {
    return deck;
  }
}

export async function buildDeck(q: Queries, brief: PitchBrief, research: PitchResearch | null, prev: PitchDeck | null, llm?: ((system: string, user: string) => Promise<string>) | null): Promise<PitchDeck> {
  let deck = templateDeck(q, brief, research);
  // Keep custom slides and manual edits on slides the AM already touched? Custom slides survive a rebuild.
  if (prev) deck.slides = [...deck.slides, ...prev.slides.filter((s) => s.kind === 'custom')];
  const fn = llm === undefined ? (config.anthropicApiKey ? (s: string, u: string) => draftWithClaude(s, u, { maxTokens: 3500, feature: 'pitch' }) : null) : llm;
  if (fn) {
    try { const { system, user } = renderDeckPrompt(brief, research, deck); deck = applyDeckJson(await fn(system, user), deck); } catch { /* template copy stands */ }
  }
  return deck;
}

// ---- Standalone HTML deck ----

const esc = (s: string | null | undefined) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function deckHtml(p: Pitch): string {
  const deck = p.deck;
  if (!deck) return '<!doctype html><title>No deck</title><p>Build the deck first.</p>';
  const pal = deck.palette;
  const slides = deck.slides.filter((s) => s.enabled);
  const slide = (s: PitchSlide, i: number) => {
    const dark = s.kind === 'cover' || s.kind === 'next';
    const imgs = s.images.filter(Boolean);
    return `<section class="slide ${s.kind} ${dark ? 'dark' : ''}" id="s${i + 1}">
  <header><span class="brand">Brightform.</span><span class="crumb">${esc(p.brief.client)} · ${i + 1} / ${slides.length}</span></header>
  <div class="content ${imgs.length && s.kind !== 'cover' ? 'with-images' : ''}">
    <div class="text">
      ${s.kind === 'cover' ? `<p class="kicker">TikTok Shop growth plan</p>` : ''}
      <h1>${esc(s.title)}</h1>
      ${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ''}
      ${s.stats.length ? `<div class="stats">${s.stats.map((st) => `<div class="stat"><div class="v">${esc(st.value)}</div><div class="k">${esc(st.label)}</div>${st.note ? `<div class="n">${esc(st.note)}</div>` : ''}</div>`).join('')}</div>` : ''}
      ${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${s.body ? `<p class="body">${esc(s.body)}</p>` : ''}
    </div>
    ${imgs.length ? `<div class="images n${Math.min(imgs.length, 6)}">${imgs.slice(0, 6).map((u) => `<figure style="background-image:url('${esc(u)}')"></figure>`).join('')}</div>` : ''}
  </div>
  <footer><span>brightform.agency · hello@brightform.agency</span><span>${esc(p.name)}</span></footer>
  ${s.notes ? `<aside class="notes">${esc(s.notes)}</aside>` : ''}
</section>`;
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Manrope:wght@400;600;800&display=swap">
<style>
:root { --primary: ${pal.primary}; --secondary: ${pal.secondary}; --accent: ${pal.accent}; --ink: ${pal.ink}; --paper: ${pal.paper}; }
* { box-sizing: border-box; } html, body { margin: 0; background: #111; font-family: 'Manrope', system-ui, sans-serif; color: var(--ink); }
.deck { display: flex; flex-direction: column; gap: 24px; padding: 24px; align-items: center; }
.slide { position: relative; width: 1280px; height: 720px; background: var(--paper); border-radius: 18px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
.slide.dark { background: var(--ink); color: #fff; }
.slide::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 10px; background: var(--secondary); }
.slide.dark::before { background: var(--accent); }
header, footer { display: flex; justify-content: space-between; align-items: center; padding: 22px 48px 0 58px; font-size: 13px; font-weight: 600; opacity: .75; }
footer { padding: 0 48px 20px 58px; margin-top: auto; }
.brand { font-family: 'Archivo Black', Impact, sans-serif; font-size: 18px; letter-spacing: -.02em; opacity: 1; }
.content { display: flex; gap: 36px; padding: 18px 48px 10px 58px; flex: 1; min-height: 0; }
.content.with-images .text { flex: 1.1; } .content.with-images .images { flex: 1; }
.text { flex: 1; min-width: 0; }
h1 { font-family: 'Archivo Black', Impact, sans-serif; font-weight: 400; font-size: 54px; line-height: .98; margin: 0 0 14px; letter-spacing: -.02em; text-transform: uppercase; }
.cover h1 { font-size: 78px; margin-top: 60px; max-width: 900px; }
.kicker { text-transform: uppercase; letter-spacing: .18em; font-size: 13px; font-weight: 800; color: var(--accent); margin: 40px 0 10px; }
.sub { font-size: 24px; font-weight: 600; margin: 0 0 18px; opacity: .85; }
ul { margin: 10px 0 0; padding: 0; list-style: none; } li { font-size: 22px; line-height: 1.35; margin: 0 0 10px; padding-left: 26px; position: relative; } li::before { content: ''; position: absolute; left: 0; top: 11px; width: 12px; height: 12px; border-radius: 3px; background: var(--secondary); } .dark li::before { background: var(--accent); }
.body { font-size: 17px; opacity: .8; margin-top: 16px; line-height: 1.45; }
.stats { display: flex; gap: 16px; flex-wrap: wrap; margin: 8px 0 14px; } .stat { background: rgba(0,0,0,.05); border-left: 5px solid var(--secondary); border-radius: 12px; padding: 14px 18px; min-width: 220px; } .dark .stat { background: rgba(255,255,255,.08); border-left-color: var(--accent); }
.stat .v { font-family: 'Archivo Black', Impact, sans-serif; font-size: 40px; line-height: 1; letter-spacing: -.02em; } .stat .k { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; font-weight: 800; margin-top: 8px; opacity: .75; } .stat .n { font-size: 13px; margin-top: 4px; opacity: .7; }
.images { display: grid; gap: 12px; align-content: stretch; } .images.n1 { grid-template-columns: 1fr; } .images.n2, .images.n3, .images.n4 { grid-template-columns: 1fr 1fr; } .images.n5, .images.n6 { grid-template-columns: 1fr 1fr 1fr; }
.images figure { margin: 0; border-radius: 14px; background: #fff center/cover no-repeat; min-height: 160px; box-shadow: 0 6px 20px rgba(0,0,0,.12); }
.cover .images { position: absolute; right: 0; top: 0; bottom: 0; width: 46%; } .cover .images figure { border-radius: 0; min-height: 100%; opacity: .92; mask-image: linear-gradient(90deg, transparent, #000 25%); -webkit-mask-image: linear-gradient(90deg, transparent, #000 25%); }
.cover .content { position: relative; z-index: 1; }
.notes { display: none; }
@media print { html, body { background: #fff; } .deck { padding: 0; gap: 0; } .slide { width: 100%; height: 100vh; border-radius: 0; box-shadow: none; page-break-after: always; } @page { size: 1280px 720px; margin: 0; } }
@media (max-width: 1340px) { .slide { width: 100%; height: auto; aspect-ratio: 16/9; } }
</style></head>
<body><div class="deck">${slides.map(slide).join('\n')}</div>
<script>(function(){const fit=()=>{document.querySelector('.deck').style.zoom=String(Math.min(1,(window.innerWidth-48)/1280));};fit();window.addEventListener('resize',fit);window.addEventListener('beforeprint',()=>{document.querySelector('.deck').style.zoom='1';});})();document.addEventListener('keydown',(e)=>{const all=[...document.querySelectorAll('.slide')];const y=window.scrollY;const i=all.findIndex((s)=>s.offsetTop>=y-10);if(e.key==='ArrowRight'||e.key==='PageDown'){all[Math.min(all.length-1,i+1)]?.scrollIntoView({behavior:'smooth'});}if(e.key==='ArrowLeft'||e.key==='PageUp'){all[Math.max(0,i-1)]?.scrollIntoView({behavior:'smooth'});}});</script>
</body></html>`;
}
