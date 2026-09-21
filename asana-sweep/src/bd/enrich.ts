import { apollo as defaultApollo, isCreditsError, type ApolloClient, type ApolloCredits, type ApolloPerson, type ApolloOrganization, TITLES, SENIORITIES } from './apollo.js';
import { normaliseDomain } from './score.js';
import type { Queries } from '../db/queries.js';
import type { ApolloStatus, BdEnrichStatus, BdProspect } from '../sweep/types.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Decision-maker enrichment for one prospect: resolve the company in Apollo (id + domain +
 * company details), search its people twice (the TikTok / e-commerce / marketing title list, then
 * everyone senior when that is thin), prefer people based in the market, keep the best-ranked
 * ones as contacts and reveal only the two most senior relevant people for a verified work email (one credit each; standing
 * authorisation, no confirmation). When Apollo runs out of credits the job stops and the
 * dashboard says so; nothing retries until the balance is back.
 */

const SUFFIXES = /\b(uk|de|fr|it|es|eu|shop|store|official|oficial|deutschland|germany|france|italia|italy|españa|espana|spain|europe|ltd|srl|s\.r\.l|gmbh|sas|sl|onlineshop|online)\b/gi;

/** The name we ask Apollo about: the brand when set, else the shop name without market/shop suffixes. */
export function companyQuery(p: Pick<BdProspect, 'shop_name' | 'brand'>): string {
  const base = p.brand?.trim() || p.shop_name;
  const cleaned = base.replace(/[_.-]+/g, ' ').replace(SUFFIXES, '').replace(/\s+/g, ' ').trim();
  return cleaned.length >= 3 ? cleaned : base.trim();
}

export interface EnrichOptions {
  /** Override the domain to search (from the UI prompt). */
  domain?: string | null;
  /** How many of the top-ranked people to reveal (credits). */
  reveal?: number;
  /** How many people to keep as contacts (masked ones stay masked until revealed). */
  keep?: number;
}

export interface EnrichResult {
  matched: boolean;
  company: string | null;
  domain: string | null;
  found: number;
  kept: number;
  revealed: number;
  with_email: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Does this person's employer look like the company we asked about (guards the name-only search)? */
export function personAtCompany(p: ApolloPerson, query: string, orgId?: string | null): boolean {
  if (orgId && p.organization_id) return p.organization_id === orgId;
  const org = norm(p.organization ?? '');
  const q = norm(query);
  if (!org || !q) return false;
  const first = q.split(' ').find((w) => w.length >= 3) ?? q;
  return org === q || org.startsWith(q) || q.startsWith(org) || org.split(' ').includes(first);
}

export function revealSetting(q: Queries): number {
  const n = Number(q.getSetting('apollo_reveal_per_prospect', '2'));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 20) : 2;
}

export function keepSetting(q: Queries): number {
  const n = Number(q.getSetting('apollo_keep_per_prospect', '8'));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 30) : 8;
}

