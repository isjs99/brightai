import type { PlaybookContentVideo, PlaybookProfile, PlaybookVoice } from '../sweep/types.js';
import { postDate } from './content.js';

/**
 * Two Claude passes per shop: the content profile (what the top videos have in common, every claim with its
 * video ids) and the voice (how the shop already writes to creators, from the copy running in Cruva).
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function profilePrompt(input: { shop_name: string; language: string; market: string | null; top: PlaybookContentVideo[]; all: PlaybookContentVideo[]; total: number; window_from: string; window_to: string }): { system: string; user: string } {
  const system = [
    `You study the TikTok Shop affiliate videos that sell for "${input.shop_name}" (market ${input.market ?? 'unknown'}) and write what the best ones have in common, for the account team to brief creators and to put into the creator messages. Think like a senior TikTok Shop content strategist.`,
    'Only say what the videos below show. Every claim carries the video ids it rests on. Never invent a number. Quote hooks and scripts in their original language; the hook group names and the summary are in English.',
    'Answer with one JSON object and nothing else:',
    '{"summary": "<two sentences on what sells for this shop>", "hooks": [{"group": "<problem first | result first | price or deal | unboxing | comparison | warning or myth | routine | other>", "example": "<the hook, verbatim>", "language": "<code>", "video_ids": ["..."]}], "formats": [{"name": "<talking head | voice-over demo | before and after | GRWM | haul | duet or stitch | live clip | text on screen | other>", "video_ids": ["..."]}], "products_carry": [{"product_id": "...", "gmv": <number>, "videos": <count>}], "products_no_gmv": ["<product ids with videos but no sales>"], "creator_shape": {"follower_band": "<small / mid / large or null>", "niches": ["..."], "first_video_share": <0..1 or null>, "video_ids": ["..."]}, "timing": {"best_days": ["Monday", "..."], "best_hours": ["evening", "..."], "video_ids": ["..."]}, "offer": "<the deal or price line the top videos mention, or null>", "example_scripts": [{"handle": "...", "video_id": "...", "lines": "<the first 3 to 5 lines, verbatim>"}], "content_ideas": ["<one line each, in the shop language, for the creator brief: 3 to 5>"], "top_creators": [{"handle": "...", "gmv": <number>, "videos": <count>}]}',
    'hooks: 3 to 6 groups, the strongest first. example_scripts: the best three. products_carry sorted by gmv. Keep every list to what the videos support.',
  ].join('\n');
  const fmt = (v: PlaybookContentVideo) => [
    `- video ${v.video_id} by @${v.handle} · GMV ${Math.round(v.gmv)} · ${v.units} units · ${v.views} views · ${v.gmv_per_view !== null ? `${v.gmv_per_view} per view` : ''} · posted ${postDate(v.post_time) ?? '?'}${v.post_time ? ` (${DAYS[new Date(postDate(v.post_time) ?? '').getUTCDay()] ?? ''})` : ''} · products ${v.products.join(', ') || v.product_id || '?'}${v.rank_eff && v.rank_eff <= 5 ? ' · top by GMV per view' : ''}`,
    v.title ? `  title: ${v.title.slice(0, 160)}` : '',
    v.overview ? `  overview: ${v.overview.slice(0, 260)}` : '',
    v.hooks.length ? `  hooks: ${v.hooks.slice(0, 3).map((h) => `"${h.hook}"${h.score !== null ? ` (${h.score})` : ''}`).join(' | ')}` : '',
    v.transcript ? `  transcript: ${v.transcript.slice(0, 450)}` : '',
  ].filter(Boolean).join('\n');
  const restGmv = input.all.filter((v) => !v.top).reduce((n, v) => n + v.gmv, 0);
  const user = [
    `Window ${input.window_from} to ${input.window_to}: ${input.total} videos in total, ${input.top.length} in the top slice below (${Math.round(input.top.reduce((n, v) => n + v.gmv, 0))} GMV); the ${input.all.length - input.top.length} others read here made ${Math.round(restGmv)} GMV together. Shop language: ${input.language}.`,
    '', 'Top videos:', ...input.top.map(fmt),
    '', 'Products with videos but no sales in the window (ids): ' + ([...new Set(input.all.filter((v) => v.gmv === 0).flatMap((v) => v.products))].slice(0, 20).join(', ') || 'none'),
  ].join('\n');
  return { system, user };
}

const strs = (v: unknown, max = 20): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max) : []);
const ids = (v: unknown, known: Set<string>): string[] => strs(v, 40).filter((x) => known.has(x));

export function parseProfile(raw: string, videos: PlaybookContentVideo[], meta: { window_from: string; window_to: string; total: number; now?: number }): PlaybookProfile {
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('the profile did not come back as JSON');
  const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const known = new Set(videos.map((v) => v.video_id));
  const byId = new Map(videos.map((v) => [v.video_id, v]));
  const top = videos.filter((v) => v.top);
  const gmvOf = (pid: string) => videos.filter((v) => v.products.includes(pid) || v.product_id === pid).reduce((n, v) => n + v.gmv, 0);
  const products = (v: unknown) => (Array.isArray(v) ? v : []).map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : null)).filter((p): p is Record<string, unknown> => Boolean(p && p.product_id)).map((p) => ({ product_id: String(p.product_id), gmv: Math.round(gmvOf(String(p.product_id))), videos: videos.filter((v) => v.products.includes(String(p.product_id)) || v.product_id === String(p.product_id)).length })).filter((p) => p.videos > 0).sort((a, b) => b.gmv - a.gmv).slice(0, 10);
  const creators = new Map<string, { gmv: number; videos: number }>();
  for (const v of top) { const c = creators.get(v.handle) ?? { gmv: 0, videos: 0 }; c.gmv += v.gmv; c.videos += 1; creators.set(v.handle, c); }
  return {
    learned_at: new Date(meta.now ?? Date.now()).toISOString(), window_from: meta.window_from, window_to: meta.window_to, videos: meta.total, top_count: top.length,
    top_gmv: Math.round(top.reduce((n, v) => n + v.gmv, 0)), total_gmv: Math.round(videos.reduce((n, v) => n + v.gmv, 0)),
    summary: String(j.summary ?? '').trim().slice(0, 600),
    hooks: (Array.isArray(j.hooks) ? j.hooks : []).map((h) => h as Record<string, unknown>).filter((h) => h && h.example).map((h) => ({ group: String(h.group ?? 'other').trim().slice(0, 40), example: String(h.example).trim().slice(0, 300), language: typeof h.language === 'string' ? h.language : null, video_ids: ids(h.video_ids, known) })).filter((h) => h.video_ids.length).slice(0, 6),
    formats: (Array.isArray(j.formats) ? j.formats : []).map((f) => f as Record<string, unknown>).filter((f) => f && f.name).map((f) => ({ name: String(f.name).trim().slice(0, 40), video_ids: ids(f.video_ids, known) })).filter((f) => f.video_ids.length).slice(0, 6),
    products_carry: products(j.products_carry),
    products_no_gmv: strs(j.products_no_gmv, 20),
    creator_shape: (() => { const c = (j.creator_shape ?? {}) as Record<string, unknown>; return { follower_band: typeof c.follower_band === 'string' ? c.follower_band : null, niches: strs(c.niches, 8), first_video_share: typeof c.first_video_share === 'number' ? c.first_video_share : null, video_ids: ids(c.video_ids, known) }; })(),
    timing: (() => { const t = (j.timing ?? {}) as Record<string, unknown>; return { best_days: strs(t.best_days, 7), best_hours: strs(t.best_hours, 4), video_ids: ids(t.video_ids, known) }; })(),
    offer: typeof j.offer === 'string' && j.offer.trim() && j.offer.trim().toLowerCase() !== 'null' ? j.offer.trim().slice(0, 200) : null,
    example_scripts: (Array.isArray(j.example_scripts) ? j.example_scripts : []).map((e) => e as Record<string, unknown>).filter((e) => e && e.video_id && known.has(String(e.video_id))).map((e) => ({ handle: String(e.handle ?? byId.get(String(e.video_id))?.handle ?? ''), video_id: String(e.video_id), link: byId.get(String(e.video_id))?.link ?? null, lines: String(e.lines ?? '').trim().slice(0, 700) })).slice(0, 3),
    content_ideas: strs(j.content_ideas, 6),
    top_creators: [...creators.entries()].map(([handle, c]) => ({ handle, gmv: Math.round(c.gmv), videos: c.videos })).sort((a, b) => b.gmv - a.gmv).slice(0, 10),
  };
}

export function voicePrompt(input: { shop_name: string; language: string; samples: { name: string; copy: string; sent: number | null; replies: number | null }[] }): { system: string; user: string } {
  const system = [
    `You describe how the brand "${input.shop_name}" already writes to TikTok Shop creators, from the messages it runs in Cruva, so new messages can be written in the same voice. Be concrete and short; quote the brand's own phrases.`,
    'Answer with one JSON object and nothing else: {"summary": "<three sentences on the voice: tone, structure, what makes it theirs>", "greeting": "<how a message opens, verbatim pattern, or null>", "signoff": "<how it closes, verbatim, or null>", "register": "<du / Sie / tu / vous / informal / formal>", "emoji": "<none | light | heavy, and which ones>", "length": "<short | medium | long, with typical sentence count>", "phrases": ["<5 to 8 phrases the brand uses, verbatim>"], "avoid": ["<things the brand clearly does not do: 2 to 4>"]}',
  ].join('\n');
  const user = input.samples.map((s, i) => `Message ${i + 1}: "${s.name}"${s.sent !== null ? ` · sent ${s.sent}` : ''}${s.replies !== null ? ` · ${s.replies} replies` : ''}\n${s.copy.slice(0, 1800)}`).join('\n\n');
  return { system, user: `Shop language: ${input.language}.\n\n${user}` };
}

export function parseVoice(raw: string, samples: PlaybookVoice['samples'], now = Date.now()): PlaybookVoice {
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('the voice did not come back as JSON');
  const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim().slice(0, 300) : null);
  return { learned_at: new Date(now).toISOString(), samples, summary: String(j.summary ?? '').trim().slice(0, 700), greeting: s(j.greeting), signoff: s(j.signoff), register: s(j.register), emoji: s(j.emoji), length: s(j.length), phrases: strs(j.phrases, 8), avoid: strs(j.avoid, 4) };
}

/** The lines a tailoring prompt gets from the profile and the voice. */
export function profileFacts(p: PlaybookProfile | null): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (p.summary) out.push(`What sells: ${p.summary}`);
  if (p.hooks.length) out.push(`Hooks that work: ${p.hooks.slice(0, 3).map((h) => `${h.group} ("${h.example}")`).join('; ')}`);
  if (p.formats.length) out.push(`Formats: ${p.formats.slice(0, 3).map((f) => f.name).join(', ')}`);
  if (p.products_carry.length) out.push(`Products that carry (ids): ${p.products_carry.slice(0, 4).map((x) => x.product_id).join(', ')}`);
  if (p.timing.best_days.length) out.push(`Best posting time: ${p.timing.best_days.slice(0, 2).join(' and ')}${p.timing.best_hours.length ? `, ${p.timing.best_hours[0]}` : ''}`);
  if (p.offer) out.push(`Offer the top videos mention: ${p.offer}`);
  if (p.top_creators.length) out.push(`Top creator this window: @${p.top_creators[0].handle} (${p.top_creators[0].gmv} GMV)`);
  if (p.content_ideas.length) out.push(`Content ideas for the brief: ${p.content_ideas.slice(0, 4).join(' · ')}`);
  return out;
}

