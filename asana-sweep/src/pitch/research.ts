import type { Queries } from '../db/queries.js';
import type { Lead, PitchBrief, PitchCreator, PitchResearch, TargetSource } from '../sweep/types.js';
import { fastmoss, isQuotaError, type FastmossClient } from '../bd/fastmoss.js';
import { cruvaMcp, type CruvaMcp } from '../cruva/mcp.js';
import { gatherTargetContext } from '../onboarding/targets.js';
import { searchEvidence } from '../copilot/index.js';
import { riseBand } from '../bd/score.js';
import { log } from '../logger.js';

/**
 * Pitch research: everything the deck can lean on, gathered in one pass from the client's site and PDPs
 * (images, titles, prices), the pitch context on record (the tl;dv pitch call, emails and Slack that name
 * the client, internal calls excluded), TikTok Shop through FastMoss and Cruva (the brand's presence,
 * resellers, top products in the category, the creators to build the strategy on, with followers and
 * GMV), the market numbers from the BD pipeline, and Amazon as a price and reseller check (best effort).
 */

export interface ResearchDeps { fastmoss?: FastmossClient; cruva?: CruvaMcp; fetchFn?: typeof fetch; cruvaShopId?: string | null }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 BrightformPitch/1.0';

async function fetchHtml(url: string, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text.slice(0, 1_500_000);
}

const abs = (src: string, base: string): string | null => { try { return new URL(src, base).toString(); } catch { return null; } };
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/** Title, description, theme colour and the product-looking images of a page. */
export function parsePage(html: string, url: string): { title: string | null; description: string | null; theme_colour: string | null; images: string[]; price: number | null; og_image: string | null } {
  const meta = (names: string[]): string | null => {
    for (const n of names) {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']+)["']`, 'i')) ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i'));
      if (m) return decode(m[1]);
    }
    return null;
  };
  const title = meta(['og:title']) ?? (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1] ? decode(html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)![1]) : null);
  const description = meta(['og:description', 'description']);
  const theme_colour = meta(['theme-color']);
  const og = meta(['og:image', 'og:image:secure_url', 'twitter:image']);
  const og_image = og ? abs(og, url) : null;
  const priceRaw = meta(['product:price:amount', 'og:price:amount']) ?? html.match(/"price"\s*:\s*"?(\d+(?:[.,]\d{1,2})?)"?/)?.[1] ?? null;
  const price = priceRaw ? Number(String(priceRaw).replace(',', '.')) : null;
  const images = new Set<string>();
  if (og_image) images.add(og_image);
  for (const m of html.matchAll(/<img[^>]+(?:src|data-src|data-srcset)=["']([^"'\s]+)["'][^>]*>/gi)) {
    const tag = m[0];
    const src = abs(m[1].split(',')[0].trim().split(' ')[0], url);
    if (!src || !/\.(jpe?g|png|webp)(\?|$)/i.test(src)) continue;
    if (/logo|icon|sprite|pixel|badge|flag|payment|avatar|placeholder|loading|1x1|blank|spinner|cookie|arrow|svg/i.test(src + tag)) continue;
    const w = Number(tag.match(/\swidth=["']?(\d+)/i)?.[1] ?? 0), h = Number(tag.match(/\sheight=["']?(\d+)/i)?.[1] ?? 0);
    if ((w && w < 120) || (h && h < 120)) continue;
    images.add(src);
    if (images.size >= 24) break;
  }
  return { title, description, theme_colour: theme_colour && /^#?[0-9a-f]{3,8}$/i.test(theme_colour) ? (theme_colour.startsWith('#') ? theme_colour : `#${theme_colour}`) : null, images: [...images], price: Number.isFinite(price as number) ? price : null, og_image };
}

/** Amazon search page, best effort: titles, prices and links. Amazon often refuses bots; then reachable is false. */
export function parseAmazon(html: string, base: string): { title: string; price: string | null; url: string }[] {
  const out: { title: string; price: string | null; url: string }[] = [];
  const chunks = html.split(/(?=data-asin="[A-Z0-9]{10}")/);
  for (const chunk of chunks) {
    const asin = chunk.match(/^data-asin="([A-Z0-9]{10})"/)?.[1];
    if (!asin) continue;
    const title = chunk.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([^<]{5,200})<\/span>/)?.[1];
    if (!title) continue;
    const t = decode(title);
    if (out.some((o) => o.title === t)) continue;
    const price = chunk.match(/<span class="a-offscreen">([^<]{1,20})<\/span>/)?.[1];
    out.push({ title: t, price: price ? decode(price) : null, url: `${base}/dp/${asin}` });
    if (out.length >= 8) break;
  }
  return out;
}

