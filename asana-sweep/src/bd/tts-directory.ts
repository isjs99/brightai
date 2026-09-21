import type { Queries } from '../db/queries.js';
import type { GmailClient } from './gmail.js';
import { log } from '../logger.js';

/**
 * Build the TikTok Shop contact directory from Gmail: every human sender at tiktok.com / bytedance.com,
 * with the role line from their signature, the Lark link when they include one, and the market and
 * category guessed from the signature and subject. Existing rows are only filled in, never overwritten.
 */

export interface MinedContact { name: string; email: string; role: string | null; lark: string | null; market: string | null; category: string | null; is_agency_manager: boolean; evidence: string }

const MARKET_HINTS: [RegExp, string][] = [
  [/\b(germany|german|dach|deutschland|munich|münchen|berlin|hamburg)\b/i, 'DE'],
  [/\b(spain|spanish|españa|espana|madrid|barcelona|iberia)\b/i, 'ES'],
  [/\b(italy|italia|italian|milan|milano|rome|roma)\b/i, 'IT'],
  [/\b(france|french|paris)\b/i, 'FR'],
  [/\b(united kingdom|\buk\b|britain|british|london|manchester)\b/i, 'UK'],
  [/\b(benelux|netherlands|dutch|amsterdam|belgium)\b/i, 'NL'],
];
const CATEGORY_HINTS: [RegExp, string][] = [
  [/\bbeauty\b|cosmetic|skincare/i, 'Beauty'],
  [/\bhealth\b|supplement|wellness|pharma/i, 'Health'],
  [/fmcg|food|beverage|grocery|drink/i, 'Food & Beverages'],
  [/fashion|apparel|clothing|footwear/i, 'Fashion'],
  [/electronic|consumer tech|3c\b/i, 'Electronics'],
  [/home|furniture|kitchen|appliance/i, 'Home'],
  [/toy|baby|kids/i, 'Toys & Baby'],
  [/sport|outdoor|fitness/i, 'Sports & Outdoor'],
];
const ROLE_RE = /(manager|lead|director|head|partnership|partner|specialist|executive|associate|coordinator|analyst|e-?commerce|category|account|matchmaking|tsp|key account|business development|strategist|consultant)/i;
const NOISE_RE = /^(tel|phone|mobile|m:|t:|e:|email|linkedin|click here|book a meeting|www\.|https?:|tiktok\b|bytedance|\+\d)/i;
/** A company line ("TikTok - Munich") is noise, but "TikTok Global E-Commerce Partnership Development" is a role. */
const isNoise = (x: string): boolean => NOISE_RE.test(x) && !/(partnership|manager|lead\b|director|head\b|development|category|account)/i.test(x.replace(/^tiktok\s*(shop)?/i, ''));

export function parseSignature(name: string, body: string): { role: string | null; lark: string | null; marketHint: string | null; categoryHint: string | null } {
  const text = body.replace(/\r/g, '');
  const lark = text.match(/https?:\/\/[^\s<>)"']*(?:larkoffice|larksuite|feishu)[^\s<>)"']*/i)?.[0]?.replace(/&amp;/g, '&') ?? null;
  const lines = text.split('\n').map((l) => l.replace(/\*/g, '').replace(/^[>\s_]+|[\s_]+$/g, '').trim());
  const first = name.split(' ')[0]?.toLowerCase() ?? '';
  const last = name.split(' ').slice(-1)[0]?.toLowerCase() ?? '';
  let role: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l || l.length > 100 || !l.toLowerCase().includes(last) || !l.toLowerCase().includes(first)) continue;
    // The signature block: the name line, possibly with "| Role" on it, then the next few lines.
    const same = l.split(/\s*[|,]\s*/).slice(1).find((x) => ROLE_RE.test(x) && !isNoise(x));
    if (same) { role = same.trim(); break; }
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      const n = lines[j];
      if (!n) continue;
      if (isNoise(n) || n.includes('@')) continue;
      if (n.length <= 80 && ROLE_RE.test(n)) { role = n.replace(/\s+/g, ' ').trim(); break; }
    }
    if (role) break;
  }
  const around = role ? `${role} ${lines.slice(0, 60).join(' ')}` : lines.slice(-25).join(' ');
  const marketHint = MARKET_HINTS.find(([re]) => re.test(role ?? ''))?.[1] ?? MARKET_HINTS.find(([re]) => re.test(around))?.[1] ?? null;
  const categoryHint = CATEGORY_HINTS.find(([re]) => re.test(role ?? ''))?.[1] ?? null;
  return { role, lark, marketHint, categoryHint };
}