export function voiceFacts(v: PlaybookVoice | null): string[] {
  if (!v) return [];
  const out: string[] = [`Voice: ${v.summary}`];
  if (v.greeting) out.push(`Opens with: ${v.greeting}`);
  if (v.signoff) out.push(`Closes with: ${v.signoff}`);
  if (v.register) out.push(`Register: ${v.register}`);
  if (v.emoji) out.push(`Emoji: ${v.emoji}`);
  if (v.length) out.push(`Length: ${v.length}`);
  if (v.phrases.length) out.push(`Phrases to reuse: ${v.phrases.map((p) => `"${p}"`).join(', ')}`);
  if (v.avoid.length) out.push(`Never: ${v.avoid.join('; ')}`);
  return out;
}

/** Has the profile moved enough to redo the live copy? Top products, hook group or offer changed. */
export function materialChange(prev: PlaybookProfile | null, next: PlaybookProfile): string[] {
  if (!prev) return ['first profile'];
  const reasons: string[] = [];
  const p1 = prev.products_carry.slice(0, 3).map((x) => x.product_id).join(','); const p2 = next.products_carry.slice(0, 3).map((x) => x.product_id).join(',');
  if (p1 !== p2) reasons.push('the products that carry changed');
  if ((prev.hooks[0]?.group ?? '') !== (next.hooks[0]?.group ?? '')) reasons.push(`the leading hook moved from ${prev.hooks[0]?.group ?? 'none'} to ${next.hooks[0]?.group ?? 'none'}`);
  if ((prev.offer ?? '') !== (next.offer ?? '')) reasons.push('the offer changed');
  return reasons;
}
