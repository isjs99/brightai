import { config } from '../config.js';

/**
 * Thin Apollo.io REST client (api.apollo.io). People search is free; people match (email reveal)
 * costs one credit per hit, so the route that calls it asks for confirmation first.
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
}

const SENIORITIES = ['founder', 'owner', 'c_suite', 'partner', 'vp', 'head', 'director'];
const TITLES = ['founder', 'ceo', 'managing director', 'ecommerce', 'e-commerce', 'marketing', 'growth', 'tiktok', 'social', 'brand', 'sales', 'commercial'];

export class ApolloClient {
  constructor(private apiKey = config.apolloApiKey, private baseUrl = 'https://api.apollo.io/api/v1') {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) throw new Error('APOLLO_API_KEY is not set. Add it to .env and restart to search Apollo from the dashboard.');
    const res = await fetch(`${this.baseUrl}${path}`, {
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

  private static toPerson(p: Record<string, unknown>): ApolloPerson {
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
    };
  }

  /** Decision makers at a company, by domain when known, else by name keyword. No credits. */
  async searchPeople(opts: { domain?: string | null; company?: string | null; limit?: number }): Promise<ApolloPerson[]> {
    const body: Record<string, unknown> = { per_page: opts.limit ?? 10, page: 1, person_seniorities: SENIORITIES, person_titles: TITLES, include_similar_titles: true };
    if (opts.domain) body.q_organization_domains_list = [opts.domain];
    else if (opts.company) body.q_keywords = opts.company;
    else throw new Error('Need a domain or company name to search.');
    const data = await this.post<{ people?: Record<string, unknown>[]; contacts?: Record<string, unknown>[] }>('/mixed_people/api_search', body);
    const rows = [...(data.people ?? []), ...(data.contacts ?? [])];
    return rows.map(ApolloClient.toPerson).filter((p) => p.name);
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
}

export const apollo = new ApolloClient();
