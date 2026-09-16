import { config } from '../config.js';

/**
 * Apollo.io REST client (api.apollo.io). Company lookup and people search are free (organisation
 * search may cost one credit when it returns a hit); people match / bulk match costs one credit
 * per person found. Isaac has given standing authorisation to spend credits, so nothing here
 * asks first.
 */
export interface ApolloPerson {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  phone: string | null;
  organization: string | null;
  email_status: string | null;
  city: string | null;
  country: string | null;
}

export interface ApolloOrganization {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
}

export const SENIORITIES = ['founder', 'owner', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager'];
export const TITLES = ['founder', 'ceo', 'managing director', 'country manager', 'general manager', 'ecommerce', 'e-commerce', 'marketplace', 'tiktok', 'social commerce', 'marketing', 'growth', 'brand', 'sales', 'commercial', 'partnerships', 'affiliate', 'influencer', 'europe'];

const MARKET_WORDS: Record<string, string[]> = {
  DE: ['germany', 'german', 'dach', 'deutschland', 'de '],
  UK: ['uk', 'united kingdom', 'britain', 'british', 'ireland'],
  FR: ['france', 'french', 'français', 'francais'],
  IT: ['italy', 'italia', 'italian'],
  ES: ['spain', 'españa', 'espana', 'spanish', 'iberia'],
  NL: ['netherlands', 'benelux', 'dutch'],
};

/** Score a title for "who signs off a TikTok Shop agency": channel leads first, then owners, then marketing. */
export function titleScore(title: string | null | undefined, market?: string | null): number {
  const t = (title ?? '').toLowerCase();
  if (!t) return 0;
  let s = 0;
  if (/tiktok|social commerce|live commerce|live shopping/.test(t)) s += 60;
  if (/e-?commerce|marketplace|digital commerce|online sales|omnichannel|d2c|dtc/.test(t)) s += 45;
  if (/founder|co-founder|owner|ceo|chief executive|managing director|geschäftsführer|gérant|directeur général|amministratore|titolare|gerente|president/.test(t)) s += 40;
  if (/growth|performance|digital marketing/.test(t)) s += 28;
  if (/marketing|brand|partnership|influencer|affiliate|creator|social media/.test(t)) s += 22;
  if (/sales|commercial|business development|country manager|general manager|gm\b/.test(t)) s += 18;
  if (/head|director|vp|vice president|chief|lead\b|leader/.test(t)) s += 10;
  if (/manager/.test(t)) s += 4;
  if (/europe|emea|international|global/.test(t)) s += 8;
  if (market && (MARKET_WORDS[market] ?? []).some((w) => t.includes(w))) s += 20;
  if (/intern|assistant|junior|trainee|student|apprentice|coordinator|specialist|executive assistant/.test(t)) s -= 35;
  if (/engineer|developer|finance|accounting|hr\b|human resources|legal|logistics|warehouse|supply chain|customer service|support|recruit|it\b|data|analyst|designer|content creator|copywriter|photographer/.test(t)) s -= 30;
  return s;
}

/** Order people by how likely they are to own the TikTok Shop decision for this market. */
export function rankPeople(people: ApolloPerson[], market?: string | null): ApolloPerson[] {
  const countryOf: Record<string, string[]> = { DE: ['germany'], UK: ['united kingdom'], FR: ['france'], IT: ['italy'], ES: ['spain'], NL: ['netherlands'] };
  const wanted = market ? countryOf[market] ?? [] : [];
  const score = (p: ApolloPerson) => titleScore(p.title, market) + (p.country && wanted.includes(p.country.toLowerCase()) ? 15 : 0) + (p.email ? 3 : 0);
  return [...people].sort((a, b) => score(b) - score(a));
}

/** Loose name match to pick the right company out of a lookup ("Halara DE" ~ "Halara"). */
export function organizationMatches(query: string, candidate: { name: string; domain: string | null }): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const q = norm(query);
  const n = norm(candidate.name);
  if (!q || !n) return false;
  const qWords = q.split(' ').filter((w) => w.length > 2);
  const first = qWords[0] ?? q;
  return n === q || n.startsWith(q) || q.startsWith(n) || (first.length >= 4 && (n.split(' ').includes(first) || (candidate.domain ?? '').replace(/[^a-z0-9]/g, '').includes(first)));
}

