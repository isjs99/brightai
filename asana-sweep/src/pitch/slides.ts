import type { Queries } from '../db/queries.js';
import type { PitchBrief, PitchDeck, PitchResearch, PitchSlide, PitchStat } from '../sweep/types.js';
import { money } from '../bd/outreach.js';
import { caseStudies, forecastFor } from './deck.js';
import { deriveBrandLayer } from './theme.js';

/**
 * The client deck as the Brightform Design System lays it out: the fixed Brightform slides (why us, the
 * portfolio, clients, awards, outreach system, growth framework, profitability, shoppable video, LIVE,
 * studio, deliverables, MoR, team) carry the general deck's copy and figures verbatim; the client slides
 * (where they are today, their best sellers, the market, the opportunity, creators, forecast, commercials,
 * next steps) are filled from the brief and the research and then tailored by Claude. Everything here is
 * data: the renderer in brightform.ts turns each slide kind into its layout.
 */

const S = (key: string, kind: PitchSlide['kind'], title: string, extra: Partial<PitchSlide> = {}): PitchSlide => ({ key, kind, enabled: true, title, subtitle: null, bullets: [], stats: [], images: [], body: null, notes: null, ...extra });
const fmt = (n: number, cur: string) => money(n, cur);
const pct = (n: number) => `${Math.round(n)}%`;
/** A shelf price with its decimals (money() rounds to whole units, which is right for GMV and wrong for a €29.90 product). */
const price = (n: number, cur: string): string => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'EUR', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n); } catch { return `${n} ${cur}`; } };
const k = (n: number | null): string => (n === null ? '–' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));
const MARKET_NAMES: Record<string, string> = { DE: 'Germany', UK: 'United Kingdom', GB: 'United Kingdom', FR: 'France', IT: 'Italy', ES: 'Spain', IE: 'Ireland', NL: 'Netherlands', BE: 'Belgium', PL: 'Poland', AT: 'Austria', SE: 'Sweden', US: 'United States' };

