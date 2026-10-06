import { createHash } from 'node:crypto';
import cron, { type ScheduledTask } from 'node-cron';
import type { Queries } from '../db/queries.js';
import type { AtsKind, Competitor, CompetitorClient, CompetitorDetail, CompetitorPerson, CompetitorSignal, CompetitorSignalKind, CompetitorsData, CompetitorsSettings, CompetitorOverlapRow, CompetitorView } from '../sweep/types.js';
import { apollo as defaultApollo, ApolloClient, ApolloCreditsError, type ApolloOrgPerson } from '../bd/apollo.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { incidentSettings } from '../incidents/index.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';
import { slackBot } from '../notify/slackbot.js';

/**
 * Competitor intelligence, phase 1: a registry of the agencies we meet in deals, who works there and who
 * joins or leaves (Apollo, no credits), what they are hiring for (public ATS feeds, Apollo job postings
 * when switched on), which brands they run (their own client, case study and press pages, fetched weekly
 * and diffed, with Claude reading the additions), the overlap with our pipeline and lead list, and a
 * Monday digest to Slack. Everything is a signal with its evidence and a link; nothing is inferred
 * without a source line.
 */

export interface SlackLike { configured: boolean; post(channel: string, text: string): Promise<unknown>; channelId(nameOrId: string): Promise<string> }
export interface CompetitorDeps { apollo?: ApolloClient; fetchFn?: typeof fetch; llm?: ((system: string, user: string) => Promise<string>) | null; slack?: SlackLike; now?: () => string }

export const SEED_COMPETITORS: { name: string; domain: string; markets: string[]; notes: string }[] = [
  { name: 'Genuine', domain: 'wearegenuine.com', markets: ['UK'], notes: 'Domain from an Apollo lookup; confirm it is the TikTok Shop agency.' },
  { name: 'Unsociable', domain: 'weareunsociable.com', markets: ['UK'], notes: '' },
  { name: 'Flywheel Digital', domain: 'flywheel.digital', markets: ['UK', 'DE', 'FR'], notes: '' },
  { name: 'AdToker', domain: 'adtoker.com', markets: ['UK', 'DE'], notes: '' },
  { name: 'AdBaker', domain: 'adbaker.de', markets: ['DE'], notes: '' },
];

const UA = 'Mozilla/5.0 (compatible; BrightformIntel/1.0; +https://brightform.agency)';
const SUFFIX_RE = /\b(gmbh|ltd|limited|llc|inc|ag|sas|srl|sl|bv|uk|de|fr|it|es|nl|eu|official|store|shop|shopify|cosmetics|co)\b/g;