export class ApolloClient {
  constructor(private apiKey = config.apolloApiKey, private baseUrl = 'https://api.apollo.io/api/v1', private fetchFn: typeof fetch = fetch) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) throw new Error('APOLLO_API_KEY is not set. Add it to .env and restart to search Apollo from the dashboard.');
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': this.apiKey, 'cache-control': 'no-cache' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = (data as { error?: string; message?: string } | null)?.error ?? (data as { message?: string } | null)?.message ?? text.slice(0, 200);
      throw new Error(`Apollo ${res.status}: ${msg || res.statusText}`);
    }
    return data as T;
  }

  static toPerson(p: Record<string, unknown>): ApolloPerson {
    const org = (p.organization as Record<string, unknown> | undefined) ?? undefined;
    const first = String(p.first_name ?? '').trim();
    const last = String(p.last_name ?? p.last_name_obfuscated ?? '').trim();
    const phone = (p.phone_numbers as { sanitized_number?: string }[] | undefined)?.[0]?.sanitized_number ?? null;
    return {
      id: String(p.id),
      name: String(p.name ?? `${first} ${last}`).trim(),
      title: (p.title as string | null) ?? null,
      email: (p.email as string | null) ?? null,
      linkedin_url: (p.linkedin_url as string | null) ?? null,
      phone,
      organization: (org?.name as string | null) ?? (p.organization_name as string | null) ?? null,
      email_status: (p.email_status as string | null) ?? null,
      city: (p.city as string | null) ?? null,
      country: (p.country as string | null) ?? null,
    };
  }

  /** Resolve a shop or brand name to the Apollo organisation (id + domain). */
  async findOrganization(name: string, opts: { domainHint?: string | null } = {}): Promise<ApolloOrganization | null> {
    const body: Record<string, unknown> = { per_page: 5, page: 1 };
    if (opts.domainHint) body.q_organization_domains_list = [opts.domainHint];
    else body.q_organization_name = name;
    const data = await this.post<{ organizations?: Record<string, unknown>[]; accounts?: Record<string, unknown>[] }>('/mixed_companies/search', body);
    const rows: ApolloOrganization[] = [
      ...(data.organizations ?? []).map((o) => ({ id: String(o.id), name: String(o.name ?? ''), domain: (o.primary_domain as string | null) ?? null, website: (o.website_url as string | null) ?? null })),
      ...(data.accounts ?? []).map((o) => ({ id: String(o.organization_id ?? o.id), name: String(o.name ?? ''), domain: (o.domain as string | null) ?? null, website: (o.website_url as string | null) ?? null })),
    ].filter((o) => o.id && o.name);
    if (opts.domainHint) return rows[0] ?? null;
    return rows.find((o) => organizationMatches(name, o)) ?? null;
  }

  /** Decision makers at a company: by organisation id when known, else domain, else name keyword. No credits. */
  async searchPeople(opts: { organizationId?: string | null; domain?: string | null; company?: string | null; market?: string | null; limit?: number; locations?: string[] }): Promise<ApolloPerson[]> {
    const body: Record<string, unknown> = { per_page: Math.min(opts.limit ?? 25, 100), page: 1, person_seniorities: SENIORITIES, person_titles: TITLES, include_similar_titles: true };
    if (opts.organizationId) body.organization_ids = [opts.organizationId];
    else if (opts.domain) body.q_organization_domains_list = [opts.domain];
    else if (opts.company) body.q_keywords = opts.company;
    else throw new Error('Need an organisation, domain or company name to search.');
    if (opts.locations?.length) body.person_locations = opts.locations;
    const data = await this.post<{ people?: Record<string, unknown>[]; contacts?: Record<string, unknown>[] }>('/mixed_people/api_search', body);
    const rows = [...(data.people ?? []), ...(data.contacts ?? [])].map(ApolloClient.toPerson).filter((p) => p.name);
    const seen = new Set<string>();
    return rankPeople(rows.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))), opts.market);
  }

  /** Enrich one person to get their work email and LinkedIn. One credit when found. */
  async matchPerson(opts: { id?: string | null; name?: string | null; domain?: string | null; company?: string | null }): Promise<ApolloPerson | null> {
    const body: Record<string, unknown> = { reveal_personal_emails: false };
    if (opts.id) body.id = opts.id;
    if (opts.name) body.name = opts.name;
    if (opts.domain) body.domain = opts.domain;
    if (opts.company) body.organization_name = opts.company;
    const data = await this.post<{ person?: Record<string, unknown> | null }>('/people/match', body);
    return data.person ? ApolloClient.toPerson(data.person) : null;
  }

  /** Enrich up to 10 people per call by Apollo id. One credit per person found. Returns a map id -> person. */
  async bulkMatch(ids: string[]): Promise<Map<string, ApolloPerson>> {
    const out = new Map<string, ApolloPerson>();
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const data = await this.post<{ matches?: (Record<string, unknown> | null)[] }>('/people/bulk_match', { details: chunk.map((id) => ({ id })), reveal_personal_emails: false });
      (data.matches ?? []).forEach((m, idx) => {
        if (m && m.id) out.set(String(m.id), ApolloClient.toPerson(m));
        else if (m && chunk[idx]) out.set(chunk[idx], ApolloClient.toPerson({ ...m, id: chunk[idx] }));
      });
    }
    return out;
  }
}

export const apollo = new ApolloClient();
