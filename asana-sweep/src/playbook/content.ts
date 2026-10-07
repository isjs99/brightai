import type { McpCaller } from '../cruva/mcp.js';
import { unwrap } from '../cruva/mcp.js';
import type { PlaybookContentVideo } from '../sweep/types.js';

/**
 * The shop's affiliate videos from Cruva's search_videos (timeseries mode over a window), ranked, and the
 * top slice marked. Cruva already carries each video's transcript, scored hooks, GMV per view and products,
 * so nothing is downloaded or transcribed here.
 */

const num = (v: unknown): number => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The JSON array inside the tool's text (after the "Video performance (...)" heading). */
export function parseVideos(text: string): PlaybookContentVideo[] {
  const t = unwrap(text);
  const start = t.indexOf('['); const end = t.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(t.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return (arr as Record<string, unknown>[]).filter((r) => r && typeof r === 'object' && r.video_id).map((r) => ({
    video_id: String(r.video_id), handle: String(r.handle ?? ''), product_id: str(r.product_id), products: Array.isArray(r.products) ? (r.products as unknown[]).map(String) : [],
    gmv: num(r.gmv), units: num(r.units_sold), views: num(r.views), likes: num(r.likes), gmv_per_view: r.avg_gmv_per_view === null || r.avg_gmv_per_view === undefined ? null : num(r.avg_gmv_per_view), conversion: r.conversion_rate === null || r.conversion_rate === undefined ? null : num(r.conversion_rate),
    post_time: str(r.post_time), link: str(r.video_link), title: str(r.title), overview: str(r.content_overview), transcript: str(r.transcript)?.slice(0, 2000) ?? null,
    hooks: Array.isArray(r.hooks) ? (r.hooks as Record<string, unknown>[]).filter((h) => h && typeof h.hook === 'string').map((h) => ({ hook: String(h.hook).slice(0, 300), score: h.score === null || h.score === undefined ? null : num(h.score), explanation: str(h.explanation) })) : [],
    rank_gmv: 0, rank_eff: null, top: false,
  }));
}

/** "MM/DD/YYYY" (Cruva) or ISO → ISO date, else null. */
export const postDate = (s: string | null): string | null => { if (!s) return null; const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[1]}-${m[2]}`; const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };

/** How many videos the top slice holds: pct of the count, never under 5, never over 40, never more than there are. */
export const topCount = (total: number, pct: number): number => Math.min(total, Math.max(Math.min(5, total), Math.min(40, Math.ceil(total * (Math.max(1, Math.min(20, pct)) / 100)))));

/** Rank by GMV and by GMV per view (over 2,000 views), mark the top slice of both. */
export function rankContent(videos: PlaybookContentVideo[], pct: number): PlaybookContentVideo[] {
  const byGmv = [...videos].sort((a, b) => b.gmv - a.gmv || b.views - a.views);
  const n = topCount(byGmv.length, pct);
  const out = byGmv.map((v, i) => ({ ...v, rank_gmv: i + 1, rank_eff: null as number | null, top: i < n && v.gmv > 0 }));
  const eff = out.filter((v) => v.views >= 2000 && v.gmv > 0).sort((a, b) => (b.gmv_per_view ?? b.gmv / b.views) - (a.gmv_per_view ?? a.gmv / a.views));
  const m = Math.min(eff.length, Math.max(3, Math.ceil(n / 2)));
  eff.forEach((v, i) => { v.rank_eff = i + 1; if (i < m) v.top = true; });
  return out;
}

/** Pages through search_videos for the window, newest GMV first, until the top slice is covered or the pages run out. */
export async function pullContent(mcp: McpCaller, shopId: string, opts: { from: string; to: string; pct: number; maxPages?: number }): Promise<{ videos: PlaybookContentVideo[]; total: number }> {
  let total = 0;
  try { total = Number(unwrap(await mcp.call('search_videos', { shop_id: shopId, timeseries: true, date_from: opts.from, date_to: opts.to, just_count: true })).match(/(\d[\d,]*)/)?.[1]?.replace(/,/g, '') ?? 0); } catch { total = 0; }
  const want = Math.max(topCount(total || 200, opts.pct) * 3, 60);
  const videos: PlaybookContentVideo[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= (opts.maxPages ?? 6); page += 1) {
    const text = await mcp.call('search_videos', { shop_id: shopId, timeseries: true, date_from: opts.from, date_to: opts.to, page_number: page, page_size: 50, sort_by: 'gmv', sort_direction: 'desc' });
    const rows = parseVideos(text);
    for (const v of rows) if (!seen.has(v.video_id)) { seen.add(v.video_id); videos.push(v); }
    if (rows.length < 50 || videos.length >= want) break;
  }
  // A second cut by GMV per view so a small creator with a brilliant hook is not drowned out by a big one.
  try {
    const text = await mcp.call('search_videos', { shop_id: shopId, timeseries: true, date_from: opts.from, date_to: opts.to, page_number: 1, page_size: 30, sort_by: 'avg_gmv_per_view', sort_direction: 'desc', min_view_count: 2000 });
    for (const v of parseVideos(text)) if (!seen.has(v.video_id)) { seen.add(v.video_id); videos.push(v); }
  } catch { /* the GMV cut is enough */ }
  return { videos: rankContent(videos, opts.pct), total: Math.max(total, videos.length) };
}