/** "Waterdrop GmbH" and "WATERDROP Official Store DE" both key to "waterdrop". */
export function brandKey(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(SUFFIX_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Visible text of a page as lines: scripts, styles, nav noise and tags out, entities decoded, whitespace collapsed. */
export function textOfHtml(html: string): string {
  const body = html.replace(/<head[\s\S]*?<\/head>/gi, ' ').replace(/<title[\s\S]*?<\/title>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, ' ');
  const withBreaks = body.replace(/<img[^>]+alt=["']([^"']{2,80})["'][^>]*>/gi, '\n$1\n').replace(/<\/(p|div|li|h[1-6]|tr|section|article|br|blockquote|figcaption)>|<br\s*\/?>/gi, '\n');
  const text = withBreaks.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 2);
  const out: string[] = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
  return out.join('\n').slice(0, 200000);
}

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Lines in the new text that were not in the old one (order kept, duplicates dropped). */
export function addedLines(prev: string, next: string): string[] {
  const before = new Set(prev.split('\n'));
  const seen = new Set<string>();
  return next.split('\n').filter((l) => l && !before.has(l) && (seen.has(l) ? false : (seen.add(l), true)));
}

// ---- Jobs: public ATS feeds ----

export interface JobRow { ext_id: string; title: string; location: string | null; url: string | null; posted_at: string | null }

export function atsUrl(kind: AtsKind, slug: string): string {
  switch (kind) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false`;
    case 'lever': return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`;
    case 'personio': return `https://${encodeURIComponent(slug)}.jobs.personio.de/search.json`;
  }
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const day = (v: unknown): string | null => { if (v === null || v === undefined) return null; const d = typeof v === 'number' ? new Date(v) : new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };

export function parseAtsFeed(kind: AtsKind, payload: unknown, slug: string): JobRow[] {
  const o = (payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case 'greenhouse':
      return ((o.jobs as Record<string, unknown>[] | undefined) ?? []).map((j) => ({ ext_id: String(j.id ?? ''), title: String(j.title ?? ''), location: str((j.location as { name?: string } | undefined)?.name), url: str(j.absolute_url), posted_at: day(j.first_published ?? j.updated_at) })).filter((j) => j.ext_id && j.title);
    case 'lever':
      return (Array.isArray(payload) ? (payload as Record<string, unknown>[]) : []).map((j) => ({ ext_id: String(j.id ?? ''), title: String(j.text ?? ''), location: str((j.categories as { location?: string } | undefined)?.location), url: str(j.hostedUrl), posted_at: day(j.createdAt) })).filter((j) => j.ext_id && j.title);
    case 'workable':
      return ((o.jobs as Record<string, unknown>[] | undefined) ?? []).map((j) => ({ ext_id: String(j.shortcode ?? j.id ?? ''), title: String(j.title ?? ''), location: [j.city, j.country].filter(Boolean).join(', ') || null, url: str(j.url), posted_at: day(j.published_on) })).filter((j) => j.ext_id && j.title);
    case 'personio':
      return (Array.isArray(payload) ? (payload as Record<string, unknown>[]) : []).map((j) => ({ ext_id: String(j.id ?? ''), title: String(j.name ?? ''), location: str(j.office), url: j.id ? `https://${slug}.jobs.personio.de/job/${j.id}` : null, posted_at: day(j.createdAt) })).filter((j) => j.ext_id && j.title);
  }
}

// ---- People: the weekly diff ----

export interface PeopleDiff { joined: ApolloOrgPerson[]; left: CompetitorPerson[]; changed: { person: CompetitorPerson; from: string | null; to: string | null }[]; missed: CompetitorPerson[] }

/** Compare what Apollo lists now with what we had. Someone is "left" on the second consecutive sweep they are missing. */
export function diffPeople(prev: CompetitorPerson[], next: ApolloOrgPerson[]): PeopleDiff {
  const before = new Map(prev.filter((p) => !p.left_at).map((p) => [p.apollo_id, p]));
  const now = new Map(next.map((p) => [p.id, p]));
  const joined = next.filter((p) => !before.has(p.id));
  const changed: PeopleDiff['changed'] = [];
  for (const p of prev) { const n = now.get(p.apollo_id); if (n && !p.left_at && (n.title ?? null) !== (p.title ?? null) && n.title) changed.push({ person: p, from: p.title, to: n.title }); }
  const missing = [...before.values()].filter((p) => !now.has(p.apollo_id));
  return { joined, left: missing.filter((p) => p.miss_count >= 1), missed: missing.filter((p) => p.miss_count < 1), changed };
}

const deptOf = (p: ApolloOrgPerson): string | null => p.departments[0]?.replace(/^master_/, '').replace(/_/g, ' ') ?? null;
const seniorRe = /\b(founder|co-founder|ceo|coo|cfo|cmo|managing director|md\b|director|head|vp|vice president|partner|owner|chief)\b/i;
const isSenior = (p: { title: string | null; seniority?: string | null }): boolean => /^(founder|owner|c_suite|partner|vp|head|director)$/.test(p.seniority ?? '') || seniorRe.test(p.title ?? '');

// ---- Website extraction ----

export interface Extracted { clients: { brand: string; market: string | null; evidence: string }[]; hires: { name: string; title: string | null; evidence: string }[]; markets: { market: string; evidence: string }[]; events: { title: string; evidence: string }[]; press: { title: string; evidence: string }[] }

const EMPTY: Extracted = { clients: [], hires: [], markets: [], events: [], press: [] };
const HIRE_RE = /\b(welcome(s)? (to the team)?|joins (us|the team|as)|joined (us|the team|as)|new (hire|team member|joiner)|appointed|promoted to)\b/i;
const EVENT_RE = /\b(webinar|summit|meetup|conference|panel|workshop|masterclass|live session|speaking at|join us at)\b/i;
const PRESS_RE = /\b(press|announce[sd]?|partnership|award|wins?|winner|shortlisted|featured in|interview)\b/i;
const MARKET_WORDS: [RegExp, string][] = [[/\b(germany|deutschland|german|dach)\b/i, 'DE'], [/\b(united kingdom|uk\b|britain|british)\b/i, 'UK'], [/\b(france|french)\b/i, 'FR'], [/\b(italy|italia|italian)\b/i, 'IT'], [/\b(spain|españa|spanish)\b/i, 'ES'], [/\b(netherlands|dutch|benelux)\b/i, 'NL'], [/\b(ireland|irish)\b/i, 'IE'], [/\b(poland|polish)\b/i, 'PL']];

/** Without Claude: the brands we already know by name, and lines that read like hires, events or press. */
export function extractRules(lines: string[], knownBrands: { name: string; key: string }[]): Extracted {
  const out: Extracted = { clients: [], hires: [], markets: [], events: [], press: [] };
  const seenBrand = new Set<string>();
  for (const line of lines) {
    const key = brandKey(line);
    for (const b of knownBrands) {
      if (seenBrand.has(b.key) || b.key.length < 3) continue;
      if (key === b.key || new RegExp(`(^| )${b.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(key)) { seenBrand.add(b.key); out.clients.push({ brand: b.name, market: MARKET_WORDS.find(([re]) => re.test(line))?.[1] ?? null, evidence: line.slice(0, 240) }); }
    }
    if (line.length <= 240) {
      if (HIRE_RE.test(line)) out.hires.push({ name: line.replace(/^(welcome|welcoming)\s+/i, '').split(/\b(to|as|joins|joined|who)\b/i)[0].trim().slice(0, 80) || line.slice(0, 80), title: line.match(/\bas (?:our )?(?:new )?([A-Z][\w &/-]{2,60})/)?.[1] ?? null, evidence: line });
      else if (EVENT_RE.test(line)) out.events.push({ title: line.slice(0, 120), evidence: line });
      else if (PRESS_RE.test(line) && line.length > 40) out.press.push({ title: line.slice(0, 120), evidence: line });
    }
  }
  return { ...out, hires: out.hires.slice(0, 10), events: out.events.slice(0, 10), press: out.press.slice(0, 10) };
}

export function renderExtractionPrompt(competitor: Competitor, url: string, lines: string[], knownBrands: string[]): { system: string; user: string } {
  return {
    system: [
      `You read a competitor's web page for Brightform, a TikTok Shop agency. The competitor is ${competitor.name} (${competitor.domain ?? 'no domain'}), a TikTok Shop or social commerce agency in ${competitor.markets.join(', ') || 'Europe'}.`,
      'You get the lines that are new on the page since we last looked (or the whole page the first time). Extract only what the lines literally say; quote the line as evidence; never guess a brand from a logo file name unless the name is readable; skip generic words, product categories, platform names (TikTok, Shopify, Amazon, Meta) and the competitor itself.',
      'clients: brands the competitor works or worked with (client lists, case studies, results, testimonials), with the market when the text says it (DE, UK, FR, IT, ES, NL, IE, PL). hires: people named as joining or being promoted, with the title. markets: a market or country the competitor says it is launching or expanding in. events: webinars, talks, summits, with the title. press: announcements, awards, partnerships, features.',
      'Return JSON only: {"clients":[{"brand":"","market":null,"evidence":""}],"hires":[{"name":"","title":null,"evidence":""}],"markets":[{"market":"","evidence":""}],"events":[{"title":"","evidence":""}],"press":[{"title":"","evidence":""}]}. Empty arrays when nothing applies.',
    ].join('\n'),
    user: `Page: ${url}\nBrands we already know (to spell them the same way): ${knownBrands.slice(0, 60).join(', ') || 'none'}\n\nNew lines:\n${lines.slice(0, 400).join('\n').slice(0, 14000)}\n\nReturn the JSON now.`,
  };
}

export function parseExtraction(text: string): Extracted | null {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Partial<Record<keyof Extracted, Record<string, unknown>[]>>;
    const s = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 240) : '');
    const arr = (k: keyof Extracted) => (Array.isArray(j[k]) ? j[k]! : []);
    return {
      clients: arr('clients').map((c) => ({ brand: s(c.brand).slice(0, 80), market: s(c.market).toUpperCase().slice(0, 2) || null, evidence: s(c.evidence) })).filter((c) => c.brand.length >= 2 && c.evidence),
      hires: arr('hires').map((c) => ({ name: s(c.name).slice(0, 80), title: s(c.title).slice(0, 80) || null, evidence: s(c.evidence) })).filter((c) => c.name && c.evidence),
      markets: arr('markets').map((c) => ({ market: s(c.market).toUpperCase().slice(0, 2), evidence: s(c.evidence) })).filter((c) => c.market.length === 2 && c.evidence),
      events: arr('events').map((c) => ({ title: s(c.title).slice(0, 120), evidence: s(c.evidence) })).filter((c) => c.title && c.evidence),
      press: arr('press').map((c) => ({ title: s(c.title).slice(0, 120), evidence: s(c.evidence) })).filter((c) => c.title && c.evidence),
    };
  } catch {
    return null;
  }
}

