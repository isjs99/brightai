import type { Queries } from '../db/queries.js';
import type { Account, AccountTarget, PlaybookShop, SampleAccount, SampleRequest, SampleResearch, SampleRules, SampleShop, SamplesData } from '../sweep/types.js';
import type { McpCaller } from '../cruva/mcp.js';
import { cruvaMcp, unwrap } from '../cruva/mcp.js';
import type { PlaybookEngine } from '../playbook/index.js';
import { makeThrottle, marketRegion } from '../playbook/competitors.js';
import { startOfWeek, targetValue } from '../health/tts-rules.js';
import { draftWithClaude } from '../inbox/llm.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { liveEvents } from '../live/events.js';
import { slackBot } from '../notify/slackbot.js';

/**
 * Samples: a traffic light per account over its pending sample requests in Cruva. The rules (30-day GMV,
 * engagement, post rate, followers, relevance) are set per account; the weekly cap is the account's
 * "samples a week" target (the source of truth in Account monitor) unless overridden here. Every scan
 * reads the To Review queue, researches the creators that clear the numbers (categories, the brands they
 * sold for, whether one is a direct competitor, brand risk), scores them and shortlists the ones to
 * accept in bulk; with auto-accept on, the scan approves the top of the shortlist itself, up to the
 * number set, never past the weekly cap. Approving ships product, so nothing is approved twice and every
 * decision is kept.
 */

export const DEFAULT_RULES: SampleRules = { min_gmv: 300, min_engagement: 2, min_post_rate: 60, min_followers: 1000, relevance: 'prefer', cap_override: null, auto_accept: false, auto_per_week: 10 };

