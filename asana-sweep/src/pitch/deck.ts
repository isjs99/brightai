import type { Queries } from '../db/queries.js';
import type { Account, Pitch, PitchBrief, PitchDeck, PitchResearch, PitchSlide, PitchStat } from '../sweep/types.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { computeMonth, forecastMonths, PNL_DEFAULTS } from '../pnl/index.js';
import { gmvSettings, shopsForGmv } from '../reports/index.js';
import { toReportCurrency } from '../gmv/currency.js';
import { money } from '../bd/outreach.js';
import { renderDeck } from './brightform.js';
import { brightformDeck } from './slides.js';

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

/** The deck as the Brightform Design System lays it out (slides.ts): the fixed Brightform slides plus the client's own, from the brief and the research. */
export function templateDeck(q: Queries, brief: PitchBrief, research: PitchResearch | null): PitchDeck {
  return brightformDeck(q, brief, research);
}

export function renderDeckPrompt(brief: PitchBrief, research: PitchResearch | null, deck: PitchDeck): { system: string; user: string } {
  const system = [
    `You write client decks for Brightform, a TikTok Shop Partner agency, for the client ${brief.client}. Voice: operator, not agency. British English (optimise, programme, localised). Specific and numerical; a claim arrives with a figure or it does not arrive. No hype, no exclamation marks, no questions or puns in headlines. Headlines are two to four words, noun phrases, no verbs, no full stop. Body lines are short declaratives; "→" carries a consequence. "We" is Brightform, "your brand" or "you" is the client. Numbers are compressed and qualified ("€8.19M GMV across DE, FR, IT in six months").`,
    'You get the current slides (template copy) and the research. Tailor the client slides (cover subtitle, today, best sellers, market, opportunity, cruva, creators, forecast assumptions, commercials, next steps) to this client, its category and its markets using only the facts given; keep every number exactly; never invent creators, figures or names. On the fixed Brightform slides (why_us, portfolio, clients, awards, outreach, framework, profitability, shoppable, livestream, studio, deliverables, mor, team, case_study) keep the copy as it is, except framework and profitability panel lines, which you may tailor to the category. Keep slide keys and kinds. Keep stats as given (you may reword labels and notes). Do not touch images or charts. Lines must fit: titles up to 30 characters, bullets up to 110 characters, panel lines up to 120 characters.',
    'Return JSON only: {"slides": [{"key": "...", "title": "...", "subtitle": "...|null", "bullets": ["..."], "body": "...|null", "panels": [{"heading": "...", "items": ["..."]}] | null, "notes": "<speaker notes, one or two lines>"}, ...]}. Leave out any slide you do not change.',
  ].join('\n');
  const u = [
    `## Brief\nClient: ${brief.client} · markets: ${brief.markets.join(', ')} · category: ${brief.category || 'n/a'} · website: ${brief.website || 'n/a'}${brief.notes ? `\nNotes: ${brief.notes}` : ''}${brief.instructions ? `\nInstructions: ${brief.instructions}` : ''}`,
    research ? `## Research\n${research.site?.description ? `Site: ${research.site.title ?? ''} — ${research.site.description}\n` : ''}${research.tiktok.brand ? `Brand on TikTok Shop: GMV $${research.tiktok.brand.gmv} in 30 days, ${research.tiktok.brand.creators} creators, ${research.tiktok.brand.videos} videos\n` : ''}${research.resellers.length ? `Resellers: ${research.resellers.map((r) => `${r.name} (${r.region})`).join(', ')}\n` : ''}${research.amazon.items.length ? `Amazon: ${research.amazon.items.slice(0, 3).map((i) => `${i.title} ${i.price ?? ''}`).join('; ')}\n` : ''}${research.creators.length ? `Creators: ${research.creators.slice(0, 8).map((c) => `@${c.handle} ${c.followers ?? '?'} followers, $${c.gmv_30d ?? '?'} 30d GMV`).join('; ')}\n` : ''}${research.context.length ? `What the client said (pitch call, emails, Slack):\n${research.context.slice(0, 5).map((c) => `- ${c.title}: ${c.snippet.slice(0, 300)}`).join('\n')}` : ''}` : '## Research\n(none yet)',
    '## Slides', JSON.stringify(deck.slides.map((s) => ({ key: s.key, kind: s.kind, title: s.title, subtitle: s.subtitle, bullets: s.bullets, stats: s.stats, body: s.body, ...(s.panels ? { panels: s.panels } : {}) }))),
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
    return { ...deck, generator: 'claude', slides: deck.slides.map((s) => { const n = by.get(s.key); if (!n) return s; const panels = Array.isArray(n.panels) && n.panels.length && s.panels ? s.panels.map((orig, i) => { const x = (n.panels as unknown[])[i] as { heading?: unknown; items?: unknown } | undefined; if (!x || typeof x !== 'object') return orig; return { heading: typeof x.heading === 'string' && x.heading.trim() ? x.heading.slice(0, 60) : orig.heading, items: Array.isArray(x.items) && x.items.length ? x.items.map(String).slice(0, 10) : orig.items }; }) : s.panels; return { ...s, title: typeof n.title === 'string' && n.title.trim() ? n.title.trim().slice(0, 120) : s.title, subtitle: n.subtitle === null ? null : typeof n.subtitle === 'string' ? n.subtitle.slice(0, 400) : s.subtitle, bullets: Array.isArray(n.bullets) && n.bullets.length ? n.bullets.map(String).slice(0, 10) : s.bullets, body: n.body === null ? null : typeof n.body === 'string' ? n.body.slice(0, 900) : s.body, notes: typeof n.notes === 'string' ? n.notes.slice(0, 400) : s.notes, ...(panels ? { panels } : {}) }; }) };
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

// ---- Standalone HTML deck: the Brightform Design System renderer ----

export function deckHtml(p: Pitch, opts: { inline?: boolean } = {}): string {
  return renderDeck(p, opts);
}