// ---- Overlap with our pipeline ----

export interface OverlapIndex { prospects: { id: number; key: string; alt: string; market: string; status: string }[]; leads: { id: number; key: string; stage: string | null }[] }

export function overlapIndex(q: Queries): OverlapIndex {
  return {
    prospects: q.listProspects(false).map((p) => ({ id: p.id, key: brandKey(p.brand ?? p.shop_name), alt: brandKey(p.shop_name), market: p.market, status: String(p.status) })),
    leads: q.listLeads(false).map((l) => ({ id: l.id, key: brandKey(l.name), stage: l.stage })),
  };
}

export function matchOverlap(key: string, market: string | null, idx: OverlapIndex): { prospect_id: number | null; lead_id: number | null } {
  if (key.length < 3) return { prospect_id: null, lead_id: null };
  const hit = (k: string) => k === key || (k.length >= 4 && (k.startsWith(`${key} `) || key.startsWith(`${k} `)));
  const ps = idx.prospects.filter((p) => hit(p.key) || hit(p.alt));
  const prospect = (market ? ps.find((p) => p.market === market) : null) ?? ps[0] ?? null;
  const lead = idx.leads.find((l) => hit(l.key)) ?? null;
  return { prospect_id: prospect?.id ?? null, lead_id: lead?.id ?? null };
}

// ---- Digest ----

const KIND_LABEL: Record<CompetitorSignalKind, string> = { joined: 'Joined', left: 'Left', title_change: 'New title', hiring: 'Hiring', job_closed: 'Role closed', new_client: 'New client', client_gone: 'Client gone', overlap: 'In our pipeline', press: 'Press', event: 'Event', market: 'Market', website: 'Website', note: 'Note' };
const DIGEST_ORDER: CompetitorSignalKind[] = ['overlap', 'new_client', 'joined', 'left', 'title_change', 'hiring', 'market', 'press', 'event', 'website', 'client_gone', 'note', 'job_closed'];