const num = (s: string | undefined | null): number => { const n = Number(String(s ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const pct = (s: string | undefined | null): number | null => (s === undefined || s === null ? null : num(s));

export type PendingRow = Omit<SampleRequest, 'shop_id' | 'research' | 'verdict' | 'score' | 'reasons' | 'seen_at' | 'status' | 'decided_at' | 'decided_by'>;

/**
 * ai_search_sample_requests (filters only):
 * "- @lunaita._ (Jumashop) | 5,063 followers | 30d GMV $1236.0 | engagement 0.6% | post rate 100.0%
 *      request: apply_id 807… | Kijimea K53 … (ID: 172…) | Variant: 14 Kapseln | Submitted: 2026-10-04 | Commission: 15%
 *      video: https://www.tiktok.com/@…/video/… | 142 views"
 */
export function parsePending(text: string): { rows: PendingRow[]; total: number | null; more: boolean } {
  const t = unwrap(text);
  const total = t.match(/pending requests on the shop:\s*([\d,]+)/)?.[1];
  const rows: PendingRow[] = [];
  let creator: { handle: string; name: string | null; followers: number; gmv_30d: number; engagement: number | null; post_rate: number | null; videos: { url: string; views: number }[] } | null = null;
  let last: PendingRow | null = null;
  for (const raw of t.split('\n')) {
    const line = raw.trim();
    const head = line.match(/^-\s*@([^\s(]+)\s*(?:\(([^)]*)\))?\s*\|?\s*(.*)$/);
    if (head) {
      const rest = head[3];
      creator = { handle: head[1], name: head[2] && head[2] !== 'N/A' ? head[2].trim() : null, followers: num(rest.match(/([\d,]+)\s*followers/)?.[1]), gmv_30d: num(rest.match(/30d GMV\s*\$?([\d,.]+)/)?.[1]), engagement: pct(rest.match(/engagement\s*([\d.]+)%/)?.[1]), post_rate: pct(rest.match(/post rate\s*([\d.]+)%/)?.[1]), videos: [] };
      last = null;
      continue;
    }
    if (!creator) continue;
    const req = line.match(/^request:\s*apply_id\s*(\d+)\s*\|\s*(.*)$/);
    if (req) {
      const rest = req[2];
      const prod = rest.match(/^(.*?)\s*\(ID:\s*(\d+)\)/);
      last = { apply_id: req[1], handle: creator.handle, name: creator.name, followers: creator.followers, gmv_30d: creator.gmv_30d, engagement: creator.engagement, post_rate: creator.post_rate, product: prod ? prod[1].trim().slice(0, 200) : rest.split('|')[0].trim().slice(0, 200) || null, product_id: prod?.[2] ?? null, variant: rest.match(/Variant:\s*([^|]+)/)?.[1]?.trim() ?? null, submitted: rest.match(/Submitted:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null, commission: pct(rest.match(/Commission:\s*([\d.]+)%/)?.[1]), videos: creator.videos };
      rows.push(last);
      continue;
    }
    const vid = line.match(/^video:\s*(https?:\/\/\S+)\s*\|\s*([\d,]+)\s*views/);
    if (vid) { creator.videos.push({ url: vid[1], views: num(vid[2]) }); continue; }
  }
  return { rows, total: total ? num(total) : null, more: /More results available/i.test(t) };
}

/** get_affiliate_data: "Affiliate data for @x (de):\n{ ...json... }" */
export function parseAffiliate(text: string): Record<string, unknown> | null {
  const t = unwrap(text); const start = t.indexOf('{'); const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const j = JSON.parse(t.slice(start, end + 1)); return j && typeof j === 'object' ? (j as Record<string, unknown>) : null; } catch { return null; }
}

/** list_creator_brands: "- ORNARTO (id: 864…) | GMV: $2,668.85 | Views: 282,391 | Videos: 3" */
export function parseCreatorBrands(text: string): { name: string; id: string; gmv: number; videos: number }[] {
  const out: { name: string; id: string; gmv: number; videos: number }[] = [];
  for (const raw of unwrap(text).split('\n')) {
    const m = raw.trim().match(/^-\s*(.+?)\s*\(id:\s*(\d+)\)\s*\|?\s*(.*)$/);
    if (m) out.push({ name: m[1].trim(), id: m[2], gmv: num(m[3].match(/GMV:\s*([^|]+)/)?.[1]), videos: Math.round(num(m[3].match(/Videos:\s*([^|]+)/)?.[1])) });
  }
  return out;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9äöüß]+/i).filter((w) => w.length > 3);

/** Which of the shop's categories or product words a creator's categories share, if any. */
export function categoryMatch(creatorCategories: string[], shop: { categories: string[]; products: string[] }): string | null {
  const ours = new Set([...shop.categories.flatMap(words), ...shop.products.flatMap(words)]);
  const generic = new Set(['supplies', 'products', 'other', 'more', 'with', 'from', 'care']);
  for (const c of creatorCategories) { const hit = words(c).find((w) => ours.has(w) && !generic.has(w)); if (hit) return c; }
  return null;
}

/** The numbers, then the research, into a verdict and a score. */
export function judge(row: PendingRow, research: SampleResearch | null, rules: SampleRules): { verdict: SampleRequest['verdict']; score: number; reasons: string[] } {
  const reasons: string[] = []; let review = false;
  if (row.gmv_30d < rules.min_gmv) reasons.push(`30d GMV ${Math.round(row.gmv_30d)} under ${rules.min_gmv}`);
  if (row.followers < rules.min_followers) reasons.push(`${row.followers.toLocaleString()} followers under ${rules.min_followers.toLocaleString()}`);
  if (rules.min_engagement > 0) { if (row.engagement === null) { review = true; reasons.push('no engagement data'); } else if (row.engagement < rules.min_engagement) reasons.push(`engagement ${row.engagement}% under ${rules.min_engagement}%`); }
  if (rules.min_post_rate > 0) { if (row.post_rate === null) { review = true; reasons.push('no post rate yet'); } else if (row.post_rate < rules.min_post_rate) reasons.push(`post rate ${row.post_rate}% under ${rules.min_post_rate}%`); }
  const hardFails = reasons.filter((r) => !/^no /.test(r)).length;
  let score = Math.min(100, row.gmv_30d / 200) + Math.min(30, (row.post_rate ?? 0) * 0.3) + Math.min(30, (row.engagement ?? 0) * 3) + Math.min(10, Math.log10(Math.max(1, row.followers)) * 2);
  if (research) {
    score += research.relevant * 15 + (research.competitor ? 10 : 0) + (research.category_match ? 5 : 0);
    if (research.competitor) reasons.push(`sold for ${research.competitor}`);
    if (research.category_match) reasons.push(`sells ${research.category_match}`);
    if (research.risk === 'high') return { verdict: 'skip', score, reasons: [`brand risk: ${research.note ?? 'flagged'}`, ...reasons] };
    if (research.risk === 'some') { review = true; reasons.push(`check: ${research.note ?? 'possible brand risk'}`); }
    if (rules.relevance === 'require' && research.relevant === 0) { review = true; reasons.push('not clearly relevant to the brand'); }
    if (research.note && research.risk === 'none' && research.relevant > 0) reasons.push(research.note);
  } else if (rules.relevance === 'require' && !hardFails) { review = true; reasons.push('not researched yet'); }
  if (hardFails) return { verdict: 'skip', score, reasons };
  return { verdict: review ? 'review' : 'accept', score: Math.round(score * 10) / 10, reasons };
}

/** One Claude pass over the researched creators: relevant to the brand, and any brand risk. */
export function relevancePrompt(input: { brand: string; market: string | null; products: string[]; categories: string[]; competitors: string[]; creators: { handle: string; bio: string | null; categories: string[]; brands: string[]; followers: number; language: string | null }[] }): { system: string; user: string } {
  const system = [
    `You vet TikTok Shop creators who asked ${input.brand} (market ${input.market ?? 'unknown'}) for a free product sample. For each creator say how relevant they are to the brand and whether sending them product carries a brand risk.`,
    'relevant: 2 = their content or the brands they sold for are the same product type or audience (a direct competitor counts); 1 = adjacent (same broad category or a buyer who would plausibly buy this); 0 = unrelated or no signal.',
    'risk: high = content a consumer brand must not be next to (adult, hate, violence, drugs, gambling, scams, counterfeit, medical claims), or a reseller/dropship account; some = something to check first (say what); none = nothing in the data.',
    'Only use the data below. Answer with one JSON object and nothing else: {"creators": [{"handle": "...", "relevant": 0|1|2, "risk": "none|some|high", "note": "<one short line, or null>"}]}',
  ].join('\n');
  const user = [
    `Brand: ${input.brand}. Products: ${input.products.slice(0, 10).join('; ') || 'unknown'}. Categories: ${input.categories.join(', ') || 'unknown'}. Direct competitors: ${input.competitors.join(', ') || 'none listed'}.`,
    '', ...input.creators.map((c) => `- @${c.handle} · ${c.followers} followers${c.language ? ` · ${c.language}` : ''} · categories: ${c.categories.join(', ') || 'none'} · sold for: ${c.brands.join(', ') || 'none in 90 days'}${c.bio ? ` · bio: ${c.bio.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`),
  ].join('\n');
  return { system, user };
}

export function parseRelevance(raw: string): Map<string, { relevant: 0 | 1 | 2; risk: 'none' | 'some' | 'high'; note: string | null }> {
  const out = new Map<string, { relevant: 0 | 1 | 2; risk: 'none' | 'some' | 'high'; note: string | null }>();
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) return out;
  let j: { creators?: unknown };
  try { j = JSON.parse(raw.slice(start, end + 1)) as { creators?: unknown }; } catch { return out; }
  for (const c of (Array.isArray(j.creators) ? j.creators : []) as Record<string, unknown>[]) {
    if (!c || typeof c.handle !== 'string') continue;
    const rel = Number(c.relevant); const risk = String(c.risk ?? 'none').toLowerCase();
    out.set(c.handle.replace(/^@/, '').toLowerCase(), { relevant: (rel >= 2 ? 2 : rel >= 1 ? 1 : 0) as 0 | 1 | 2, risk: risk === 'high' ? 'high' : risk === 'some' ? 'some' : 'none', note: typeof c.note === 'string' && c.note.trim() && c.note.trim().toLowerCase() !== 'null' ? c.note.trim().slice(0, 200) : null });
  }
  return out;
}

/** The light for one account: red when the queue is stale or the week is behind its minimum, amber when a shortlist waits or the week is behind target, green otherwise, grey without a scan. */
export function lightFor(shops: SampleShop[], now = Date.now()): { light: SampleAccount['light']; summary: string } {
  const scanned = shops.filter((s) => s.scanned_at);
  if (!scanned.length) return { light: 'grey', summary: shops.length ? 'Not scanned yet' : 'No Cruva shop linked' };
  const elapsed = Math.max(1, Math.min(7, Math.ceil((now - startOfWeek(now)) / 86400000)));
  const pending = scanned.reduce((n, s) => n + s.pending, 0);
  const shortlist = scanned.reduce((n, s) => n + s.shortlist.length, 0);
  const accepted = scanned.reduce((n, s) => n + s.accepted_week, 0);
  const cap = scanned.some((s) => s.cap !== null) ? scanned.reduce((n, s) => n + (s.cap ?? 0), 0) : null;
  const min = scanned.some((s) => s.min_target !== null) ? scanned.reduce((n, s) => n + (s.min_target ?? 0), 0) : null;
  const oldest = Math.max(0, ...scanned.map((s) => s.oldest_days ?? 0));
  const parts = [`${pending} to review`, shortlist ? `${shortlist} shortlisted` : null, cap !== null ? `${accepted} of ${cap} accepted this week` : `${accepted} accepted this week`].filter(Boolean).join(' · ');
  if (scanned.some((s) => s.error)) return { light: 'red', summary: `Scan failed: ${scanned.find((s) => s.error)!.error}` };
  if (oldest >= 5 && pending) return { light: 'red', summary: `Requests waiting ${oldest} days · ${parts}` };
  if (min !== null && accepted < Math.ceil((min * elapsed) / 7) && shortlist + accepted < min) return { light: 'red', summary: `Behind the minimum (${min} a week) · ${parts}` };
  if (shortlist) return { light: 'amber', summary: `${shortlist} ready to accept · ${parts}` };
  if (cap !== null && accepted < Math.floor((cap * elapsed) / 7) && pending) return { light: 'amber', summary: `Behind target (${cap} a week) · ${parts}` };
  return { light: 'green', summary: parts };
}

export class SampleEngine {
  private scanning = new Set<string>();
  private throttle: <T>(fn: () => Promise<T>) => Promise<T>;
  constructor(private q: Queries, private playbook: PlaybookEngine, private mcp: McpCaller = cruvaMcp, private llm: ((system: string, user: string) => Promise<string>) | null | undefined = undefined, opts: { minGapMs?: number } = {}) { this.throttle = makeThrottle(opts.minGapMs ?? 600); }

  private llmOrNull(): ((system: string, user: string) => Promise<string>) | null {
    if (this.llm !== undefined) return this.llm;
    return config.anthropicApiKey ? (sys: string, user: string) => draftWithClaude(sys, user, { maxTokens: 2500, feature: 'playbook' }) : null;
  }

  rulesFor(accountId: number): SampleRules {
    try { return { ...DEFAULT_RULES, ...(JSON.parse(this.q.getSetting(`samples_rules_${accountId}`, '') || '{}') as Partial<SampleRules>) }; } catch { return { ...DEFAULT_RULES }; }
  }

  setRules(accountId: number, patch: Partial<SampleRules>): SampleRules {
    const cur = this.rulesFor(accountId);
    const n = (v: unknown, fallback: number, min = 0, max = 1e9) => (v === undefined || v === null || v === '' ? fallback : Math.max(min, Math.min(max, Number(v) || 0)));
    const next: SampleRules = {
      min_gmv: n(patch.min_gmv, cur.min_gmv), min_engagement: n(patch.min_engagement, cur.min_engagement, 0, 100), min_post_rate: n(patch.min_post_rate, cur.min_post_rate, 0, 100), min_followers: n(patch.min_followers, cur.min_followers),
      relevance: patch.relevance && ['require', 'prefer', 'ignore'].includes(patch.relevance) ? patch.relevance : cur.relevance,
      cap_override: patch.cap_override === undefined ? cur.cap_override : patch.cap_override === null ? null : Math.max(0, Math.round(Number(patch.cap_override) || 0)),
      auto_accept: patch.auto_accept === undefined ? cur.auto_accept : Boolean(patch.auto_accept), auto_per_week: n(patch.auto_per_week, cur.auto_per_week, 0, 500),
    };
    this.q.setSetting(`samples_rules_${accountId}`, JSON.stringify(next));
    liveEvents.emitUpdate({ kind: 'samples', account_id: accountId });
    return next;
  }

  private scanState(shopId: string): { scanned_at: string | null; pending: number; accepted_week: number; week_of: string | null; error: string | null } {
    try { return { scanned_at: null, pending: 0, accepted_week: 0, week_of: null, error: null, ...(JSON.parse(this.q.getSetting(`samples_scan_${shopId}`, '') || '{}') as Record<string, unknown>) } as ReturnType<SampleEngine['scanState']>; } catch { return { scanned_at: null, pending: 0, accepted_week: 0, week_of: null, error: null }; }
  }

  private capFor(shop: PlaybookShop, rules: SampleRules, targets: AccountTarget[]): { cap: number | null; cap_source: SampleShop['cap_source']; min_target: number | null } {
    if (rules.cap_override !== null) return { cap: rules.cap_override, cap_source: 'override', min_target: targetValue(targets, 'samples_min_per_week', shop.market ?? '') };
    const t = targetValue(targets, 'samples_per_week', shop.market ?? '');
    return { cap: t, cap_source: t === null ? null : 'target', min_target: targetValue(targets, 'samples_min_per_week', shop.market ?? '') };
  }

  shopView(shop: PlaybookShop, rules: SampleRules, targets: AccountTarget[], now = Date.now()): SampleShop {
    const st = this.scanState(shop.shop_id);
    const weekIso = new Date(startOfWeek(now)).toISOString();
    const rows = this.q.listSampleRequests(shop.shop_id);
    const pending = rows.filter((r) => r.status === 'pending');
    const accepted = rows.filter((r) => r.status === 'accepted').sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? '')).slice(0, 50);
    const oldest = pending.map((r) => (r.submitted ? (now - Date.parse(r.submitted)) / 86400000 : 0)).sort((a, b) => b - a)[0];
    // Cruva's count of approvals this week as of the scan (from anywhere), plus what was approved here since.
    const fromCruva = st.week_of === weekIso ? st.accepted_week : 0;
    const since = st.week_of === weekIso && st.scanned_at && st.scanned_at > weekIso ? st.scanned_at : weekIso;
    return {
      shop_id: shop.shop_id, shop_name: shop.shop_name, market: shop.market, account_id: shop.account_id, pending: pending.length, oldest_days: oldest === undefined ? null : Math.floor(oldest),
      shortlist: pending.filter((r) => r.verdict === 'accept'), review: pending.filter((r) => r.verdict === 'review'), skipped: pending.filter((r) => r.verdict === 'skip'), accepted,
      accepted_week: fromCruva + this.q.countSampleAccepted(shop.shop_id, since), auto_week: this.q.countSampleAccepted(shop.shop_id, weekIso, true),
      ...this.capFor(shop, rules, targets), scanned_at: st.scanned_at, error: st.error,
    };
  }

  data(now = Date.now()): SamplesData {
    const accounts = new Map<number, Account>(this.q.listAccounts().map((a) => [a.id, a]));
    const targets = this.q.listAccountTargets();
    const byAccount = new Map<number, SampleShop[]>();
    for (const shop of this.playbook.shops()) {
      const rules = this.rulesFor(shop.account_id);
      byAccount.set(shop.account_id, [...(byAccount.get(shop.account_id) ?? []), this.shopView(shop, rules, targets.filter((t) => t.account_id === shop.account_id), now)]);
    }
    const order = { red: 0, amber: 1, green: 2, grey: 3 };
    const out: SampleAccount[] = [...byAccount.entries()].map(([id, shops]) => { const a = accounts.get(id); const { light, summary } = lightFor(shops, now); return { account_id: id, name: a?.name ?? `Account ${id}`, am_name: a?.am_name ?? null, light, summary, rules: this.rulesFor(id), shops }; }).sort((a, b) => order[a.light] - order[b.light] || a.name.localeCompare(b.name));
    return { configured: this.mcp.configured, accounts: out, defaults: DEFAULT_RULES, scanning: this.scanning.size > 0 };
  }

  /** Every pending request of the shop, pages of 24, ranked by platform GMV. */
  private async pullPending(shopId: string): Promise<{ rows: PendingRow[]; total: number | null }> {
    const rows: PendingRow[] = []; let total: number | null = null;
    for (let page = 1; page <= 8; page += 1) {
      const text = await this.throttle(() => this.mcp.call('ai_search_sample_requests', { shop_id: shopId, page, page_size: 24 }));
      const r = parsePending(text);
      rows.push(...r.rows); total = total ?? r.total;
      if (!r.more || !r.rows.length) break;
    }
    return { rows, total };
  }

  /** Who the creator is and who they sold for: Cruva's affiliate record and their brands of the last 90 days; the direct competitors come from the shop's list. */
  async research(shop: PlaybookShop, handle: string, competitors: { brand_id: string; name: string }[], now = Date.now()): Promise<SampleResearch> {
    const region = marketRegion(shop.market);
    const aff = parseAffiliate(await this.throttle(() => this.mcp.call('get_affiliate_data', { handle, region })));
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const numOr = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const categories = Array.isArray(aff?.category) ? (aff!.category as unknown[]).map(String) : [];
    const creatorId = str(aff?.creator_id);
    let brands: SampleResearch['brands'] = [];
    if (creatorId) { try { brands = parseCreatorBrands(await this.throttle(() => this.mcp.call('list_creator_brands', { creator_id: creatorId, region, sort: 'gmv', ts_days: 90, page_size: 10 }))); } catch (err) { log.info(`Samples: brands of @${handle}: ${(err as Error).message}`); } }
    const compIds = new Map(competitors.map((c) => [c.brand_id, c.name]));
    const compNames = competitors.map((c) => c.name.toLowerCase());
    const competitor = brands.map((b) => compIds.get(b.id) ?? (compNames.some((n) => b.name.toLowerCase().includes(n) || n.includes(b.name.toLowerCase())) ? b.name : null)).find((x): x is string => Boolean(x)) ?? null;
    const category_match = categoryMatch(categories, { categories: shop.learned?.categories ?? [], products: shop.learned?.products ?? [] });
    return { creator_id: creatorId, categories, category_splits: aff && typeof aff.category_splits === 'object' && aff.category_splits ? (aff.category_splits as Record<string, number>) : {}, bio: str(aff?.bio), content_quality: numOr(aff?.content_quality), brand_collaborations: numOr(aff?.brand_collaborations), language: str(aff?.language), brands, competitor, category_match, relevant: competitor ? 2 : category_match ? 1 : 0, risk: 'none', note: null, researched_at: new Date(now).toISOString() };
  }

  /** Read the queue, research what clears the numbers, score, shortlist, and accept on its own where the account allows it. */
  async scanShop(shopId: string, now = Date.now()): Promise<SampleShop> {
    const shop = this.playbook.shops().find((s) => s.shop_id === shopId);
    if (!shop) throw new Error('Shop not found');
    if (!this.mcp.configured) throw new Error('CRUVA_API_KEY is not set.');
    if (this.scanning.has(shopId)) throw new Error('This shop is being scanned already.');
    this.scanning.add(shopId);
    const rules = this.rulesFor(shop.account_id);
    const targets = this.q.listAccountTargets(shop.account_id);
    const state = (patch: Record<string, unknown>) => this.q.setSetting(`samples_scan_${shopId}`, JSON.stringify({ ...this.scanState(shopId), ...patch }));
    try {
      const { rows, total } = await this.pullPending(shopId);
      const seenAt = new Date(now).toISOString();
      const competitors = this.q.listShopCompetitors(shopId).filter((c) => c.status !== 'rejected');
      // Research the creators that clear the numbers and were not researched in the last fortnight; at most 25 a scan.
      const fortnight = now - 14 * 86400000;
      const toResearch: PendingRow[] = []; const researchOf = new Map<string, SampleResearch | null>();
      for (const row of rows) {
        if (researchOf.has(row.handle)) continue;
        const prev = this.q.getSampleRequest(shopId, row.apply_id)?.research ?? this.q.latestSampleResearch(row.handle);
        if (prev && Date.parse(prev.researched_at) >= fortnight) { researchOf.set(row.handle, prev); continue; }
        researchOf.set(row.handle, null);
        if (rules.relevance !== 'ignore' && judge(row, null, rules).verdict !== 'skip' && toResearch.length < 25) toResearch.push(row);
      }
      for (const row of toResearch) { try { researchOf.set(row.handle, await this.research(shop, row.handle, competitors, now)); } catch (err) { log.info(`Samples: research @${row.handle}: ${(err as Error).message}`); } }
      // One Claude pass over the freshly researched creators: relevance and brand risk.
      const llm = this.llmOrNull();
      const fresh = toResearch.map((r) => ({ row: r, research: researchOf.get(r.handle) })).filter((x): x is { row: PendingRow; research: SampleResearch } => Boolean(x.research));
      if (llm && fresh.length) {
        try {
          const { system, user } = relevancePrompt({ brand: shop.shop_name.replace(/\s*\b(DE|FR|IT|ES|UK|GB|IE|NL|BE|PL|AT|AU|MX|US)\b\s*$/i, '').trim(), market: shop.market, products: shop.learned?.products ?? [], categories: shop.learned?.categories ?? [], competitors: competitors.map((c) => c.name), creators: fresh.map((x) => ({ handle: x.row.handle, bio: x.research.bio, categories: x.research.categories, brands: x.research.brands.map((b) => b.name), followers: x.row.followers, language: x.research.language })) });
          const verdicts = parseRelevance(await llm(system, user));
          for (const x of fresh) { const v = verdicts.get(x.row.handle.toLowerCase()); if (v) researchOf.set(x.row.handle, { ...x.research, relevant: Math.max(v.relevant, x.research.competitor ? 2 : 0) as 0 | 1 | 2, risk: v.risk, note: v.note }); }
        } catch (err) { log.warn(`Samples: relevance pass for ${shop.shop_name}: ${(err as Error).message}`); }
      }
      const saved: SampleRequest[] = [];
      for (const row of rows) {
        const prev = this.q.getSampleRequest(shopId, row.apply_id);
        if (prev && prev.status === 'accepted') continue; // approved here already; Cruva will drop it from the queue
        const research = researchOf.get(row.handle) ?? null;
        const j = judge(row, research, rules);
        const req: SampleRequest = { ...row, shop_id: shopId, research, ...j, seen_at: seenAt, status: 'pending', decided_at: null, decided_by: null };
        this.q.saveSampleRequest(req); saved.push(req);
      }
      this.q.markSampleRequestsGone(shopId, rows.map((r) => r.apply_id), seenAt);
      // Accepted this week on the shop, from Cruva (approvals from anywhere, not just here).
      const weekIso = new Date(startOfWeek(now)).toISOString();
      let acceptedWeek = this.q.countSampleAccepted(shopId, weekIso);
      try { const t = await this.throttle(() => this.mcp.call('search_sample_requests', { shop_id: shopId, approval_time_from: weekIso.slice(0, 10), just_count: true })); const m = unwrap(t).match(/total:\s*([\d,]+)/); if (m) acceptedWeek = Math.max(acceptedWeek, num(m[1])); } catch (err) { log.info(`Samples: approved count for ${shop.shop_name}: ${(err as Error).message}`); }
      state({ scanned_at: seenAt, pending: total ?? rows.length, accepted_week: acceptedWeek, week_of: weekIso, error: null });
      // Auto-accept: the top of the shortlist, up to the weekly number, never past the cap.
      if (rules.auto_accept && rules.auto_per_week > 0) {
        const { cap } = this.capFor(shop, rules, targets);
        const room = Math.min(rules.auto_per_week - this.q.countSampleAccepted(shopId, weekIso, true), cap === null ? Infinity : cap - acceptedWeek);
        const pick = saved.filter((r) => r.verdict === 'accept').sort((a, b) => b.score - a.score).slice(0, Math.max(0, room));
        if (pick.length) {
          const r = await this.accept(shopId, pick.map((p) => p.apply_id), 'auto', now);
          if (r.accepted.length) void this.postAuto(shop, r.accepted).catch(() => undefined);
        }
      }
    } catch (err) {
      state({ scanned_at: new Date(now).toISOString(), error: (err as Error).message });
      throw err;
    } finally { this.scanning.delete(shopId); liveEvents.emitUpdate({ kind: 'samples', account_id: shop.account_id }); }
    return this.shopView(this.playbook.shops().find((s) => s.shop_id === shopId)!, rules, targets, now);
  }

  /** Approve requests in Cruva (ships product: only ids that are pending here, never twice) and keep the decision. */
  async accept(shopId: string, applyIds: string[], actor: string, now = Date.now()): Promise<{ accepted: SampleRequest[]; skipped: string[] }> {
    if (!this.mcp.configured) throw new Error('CRUVA_API_KEY is not set.');
    const rows = applyIds.map((id) => this.q.getSampleRequest(shopId, id)).filter((r): r is SampleRequest => Boolean(r) && r!.status === 'pending');
    const skipped = applyIds.filter((id) => !rows.some((r) => r.apply_id === id));
    if (!rows.length) return { accepted: [], skipped };
    const text = await this.mcp.call('approve_samples', { shop_id: shopId, apply_ids: rows.map((r) => r.apply_id) });
    if (/error|failed|not found|unauthori/i.test(unwrap(text)) && !/approved/i.test(unwrap(text))) throw new Error(`Cruva did not approve: ${unwrap(text).slice(0, 200)}`);
    const at = new Date(now).toISOString();
    const accepted = rows.map((r) => { const req: SampleRequest = { ...r, status: 'accepted', decided_at: at, decided_by: actor }; this.q.saveSampleRequest(req); return req; });
    const shop = this.playbook.shops().find((s) => s.shop_id === shopId);
    liveEvents.emitUpdate({ kind: 'samples', account_id: shop?.account_id });
    log.info(`Samples: ${accepted.length} request(s) approved on ${shop?.shop_name ?? shopId} by ${actor}`);
    return { accepted, skipped };
  }

  private async postAuto(shop: PlaybookShop, accepted: SampleRequest[]): Promise<void> {
    const acc = this.q.listAccounts().find((a) => a.id === shop.account_id);
    if (!slackBot.configured || !acc?.slack_channel) return;
    const lines = [`*Samples auto-accepted on ${shop.shop_name}* (${accepted.length}): ${accepted.map((r) => `@${r.handle} (${Math.round(r.gmv_30d)} GMV 30d${r.research?.competitor ? `, sold for ${r.research.competitor}` : ''})`).join(', ')} · ${config.publicUrl}/samples`];
    await slackBot.post(await slackBot.channelId(acc.slack_channel), lines.join('\n'));
  }

  /** Every linked shop, one after the other; errors come back as text. */
  async scanAll(): Promise<{ shops: number; errors: string[] }> {
    const out = { shops: 0, errors: [] as string[] };
    if (!this.mcp.configured) return out;
    for (const shop of this.playbook.shops()) { out.shops += 1; try { await this.scanShop(shop.shop_id); } catch (err) { out.errors.push(`${shop.shop_name}: ${(err as Error).message}`); } }
    return out;
  }
}