export async function enrichProspect(q: Queries, prospectId: number, opts: EnrichOptions = {}, apollo: ApolloClient = defaultApollo): Promise<EnrichResult> {
  const p = q.getProspect(prospectId);
  if (!p) throw new Error('Prospect not found');
  const reveal = opts.reveal ?? revealSetting(q);
  const keep = opts.keep ?? keepSetting(q);
  let domain = normaliseDomain(opts.domain) ?? p.domain;
  let orgId = p.apollo_org_id;
  let company: string | null = p.brand ?? null;
  const query = companyQuery(p);

  // 1. Resolve the company (once): by the domain we know, else by name.
  if (!orgId || (opts.domain && normaliseDomain(opts.domain) !== p.domain)) {
    const org = await apollo.findOrganization(query, { domainHint: domain });
    if (org) {
      orgId = org.id;
      company = org.name;
      domain = domain ?? normaliseDomain(org.domain ?? org.website);
      q.patchProspect(p.id, { apollo_org_id: orgId, ...(domain && !p.domain ? { domain, website: p.website ?? domain } : {}) });
    }
  }
  // 1b. Company details (industry, size, LinkedIn, location) once we have a domain.
  if (domain && !p.company_industry && !p.company_employees) {
    try {
      const org: ApolloOrganization | null = await apollo.enrichOrganization(domain);
      if (org) {
        if (!orgId) { orgId = org.id; q.patchProspect(p.id, { apollo_org_id: org.id }); }
        company = company ?? org.name;
        q.patchProspect(p.id, { company_industry: org.industry ?? null, company_employees: org.employees ?? null, company_linkedin: org.linkedin_url ?? null, company_location: org.location ?? null, company_description: org.description?.slice(0, 600) ?? null });
      }
    } catch (err) {
      if (isCreditsError(err)) throw err;
      log.warn(`Apollo organisation enrich for ${domain}: ${(err as Error).message}`);
    }
  }

  // 2. People. Pass A: the channel / owner title list. Pass B (when thin): anyone senior. Local people first.
  const base = { organizationId: orgId, domain: orgId ? null : domain, company: orgId || domain ? null : query, market: p.market };
  const dedupe = (rows: ApolloPerson[]) => { const seen = new Set<string>(); return rows.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))); };
  let people: ApolloPerson[] = [];
  if (orgId || domain || query) {
    people = await apollo.searchPeople({ ...base, limit: 50 });
    if (people.length < 8) people = dedupe([...people, ...(await apollo.searchPeople({ ...base, limit: 50, titles: null, seniorities: SENIORITIES.filter((s) => s !== 'manager') }))]);
    if (people.length > 12) {
      const local = await apollo.searchPeople({ ...base, limit: 50, locations: [marketCountry(p.market), 'Europe'] });
      if (local.length) people = dedupe([...local, ...people]);
    }
    // Name-only searches can return the wrong company; keep only people whose employer matches.
    if (!orgId && !domain) people = people.filter((x) => personAtCompany(x, query));
  }
  // Rank: the ranking is inside searchPeople per call; re-rank the merged list so pass A titles still win.
  const rankOf = (x: ApolloPerson) => { const t = (x.title ?? '').toLowerCase(); return TITLES.some((w) => t.includes(w)) ? 1 : 0; };
  people.sort((a, b) => rankOf(b) - rankOf(a));
  const existing = new Set(p.contacts.map((c) => c.apollo_id).filter(Boolean));
  const chosen = dedupe([...people.filter((x) => existing.has(x.id)), ...people.filter((x) => !existing.has(x.id))]).slice(0, Math.max(keep, existing.size));

  // 3. Reveal the top few (those without an email yet) in one bulk call; verified emails first in the ranking.
  const needReveal = chosen.filter((x) => !x.email && !p.contacts.some((c) => c.apollo_id === x.id && c.email)).slice(0, reveal).map((x) => x.id);
  const revealed = needReveal.length ? await apollo.bulkMatch(needReveal) : new Map<string, ApolloPerson>();
  let revealedCount = 0;
  let withEmail = 0;
  for (const x of chosen) {
    const full = revealed.get(x.id) ?? x;
    const prior = p.contacts.find((c) => c.apollo_id === x.id);
    const email = full.email ?? prior?.email ?? null;
    if (revealed.has(x.id) && (full.email || full.linkedin_url)) revealedCount += 1;
    if (email) withEmail += 1;
    q.addContact(p.id, {
      name: full.name || x.name,
      title: full.title ?? x.title,
      email,
      linkedin_url: full.linkedin_url ?? prior?.linkedin_url ?? null,
      phone: full.phone ?? prior?.phone ?? null,
      source: 'apollo',
      apollo_id: x.id,
      enriched: Boolean(email || full.linkedin_url || prior?.linkedin_url),
      notes: [full.organization ? `At ${full.organization}` : null, full.email_status ? `email ${full.email_status}` : null, full.seniority ? full.seniority : null, full.city || full.country ? `${[full.city, full.country].filter(Boolean).join(', ')}` : null].filter(Boolean).join(' · ') || null,
    });
  }
  q.patchProspect(p.id, { enriched_at: new Date().toISOString(), enrich_note: `${people.length} found, ${chosen.length} kept, ${revealedCount} revealed, ${withEmail} with email${orgId ? '' : ' (company not matched)'}` });
  return { matched: Boolean(orgId), company, domain, found: people.length, kept: chosen.length, revealed: revealedCount, with_email: withEmail };
}