export function digestText(competitors: Competitor[], signals: CompetitorSignal[], opts: { since: string; until: string; link: string; timezone?: string }): string {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: opts.timezone ?? 'Europe/Madrid' });
  const lines: string[] = [`*Competitor movements · ${fmt(opts.since)} to ${fmt(opts.until)}*`];
  const quiet: string[] = [];
  for (const c of competitors.filter((x) => x.enabled)) {
    const mine = signals.filter((s) => s.competitor_id === c.id && s.kind !== 'job_closed');
    if (!mine.length) { quiet.push(c.name); continue; }
    lines.push('', `*${c.name}*${c.markets.length ? ` (${c.markets.join(', ')})` : ''}`);
    for (const kind of DIGEST_ORDER) {
      const rows = mine.filter((s) => s.kind === kind);
      if (!rows.length) continue;
      const shown = rows.slice(0, 5);
      for (const s of shown) lines.push(`• ${KIND_LABEL[kind]}: ${s.summary}${s.url ? ` <${s.url}|source>` : ''}`);
      if (rows.length > shown.length) lines.push(`• ${KIND_LABEL[kind]}: and ${rows.length - shown.length} more`);
    }
  }
  if (quiet.length) lines.push('', `_No changes seen for ${quiet.join(', ')}._`);
  lines.push('', `<${opts.link}|Open Competitors in the dashboard>`);
  return lines.join('\n');
}

// ---- The module ----

const DEFAULT_SETTINGS: CompetitorsSettings = { day: 1, time: '06:00', digest_time: '08:00', channel: '', apollo_jobs: false };

export class Competitors {
  private running = false;
  private sweepTask: ScheduledTask | null = null;
  private digestTask: ScheduledTask | null = null;
  constructor(private q: Queries, private deps: CompetitorDeps = {}) {}

  private get apollo(): ApolloClient { return this.deps.apollo ?? defaultApollo; }
  private get fetchFn(): typeof fetch { return this.deps.fetchFn ?? fetch; }
  private get slack(): SlackLike { return this.deps.slack ?? slackBot; }
  private get now(): string { return this.deps.now ? this.deps.now() : new Date().toISOString(); }
  private get llm(): ((system: string, user: string) => Promise<string>) | null {
    if (this.deps.llm !== undefined) return this.deps.llm;
    return config.anthropicApiKey ? (s, u) => draftWithClaude(s, u, { maxTokens: 1800 }) : null;
  }

  settings(): CompetitorsSettings {
    const day = Number(this.q.getSetting('competitors_day', String(DEFAULT_SETTINGS.day)));
    const time = this.q.getSetting('competitors_time', DEFAULT_SETTINGS.time);
    const digest = this.q.getSetting('competitors_digest_time', DEFAULT_SETTINGS.digest_time);
    return { day: Number.isInteger(day) && day >= 0 && day <= 6 ? day : 1, time: /^\d{2}:\d{2}$/.test(time) ? time : '06:00', digest_time: /^\d{2}:\d{2}$/.test(digest) ? digest : '08:00', channel: this.q.getSetting('competitors_channel', '') || incidentSettings(this.q).default_channel, apollo_jobs: this.q.getSetting('competitors_apollo_jobs', '0') === '1' };
  }

  saveSettings(patch: Partial<CompetitorsSettings>): CompetitorsSettings {
    if (patch.day !== undefined) this.q.setSetting('competitors_day', String(Math.min(6, Math.max(0, Math.round(patch.day)))));
    if (patch.time !== undefined && /^\d{2}:\d{2}$/.test(patch.time)) this.q.setSetting('competitors_time', patch.time);
    if (patch.digest_time !== undefined && /^\d{2}:\d{2}$/.test(patch.digest_time)) this.q.setSetting('competitors_digest_time', patch.digest_time);
    if (patch.channel !== undefined) this.q.setSetting('competitors_channel', patch.channel.trim());
    if (patch.apollo_jobs !== undefined) this.q.setSetting('competitors_apollo_jobs', patch.apollo_jobs ? '1' : '0');
    this.reloadSchedule();
    return this.settings();
  }

  /** The five we meet most, once, when the registry is empty. Editable afterwards. */
  seed(): void {
    if (this.q.getSetting('competitors_seeded', '') === '1' || this.q.listCompetitors().length) return;
    for (const c of SEED_COMPETITORS) this.q.createCompetitor({ name: c.name, domain: c.domain, markets: c.markets, notes: c.notes || null, watch_urls: [`https://${c.domain}`] });
    this.q.setSetting('competitors_seeded', '1');
  }

  start(): void {
    this.seed();
    this.reloadSchedule();
  }

  stop(): void {
    this.sweepTask?.stop(); this.digestTask?.stop();
    this.sweepTask = null; this.digestTask = null;
  }

