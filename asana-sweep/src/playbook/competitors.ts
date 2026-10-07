import type { McpCaller } from '../cruva/mcp.js';
import { unwrap } from '../cruva/mcp.js';
import type { PlaybookCompetitor, PlaybookMarketCreator, PlaybookMarketProfile, PlaybookMarketVideo, PlaybookProfile } from '../sweep/types.js';
import { topCount } from './content.js';

/**
 * Direct competitors and what works for them. Claude proposes the brands that compete head-on with the
 * shop (from its products and market), each is verified against Cruva's marketplace brand index (so it
 * has a brand id, GMV, creators and videos), the team confirms or removes them, and every week the
 * scan reads each competitor's top videos by GMV and the creators selling for it, pulls the spoken
 * script of the best videos through FastMoss where it is configured, and one Claude pass writes the
 * market read: trends, hooks, formats, winning products and price points, and the creators that sell
 * for competitors but not for us.
 */

const money = (s: string | undefined): number => { const n = Number(String(s ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const int = (s: string | undefined): number => Math.round(money(s));

/** "Kijimea (brand_id: 7496168849371662551) - GMV: $16,931.76 | Creators: 646 | Videos: 319 | Category: Health" */
export function parseBrands(text: string): { brand_id: string; name: string; gmv: number; creators: number; videos: number; category: string | null }[] {
  const out: { brand_id: string; name: string; gmv: number; creators: number; videos: number; category: string | null }[] = [];
  for (const line of unwrap(text).split('\n')) {
    const m = line.match(/^\s*-?\s*(.+?)\s*\(brand_id:\s*(\d+)\)\s*-?\s*(.*)$/);
    if (!m) continue;
    const rest = m[3];
    out.push({ name: m[1].trim(), brand_id: m[2], gmv: money(rest.match(/GMV:\s*([^|]+)/)?.[1]), creators: int(rest.match(/Creators:\s*([^|]+)/)?.[1]), videos: int(rest.match(/Videos:\s*([^|]+)/)?.[1]), category: rest.match(/Category:\s*(.*)$/)?.[1]?.trim() || null });
  }
  return out;
}

/**
 * "- @lissy_gala (video_id: 769…) | GMV: $215.94 | Views: 13,200 | Likes: 71 | Comments: 1 | Posted: 2026-10-03T18:23:22
 *      Product: Kijimea Magen – … (product_id: 1729…)
 *      https://tiktok.com/@lissy_gala/video/769…"
 */
export function parseBrandVideos(text: string, brand: { brand_id: string; name: string }): PlaybookMarketVideo[] {
  const out: PlaybookMarketVideo[] = [];
  let cur: PlaybookMarketVideo | null = null;
  for (const raw of unwrap(text).split('\n')) {
    const line = raw.trim();
    const head = line.match(/^-\s*@?([^\s(]+)\s*\(video_id:\s*(\d+)\)\s*\|?\s*(.*)$/);
    if (head) {
      const rest = head[3];
      cur = { video_id: head[2], brand_id: brand.brand_id, brand_name: brand.name, handle: head[1], gmv: money(rest.match(/GMV:\s*([^|]+)/)?.[1]), views: int(rest.match(/Views:\s*([^|]+)/)?.[1]), likes: int(rest.match(/Likes:\s*([^|]+)/)?.[1]), comments: int(rest.match(/Comments:\s*([^|]+)/)?.[1]), posted: rest.match(/Posted:\s*(\S+)/)?.[1]?.slice(0, 10) ?? null, product: null, product_id: null, link: null, overview: null, hook: null, script: null, top: false };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const prod = line.match(/^Product:\s*(.+?)(?:\s*\(product_id:\s*(\d+)\))?$/);
    if (prod) { cur.product = prod[1].trim().slice(0, 200); cur.product_id = prod[2] ?? null; continue; }
    if (/^https?:\/\//.test(line)) { cur.link = line; continue; }
    const ai = line.match(/^(?:AI|Overview|AI overview):\s*(.+)$/i);
    if (ai) { cur.overview = ai[1].trim().slice(0, 300); continue; }
    const hook = line.match(/^(?:Top hook|Hook):\s*(.+)$/i);
    if (hook) { cur.hook = hook[1].trim().slice(0, 300); continue; }
  }
  return out;
}

/** "Videos for brand 8001 (sorted by gmv desc) — 344 total:" → 344; null when the heading has no total. */
export function parseVideoTotal(text: string): number | null { const m = unwrap(text).match(/[—-]\s*([\d,]+)\s*total/); return m ? Number(m[1].replace(/,/g, '')) : null; }

/** The same top-slice rule as the shop's own videos: top pct of the window's videos by GMV (never under 5, never over 40), plus the best by GMV per view over 2,000 views. */
export function rankMarket(videos: PlaybookMarketVideo[], pct: number, total: number): PlaybookMarketVideo[] {
  const byGmv = [...videos].sort((a, b) => b.gmv - a.gmv || b.views - a.views);
  const n = topCount(Math.max(total, byGmv.length), pct);
  const out = byGmv.map((v, i) => ({ ...v, top: i < n && v.gmv > 0 }));
  const eff = out.filter((v) => v.views >= 2000 && v.gmv > 0).sort((a, b) => b.gmv / b.views - a.gmv / a.views);
  eff.slice(0, Math.min(eff.length, Math.max(3, Math.ceil(n / 2)))).forEach((v) => { v.top = true; });
  return out;
}

/** "- @nebras.akeel8 (id: 7495439929099324058) | Brand GMV: $32,317.92 | Platform GMV (30d): $7,240.00 | Followers: 32,625" */
export function parseBrandCreators(text: string, brand: { brand_id: string; name: string }): PlaybookMarketCreator[] {
  const out: PlaybookMarketCreator[] = [];
  for (const raw of unwrap(text).split('\n')) {
    const m = raw.trim().match(/^-\s*@?([^\s(]+)\s*\(id:\s*(\d+)\)\s*\|?\s*(.*)$/);
    if (!m) continue;
    const rest = m[3];
    out.push({ handle: m[1], creator_id: m[2], brand_id: brand.brand_id, brand_name: brand.name, brand_gmv: money(rest.match(/Brand GMV:\s*([^|]+)/)?.[1]), platform_gmv_30d: money(rest.match(/Platform GMV[^:]*:\s*([^|]+)/)?.[1]), followers: int(rest.match(/Followers:\s*([^|]+)/)?.[1]), ours: false });
  }
  return out;
}

/** FastMoss video_script_info: [{start_time, end_time, text}] → the spoken lines. */
export function scriptFromSubtitles(payload: unknown): string | null {
  const arr = Array.isArray(payload) ? payload : payload && typeof payload === 'object' ? ((payload as Record<string, unknown>).data ?? (payload as Record<string, unknown>).list ?? (payload as Record<string, unknown>).subtitles) : null;
  if (!Array.isArray(arr)) return null;
  const lines = (arr as Record<string, unknown>[]).map((r) => (r && typeof r.text === 'string' ? r.text.trim() : '')).filter(Boolean);
  return lines.length ? lines.join('\n').slice(0, 1500) : null;
}

/** Cruva's marketplace region code for a market. */
export const marketRegion = (market: string | null): string => { const m = (market ?? '').toUpperCase(); return ({ UK: 'uk', GB: 'uk', DE: 'de', AT: 'at', FR: 'fr', IT: 'it', ES: 'es', IE: 'ie', NL: 'nl', BE: 'be', PL: 'pl', PT: 'pt', MX: 'mx', US: 'us', BR: 'br', JP: 'jp' } as Record<string, string>)[m] ?? 'us'; };

/** Lowercase letters and digits only, for comparing brand names. */
const key = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The marketplace brand that is the name we looked for: exact first, then the one that starts with or contains it, by GMV. */
export function pickBrand(name: string, rows: ReturnType<typeof parseBrands>): ReturnType<typeof parseBrands>[number] | null {
  const k = key(name);
  if (!k) return null;
  const exact = rows.filter((r) => key(r.name) === k).sort((a, b) => b.gmv - a.gmv);
  if (exact.length) return exact[0];
  const near = rows.filter((r) => key(r.name).startsWith(k) || k.startsWith(key(r.name)) || key(r.name).includes(k)).sort((a, b) => b.gmv - a.gmv);
  return near[0] ?? null;
}

/** Cruva's intelligence endpoints allow two requests a second: every call waits its turn. */
export function makeThrottle(minGapMs = 600, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): <T>(fn: () => Promise<T>) => Promise<T> {
  let last = 0; let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const next = chain.then(async () => { const wait = last + minGapMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); try { return await fn(); } finally { last = Date.now(); } });
    chain = next.catch(() => undefined);
    return next;
  };
}

/** Claude proposes the brands that compete head-on with the shop. */
export function suggestPrompt(input: { shop_name: string; brand: string; market: string | null; products: string[]; categories: string[]; profile_summary: string | null; known: string[] }): { system: string; user: string } {
  const system = [
    'You know the TikTok Shop market in Europe and the UK. Name the brands that compete directly with the shop below on TikTok Shop in its market: the same product type sold to the same buyer at a similar price, or a very similar brand in the same niche. A brand that only shares the category (any supplement, any skincare) is not a competitor; a store that sells everything is not a competitor.',
    'Use the brand names as they appear on TikTok Shop in that market (local brand names where they differ). 5 to 8 brands, the most direct first.',
    'Answer with one JSON object and nothing else: {"competitors": [{"name": "<brand name as on TikTok Shop>", "why": "<one line: what they sell that overlaps, and the price point if known>", "direct": <true when a buyer would choose between them and this shop, false when similar but not head-on>}]}',
  ].join('\n');
  const user = [
    `Shop: ${input.shop_name} (brand "${input.brand}"), market ${input.market ?? 'unknown'}.`,
    input.products.length ? `Products it sells: ${input.products.slice(0, 12).join('; ')}` : '',
    input.categories.length ? `Categories: ${input.categories.slice(0, 5).join(', ')}` : '',
    input.profile_summary ? `What sells for it: ${input.profile_summary}` : '',
    input.known.length ? `Already listed (do not repeat): ${input.known.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return { system, user };
}

export function parseSuggestions(raw: string): { name: string; why: string; direct: boolean }[] {
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('the competitor list did not come back as JSON');
  const j = JSON.parse(raw.slice(start, end + 1)) as { competitors?: unknown };
  return (Array.isArray(j.competitors) ? j.competitors : []).map((c) => c as Record<string, unknown>).filter((c) => c && typeof c.name === 'string' && c.name.trim()).map((c) => ({ name: String(c.name).trim().slice(0, 80), why: String(c.why ?? '').trim().slice(0, 200), direct: c.direct !== false })).slice(0, 10);
}

/** One Claude pass over the competitors' top videos and creators: the market read. */
export function marketPrompt(input: { shop_name: string; brand: string; market: string | null; language: string; competitors: PlaybookCompetitor[]; videos: PlaybookMarketVideo[]; creators: PlaybookMarketCreator[]; ours: PlaybookProfile | null; window_from: string; window_to: string; videos_total?: number }): { system: string; user: string } {
  const system = [
    `You study what sells for the direct competitors of "${input.shop_name}" (brand ${input.brand}, market ${input.market ?? 'unknown'}) on TikTok Shop, so the account team can brief creators, update the creator messages and approach the right creators. Think like a senior TikTok Shop content strategist.`,
    'Only say what the videos and creators below show. Every claim carries the video ids it rests on. Never invent a number. Quote hooks and script lines in their original language; names of trends, formats and the summary in English. Where the shop\'s own profile is given, say what the competitors do that the shop does not.',
    'Answer with one JSON object and nothing else:',
    '{"summary": "<two or three sentences: what is selling for the competitors right now and what it means for this shop>", "trends": [{"name": "<the trend in a few words>", "detail": "<one line: what it looks like in the videos>", "brands": ["<brand names>"], "video_ids": ["..."]}], "hooks": [{"group": "<problem first | result first | price or deal | unboxing | comparison | warning or myth | routine | other>", "example": "<the hook or opening line, verbatim>", "brand": "<brand name>", "video_ids": ["..."]}], "formats": [{"name": "<talking head | voice-over demo | before and after | GRWM | haul | duet or stitch | live clip | text on screen | other>", "video_ids": ["..."]}], "products": [{"name": "<product as named>", "brand": "<brand>", "gmv": <number from the videos>, "angle": "<what the videos say about it, one line>", "video_ids": ["..."]}], "gaps": ["<one line each: what competitors do that this shop does not, 2 to 5>"], "ideas": ["<one line each, in the shop language, for the creator brief: 3 to 5>"], "creators_to_approach": [{"handle": "...", "brand": "<the competitor they sell for>", "why": "<one line>"}]}',
    'trends: 3 to 6, the strongest first. hooks: 3 to 6. creators_to_approach: up to 10 creators that sell for competitors and do not sell for this shop (marked "not ours" below), the biggest first.',
  ].join('\n');
  const top = input.videos.some((v) => v.top) ? input.videos.filter((v) => v.top) : input.videos;
  const vids = [...top].sort((a, b) => b.gmv - a.gmv).slice(0, 40).map((v) => [
    `- video ${v.video_id} · ${v.brand_name} · @${v.handle} · GMV ${Math.round(v.gmv)} · ${v.views} views · ${v.likes} likes · posted ${v.posted ?? '?'}${v.product ? ` · product: ${v.product.slice(0, 120)}` : ''}`,
    v.overview ? `  overview: ${v.overview}` : '', v.hook ? `  hook: "${v.hook}"` : '', v.script ? `  script: ${v.script.replace(/\n/g, ' / ').slice(0, 600)}` : '',
  ].filter(Boolean).join('\n'));
  const creators = [...input.creators].sort((a, b) => b.brand_gmv - a.brand_gmv).slice(0, 40).map((c) => `- @${c.handle} · sells for ${c.brand_name} · ${Math.round(c.brand_gmv)} GMV with them · ${Math.round(c.platform_gmv_30d)} platform GMV 30d · ${c.followers} followers · ${c.ours ? 'ours too' : 'not ours'}`);
  const user = [
    `Window ${input.window_from} to ${input.window_to}. Shop language: ${input.language}.`,
    `Competitors: ${input.competitors.map((c) => `${c.name}${c.gmv ? ` (${Math.round(c.gmv)} GMV, ${c.creators ?? '?'} creators, ${c.videos ?? '?'} videos in the window)` : ''}`).join('; ')}`,
    input.ours ? `\nThis shop's own profile: ${input.ours.summary}${input.ours.hooks.length ? ` Its hooks: ${input.ours.hooks.slice(0, 3).map((h) => `${h.group} ("${h.example.slice(0, 80)}")`).join('; ')}.` : ''}${input.ours.offer ? ` Its offer: ${input.ours.offer}.` : ''}` : '',
    '', `Competitor videos: the top ${vids.length} of ${input.videos_total ?? input.videos.length} in the window by GMV and GMV per view${input.videos.length > vids.length ? ` (the ${input.videos.length - vids.length} others read made ${Math.round(input.videos.filter((v) => !v.top).reduce((n, v) => n + v.gmv, 0))} GMV together)` : ''}:`, ...vids,
    '', 'Creators selling for competitors:', ...creators,
  ].filter((l) => l !== null).join('\n');
  return { system, user };
}

const strs = (v: unknown, max = 20): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max) : []);

export function parseMarket(raw: string, input: { competitors: PlaybookCompetitor[]; videos: PlaybookMarketVideo[]; creators: PlaybookMarketCreator[]; window_from: string; window_to: string; now?: number; videos_total?: number; top_pct?: number }): PlaybookMarketProfile {
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('the market read did not come back as JSON');
  const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const known = new Set(input.videos.map((v) => v.video_id));
  const ids = (v: unknown) => strs(v, 40).filter((x) => known.has(x));
  const byHandle = new Map(input.creators.map((c) => [c.handle.toLowerCase(), c]));
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => x as Record<string, unknown>).filter((x) => x && typeof x === 'object');
  const byVideos = (a: { video_ids: string[] }, b: { video_ids: string[] }) => b.video_ids.length - a.video_ids.length;
  const gmvOf = (vids: string[]) => Math.round(input.videos.filter((v) => vids.includes(v.video_id)).reduce((n, v) => n + v.gmv, 0));
  return {
    learned_at: new Date(input.now ?? Date.now()).toISOString(), window_from: input.window_from, window_to: input.window_to,
    competitors: input.competitors.map((c) => ({ brand_id: c.brand_id, name: c.name, gmv: c.gmv, videos_read: input.videos.filter((v) => v.brand_id === c.brand_id).length, creators_read: input.creators.filter((v) => v.brand_id === c.brand_id).length })),
    videos_total: input.videos_total ?? input.videos.length, top_count: input.videos.filter((v) => v.top).length, top_pct: input.top_pct ?? 10,
    summary: String(j.summary ?? '').trim().slice(0, 800),
    trends: list(j.trends).filter((t) => t.name).map((t) => ({ name: String(t.name).trim().slice(0, 80), detail: String(t.detail ?? '').trim().slice(0, 300), brands: strs(t.brands, 6), video_ids: ids(t.video_ids) })).filter((t) => t.video_ids.length).slice(0, 6),
    hooks: list(j.hooks).filter((h) => h.example).map((h) => ({ group: String(h.group ?? 'other').trim().slice(0, 40), example: String(h.example).trim().slice(0, 300), brand: String(h.brand ?? '').trim().slice(0, 80) || null, video_ids: ids(h.video_ids) })).filter((h) => h.video_ids.length).slice(0, 6),
    formats: list(j.formats).filter((f) => f.name).map((f) => ({ name: String(f.name).trim().slice(0, 40), video_ids: ids(f.video_ids) })).filter((f) => f.video_ids.length).sort(byVideos).slice(0, 6),
    products: list(j.products).filter((p) => p.name).map((p) => { const vids = ids(p.video_ids); return { name: String(p.name).trim().slice(0, 160), brand: String(p.brand ?? '').trim().slice(0, 80) || null, gmv: gmvOf(vids), angle: String(p.angle ?? '').trim().slice(0, 300), video_ids: vids }; }).filter((p) => p.video_ids.length).sort((a, b) => b.gmv - a.gmv).slice(0, 8),
    gaps: strs(j.gaps, 5),
    ideas: strs(j.ideas, 6),
    creators_to_approach: list(j.creators_to_approach).map((c) => { const h = String(c.handle ?? '').replace(/^@/, '').trim(); const k = byHandle.get(h.toLowerCase()); return k && !k.ours ? { handle: k.handle, creator_id: k.creator_id, brand: k.brand_name, brand_gmv: Math.round(k.brand_gmv), platform_gmv_30d: Math.round(k.platform_gmv_30d), followers: k.followers, why: String(c.why ?? '').trim().slice(0, 200) } : null; }).filter((c): c is NonNullable<typeof c> => c !== null).slice(0, 10),
    videos: [...input.videos].sort((a, b) => Number(b.top) - Number(a.top) || b.gmv - a.gmv).slice(0, 30),
  };
}

/** The lines a tailoring prompt gets from the market read. */
export function marketFacts(m: PlaybookMarketProfile | null): string[] {
  if (!m) return [];
  const out: string[] = [];
  if (m.summary) out.push(`The market right now: ${m.summary}`);
  if (m.trends.length) out.push(`Trends in competitor videos: ${m.trends.slice(0, 3).map((t) => `${t.name} (${t.detail.slice(0, 100)})`).join('; ')}`);
  if (m.hooks.length) out.push(`Hooks that work for competitors: ${m.hooks.slice(0, 3).map((h) => `${h.group} ("${h.example.slice(0, 100)}"${h.brand ? `, ${h.brand}` : ''})`).join('; ')}`);
  if (m.products.length) out.push(`Competitor products that carry: ${m.products.slice(0, 3).map((p) => `${p.name.slice(0, 60)}${p.brand ? ` (${p.brand})` : ''}: ${p.angle.slice(0, 80)}`).join('; ')}`);
  if (m.gaps.length) out.push(`What competitors do that this shop does not: ${m.gaps.slice(0, 3).join(' · ')}`);
  return out;
}

export interface MarketPullOpts { from: string; to: string; region: string; /** The top slice, as a share of the competitors' videos in the window (the shop's own setting). */ pct?: number; videosPerBrand?: number; creatorsPerBrand?: number; scripts?: ((videoId: string) => Promise<string | null>) | null; scriptCount?: number; throttle?: <T>(fn: () => Promise<T>) => Promise<T>; ourHandles?: Set<string> }

/** Each competitor's top videos by GMV and the creators selling for it, two requests a second, the best videos' scripts where FastMoss answers. */
export async function pullMarket(mcp: McpCaller, competitors: PlaybookCompetitor[], opts: MarketPullOpts): Promise<{ videos: PlaybookMarketVideo[]; creators: PlaybookMarketCreator[]; total: number; errors: string[] }> {
  const throttle = opts.throttle ?? makeThrottle();
  let videos: PlaybookMarketVideo[] = []; const creators: PlaybookMarketCreator[] = []; const errors: string[] = []; let total = 0;
  for (const c of competitors) {
    try {
      const t = await throttle(() => mcp.call('list_marketplace_brand_videos', { brand_id: c.brand_id, region: opts.region, sort: 'gmv', sort_direction: 'desc', ts_start: opts.from, ts_end: opts.to, page_size: opts.videosPerBrand ?? 15 }));
      const rows = parseBrandVideos(t, c); videos.push(...rows); total += parseVideoTotal(t) ?? rows.length;
    } catch (err) { errors.push(`${c.name} videos: ${(err as Error).message}`); }
    try {
      const t = await throttle(() => mcp.call('list_brand_creators', { brand_id: c.brand_id, region: opts.region, sort: 'shop_gmv', ts_start: opts.from, ts_end: opts.to, page_size: opts.creatorsPerBrand ?? 20 }));
      creators.push(...parseBrandCreators(t, c));
    } catch (err) { errors.push(`${c.name} creators: ${(err as Error).message}`); }
  }
  const ours = new Set([...(opts.ourHandles ?? [])].map((h) => h.toLowerCase()));
  for (const cr of creators) cr.ours = ours.has(cr.handle.toLowerCase());
  videos = rankMarket(videos, opts.pct ?? 10, total);
  if (opts.scripts) {
    const top = videos.filter((v) => v.top).sort((a, b) => b.gmv - a.gmv).slice(0, opts.scriptCount ?? 6);
    for (const v of top) { try { v.script = await opts.scripts(v.video_id); } catch (err) { errors.push(`script ${v.video_id}: ${(err as Error).message}`); if (/quota|credit|402|balance/i.test((err as Error).message)) break; } }
  }
  return { videos, creators, total, errors };
}

/** Has the market moved enough to redo the outreach copy? The leading trend, the leading hook group or the top competitor product changed. */
export function marketChange(prev: PlaybookMarketProfile | null, next: PlaybookMarketProfile): string[] {
  if (!prev) return ['first market read'];
  const reasons: string[] = [];
  if ((prev.trends[0]?.name ?? '') !== (next.trends[0]?.name ?? '')) reasons.push(`the competitors' leading trend moved from ${prev.trends[0]?.name ?? 'none'} to ${next.trends[0]?.name ?? 'none'}`);
  if ((prev.hooks[0]?.group ?? '') !== (next.hooks[0]?.group ?? '')) reasons.push(`the competitors' leading hook moved from ${prev.hooks[0]?.group ?? 'none'} to ${next.hooks[0]?.group ?? 'none'}`);
  if ((prev.products[0]?.name ?? '') !== (next.products[0]?.name ?? '')) reasons.push('the competitor product that carries changed');
  return reasons;
}