export function marketCountry(market: string): string {
  return ({ DE: 'Germany', UK: 'United Kingdom', FR: 'France', IT: 'Italy', ES: 'Spain', NL: 'Netherlands', IE: 'Ireland', BE: 'Belgium', PL: 'Poland', AT: 'Austria', SE: 'Sweden' } as Record<string, string>)[market] ?? market;
}

const CREDITS_KEY = 'apollo_credits_json';
const EXHAUSTED_KEY = 'apollo_credits_exhausted_at';

/** Cached Apollo status for the dashboard (the balance is refreshed by the scheduler and after every run). */
export function apolloStatus(q: Queries, client: ApolloClient = defaultApollo): ApolloStatus {
  let cached: (ApolloCredits & { checked_at: string; error?: string | null }) | null = null;
  try { cached = JSON.parse(q.getSetting(CREDITS_KEY, '') || 'null'); } catch { cached = null; }
  const exhaustedAt = q.getSetting(EXHAUSTED_KEY, '') || null;
  return {
    configured: client.configured,
    ok: Boolean(cached && !cached.error),
    error: cached?.error ?? (client.configured ? null : 'APOLLO_API_KEY is not set'),
    remaining: cached && !cached.error ? cached.remaining : null,
    limit: cached && !cached.error ? cached.limit : null,
    used: cached && !cached.error ? cached.used : null,
    cycle_end: cached?.cycle_end ?? null,
    checked_at: cached?.checked_at ?? null,
    exhausted: Boolean(exhaustedAt) || Boolean(cached && !cached.error && cached.remaining <= 0),
    exhausted_at: exhaustedAt,
    reveal_per_prospect: revealSetting(q),
    keep_per_prospect: keepSetting(q),
  };
}

/** Ask Apollo for the balance and cache it; clears the exhausted flag once credits are back. */
export async function refreshApolloCredits(q: Queries, client: ApolloClient = defaultApollo): Promise<ApolloStatus> {
  if (!client.configured) return apolloStatus(q, client);
  try {
    const c = await client.credits();
    q.setSetting(CREDITS_KEY, JSON.stringify({ ...c, checked_at: new Date().toISOString(), error: null }));
    if (c.remaining > 0 && q.getSetting(EXHAUSTED_KEY, '')) { q.setSetting(EXHAUSTED_KEY, ''); log.info('Apollo credits are back; enrichment resumes'); }
    if (c.remaining <= 0 && !q.getSetting(EXHAUSTED_KEY, '')) q.setSetting(EXHAUSTED_KEY, new Date().toISOString());
  } catch (err) {
    q.setSetting(CREDITS_KEY, JSON.stringify({ remaining: 0, limit: 0, used: 0, cycle_start: null, cycle_end: null, source: 'profile', checked_at: new Date().toISOString(), error: (err as Error).message }));
    if (isCreditsError(err)) q.setSetting(EXHAUSTED_KEY, q.getSetting(EXHAUSTED_KEY, '') || new Date().toISOString());
  }
  liveEvents.emitUpdate({ kind: 'bd' });
  return apolloStatus(q, client);
}

export function markApolloExhausted(q: Queries): void {
  if (!q.getSetting(EXHAUSTED_KEY, '')) q.setSetting(EXHAUSTED_KEY, new Date().toISOString());
}