  reloadSchedule(): void {
    this.stop();
    const s = this.settings();
    const tz = this.q.getSetting('check_timezone', 'Europe/Madrid');
    const [sh, sm] = s.time.split(':').map(Number);
    const [dh, dm] = s.digest_time.split(':').map(Number);
    this.sweepTask = cron.schedule(`${sm} ${sh} * * ${s.day}`, () => void this.sweep().catch((err) => log.warn(`Competitor sweep: ${(err as Error).message}`)), { timezone: tz, name: 'competitors-sweep' });
    this.digestTask = cron.schedule(`${dm} ${dh} * * ${s.day}`, () => void this.sendDigest().catch((err) => log.warn(`Competitor digest: ${(err as Error).message}`)), { timezone: tz, name: 'competitors-digest' });
  }

  data(): CompetitorsData {
    const counts = this.q.competitorCounts();
    const competitors: CompetitorView[] = this.q.listCompetitors().map((c) => ({ ...c, ...(counts.get(c.id) ?? { people_active: 0, joined_30d: 0, left_30d: 0, open_jobs: 0, clients: 0, overlap: 0, new_signals: 0, latest_signal_at: null }) }));
    const byId = new Map(competitors.map((c) => [c.id, c]));
    const prospects = new Map(this.q.listProspects(true).map((p) => [p.id, p]));
    const leads = new Map(this.q.listLeads(true).map((l) => [l.id, l]));
    const overlap: CompetitorOverlapRow[] = this.q.listCompetitorClients().filter((c) => c.prospect_id !== null || c.lead_id !== null).map((c) => ({ competitor_id: c.competitor_id, competitor: byId.get(c.competitor_id)?.name ?? '?', brand: c.brand, market: c.market, confidence: c.confidence, prospect_id: c.prospect_id, prospect_status: c.prospect_id !== null ? String(prospects.get(c.prospect_id)?.status ?? '') || null : null, lead_id: c.lead_id, lead_stage: c.lead_id !== null ? leads.get(c.lead_id)?.stage ?? null : null, last_seen_at: c.last_seen_at })).sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
    const last = this.q.lastCompetitorDigest();
    return {
      competitors, overlap, settings: this.settings(), apollo_configured: this.apollo.configured, llm_configured: Boolean(this.llm), slack_configured: this.slack.configured, running: this.running,
      last_run_at: this.q.getSetting('competitors_last_run_at', '') || null, last_error: this.q.getSetting('competitors_last_error', '') || null, last_digest_at: last?.sent_at ?? null,
      digest_preview: this.digestText(), timezone: this.q.getSetting('check_timezone', 'Europe/Madrid'),
    };
  }

  detail(id: number): CompetitorDetail | null {
    const competitor = this.q.getCompetitor(id);
    if (!competitor) return null;
    const all = this.q.listCompetitorPeople(id, { includeLeft: true });
    const d90 = new Date(Date.now() - 90 * 86400000).toISOString();
    return { competitor, people: all.filter((p) => !p.left_at), leavers: all.filter((p) => p.left_at && p.left_at >= d90), jobs: this.q.listCompetitorJobs(id, { includeClosed: true }).filter((j) => !j.closed_at || j.closed_at >= d90), clients: this.q.listCompetitorClients(id), signals: this.q.listCompetitorSignals({ competitorId: id, limit: 300 }), snapshots: this.q.listCompetitorSnapshots(id) };
  }

  markSeen(competitorId: number | null): number {
    const n = this.q.markCompetitorSignalsSeen(competitorId, this.now);
    if (n) liveEvents.emitUpdate({ kind: 'competitors' });
    return n;
  }

  private signal(s: { competitor_id: number; kind: CompetitorSignalKind; summary: string; evidence?: string | null; url?: string | null; dedupe_key: string; observed_at?: string }): CompetitorSignal | null {
    return this.q.addCompetitorSignal({ ...s, observed_at: s.observed_at ?? this.now });
  }

  /** One pass over every enabled competitor (or one). Each source fails on its own; the rest carry on. */
  async sweep(opts: { competitorId?: number; useLlm?: boolean } = {}): Promise<{ swept: number; signals: number; errors: string[] }> {
    if (this.running) return { swept: 0, signals: 0, errors: ['A sweep is already running.'] };
    this.running = true;
    const errors: string[] = [];
    let swept = 0, signals = 0;
    try {
      const list = this.q.listCompetitors().filter((c) => c.enabled && (opts.competitorId === undefined || c.id === opts.competitorId));
      for (const c of list) {
        const errs: string[] = [];
        try { signals += await this.sweepPeople(c, errs); } catch (err) { errs.push(`People: ${(err as Error).message}`); if (err instanceof ApolloCreditsError) break; }
        try { signals += await this.sweepJobs(c, errs); } catch (err) { errs.push(`Jobs: ${(err as Error).message}`); }
        try { signals += await this.sweepWebsite(c, errs, opts.useLlm); } catch (err) { errs.push(`Website: ${(err as Error).message}`); }
        try { signals += this.sweepOverlap(c); } catch (err) { errs.push(`Overlap: ${(err as Error).message}`); }
        this.q.updateCompetitor(c.id, { last_checked_at: this.now, last_error: errs.length ? errs.join(' · ').slice(0, 1000) : null });
        errors.push(...errs.map((e) => `${c.name}: ${e}`));
        swept++;
      }
      this.q.setSetting('competitors_last_run_at', this.now);
      this.q.setSetting('competitors_last_error', errors.length ? `${errors.length} note(s): ${errors[0]}` : '');
    } finally {
      this.running = false;
      liveEvents.emitUpdate({ kind: 'competitors' });
    }
    if (swept) log.info(`Competitor sweep: ${swept} competitor(s), ${signals} new signal(s)${errors.length ? `, ${errors.length} note(s)` : ''}`);
    return { swept, signals, errors };
  }