/** Brightform's standing content, from the July 2026 general deck. */
export const BRIGHTFORM = {
  quotes: [
    { quote: 'Brightform were invaluable partners as we evolved, mastering our brands and driving continuous growth through strategic, high-performing marketplace campaigns.', name: 'Ambika Handa', role: 'Head of E-Commerce Marketing Strategy, Karo' },
    { quote: 'Brightform was a great partner for Nutravita — professional, reliable, and always delivering high-quality work. Isaac and his team were a pleasure to work with.', name: 'Arash Peyami', role: 'CEO & Founder, Nutravita' },
  ],
  creds: ['No.1 TikTok Shop Partner in Germany by GMV', 'Top 10 TikTok Shop Partner in the UK by GMV', 'Regional EU hubs (ES, IT, DE, FR) plus UK, with localised teams', '300M+ video views and 230K+ active creators across the portfolio'],
  portfolio: [['Total GMV', '€8.19M', 'Six months, DE / FR / IT'], ['Impressions', '1.25B', 'Product surface area'], ['Items sold', '388K', 'Across managed shops'], ['Affiliate share', '75%', 'Creator-driven GMV'], ['Shoppable videos', '103.5K', 'Creator-produced'], ['Avg conversion', '2.3%', '2.3x category benchmark'], ['Avg order value', '£18.23', 'Stable across all months'], ['LIVE streams', '20.2K', 'Shoppable broadcasts']] as [string, string, string][],
  logos: [['unilever', 62], ['mars', 38], ['snickers', 28], ['mms', 42], ['sheamoisture', 28], ['nutravita', 32], ['estrid', 18], ['kijimea', 24], ['waschies', 24], ['nutori', 38], ['clearly', 28], ['great-vita', 42], ['evolsin', 28], ['trend-lounge', 38], ['vivo-life', 42], ['feelgud', 24], ['belively', 20], ['karo-group-lockup', 18]] as [string, number][],
  outreach: [
    { heading: 'Daily capacity', items: ['Up to 7.5K targeted creator contacts per day, per market', 'Intelligent retargeting of high-intent creators — quality over volume', 'Full CRM tracking across creator performance, content output and revenue impact'] },
    { heading: 'Automation systems', items: ['Creator qualification on content quality, audience fit and brand alignment, not just GMV', 'Structured briefing and follow-up flows for premium content output', 'Seamless onboarding into TikTok Target Plan and the affiliate ecosystem', 'Performance tracking across affiliate, paid and organic impact'] },
    { heading: 'Brand safety', items: ['AI-powered content vetting and brand safety SOPs', 'Full control over brand perception and premium positioning', 'Content vetting and brand risk SOPs as the anchor, powered with AI'] },
  ],
  framework: [
    { heading: 'Creator activation', items: ['Build a dense creator ecosystem promoting your brand daily', 'Identify and activate creators with strong audience-brand fit and proven conversion potential', 'Seed products strategically to drive consistent creator-generated content', 'Develop long-term partnerships with top performers to maximise GMV'] },
    { heading: 'Content engine', items: ['Create a constant stream of TikTok-native product discovery', 'Focus on routine-driven content: morning rituals, cooking habits, cleaning flows, everyday home routines', 'Drive storytelling around performance, product upgrades and real-life integration', 'Continuously analyse performance data to scale high-converting formats'] },
    { heading: 'Live commerce', items: ['Run creator-led livestreams built around authentic, everyday moments', 'Use flash deals, bundles and limited-time offers to create urgency', 'Position livestreams as entertainment-first experiences, not traditional sales formats', 'Blend storytelling, community interaction and live product discovery'] },
  ],
  profitability: [
    { heading: 'High GMV sampling strategy', items: ['Samples are sent to creators with high conversion probability, based on performance indicators such as audience fit, engagement quality and historical conversion signals.'] },
    { heading: 'Affiliate-led growth', items: ['Creators earn commission on the sales they generate, aligning incentives between brand and creator. This encourages content designed to convert and turns creators into long-term sales partners rather than one-off influencers.'] },
    { heading: 'Snowball effect', items: ['Successful creators keep driving revenue as their videos remain in circulation on TikTok. More creators → more content → more discovery → more sales.'] },
  ],
  shoppable: { who: ['Performance-driven creators already active on TikTok Shop', 'Niche specialists across relevant content verticals'], role: ['Drive high-volume, conversion-focused content', 'Continuously test formats, hooks and products', 'Generate consistent, scalable GMV'], why: ['Deep understanding of TikTok Shop mechanics', 'Proven ability to convert, not just create content', 'Fast onboarding, immediate impact'] },
  live: { formats: ['Real-life use cases — integrating the product into everyday moments', 'Routine-driven content — how the product fits into habits', 'Before and after — outcome-focused storytelling', 'Live testing and proof — showing results in real time'] },
  studio: { enables: ['Multi-camera setups and professional lighting', 'Clean, brand-adaptable sets', 'Stable high-speed livestream infrastructure', 'Professional audio control for consistent LIVE delivery', 'Live moderation and sales support', 'Real-time product pinning and Shop integration', 'Additional office / guest room for prep, storage or talent briefing'], advantage: ['Zero dependency on external setups, locations or availability', 'Faster turnaround, tighter quality control, reliable daily LIVE output'] },
  team: { leads: [['Isaac Sinclair', 'Founder & CEO', 'isaac-sinclair.png'], ['Robat Huw', 'Co-Founder & COO', null], ['Tamara Gil Martins', 'Head of DACH', null]] as [string, string, string | null][], team: [['Jena Ally', 'Head of Growth'], ['Ana Gočmanac', 'Livestream Operator'], ['Elena Frosali', 'Account Manager'], ['Edsel Vaflor', 'Account Analyst'], ['Federica Seminerio', 'Content & Creative'], ['+ 12 CS team', 'Headcount']] as [string, string][] },
  deliverables1: [
    { heading: 'Affiliate management', items: ['Creator outreach: identify, engage and manage relationships with creators', 'Retention strategy for high-performing creators', 'Ongoing creator management and support', 'Commission and discount strategy', 'Brief and creative optimisation', 'Paid Spark Ad strategy', 'Building an in-house UGC tribe', 'Creator acquisition and plan optimisation', 'Brief, hook and CTA development', 'Monthly reporting and analytics'] },
    { heading: 'Advertising management', items: ['Return on ad spend development', 'Creative and analysis development', 'Audience and demographic optimisation', 'Ad strategy development', 'Policy compliance', 'Full-funnel optimisation', 'Budget allocation efficiency', 'Monthly reporting and analytics', 'Strategic planning and execution of TikTok paid campaigns', 'Media budget specification as requested'] },
  ],
  deliverables2: [
    { heading: 'Content production (adhoc)', items: ['Authentic content development', 'Value-add content structures', 'TTS and advertising policy compliance', 'Hook and sound development', 'Trend utilisation', 'Competitor CVR analysis', 'High-volume shoppable videos, daily or more', 'Brand-building focus'] },
    { heading: 'Profile management', items: ['Engaging content development aligned to the brand', 'High-volume publishing, adjusted upward when needed', 'Marketing calendar management across key events', 'Promotional and discount strategy', 'Community engagement', 'Monthly reporting and analytics', 'Comprehensive page management', 'Low-fi content focus'] },
    { heading: 'Shop management', items: ['Logistics support', 'Policy compliance', 'Listing support and keyword optimisation', 'Growth strategy development', 'Promotion and discount strategy', 'P&L management assistance', 'Review and rating surveillance', 'Shop build, content and campaign management'] },
  ],
  mor: [
    { heading: 'Regulatory compliance', items: ['Legal seller of record in EU markets', 'EU VAT, EPR and product safety directives', 'Local business registrations maintained'] },
    { heading: 'Tax & invoicing', items: ['Register, collect and remit VAT in all relevant jurisdictions', 'Compliant invoices to TikTok Shop and end customers', 'VAT reports and reconciliation'] },
    { heading: 'Payments & finance', items: ['Collect payments from TikTok Shop', 'Distribute net revenues after deductions', 'Chargebacks, refunds and payment disputes'] },
    { heading: 'Product & listing', items: ['List products under the MoR entity name', 'Manage restricted goods approval with TikTok'] },
    { heading: 'Logistics & fulfilment', items: ['Importer of record for cross-border shipments', 'Customs clearance and duties', 'FBT or third-party warehousing integrations'] },
    { heading: 'Risk & liability', items: ['Product liability insurance', 'Consumer rights: returns, warranties, complaints', 'Compliance audits by TikTok or EU regulators'] },
    { heading: 'Reporting & transparency', items: ['Monthly reporting on sales, VAT, returns and chargebacks', 'Settlement statements for payouts', 'Ongoing compliance monitoring'] },
  ],
  cases: [
    S('case_health', 'case_study', 'Health & nutrition brand', { body: 'Creator-led launch on TikTok Shop · Nov 2025 – Mar 2026', stats: [{ label: 'Headline', value: '£1.7M', note: 'GMV in five months' }, { label: 'GMV Max ROI', value: '15x', note: 'Return on ad spend' }, { label: 'Affiliate share', value: '89%', note: 'Creator-driven sales' }, { label: 'Impressions', value: '252M', note: null }, { label: 'Items sold', value: '100K', note: null }, { label: 'Videos', value: '18.1K', note: null }, { label: 'LIVE streams', value: '3.5K', note: null }, { label: 'Conversion', value: '2.4%', note: null }, { label: 'AOV', value: '£17.21', note: null }, { label: 'Peak month', value: '£707K', note: null }, { label: 'Commission', value: '£199K', note: null }], chart: { label: 'Monthly GMV · zero to £707K peak', labels: ['Nov', 'Dec', 'Jan', 'Feb', 'Mar'], values: [3, 5, 46, 100, 92] } }),
    S('case_beauty', 'case_study', 'Beauty & personal care brand', { body: 'Creator-led brand on TikTok Shop · Nov 2025 – Apr 2026', stats: [{ label: 'Headline', value: '€2.61M', note: 'Affiliate GMV, six months' }, { label: 'Shoppable video share', value: '98%', note: 'Creator video driven' }, { label: 'Creator commission', value: '€378K', note: 'Paid to affiliates' }, { label: 'Items sold', value: '132K', note: null }, { label: 'Shoppable videos', value: '28.1K', note: null }, { label: 'LIVE streams', value: '5,017', note: null }, { label: 'AOV', value: '€19.75', note: null }, { label: 'Peak month', value: '€630K', note: null }, { label: 'Avg month', value: '€434K', note: null }, { label: 'Refund rate', value: '6.5%', note: null }, { label: 'Net GMV', value: '€2.44M', note: null }], chart: { label: 'Monthly affiliate GMV · €630K peak', labels: ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'], values: [57, 57, 52, 68, 100, 57] } }),
  ],
  cruva: { paragraph: 'Cruva identified 1.4M+ creators across Europe producing content aligned with your category, audience and key use cases — a strong foundation for scalable creator activation.', capabilities: ['Advanced niche targeting', 'Audience demographic filtering', 'Engagement signal analysis', 'Sales signal analysis'], broad: 'Across the EU4 markets we have identified 1,462 top-performing creators generating €10K+ GMV in the last 30 days — the ideal starting point for initial outreach, letting us prioritise high-conversion creators while keeping sample distribution lean and controlled.' },
  nextSteps: ['Contract signature & onboarding', 'Strategy alignment & final setup', 'TikTok Shop launch', 'Creator activation & content rollout', 'Scale via ads & LIVEs'],
};

export function marketLabel(codes: string[]): string { return codes.map((c) => c.toUpperCase()).join(' · '); }

/** The full client deck from the brief and the research: Brightform's fixed slides plus the client's own. */
export function brightformDeck(q: Queries, brief: PitchBrief, research: PitchResearch | null): PitchDeck {
  const cur = brief.pricing.currency;
  const mk = marketLabel(brief.markets);
  const client = brief.client;
  const site = research?.site ?? null;
  const siteCur = research?.products.find((p) => p.currency)?.currency ?? site?.currency ?? cur;
  const theme = deriveBrandLayer({ primary: brief.colours.primary, secondary: brief.colours.secondary, accent: brief.colours.accent });
  const fc = brief.options.forecasts ? forecastFor(q, brief) : null;
  const own = brief.options.case_studies ? caseStudies(q, brief.case_studies) : [];
  const creators = (research?.creators ?? []).slice(0, 8);
  const products = (research?.products.length ? research.products : brief.products.map((p) => ({ ...p, rank: null as number | null, images: p.image ? [p.image] : [], currency: cur }))).slice(0, 6);
  const tiktokProducts = (research?.tiktok.brand_products ?? []).slice(0, 6); // research saved before the brand products existed has none
  const brand = research?.tiktok.brand ?? null;
  const market = research?.tiktok.market ?? [];
  const scope = ['Shop', brief.options.creators ? 'affiliate' : null, 'ads', brief.options.livestream ? 'LIVE' : null, brief.pricing.commission_basis === 'mor' ? 'MoR' : null].filter(Boolean).join(', ');

  const slides: PitchSlide[] = [
    S('cover', 'cover', 'End-to-end TikTok Shop management', { subtitle: `Prepared for ${client}`, stats: [{ label: 'Prepared for', value: client, note: null }, { label: 'Markets', value: mk, note: null }, { label: 'Scope', value: scope, note: null }, { label: 'Date', value: new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), note: null }], images: research?.site?.logo ? [research.site.logo] : [] }),
    S('why_us', 'why_us', 'Why us', { panels: BRIGHTFORM.quotes.map((x) => ({ heading: x.name, items: [x.quote, x.role] })), bullets: [...BRIGHTFORM.creds], body: 'Certified in all three TSP categories, Q1 2026' }),
    S('portfolio', 'portfolio', 'TSP portfolio overview', { subtitle: '€8.19M GMV across DE, FR and IT in six months. 1.25 billion impressions powering 388K sold units. 75% of GMV driven by affiliates — the model works.', stats: BRIGHTFORM.portfolio.map(([label, value, note]) => ({ label, value, note })) }),
    S('clients', 'clients', 'Our clients', { subtitle: 'Trusted by brands as a TikTok Shop partner, we drive performance across healthcare, fashion, food & beverage, beauty and lifestyle — scaling success across multiple European markets.' }),
    S('awards', 'awards', 'Award-winning performance', { body: 'Certified across affiliates, ads and short video — recognised by TikTok Shop as a top-ten German TSP in all three categories.' }),
  ];

  // The client today: what the brand does on TikTok Shop and on its own site.
  const presenceStats: (PitchStat | null)[] = [
    brand ? { label: `Brand GMV, last 30 days (${brand.region})`, value: fmt(brand.gmv ?? 0, 'USD'), note: `${k(brand.creators)} creators · ${k(brand.videos)} videos` } : null,
    research?.tiktok.shops.length ? { label: 'Shops selling the brand', value: String(research.tiktok.shops.length), note: research.resellers.length ? `${research.resellers.length} reseller${research.resellers.length === 1 ? '' : 's'}` : 'official shop only' } : null,
    tiktokProducts.length ? { label: 'Top product on TikTok Shop', value: fmt(tiktokProducts[0].gmv_28d ?? 0, cur), note: `${tiktokProducts[0].name.slice(0, 48)} · 28 days` } : null,
    site?.product_count ? { label: `Products on ${site.platform === 'shopify' ? 'the Shopify store' : 'the site'}`, value: String(site.product_count), note: products[0] ? `best seller: ${products[0].name.slice(0, 40)}` : null } : null,
  ];
  slides.push(S('presence', 'presence', `${client} today`, {
    subtitle: site?.description ? site.description.slice(0, 220) : null,
    stats: presenceStats.filter((x): x is PitchStat => x !== null).slice(0, 4),
    bullets: [
      ...(research?.resellers.slice(0, 4).map((r) => `${r.name} (${r.region})${r.gmv_7d !== null ? ` · ${fmt(r.gmv_7d, cur)} last 7 days` : ''}`) ?? []),
      ...tiktokProducts.slice(0, 4).map((p) => `${p.name.slice(0, 60)}${p.gmv_28d !== null ? ` · ${fmt(p.gmv_28d, cur)} in 28 days` : ''}${p.units_28d !== null ? ` · ${k(p.units_28d)} units` : ''}`),
    ],
    body: research ? (brand || tiktokProducts.length ? '→ The brand already sells on TikTok Shop; the job is scale, not launch.' : '→ No TikTok Shop footprint found yet: a launch with a creator base from day one.') : 'Run the research to fill this slide.',
  }));
  if (brief.options.pdp_imagery && products.length) slides.push(S('products', 'products', 'Your best sellers', {
    subtitle: site?.platform === 'shopify' ? `In the order ${client}'s own store sells them. These are the products the first creator wave gets.` : `From ${client}'s product pages. These are the products the first creator wave gets.`,
    stats: products.map((p) => ({ label: p.name, value: p.price !== null ? price(p.price, p.currency ?? siteCur) : '', note: p.rank ? `#${p.rank} best seller` : null })),
    images: products.map((p) => p.image ?? ''),
  }));
  if (brief.options.market) slides.push(S('market', 'market', `TikTok Shop in ${brief.markets.map((m) => MARKET_NAMES[m.toUpperCase()] ?? m).join(' and ')}`, {
    stats: market.slice(0, 2).flatMap((m) => [{ label: `${MARKET_NAMES[m.market] ?? m.market}: shops we track`, value: String(m.prospects), note: `${m.surging} surging this week` }]).concat(research?.tiktok.top_products.slice(0, 2).map((p) => ({ label: p.name.slice(0, 50), value: p.gmv !== null ? fmt(p.gmv, cur) : '–', note: `${p.shop ?? 'category leader'} · 28 days` })) ?? []).slice(0, 4),
    bullets: [...market.map((m) => `${MARKET_NAMES[m.market] ?? m.market} leaders this week: ${m.leaders.slice(0, 4).join(', ') || 'n/a'}`), ...(research?.tiktok.top_products.slice(2, 6).map((p) => `${p.name.slice(0, 60)}${p.gmv !== null ? ` · ${fmt(p.gmv, cur)} in 28 days` : ''}${p.shop ? ` (${p.shop})` : ''}`) ?? [])],
    body: brief.category ? `→ ${brief.category} is being bought on TikTok Shop in ${mk} today; the question is who gets the creators.` : null,
  }));
  slides.push(S('opportunity', 'opportunity', 'The opportunity', {
    bullets: [`Launch ${client} on TikTok Shop ${mk} with a creator-led programme from day one`, 'Affiliate GMV first: hundreds of small and mid creators posting consistently beats a few big names', 'Standing discount and GMV Max to convert the traffic the creators bring', 'Live selling once the creator base is there', 'Brightform runs the shop day to day: listings, logistics, policy, customer service'],
    stats: fc ? [{ label: `GMV over ${fc.months.length} months`, value: fmt(fc.total_gmv, cur), note: `${pct(brief.forecast.growth_pct)} monthly growth` }, { label: `Month ${fc.months.length} GMV`, value: fmt(fc.month12_gmv, cur), note: `from ${fmt(brief.forecast.start_gmv, cur)} in month 1` }] : [],
    body: '→ Once approved, Brightform can begin creator activation within days.',
  }));
  if (brief.options.case_studies) {
    slides.push(S('divider_cases', 'divider', 'Case studies'));
    for (const c of BRIGHTFORM.cases) slides.push({ ...c, stats: c.stats.map((x) => ({ ...x })), chart: c.chart ? { ...c.chart, labels: [...c.chart.labels], values: [...c.chart.values] } : undefined });
    for (const c of own) slides.push(S(`case_${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, 'case_study', c.name, { body: `Managed by Brightform${c.markets ? ` · ${c.markets}` : ''} · last 90 days`, stats: [{ label: 'Headline', value: fmt(c.gmv_90d, c.currency), note: 'GMV, last 90 days' }, { label: 'Growth', value: c.growth_pct === null ? '–' : `${c.growth_pct >= 0 ? '+' : ''}${c.growth_pct}%`, note: 'vs the 90 days before' }, { label: 'Affiliate share', value: c.affiliate_share === null ? '–' : `${c.affiliate_share}%`, note: 'Creator-driven sales' }, { label: 'Previous 90 days', value: fmt(c.prev_90d, c.currency), note: null }] }));
  }
  slides.push(S('outreach', 'outreach', 'EU4 creator outreach system', { subtitle: 'Using Cruva and our internal CRM infrastructure, we scale high-quality creator partnerships across Germany, France, Spain and Italy.', panels: BRIGHTFORM.outreach.map((p) => ({ heading: p.heading, items: [...p.items] })), body: '→ A curated, high-performing creator ecosystem: outreach becomes a predictable growth engine.' }));
  slides.push(S('framework', 'framework', 'Growth framework', { panels: BRIGHTFORM.framework.map((p) => ({ heading: p.heading, items: [...p.items] })) }));
  if (brief.options.creators) slides.push(S('cruva', 'cruva', 'Cruva insights', {
    body: BRIGHTFORM.cruva.paragraph.replace('your category', brief.category ? `${brief.category.toLowerCase()}` : 'your category'),
    bullets: [...BRIGHTFORM.cruva.capabilities],
    stats: [{ label: 'Creators identified across Europe', value: '1.4M+', note: 'Aligned to your category' }, { label: 'Reachable via broad demand outreach', value: '1M+', note: 'Current capacity' }, ...(creators.length ? [{ label: `Creators already selling ${brief.category || 'in your category'}`, value: String(creators.length), note: `${creators.filter((c) => (c.gmv_30d ?? 0) > 0).length} with GMV in the last 30 days` }] : [])],
    subtitle: BRIGHTFORM.cruva.broad,
  }));
  if (brief.options.creators && creators.length) slides.push(S('creators', 'creators', 'Creators to start with', {
    subtitle: `Target profile: ${brief.creator_query || `${brief.category || client} content creators in ${mk}`}`,
    stats: creators.map((c) => ({ label: `@${c.handle}`, value: c.gmv_30d !== null ? fmt(c.gmv_30d, 'USD') : c.followers !== null ? `${k(c.followers)} followers` : '–', note: [c.gmv_30d !== null ? '30-day GMV' : null, c.followers !== null && c.gmv_30d !== null ? `${k(c.followers)} followers` : null, c.categories ? c.categories.split(',')[0].trim() : null].filter(Boolean).join(' · ') || null })),
    bullets: ['Outreach in waves through Cruva: open plan, target collab tiers for the top sellers, samples within 48 hours', 'Brief with hooks and CTAs per product; retention plan for anyone who sells', 'Creator qualification on content quality, audience fit and brand alignment, not just GMV'],
  }));
  slides.push(S('profitability', 'profitability', 'Profitability & sustainable scaling', { panels: BRIGHTFORM.profitability.map((p) => ({ heading: p.heading, items: [...p.items] })) }));
  slides.push(S('shoppable', 'shoppable', 'Shoppable content videos', { subtitle: 'Scale shoppable video GMV with UGC and high-performing affiliate creators — the conversion engine.', panels: [{ heading: 'Who', items: [...BRIGHTFORM.shoppable.who] }, { heading: 'Role', items: [...BRIGHTFORM.shoppable.role] }, { heading: 'Why it works', items: [...BRIGHTFORM.shoppable.why] }], stats: [{ label: 'Shoppable videos produced', value: '103.5K', note: 'Across the managed portfolio' }], body: '→ The core engine for daily sales and algorithm learning.' }));
  if (brief.options.livestream) {
    slides.push(S('livestream', 'livestream', 'Livestream strategy', { subtitle: 'Across TikTok Shop, one thing is clear: products that are experienced in real time consistently outperform.', body: "Consumers don't buy on features alone. They convert when they understand how a product fits into their life, solves a need, or delivers a clear result. Livestream creates exactly that environment — turning products into tangible, relatable experiences rather than static listings.", bullets: [...BRIGHTFORM.live.formats], notes: '→ Livestreams as interactive, value-driven experiences, not pure product selling — aligned with premium brand perception.' }));
    slides.push(S('studio', 'studio', 'Our studio', { subtitle: 'Our in-house livestream studio in Munich — fully equipped, permanent, built specifically for TikTok Shop livestreams and optimised for speed, consistency and scale.', panels: [{ heading: 'What the studio enables', items: [...BRIGHTFORM.studio.enables] }, { heading: 'Office space in TT HQ', items: ['Same building, supported by TikTok Shop DE. Real-time insight into what TikTok Shop is prioritising.'] }, { heading: 'Studio advantage', items: [...BRIGHTFORM.studio.advantage] }], body: '→ Higher retention. Higher conversion. Cleaner execution.' }));
  }
  if (fc) slides.push(S('forecast', 'forecast', `${fc.months.length}-month forecast`, {
    stats: [{ label: `GMV over ${fc.months.length} months`, value: fmt(fc.total_gmv, cur), note: `${pct(brief.forecast.growth_pct)} monthly growth` }, { label: `Month ${fc.months.length} GMV`, value: fmt(fc.month12_gmv, cur), note: `from ${fmt(brief.forecast.start_gmv, cur)} in month 1` }, { label: 'Client net profit', value: fmt(fc.total_net, cur), note: `COGS ${pct(brief.forecast.cogs_pct)}, ads ${fmt(brief.forecast.ad_spend, cur)} a month` }, { label: 'Brightform billing', value: fmt(fc.total_billing, cur), note: 'retainer and commission over the period' }],
    bullets: [`AOV ${fmt(brief.forecast.aov, cur)} with a ${pct(brief.forecast.discount_pct)} standing discount`, `Ad ROI ${brief.forecast.ad_roi}x on ${fmt(brief.forecast.ad_spend, cur)} a month`, `${brief.forecast.samples_per_month} samples a month at ${fmt(brief.forecast.sample_gmv_each, cur)} GMV each`],
    chart: { label: `Monthly GMV · ${fmt(fc.month12_gmv, cur)} in month ${fc.months.length}`, labels: fc.months.map((m) => m.month.slice(5)), values: (() => { const max = Math.max(...fc.months.map((m) => m.gmv), 1); return fc.months.map((m) => Math.round((m.gmv / max) * 100)); })() },
  }));
  const pricingStats: (PitchStat | null)[] = [brief.pricing.retainer !== null ? { label: 'Retainer', value: `${fmt(brief.pricing.retainer, cur)} / month`, note: 'per store, per country' } : null, brief.pricing.commission_pct !== null ? { label: 'Commission', value: `${brief.pricing.commission_pct}%`, note: brief.pricing.commission_basis === 'mor' ? 'of net settlement (MoR)' : 'of GMV' } : null, { label: 'Initial term', value: `${brief.pricing.term_months} months`, note: 'then monthly' }];
  slides.push(S('pricing', 'pricing', 'Commercials', { stats: pricingStats.filter((x): x is PitchStat => x !== null), bullets: [brief.pricing.creator_video_fee !== null ? `Creator videos ${fmt(brief.pricing.creator_video_fee, cur)} each, on approval` : '', brief.pricing.live_rate !== null ? `Live production ${fmt(brief.pricing.live_rate, cur)} an hour` : '', 'Retainer billed in advance, commission in arrears on the month’s GMV', brief.pricing.commission_basis === 'mor' ? 'Merchant of Record: Brightform Social Media UG sells into the EU and settles net of platform fees, refunds and cancellations' : ''].filter(Boolean) }));
  slides.push(S('deliverables1', 'deliverables', 'Deliverables 1 / 2', { subtitle: 'Affiliate and advertising management.', panels: BRIGHTFORM.deliverables1.map((p) => ({ heading: p.heading, items: [...p.items] })) }));
  slides.push(S('deliverables2', 'deliverables', 'TSP deliverables 2 / 2', { subtitle: 'Content production, profile management and shop management.', panels: BRIGHTFORM.deliverables2.map((p) => ({ heading: p.heading, items: [...p.items] })) }));
  if (brief.pricing.commission_basis === 'mor') slides.push(S('mor', 'mor', 'MoR deliverables', { subtitle: 'Brightform acts as legal seller of record in EU markets, carrying the regulatory, tax and liability load.', panels: BRIGHTFORM.mor.map((p) => ({ heading: p.heading, items: [...p.items] })), body: 'One entity, one contract. The brand ships product; Brightform carries the compliance.' }));
  slides.push(S('team', 'team', 'Meet the team', { subtitle: "Clients are supported by dedicated market specialists combining strategic oversight, shop operations, performance analysis, customer service, livestream execution, creator management and content optimisation — managed by local-language experts and backed by Brightform's wider European infrastructure." }));
  slides.push(S('next', 'next', 'Next steps', { bullets: [...BRIGHTFORM.nextSteps], body: '→ Once approved, Brightform can begin creator activation within days.' }));
  slides.push(S('closing', 'closing', "Let's do it", { subtitle: 'Why wait?', stats: [{ label: 'Email', value: q.getSetting('pitch_contact_email', '') || 'isaac@brightform.agency', note: null }, { label: 'Website', value: 'www.brightform.agency', note: null }] }));

  return {
    palette: { primary: brief.colours.primary, secondary: brief.colours.secondary, accent: brief.colours.accent, ink: '#000000', paper: '#ffffff' },
    theme: { panel1: theme.layer.panel1, panel2: theme.layer.panel2, accent: theme.layer.accent, accent_ink: theme.layer.accentInk, data: theme.layer.data, data_ink: theme.layer.dataInk, contrast_accent: Math.round(theme.contrast.accent * 10) / 10, contrast_data: Math.round(theme.contrast.data * 10) / 10, neutral: theme.source.neutral },
    slides, generator: 'template', built_at: new Date().toISOString(),
  };
}