/** One background run over prospects that still need Apollo. Only one at a time per process. */
export class EnrichJob {
  private status: BdEnrichStatus = { running: false, total: 0, done: 0, current: null, matched: 0, contacts: 0, revealed: 0, errors: [], started_at: null, finished_at: null, mode: 'new', stopped_reason: null };
  private stopRequested = false;

  constructor(private q: Queries, private apollo: ApolloClient = defaultApollo) {}

  get state(): BdEnrichStatus {
    return { ...this.status, errors: this.status.errors.slice(-10) };
  }

  /**
   * Prospects the job will visit. new: no contacts yet. no_email: has contacts but nobody with an email
   * and the last pass is older than 14 days (or never ran with the deeper search). all: both.
   */
  candidates(mode: BdEnrichStatus['mode'] = 'new'): BdProspect[] {
    const cut = new Date(Date.now() - 14 * 86400000).toISOString();
    return this.q.listProspects(false).filter((p) => {
      if (p.is_client || p.status === 'won' || p.status === 'lost') return false;
      const fresh = p.contacts.length === 0;
      const noEmail = p.contacts.length > 0 && !p.contacts.some((c) => c.email) && (!p.enriched_at || p.enriched_at < cut);
      return mode === 'new' ? fresh : mode === 'no_email' ? noEmail : fresh || noEmail;
    });
  }

  start(opts: { reveal?: number; ids?: number[]; mode?: BdEnrichStatus['mode'] } = {}): BdEnrichStatus {
    if (this.status.running) return this.state;
    if (apolloStatus(this.q, this.apollo).exhausted) {
      this.status = { ...this.status, running: false, stopped_reason: 'credits', finished_at: new Date().toISOString() };
      return this.state;
    }
    const mode = opts.mode ?? 'new';
    const targets = opts.ids?.length ? opts.ids.map((id) => this.q.getProspect(id)).filter((p): p is BdProspect => Boolean(p)) : this.candidates(mode);
    this.status = { running: true, total: targets.length, done: 0, current: null, matched: 0, contacts: 0, revealed: 0, errors: [], started_at: new Date().toISOString(), finished_at: null, mode, stopped_reason: null };
    this.stopRequested = false;
    void this.run(targets, opts.reveal);
    return this.state;
  }

  stop(): void {
    this.stopRequested = true;
  }

  private async run(targets: BdProspect[], reveal?: number): Promise<void> {
    log.info(`BD enrichment started for ${targets.length} prospect(s) (${this.status.mode})`);
    for (const p of targets) {
      if (this.stopRequested) { this.status.stopped_reason = 'stopped'; break; }
      this.status.current = p.shop_name;
      try {
        const r = await enrichProspect(this.q, p.id, { reveal }, this.apollo);
        if (r.matched) this.status.matched += 1;
        this.status.contacts += r.kept;
        this.status.revealed += r.revealed;
      } catch (err) {
        this.status.errors.push(`${p.shop_name}: ${(err as Error).message}`);
        if (isCreditsError(err)) {
          markApolloExhausted(this.q);
          this.status.stopped_reason = 'credits';
          log.warn('Apollo credits exhausted; enrichment paused until the balance is back');
          break;
        }
        if (/429|rate limit/i.test((err as Error).message)) await new Promise((r) => setTimeout(r, 15000));
      }
      this.status.done += 1;
      liveEvents.emitUpdate({ kind: 'bd' });
      await new Promise((r) => setTimeout(r, 400)); // stay well inside Apollo's per-minute limits
    }
    this.status.running = false;
    this.status.current = null;
    this.status.finished_at = new Date().toISOString();
    log.info(`BD enrichment finished: ${this.status.matched}/${this.status.done} matched, ${this.status.contacts} contacts, ${this.status.revealed} revealed, ${this.status.errors.length} errors${this.status.stopped_reason ? ` (${this.status.stopped_reason})` : ''}`);
    await refreshApolloCredits(this.q, this.apollo);
    liveEvents.emitUpdate({ kind: 'bd' });
  }
}
