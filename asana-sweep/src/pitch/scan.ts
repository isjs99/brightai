import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexToRgb, rgbToLab } from './theme.js';

/**
 * The brand scan behind a pitch: the client's own site read without a browser. Shopify stores (most DTC
 * brands) publish every product as JSON at /products.json and the all-products collection in best-selling
 * order, which gives titles, prices, variants, images and a sales rank in two requests. Any other site is
 * read through its product pages' schema.org JSON-LD. The homepage's stylesheets give the brand colours by
 * frequency (greys, near-white and near-black dropped), and the logo comes from the page's own tags.
 * Product images are downloaded into the pitch's folder so a deck never depends on the brand's CDN.
 */

export interface ScanProduct { name: string; url: string; handle: string | null; price: number | null; currency: string | null; images: string[]; rank: number | null; vendor: string | null; type: string | null; available: boolean | null; tags: string[] }
export interface SiteScan {
  url: string;
  platform: 'shopify' | 'other';
  title: string | null;
  description: string | null;
  theme_colour: string | null;
  colours: string[];
  logo: string | null;
  currency: string | null;
  products: ScanProduct[];
  errors: string[];
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 BrightformPitch/1.0';
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const originOf = (website: string): string => { const u = new URL(/^https?:/i.test(website) ? website : `https://${website}`); return `${u.protocol}//${u.host}`; };
const abs = (src: string, base: string): string | null => { try { return new URL(src, base).toString(); } catch { return null; } };
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const num = (v: unknown): number | null => { const n = typeof v === 'string' ? Number(v.replace(/[^0-9.,-]/g, '').replace(',', '.')) : Number(v); return Number.isFinite(n) ? n : null; };

async function get(url: string, fetchFn: FetchLike, accept = 'text/html,application/json'): Promise<{ status: number; text: string; type: string }> {
  const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 2_000_000), type: res.headers.get('content-type') ?? '' };
}
async function getJson(url: string, fetchFn: FetchLike): Promise<unknown | null> {
  try { const r = await get(url, fetchFn, 'application/json'); if (r.status !== 200 || !/json/i.test(r.type) && !r.text.trim().startsWith('{')) return null; return JSON.parse(r.text); } catch { return null; }
}

// ---- Shopify ----

interface ShopifyProduct { id: number; title: string; handle: string; vendor?: string; product_type?: string; tags?: string[] | string; variants?: { price?: string; available?: boolean }[]; images?: { src: string }[] }

export function shopifyProducts(payload: unknown, origin: string, currency: string | null): ScanProduct[] {
  const list = (payload as { products?: ShopifyProduct[] } | null)?.products;
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && p.title && p.handle).map((p) => {
    const prices = (p.variants ?? []).map((v) => num(v.price)).filter((x): x is number => x !== null);
    return { name: decode(p.title), url: `${origin}/products/${p.handle}`, handle: p.handle, price: prices.length ? Math.min(...prices) : null, currency, images: (p.images ?? []).map((i) => i.src).filter(Boolean).slice(0, 4), rank: null, vendor: p.vendor ?? null, type: p.product_type || null, available: (p.variants ?? []).some((v) => v.available) ? true : (p.variants ?? []).length ? false : null, tags: Array.isArray(p.tags) ? p.tags : typeof p.tags === 'string' ? p.tags.split(',').map((t) => t.trim()).filter(Boolean) : [] };
  });
}