const num = (v: unknown): number | null => { const n = typeof v === 'string' ? Number(v.replace(/[^0-9.-]/g, '')) : Number(v); return Number.isFinite(n) ? n : null; };
const rows = (payload: unknown): Record<string, unknown>[] => {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === 'object') { const o = payload as Record<string, unknown>; for (const k of ['list', 'data', 'items', 'rows', 'results']) { const v = o[k]; if (Array.isArray(v)) return v as Record<string, unknown>[]; if (v && typeof v === 'object') { const inner = rows(v); if (inner.length) return inner; } } }
  return [];
};

/** Cruva's "- @handle (Name) | 20,220 followers | 30d GMV $10333.0 | engagement 1.2% | ... | categories" lines. */
export function parseCruvaCreators(text: string): PitchCreator[] {
  const out: PitchCreator[] = [];
  let cur: PitchCreator | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s*@([^\s(|]+)\s*(?:\(([^)]*)\))?\s*\|\s*([\d,.]+)\s*followers\s*\|\s*30d GMV\s*\$?([\d,.]+)\s*\|\s*engagement\s*([\d.]+)%(?:\s*\|\s*similarity\s*[\d.]+)?\s*\|?\s*(.*)$/i);
    if (m) { cur = { handle: m[1], name: m[2]?.trim() || null, followers: num(m[3]), gmv_30d: num(m[4]), engagement: num(m[5]), categories: m[6]?.trim() || null, video_url: null, source: 'cruva' }; out.push(cur); continue; }
    const v = line.match(/video:\s*(https?:\/\/\S+)/i);
    if (v && cur && !cur.video_url) cur.video_url = v[1];
  }
  return out;
}

/** Cruva's "Brand (brand_id: X) - GMV: $16,196.73 | Creators: 646 | Videos: 305 | Category: ..." line. */
export function parseCruvaBrand(text: string, region: string): PitchResearch['tiktok']['brand'] {
  const m = text.match(/^\s*(.+?)\s*\(brand_id:\s*\d+\)\s*-\s*GMV:\s*\$?([\d,.]+)\s*\|\s*Creators:\s*([\d,]+)\s*\|\s*Videos:\s*([\d,]+)/m);
  return m ? { name: m[1].trim(), gmv: num(m[2]), creators: num(m[3]), videos: num(m[4]), region } : null;
}