  private async sweepPeople(c: Competitor, errs: string[]): Promise<number> {
    if (!this.apollo.configured) { errs.push('People: Apollo is not configured.'); return 0; }
    let orgId = c.apollo_org_id;
    if (!orgId && c.domain) {
      try { const org = await this.apollo.enrichOrganization(c.domain); if (org) { orgId = org.id; this.q.updateCompetitor(c.id, { apollo_org_id: org.id, linkedin_url: c.linkedin_url ?? org.linkedin_url ?? null }); } } catch (err) { errs.push(`Apollo org: ${(err as Error).message.slice(0, 160)}`); }
    }
    if (!orgId && !c.domain) { errs.push('People: no domain to search Apollo with.'); return 0; }
    const people: ApolloOrgPerson[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await this.apollo.peopleAtOrganization(orgId ? { organizationId: orgId, page } : { domain: c.domain, page });
      people.push(...r.people);
      if (people.length >= r.total || r.people.length < 100) break;
    }
    const prev = this.q.listCompetitorPeople(c.id, { includeLeft: true });
    const baseline = prev.length === 0;
    const diff = diffPeople(prev, people);
    const now = this.now;
    let n = 0;
    const prevById = new Map(prev.map((p) => [p.apollo_id, p]));
    for (const p of people) {
      const was = prevById.get(p.id);
      const titleChanged = was && !was.left_at && was.title && p.title && was.title !== p.title;
      this.q.upsertCompetitorPerson({ competitor_id: c.id, apollo_id: p.id, name: p.name, title: p.title, prev_title: titleChanged ? was!.title : was?.prev_title ?? null, seniority: p.seniority ?? null, department: deptOf(p), location: [p.city, p.country].filter(Boolean).join(', ') || null, linkedin_url: p.linkedin_url, started_at: p.started_at, seen_at: now, miss_count: 0, left_at: null });
    }
    if (!baseline) {
      for (const p of diff.joined) {
        const recent = !p.started_at || p.started_at >= new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
        if (this.signal({ competitor_id: c.id, kind: 'joined', summary: `${p.name}, ${p.title ?? 'role unknown'}${p.started_at ? ` (started ${p.started_at.slice(0, 7)})` : ''}${isSenior(p) ? ' · senior' : ''}${recent ? '' : ' · newly listed, started earlier'}`, evidence: [p.city, p.country].filter(Boolean).join(', ') || null, url: p.linkedin_url, dedupe_key: `joined:${c.id}:${p.id}` })) n++;
      }
      for (const ch of diff.changed) if (this.signal({ competitor_id: c.id, kind: 'title_change', summary: `${ch.person.name}: ${ch.from ?? '?'} → ${ch.to ?? '?'}`, url: ch.person.linkedin_url, dedupe_key: `title:${c.id}:${ch.person.apollo_id}:${ch.to}` })) n++;
    }
    for (const p of diff.missed) this.q.markCompetitorPersonMissed(p.id, p.miss_count + 1, null);
    for (const p of diff.left) {
      this.q.markCompetitorPersonMissed(p.id, p.miss_count + 1, now);
      if (this.signal({ competitor_id: c.id, kind: 'left', summary: `${p.name}, ${p.title ?? 'role unknown'}${isSenior(p) ? ' · senior' : ''}`, evidence: 'No longer listed at the company by Apollo on two consecutive sweeps', url: p.linkedin_url, dedupe_key: `left:${c.id}:${p.apollo_id}:${now.slice(0, 10)}` })) n++;
    }
    return n;
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).slice(0, 2_000_000);
  }

  private async sweepJobs(c: Competitor, errs: string[]): Promise<number> {
    let n = 0;
    const now = this.now;
    const record = (source: string, rows: JobRow[]) => {
      const { opened } = this.q.syncCompetitorJobs(c.id, source, rows, now);
      const baseline = !this.q.listCompetitorJobs(c.id, { includeClosed: true }).some((j) => j.source === source && j.first_seen_at < now);
      if (baseline) return;
      for (const j of opened) if (this.signal({ competitor_id: c.id, kind: 'hiring', summary: `${j.title}${j.location ? ` · ${j.location}` : ''}`, url: j.url, dedupe_key: `job:${c.id}:${source}:${j.ext_id}`, observed_at: j.posted_at ? `${j.posted_at}T09:00:00.000Z` : now })) n++;
    };
    for (const a of c.ats) {
      try { const payload = JSON.parse(await this.fetchText(atsUrl(a.kind, a.slug))) as unknown; record(`${a.kind}:${a.slug}`, parseAtsFeed(a.kind, payload, a.slug)); } catch (err) { errs.push(`${a.kind} ${a.slug}: ${(err as Error).message.slice(0, 120)}`); }
    }
    if (this.settings().apollo_jobs && this.apollo.configured && c.apollo_org_id) {
      try { const jobs = await this.apollo.jobPostings(c.apollo_org_id); record('apollo', jobs.map((j) => ({ ext_id: j.id, title: j.title, location: j.location, url: j.url, posted_at: j.posted_at }))); } catch (err) { errs.push(`Apollo jobs: ${(err as Error).message.slice(0, 120)}`); if (err instanceof ApolloCreditsError) throw err; }
    }
    return n;
  }

  private knownBrands(): { name: string; key: string }[] {
    const seen = new Map<string, string>();
    for (const p of this.q.listProspects(true)) { const name = p.brand ?? p.shop_name; const k = brandKey(name); if (k.length >= 3 && !seen.has(k)) seen.set(k, name); }
    for (const l of this.q.listLeads(true)) { const k = brandKey(l.name); if (k.length >= 3 && !seen.has(k)) seen.set(k, l.name); }
    for (const a of this.q.listAccounts()) { const k = brandKey(a.name); if (k.length >= 3 && !seen.has(k)) seen.set(k, a.name); }
    for (const c of this.q.listCompetitorClients()) if (!seen.has(c.brand_key)) seen.set(c.brand_key, c.brand);
    return [...seen.entries()].map(([key, name]) => ({ name, key }));
  }

  private async sweepWebsite(c: Competitor, errs: string[], useLlm?: boolean): Promise<number> {
    const urls = c.watch_urls.length ? c.watch_urls : c.domain ? [`https://${c.domain}`] : [];
    if (!urls.length) { errs.push('Website: nothing to watch (add the client, case study or press pages).'); return 0; }
    const known = this.knownBrands();
    const llm = useLlm === false ? null : this.llm;
    let n = 0;
    for (const url of urls) {
      const now = this.now;
      let text: string;
      try { text = textOfHtml(await this.fetchText(url)); } catch (err) { this.q.addCompetitorSnapshot({ competitor_id: c.id, url, fetched_at: now, hash: '', text: '', error: (err as Error).message.slice(0, 200) }); errs.push(`${url}: ${(err as Error).message.slice(0, 120)}`); continue; }
      const hash = hashText(text);
      const prev = this.q.latestCompetitorSnapshot(c.id, url);
      if (prev && prev.hash === hash) continue;
      this.q.addCompetitorSnapshot({ competitor_id: c.id, url, fetched_at: now, hash, text });
      const lines = prev ? addedLines(prev.text, text) : text.split('\n');
      if (!lines.length) continue;
      let ex: Extracted = extractRules(lines, known);
      if (llm) {
        try { const { system, user } = renderExtractionPrompt(c, url, lines, known.map((k) => k.name)); const parsed = parseExtraction(await llm(system, user)); if (parsed) ex = { clients: [...parsed.clients, ...ex.clients.filter((r) => !parsed.clients.some((p) => brandKey(p.brand) === brandKey(r.brand)))], hires: parsed.hires.length ? parsed.hires : ex.hires, markets: parsed.markets, events: parsed.events.length ? parsed.events : ex.events, press: parsed.press.length ? parsed.press : ex.press }; } catch (err) { errs.push(`Claude on ${url}: ${(err as Error).message.slice(0, 120)}`); }
      }
      const baseline = !prev;
      for (const cl of ex.clients) {
        const key = brandKey(cl.brand);
        if (key.length < 3 || key === brandKey(c.name)) continue;
        const { client, created } = this.q.upsertCompetitorClient({ competitor_id: c.id, brand: cl.brand, brand_key: key, market: cl.market, confidence: 'medium', source: { url, evidence: cl.evidence, at: now }, now });
        if (created && !baseline && this.signal({ competitor_id: c.id, kind: 'new_client', summary: `${client.brand}${client.market ? ` (${client.market})` : ''}`, evidence: cl.evidence, url, dedupe_key: `client:${c.id}:${key}` })) n++;
      }
      if (baseline) continue;
      for (const h of ex.hires) if (this.signal({ competitor_id: c.id, kind: 'joined', summary: `${h.name}${h.title ? `, ${h.title}` : ''} (from their website)`, evidence: h.evidence, url, dedupe_key: `hire:${c.id}:${brandKey(h.name)}` })) n++;
      for (const m of ex.markets) if (this.signal({ competitor_id: c.id, kind: 'market', summary: `${m.market}: ${m.evidence.slice(0, 120)}`, evidence: m.evidence, url, dedupe_key: `market:${c.id}:${m.market}:${hashText(m.evidence).slice(0, 8)}` })) n++;
      for (const e of ex.events) if (this.signal({ competitor_id: c.id, kind: 'event', summary: e.title, evidence: e.evidence, url, dedupe_key: `event:${c.id}:${hashText(e.title).slice(0, 10)}` })) n++;
      for (const p of ex.press) if (this.signal({ competitor_id: c.id, kind: 'press', summary: p.title, evidence: p.evidence, url, dedupe_key: `press:${c.id}:${hashText(p.title).slice(0, 10)}` })) n++;
      if (!ex.clients.length && !ex.hires.length && !ex.markets.length && !ex.events.length && !ex.press.length && lines.length >= 3) {
        if (this.signal({ competitor_id: c.id, kind: 'website', summary: `${lines.length} new line(s) on ${url.replace(/^https?:\/\//, '')}`, evidence: lines.slice(0, 5).join(' · ').slice(0, 400), url, dedupe_key: `web:${c.id}:${hash.slice(0, 12)}` })) n++;
      }
    }
    return n;
  }

  /** Link attributed clients to our prospects and leads; a fresh link is a signal the BD team wants to see. */
  sweepOverlap(c: Competitor): number {
    const idx = overlapIndex(this.q);
    let n = 0;
    for (const cl of this.q.listCompetitorClients(c.id)) {
      if (cl.status !== 'active' || (cl.prospect_id !== null && cl.lead_id !== null)) continue;
      const m = matchOverlap(cl.brand_key, cl.market, idx);
      const patch: Partial<{ prospect_id: number | null; lead_id: number | null }> = {};
      if (cl.prospect_id === null && m.prospect_id !== null) patch.prospect_id = m.prospect_id;
      if (cl.lead_id === null && m.lead_id !== null) patch.lead_id = m.lead_id;
      if (!Object.keys(patch).length) continue;
      this.q.patchCompetitorClient(cl.id, patch);
      const where = [patch.prospect_id !== undefined ? `BD pipeline (${idx.prospects.find((p) => p.id === patch.prospect_id)?.status ?? 'prospect'})` : '', patch.lead_id !== undefined ? `lead list (${idx.leads.find((l) => l.id === patch.lead_id)?.stage ?? 'no stage'})` : ''].filter(Boolean).join(' and ');
      if (this.signal({ competitor_id: c.id, kind: 'overlap', summary: `${cl.brand} is a ${c.name} client and on our ${where}`, evidence: cl.sources[0]?.evidence ?? null, url: cl.sources[0]?.url ?? null, dedupe_key: `overlap:${cl.id}` })) n++;
    }
    return n;
  }

  /** A client added by hand (from a call, an email, a post the team saw). */
  addClient(competitorId: number, i: { brand: string; market?: string | null; evidence?: string | null; url?: string | null; actor?: string | null }): CompetitorClient {
    const c = this.q.getCompetitor(competitorId);
    if (!c) throw new Error('Unknown competitor');
    const key = brandKey(i.brand);
    const { client, created } = this.q.upsertCompetitorClient({ competitor_id: competitorId, brand: i.brand.trim(), brand_key: key, market: i.market ?? null, confidence: 'high', source: { url: i.url ?? null, evidence: i.evidence?.trim() || `Added by ${i.actor ?? 'the team'}`, at: this.now }, now: this.now });
    if (created) this.signal({ competitor_id: competitorId, kind: 'new_client', summary: `${client.brand}${client.market ? ` (${client.market})` : ''} (added by ${i.actor ?? 'the team'})`, evidence: i.evidence ?? null, url: i.url ?? null, dedupe_key: `client:${competitorId}:${key}` });
    this.sweepOverlap(c);
    liveEvents.emitUpdate({ kind: 'competitors' });
    return this.q.listCompetitorClients(competitorId).find((x) => x.id === client.id) ?? client;
  }

  addNote(competitorId: number, i: { text: string; url?: string | null; actor?: string | null }): CompetitorSignal | null {
    const s = this.signal({ competitor_id: competitorId, kind: 'note', summary: i.text.trim().slice(0, 300), evidence: i.actor ? `Noted by ${i.actor}` : null, url: i.url ?? null, dedupe_key: `note:${competitorId}:${hashText(`${i.text}${this.now}`).slice(0, 12)}` });
    liveEvents.emitUpdate({ kind: 'competitors' });
    return s;
  }

  digestText(opts: { sinceDays?: number } = {}): string {
    const until = this.now;
    const since = new Date(new Date(until).getTime() - (opts.sinceDays ?? 7) * 86400000).toISOString();
    return digestText(this.q.listCompetitors(), this.q.listCompetitorSignals({ since, limit: 500 }), { since, until, link: `${config.publicUrl}/competitors`, timezone: this.q.getSetting('check_timezone', 'Europe/Madrid') });
  }

  /** Post the week's movements to the BD channel. Skips a week with nothing new unless forced. */
  async sendDigest(opts: { force?: boolean; sinceDays?: number } = {}): Promise<{ sent: boolean; reason?: string; text: string }> {
    const text = this.digestText({ sinceDays: opts.sinceDays });
    const since = new Date(Date.now() - (opts.sinceDays ?? 7) * 86400000).toISOString();
    const fresh = this.q.listCompetitorSignals({ since, limit: 1 }).length > 0;
    if (!fresh && !opts.force) return { sent: false, reason: 'Nothing new this week.', text };
    const channel = this.settings().channel;
    if (!channel) return { sent: false, reason: 'No Slack channel set for the digest.', text };
    if (!this.slack.configured) return { sent: false, reason: 'Slack bot is not configured.', text };
    await this.slack.post(await this.slack.channelId(channel), text);
    this.q.addCompetitorDigest({ week: this.now.slice(0, 10), sent_at: this.now, channel, text });
    liveEvents.emitUpdate({ kind: 'competitors' });
    return { sent: true, text };
  }
}
