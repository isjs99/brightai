import { apollo as defaultApollo, type ApolloClient, type ApolloPerson } from './apollo.js';
import { normaliseDomain } from './score.js';
import type { Queries } from '../db/queries.js';
import type { BdEnrichStatus, BdProspect } from '../sweep/types.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Decision-maker enrichment for one prospect: resolve the company in Apollo (id + domain),
 * search its people with the broad title list, keep the best-ranked ones as contacts and
 * reveal the top few (one credit each; standing authorisation, no confirmation).
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
}

export async function enrichProspect(q: Queries, prospectId: number, opts: EnrichOptions = {}, apollo: ApolloClient = defaultApollo): Promise<EnrichResult> {
  const p = q.getProspect(prospectId);
  if (!p) throw new Error('Prospect not found');
  const reveal = opts.reveal ?? (Number(q.getSetting('apollo_reveal_per_prospect', '4')) || 4);
  const keep = opts.keep ?? 8;
  let domain = normaliseDomain(opts.domain) ?? p.domain;
  let orgId = p.apollo_org_id;
  let company: string | null = p.brand ?? null;

  // 1. Resolve the company (once): by the domain we know, else by name.
  if (!orgId || (opts.domain && normaliseDomain(opts.domain) !== p.domain)) {
    const org = await apollo.findOrganization(companyQuery(p), { domainHint: domain });
    if (org) {
      orgId = org.id;
      company = org.name;
      domain = domain ?? normaliseDomain(org.domain ?? org.website);
      q.patchProspect(p.id, { apollo_org_id: orgId, ...(domain && !p.domain ? { domain, website: p.website ?? domain } : {}) });
    }
  }

  // 2. People: by organisation when resolved, else by domain, else by name keyword.
  let people: ApolloPerson[] = [];
  if (orgId || domain || companyQuery(p)) {
    people = await apollo.searchPeople({ organizationId: orgId, domain, company: companyQuery(p), market: p.market, limit: 25 });
    if (people.length > 15) {
      // Big company: prefer people based in the market or in Europe, keep the global list as a fallback.
      const local = await apollo.searchPeople({ organizationId: orgId, domain, company: companyQuery(p), market: p.market, limit: 25, locations: [marketCountry(p.market), 'Europe'] });
      if (local.length) people = [...local, ...people.filter((x) => !local.some((l) => l.id === x.id))];
    }
  }
  const chosen = people.slice(0, keep);

  // 3. Reveal the top few in one bulk call.
  const toReveal = chosen.filter((x) => !x.email).slice(0, reveal).map((x) => x.id);
  const revealed = toReveal.length ? await apollo.bulkMatch(toReveal) : new Map<string, ApolloPerson>();
  let revealedCount = 0;
  for (const x of chosen) {
    const full = revealed.get(x.id) ?? x;
    if (revealed.has(x.id) && (full.email || full.linkedin_url)) revealedCount += 1;
    q.addContact(p.id, {
      name: full.name || x.name,
      title: full.title ?? x.title,
      email: full.email,
      linkedin_url: full.linkedin_url,
      phone: full.phone,
      source: 'apollo',
      apollo_id: x.id,
      enriched: Boolean(full.email || full.linkedin_url),
      notes: [full.organization ? `At ${full.organization}` : null, full.email_status ? `email ${full.email_status}` : null, full.city || full.country ? `${[full.city, full.country].filter(Boolean).join(', ')}` : null].filter(Boolean).join(' · ') || null,
    });
  }
  return { matched: Boolean(orgId), company, domain, found: people.length, kept: chosen.length, revealed: revealedCount };
}

export function marketCountry(market: string): string {
  return ({ DE: 'Germany', UK: 'United Kingdom', FR: 'France', IT: 'Italy', ES: 'Spain', NL: 'Netherlands', IE: 'Ireland', BE: 'Belgium', PL: 'Poland', AT: 'Austria', SE: 'Sweden' } as Record<string, string>)[market] ?? market;
}

/** One background run over every prospect without contacts. Only one at a time per process. */
export class EnrichJob {
  private status: BdEnrichStatus = { running: false, total: 0, done: 0, current: null, matched: 0, contacts: 0, revealed: 0, errors: [], started_at: null, finished_at: null };
  private stopRequested = false;

  constructor(private q: Queries, private apollo: ApolloClient = defaultApollo) {}

  get state(): BdEnrichStatus {
    return { ...this.status, errors: this.status.errors.slice(-10) };
  }

  /** Prospects the job will visit: live, not existing clients, not closed, no contacts yet. */
  candidates(): BdProspect[] {
    return this.q.listProspects(false).filter((p) => !p.is_client && p.status !== 'won' && p.status !== 'lost' && p.contacts.length === 0);
  }

  start(opts: { reveal?: number; ids?: number[] } = {}): BdEnrichStatus {
    if (this.status.running) return this.state;
    const targets = opts.ids?.length ? opts.ids.map((id) => this.q.getProspect(id)).filter((p): p is BdProspect => Boolean(p)) : this.candidates();
    this.status = { running: true, total: targets.length, done: 0, current: null, matched: 0, contacts: 0, revealed: 0, errors: [], started_at: new Date().toISOString(), finished_at: null };
    this.stopRequested = false;
    void this.run(targets, opts.reveal);
    return this.state;
  }

  stop(): void {
    this.stopRequested = true;
  }

  private async run(targets: BdProspect[], reveal?: number): Promise<void> {
    log.info(`BD enrichment started for ${targets.length} prospect(s)`);
    for (const p of targets) {
      if (this.stopRequested) break;
      this.status.current = p.shop_name;
      try {
        const r = await enrichProspect(this.q, p.id, { reveal }, this.apollo);
        if (r.matched) this.status.matched += 1;
        this.status.contacts += r.kept;
        this.status.revealed += r.revealed;
      } catch (err) {
        this.status.errors.push(`${p.shop_name}: ${(err as Error).message}`);
        if (/429|rate limit/i.test((err as Error).message)) await new Promise((r) => setTimeout(r, 15000));
      }
      this.status.done += 1;
      liveEvents.emitUpdate({ kind: 'bd' });
      await new Promise((r) => setTimeout(r, 400)); // stay well inside Apollo's per-minute limits
    }
    this.status.running = false;
    this.status.current = null;
    this.status.finished_at = new Date().toISOString();
    log.info(`BD enrichment finished: ${this.status.matched}/${this.status.done} matched, ${this.status.contacts} contacts, ${this.status.revealed} revealed, ${this.status.errors.length} errors`);
    liveEvents.emitUpdate({ kind: 'bd' });
  }
}