export function guessMarketFromSubject(subject: string): string | null {
  return MARKET_HINTS.find(([re]) => re.test(subject))?.[1] ?? null;
}

export async function mineTiktokContacts(q: Queries, gmail: GmailClient, opts: { days?: number; max?: number } = {}): Promise<{ found: number; added: number; updated: number; contacts: MinedContact[] }> {
  if (!gmail.connected) throw new Error('Connect Gmail first (Outreach emails > Settings).');
  const msgs = await gmail.searchMessages(`(from:tiktok.com OR from:bytedance.com) -from:no-reply -from:noreply -from:sellersupport -from:partner@email.tiktok.com -from:register newer_than:${opts.days ?? 540}d`, opts.max ?? 150);
  const byEmail = new Map<string, MinedContact & { subjects: string[] }>();
  for (const m of msgs) {
    const email = (m.from_email ?? '').toLowerCase();
    if (!email || !/@(tiktok|bytedance)\./.test(email)) continue;
    const name = (m.from_name ?? '').replace(/["']/g, '').trim() || email.split('@')[0].split('.').map((x) => x[0]?.toUpperCase() + x.slice(1)).join(' ');
    const sig = parseSignature(name, m.body);
    const cur = byEmail.get(email) ?? { name, email, role: null, lark: null, market: null, category: null, is_agency_manager: false, evidence: '', subjects: [] };
    cur.role = cur.role ?? sig.role;
    cur.lark = cur.lark ?? sig.lark;
    cur.market = cur.market ?? sig.marketHint ?? guessMarketFromSubject(m.subject);
    cur.category = cur.category ?? sig.categoryHint;
    cur.subjects.push(m.subject);
    if (cur.name.split(' ').length < name.split(' ').length) cur.name = name;
    byEmail.set(email, cur);
  }
  const contacts: MinedContact[] = [];
  let added = 0;
  let updated = 0;
  const existing = q.listTtsContacts();
  for (const c of byEmail.values()) {
    c.is_agency_manager = /partnership|partner development|matchmaking|\bTSP\b|agency/i.test(c.role ?? '') || c.subjects.some((s) => /matchmaking|brightform x tiktok/i.test(s));
    c.evidence = c.subjects.slice(0, 3).join(' · ');
    const market = c.market ?? 'DE';
    const prior = existing.find((e) => (e.email ?? '').toLowerCase() === c.email && e.market === market) ?? existing.find((e) => (e.email ?? '').toLowerCase() === c.email);
    if (prior) {
      const patch = { ...prior, role: prior.role ?? c.role, lark: prior.lark ?? c.lark, category: prior.category ?? c.category, notes: prior.notes ?? (c.evidence ? `Seen in: ${c.evidence}` : null), is_agency_manager: prior.is_agency_manager || c.is_agency_manager };
      if (patch.role !== prior.role || patch.lark !== prior.lark || patch.category !== prior.category || patch.is_agency_manager !== prior.is_agency_manager) { q.saveTtsContact(patch); updated += 1; }
    } else {
      q.saveTtsContact({ market, category: c.category, name: c.name, role: c.role, lark: c.lark, email: c.email, notes: c.evidence ? `From Gmail. Seen in: ${c.evidence}` : 'From Gmail', is_agency_manager: c.is_agency_manager });
      added += 1;
    }
    contacts.push(c);
  }
  log.info(`TikTok contacts from Gmail: ${contacts.length} people, ${added} added, ${updated} updated`);
  return { found: contacts.length, added, updated, contacts };
}