const regionOf = (market: string): string => ({ UK: 'uk', GB: 'uk', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl', BE: 'be', IE: 'ie', PL: 'pl', AT: 'at', US: 'us' } as Record<string, string>)[market.toUpperCase()] ?? market.toLowerCase();
const amazonHost = (market: string): string => ({ UK: 'www.amazon.co.uk', DE: 'www.amazon.de', FR: 'www.amazon.fr', IT: 'www.amazon.it', ES: 'www.amazon.es', NL: 'www.amazon.nl', BE: 'www.amazon.com.be', PL: 'www.amazon.pl', US: 'www.amazon.com' } as Record<string, string>)[market.toUpperCase()] ?? 'www.amazon.de';

export async function researchPitch(q: Queries, brief: PitchBrief, lead: Lead | null, deps: ResearchDeps = {}): Promise<PitchResearch> {
  const fetchFn = deps.fetchFn ?? fetch;
  const fm = deps.fastmoss ?? fastmoss;
  const cr = deps.cruva ?? cruvaMcp;
  const errors: string[] = [];
  const out: PitchResearch = { fetched_at: new Date().toISOString(), errors, site: null, products: [], context: [], tiktok: { brand: null, shops: [], top_products: [], market: [] }, creators: [], amazon: { reachable: false, items: [] }, resellers: [] };
  const markets = (brief.markets.length ? brief.markets : ['DE']).slice(0, 3);
  const client = brief.client.trim();

  // The client's site and PDPs.
  if (brief.website) {
    try { const html = await fetchHtml(/^https?:/i.test(brief.website) ? brief.website : `https://${brief.website}`, fetchFn); const p = parsePage(html, brief.website.startsWith('http') ? brief.website : `https://${brief.website}`); out.site = { title: p.title, description: p.description, theme_colour: p.theme_colour, images: p.images.slice(0, 16) }; } catch (err) { errors.push(`Site: ${(err as Error).message}`); }
  }
  for (const pr of brief.products.filter((x) => x.url).slice(0, 8)) {
    try { const html = await fetchHtml(pr.url!, fetchFn); const p = parsePage(html, pr.url!); out.products.push({ name: pr.name || p.title || pr.url!, price: pr.price ?? p.price, image: pr.image || p.og_image || p.images[0] || null, url: pr.url! }); } catch (err) { errors.push(`PDP ${pr.name || pr.url}: ${(err as Error).message}`); out.products.push({ name: pr.name, price: pr.price, image: pr.image, url: pr.url! }); }
  }

  // Pitch context on record (same privacy rule as Targets).
  if (lead) out.context = gatherTargetContext(q, lead).sources;
  else if (client) {
    const nameLc = client.toLowerCase();
    const ev = q.listEvidence({ kinds: ['call', 'email', 'slack'] }).filter((r) => (r.title + r.text.slice(0, 4000)).toLowerCase().includes(nameLc) && !(r.kind === 'call' && /\b(internal|founders?|1:1|catch[\s-]?up|weekly|standup|all[\s-]?hands|interview)\b/i.test(r.title) && !r.title.toLowerCase().includes(nameLc)));
    out.context = searchEvidence(ev.map((r) => ({ kind: r.kind, title: r.title, text: r.text, url: r.url, occurred_at: r.occurred_at })), `${client} pitch proposal pricing launch TikTok Shop`, 8).map((h): TargetSource => ({ kind: h.kind, title: h.title, occurred_at: h.occurred_at, url: h.url, snippet: h.snippet }));
  }

  // Market numbers from the BD pipeline (FastMoss pulls already on disk).
  const prospects = q.listProspects(false);
  out.tiktok.market = markets.map((m) => { const mine = prospects.filter((p) => p.market === m.toUpperCase()); return { market: m.toUpperCase(), prospects: mine.length, surging: mine.filter((p) => riseBand(p.rise_score) === 'surging').length, leaders: [...mine].sort((a, b) => (b.gmv_7d ?? 0) - (a.gmv_7d ?? 0)).slice(0, 5).map((p) => p.brand ?? p.shop_name) }; });

  // FastMoss: the brand's shops (and resellers), the category's top products, creators by GMV.
  if (fm.configured && (brief.options.resellers || brief.options.market || brief.options.creators)) {
    for (const m of markets.slice(0, 2)) {
      const region = m.toUpperCase() === 'UK' ? 'GB' : m.toUpperCase();
      try {
        if (brief.options.resellers || brief.options.market) {
          const shops = rows(await fm.callTool('shop_search', { keywords: client, filter: { region }, orderby: [{ field: 'day7_gmv', order: 'desc' }], page: 1, pagesize: 10 }));
          for (const s of shops) {
            const name = String(s.shop_name ?? s.name ?? '');
            if (!name) continue;
            const row = { shop_name: name, region: m.toUpperCase(), gmv_7d: num(s.day7_gmv ?? s.gmv_7d ?? s.day7_sale_amount), total_gmv: num(s.total_gmv ?? s.sale_amount), seller_id: s.seller_id ? String(s.seller_id) : null };
            out.tiktok.shops.push(row);
            if (!name.toLowerCase().includes(client.toLowerCase()) || /official|offiziell/i.test(name) === false && out.tiktok.shops.length > 1) out.resellers.push({ name, region: m.toUpperCase(), gmv_7d: row.gmv_7d, note: name.toLowerCase().includes(client.toLowerCase()) ? 'carries the brand name' : 'sells the brand' });
          }
        }
        if (brief.options.market && brief.category) {
          const products = rows(await fm.callTool('product_search', { keywords: brief.category, filter: { region }, orderby: [{ field: 'day28_gmv', order: 'desc' }], page: 1, pagesize: 10 }));
          for (const p of products) { const prod = (p.product as Record<string, unknown> | undefined) ?? p; const sales = (p.sales_summary as Record<string, unknown> | undefined) ?? p; const shop = (p.shop as Record<string, unknown> | undefined) ?? {}; out.tiktok.top_products.push({ name: String(prod.title ?? prod.name ?? prod.product_name ?? ''), region: m.toUpperCase(), gmv: num(sales.day28_gmv ?? sales.day28_sale_amount ?? sales.total_gmv), units: num(sales.day28_units_sold ?? sales.day28_sold_count), price: num(prod.price ?? prod.floor_price), shop: shop.shop_name ? String(shop.shop_name) : null }); }
        }
        if (brief.options.creators) {
          const creators = rows(await fm.callTool('creator_search', { keywords: brief.category || client, filter: { region, is_ecommerce_creator: true }, orderby: [{ field: 'day28_gmv', order: 'desc' }], page: 1, pagesize: 10 }));
          for (const c of creators) { const cr2 = (c.creator as Record<string, unknown> | undefined) ?? c; const com = (c.commerce_summary as Record<string, unknown> | undefined) ?? c; const handle = String(cr2.unique_id ?? cr2.handle ?? ''); if (!handle || out.creators.some((x) => x.handle === handle)) continue; out.creators.push({ handle, name: cr2.nickname ? String(cr2.nickname) : null, followers: num(cr2.follower_count), gmv_30d: num(com.day28_gmv ?? com.day28_sale_amount), engagement: null, categories: cr2.category ? String(cr2.category) : null, video_url: null, source: 'fastmoss' }); }
        }
      } catch (err) { errors.push(`FastMoss ${m}: ${(err as Error).message.slice(0, 160)}`); if (isQuotaError(err)) break; }
    }
  }

  // Cruva: the brand across TikTok Shop and creators whose videos look like the pitch.
  if (cr.configured) {
    const region = regionOf(markets[0]);
    try { const text = await cr.call('search_marketplace_brands', { search: client, region, page_size: 3 }); out.tiktok.brand = parseCruvaBrand(text, region.toUpperCase()); } catch (err) { errors.push(`Cruva brand: ${(err as Error).message.slice(0, 160)}`); }
    if (brief.options.creators) {
      const shopId = deps.cruvaShopId ?? q.listShops('cruva')[0]?.shop_id ?? null;
      if (shopId) {
        try { const text = await cr.call('ai_search_creators', { shop_id: shopId, searchable_query: brief.creator_query || `${brief.category || client} product review at home`, page_size: 12, recency: '3' }); for (const c of parseCruvaCreators(text)) if (!out.creators.some((x) => x.handle === c.handle)) out.creators.push(c); } catch (err) { errors.push(`Cruva creators: ${(err as Error).message.slice(0, 160)}`); }
      } else errors.push('Cruva creators: no Cruva shop linked to search from.');
    }
  }
  out.creators.sort((a, b) => (b.gmv_30d ?? 0) - (a.gmv_30d ?? 0));
  out.creators = out.creators.slice(0, 16);

  // Amazon, best effort.
  if (brief.options.amazon) {
    const host = amazonHost(markets[0]);
    try { const html = await fetchHtml(`https://${host}/s?k=${encodeURIComponent(client)}`, fetchFn); const items = parseAmazon(html, `https://${host}`); out.amazon = { reachable: items.length > 0 || /s-result-item/.test(html), items }; } catch (err) { out.amazon = { reachable: false, items: [] }; errors.push(`Amazon: ${(err as Error).message.slice(0, 120)}`); }
  }
  if (errors.length) log.info(`Pitch research for ${client}: ${errors.length} note(s)`);
  return out;
}
