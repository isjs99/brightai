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
  organization_id?: string | null;
  seniority?: string | null;
}

export interface ApolloOrganization {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry?: string | null;
  employees?: number | null;
  linkedin_url?: string | null;
  location?: string | null;
  description?: string | null;
  founded_year?: number | null;
}

/** Remaining credits on the Apollo plan, from the API profile (per user) or the team usage stats. */
export interface ApolloCredits {
  remaining: number;
  limit: number;
  used: number;
  cycle_start: string | null;
  cycle_end: string | null;
  source: 'profile' | 'usage_stats';
}

/** Thrown when Apollo refuses a call for lack of credits, so jobs stop instead of burning through errors. */
export class ApolloCreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApolloCreditsError';
  }
}

export const isCreditsError = (err: unknown): boolean => err instanceof ApolloCreditsError || /insufficient credits|enough credits|out of credits|credit limit|no credits|credits? (remaining|left|exhausted)/i.test((err as Error)?.message ?? '');

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

  private async request<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, query?: Record<string, string>): Promise<T> {
    if (!this.apiKey) throw new Error('APOLLO_API_KEY is not set. Add it to .env and restart to search Apollo from the dashboard.');
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await this.fetchFn(url, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': this.apiKey, 'cache-control': 'no-cache' },
      body: body === undefined ? undefined : JSON.stringify(body),
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
      const full = `Apollo ${res.status}: ${msg || res.statusText}`;
      if (res.status === 402 || /insufficient credits|enough credits|out of credits|credit limit|no credits|credits? (remaining|left|exhausted)/i.test(full)) throw new ApolloCreditsError(full);
      throw new Error(full);
    }
    return data as T;
  }

  private post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  /** Does the key work at all? (auth/health is free.) */
  async health(): Promise<boolean> {
    const d = await this.get<{ is_logged_in?: boolean }>('/auth/health');
    return Boolean(d.is_logged_in);
  }

  /** Credits left this cycle. The API profile carries the user's balance; the team usage stats are the fallback. Both are free calls. */
  async credits(): Promise<ApolloCredits> {
    try {
      const p = await this.get<Record<string, unknown>>('/users/api_profile', { include_credit_usage: 'true' });
      const remaining = Number(p.num_credits_remaining);
      const limit = Number(p.effective_num_lead_credits ?? p.num_lead_credits_limit);
      if (Number.isFinite(remaining)) return { remaining, limit: Number.isFinite(limit) ? limit : remaining, used: Number.isFinite(limit) ? Math.max(0, limit - remaining) : Number(p.num_lead_credits_used ?? 0) || 0, cycle_start: null, cycle_end: null, source: 'profile' };
    } catch (err) {
      if (err instanceof ApolloCreditsError) throw err;
    }
    const u = await this.get<{ credit_usage_stats?: { lead_credit?: { limit?: number; consumed?: number; left_over?: number } }; current_credit_cycle?: { start_date?: string; end_date?: string } }>('/usage_stats/credit_usage_stats');
    const lc = u.credit_usage_stats?.lead_credit;
    if (!lc) throw new Error('Apollo did not return credit usage (check the key has API access).');
    return { remaining: Number(lc.left_over ?? 0), limit: Number(lc.limit ?? 0), used: Number(lc.consumed ?? 0), cycle_start: u.current_credit_cycle?.start_date ?? null, cycle_end: u.current_credit_cycle?.end_date ?? null, source: 'usage_stats' };
  }

  /** Company details by domain (industry, size, LinkedIn, location). Free on API plans. */
  async enrichOrganization(domain: string): Promise<ApolloOrganization | null> {
    const d = await this.get<{ organization?: Record<string, unknown> | null }>('/organizations/enrich', { domain });
    const o = d.organization;
    if (!o || !o.id) return null;
    return {
      id: String(o.id), name: String(o.name ?? ''), domain: (o.primary_domain as string | null) ?? domain, website: (o.website_url as string | null) ?? null,
      industry: (o.industry as string | null) ?? null, employees: o.estimated_num_employees ? Number(o.estimated_num_employees) : null, linkedin_url: (o.linkedin_url as string | null) ?? null,
      location: [o.city, o.country].filter(Boolean).join(', ') || null, description: (o.short_description as string | null) ?? null, founded_year: o.founded_year ? Number(o.founded_year) : null,
    };
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
      organization_id: (org?.id as string | null) ?? (p.organization_id as string | null) ?? null,
      seniority: (p.seniority as string | null) ?? null,
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
  async searchPeople(opts: { organizationId?: string | null; domain?: string | null; company?: string | null; market?: string | null; limit?: number; locations?: string[]; titles?: string[] | null; seniorities?: string[]; page?: number }): Promise<ApolloPerson[]> {
    const body: Record<string, unknown> = { per_page: Math.min(opts.limit ?? 25, 100), page: opts.page ?? 1, person_seniorities: opts.seniorities ?? SENIORITIES };
    if (opts.titles !== null) { body.person_titles = opts.titles ?? TITLES; body.include_similar_titles = true; }
    if (opts.organizationId) body.organization_ids = [opts.organizationId];
    else if (opts.domain) body.q_organization_domains_list = [opts.domain];
    else if (opts.company) body.q_organization_name = opts.company;
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