/** A Shopify CDN image at a given width (the CDN resizes on the fly: name_1200x.jpg). */
export function shopifyImageAt(url: string, width = 1200): string {
  if (!/cdn\.shopify\.com|\/cdn\/shop\//i.test(url)) return url;
  return url.replace(/(\.(?:jpe?g|png|webp|gif))(\?|$)/i, `_${width}x$1$2`);
}

// ---- JSON-LD on any site ----

export function jsonLdProducts(html: string, pageUrl: string): ScanProduct[] {
  const out: ScanProduct[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes: unknown[] = [];
    const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { nodes.push(v); for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) if (k in (v as object)) walk((v as Record<string, unknown>)[k]); } };
    walk(data);
    for (const n of nodes) {
      const o = n as Record<string, unknown>;
      const type = Array.isArray(o['@type']) ? (o['@type'] as string[]) : [String(o['@type'] ?? '')];
      if (!type.some((t) => /product/i.test(t))) continue;
      const offers = (Array.isArray(o.offers) ? o.offers[0] : o.offers) as Record<string, unknown> | undefined;
      const images = (Array.isArray(o.image) ? o.image : o.image ? [o.image] : []).map((i) => (typeof i === 'string' ? i : (i as { url?: string })?.url ?? '')).map((i) => abs(i, pageUrl)).filter((x): x is string => Boolean(x));
      const name = typeof o.name === 'string' ? decode(o.name) : null;
      if (!name) continue;
      out.push({ name, url: typeof o.url === 'string' ? abs(o.url, pageUrl) ?? pageUrl : pageUrl, handle: null, price: num(offers?.price ?? offers?.lowPrice), currency: typeof offers?.priceCurrency === 'string' ? offers.priceCurrency : null, images: images.slice(0, 4), rank: null, vendor: typeof o.brand === 'object' && o.brand ? String((o.brand as { name?: unknown }).name ?? '') || null : typeof o.brand === 'string' ? o.brand : null, type: typeof o.category === 'string' ? o.category : null, available: typeof offers?.availability === 'string' ? /InStock/i.test(offers.availability) : null, tags: [] });
    }
  }
  return out;
}

/** Links on a page that look like product pages, same origin, deduplicated. */
export function productLinks(html: string, pageUrl: string, limit = 14): string[] {
  const origin = originOf(pageUrl);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#?\s]+)[^"']*["']/gi)) {
    const u = abs(m[1], pageUrl);
    if (!u || !u.startsWith(origin)) continue;
    if (!/\/(products?|produkte?|produits?|prodotti|productos?|shop|item|p)\/[^/]+\/?$/i.test(u)) continue;
    if (/\/(collections?|categor|cart|account|pages?)\//i.test(u)) continue;
    out.add(u.replace(/\/$/, ''));
    if (out.size >= limit) break;
  }
  return [...out];
}

// ---- Colours and logo ----

const hexOf = (s: string): string | null => { const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i); if (!m) return null; const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]; return `#${h.toLowerCase()}`; };

/** Brand-looking colours in CSS text, most used first: no greys, no near-white, no near-black, close shades merged. */
export function brandColours(css: string, limit = 6): string[] {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) { const h = hexOf(`#${m[1]}`); if (h) counts.set(h, (counts.get(h) ?? 0) + 1); }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)) { const h = `#${[m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')}`; counts.set(h, (counts.get(h) ?? 0) + 1); }
  const ranked = [...counts.entries()].map(([hex, n]) => { const lab = rgbToLab(hexToRgb(hex)!); return { hex, n, lab }; })
    .filter((c) => Math.hypot(c.lab[1], c.lab[2]) >= 14 && c.lab[0] > 12 && c.lab[0] < 92)
    .sort((a, b) => b.n - a.n);
  const out: typeof ranked = [];
  for (const c of ranked) { if (out.some((o) => Math.hypot(o.lab[0] - c.lab[0], o.lab[1] - c.lab[1], o.lab[2] - c.lab[2]) < 14)) continue; out.push(c); if (out.length >= limit) break; }
  return out.map((c) => c.hex);
}

export function findLogo(html: string, pageUrl: string): string | null {
  const metaLogo = html.match(/<meta[^>]+property=["']og:logo["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if (metaLogo) return abs(metaLogo, pageUrl);
  const ld = html.match(/"logo"\s*:\s*(?:\{[^}]*"url"\s*:\s*)?"([^"]+\.(?:png|svg|jpe?g|webp)[^"]*)"/i)?.[1];
  if (ld) return abs(ld, pageUrl);
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    if (!/logo/i.test(tag)) continue;
    const src = tag.match(/\s(?:src|data-src)=["']([^"'\s]+)["']/i)?.[1];
    if (src && !/pixel|1x1|payment|badge/i.test(src)) return abs(src.split(',')[0].trim().split(' ')[0], pageUrl);
  }
  const icon = html.match(/<link[^>]+rel=["'](?:apple-touch-icon|icon)["'][^>]*href=["']([^"']+)["']/i)?.[1];
  return icon ? abs(icon, pageUrl) : null;
}

const meta = (html: string, names: string[]): string | null => {
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']+)["']`, 'i')) ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${esc}["']`, 'i'));
    if (m) return decode(m[1]);
  }
  return null;
};

// ---- The scan ----

export async function scanSite(website: string, fetchFn: FetchLike = fetch): Promise<SiteScan> {
  const origin = originOf(website);
  const home = /^https?:/i.test(website) ? website : `https://${website}`;
  const out: SiteScan = { url: home, platform: 'other', title: null, description: null, theme_colour: null, colours: [], logo: null, currency: null, products: [], errors: [] };
  let html = '';
  try { const r = await get(home, fetchFn); if (r.status >= 400) throw new Error(`HTTP ${r.status}`); html = r.text; } catch (err) { out.errors.push(`Site: ${(err as Error).message}`); }
  if (html) {
    out.title = meta(html, ['og:site_name', 'og:title']) ?? (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1] ? decode(html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)![1]) : null);
    out.description = meta(html, ['og:description', 'description']);
    const tc = meta(html, ['theme-color']); out.theme_colour = tc ? hexOf(tc) : null;
    out.logo = findLogo(html, home);
    // Colours: inline styles plus the first three same-origin stylesheets.
    let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n') + '\n' + [...html.matchAll(/style=["']([^"']+)["']/gi)].map((m) => m[1]).join('\n');
    const sheets = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map((m) => abs(m[1], home)).filter((u): u is string => Boolean(u)).slice(0, 3);
    for (const s of sheets) { try { const r = await get(s, fetchFn, 'text/css'); if (r.status === 200) css += '\n' + r.text.slice(0, 400_000); } catch { /* a stylesheet that will not load is not a problem */ } }
    out.colours = brandColours(css);
    if (out.theme_colour && !out.colours.includes(out.theme_colour)) out.colours.unshift(out.theme_colour);
  }
  // Shopify: the storefront JSON.
  const metaJson = (await getJson(`${origin}/meta.json`, fetchFn)) as { currency?: string } | null;
  if (metaJson?.currency) out.currency = metaJson.currency;
  const products = await getJson(`${origin}/products.json?limit=250`, fetchFn);
  const list = shopifyProducts(products, origin, out.currency);
  if (list.length) {
    out.platform = 'shopify';
    const ranked = shopifyProducts(await getJson(`${origin}/collections/all/products.json?limit=250`, fetchFn), origin, out.currency);
    const rank = new Map(ranked.map((p, i) => [p.handle, i + 1]));
    for (const p of list) p.rank = rank.get(p.handle) ?? null;
    out.products = list.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  } else if (html) {
    // Any other site: product pages found from the homepage, read through their JSON-LD.
    const found = jsonLdProducts(html, home);
    const links = productLinks(html, home);
    for (const link of links.slice(0, 10)) {
      try { const r = await get(link, fetchFn); if (r.status === 200) found.push(...jsonLdProducts(r.text, link)); } catch { /* skip the page */ }
    }
    const seen = new Set<string>();
    out.products = found.filter((p) => { const k = p.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).map((p, i) => ({ ...p, rank: i + 1 }));
    if (!out.currency) out.currency = out.products.find((p) => p.currency)?.currency ?? null;
  }
  return out;
}

// ---- Image download ----

const extOf = (url: string, type: string): string => { const m = url.match(/\.(jpe?g|png|webp|gif)(\?|$)/i); if (m) return m[1].toLowerCase().replace('jpeg', 'jpg'); if (/png/i.test(type)) return 'png'; if (/webp/i.test(type)) return 'webp'; if (/gif/i.test(type)) return 'gif'; return 'jpg'; };

/** Download images into a folder (named by the URL's hash, so a re-run reuses them). Returns url → file name for the ones that landed. */
export async function downloadImages(dir: string, urls: string[], opts: { fetchFn?: FetchLike; max?: number; maxBytes?: number } = {}): Promise<Record<string, string>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const out: Record<string, string> = {};
  mkdirSync(dir, { recursive: true });
  const have = new Map(readdirSync(dir).map((f) => [f.replace(/\.[a-z0-9]+$/i, ''), f]));
  for (const url of [...new Set(urls)].slice(0, opts.max ?? 12)) {
    const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
    const existing = have.get(key);
    if (existing) { out[url] = existing; continue; }
    try {
      const res = await fetchFn(shopifyImageAt(url), { headers: { 'User-Agent': UA, Accept: 'image/*' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > (opts.maxBytes ?? 4_000_000)) continue;
      const file = `${key}.${extOf(url, res.headers.get('content-type') ?? '')}`;
      writeFileSync(join(dir, file), buf);
      out[url] = file;
    } catch { /* an image that will not download is left out */ }
  }
  return out;
}

export const fileSize = (path: string): number => (existsSync(path) ? statSync(path).size : 0);
