import type { AirtableRecordRow, AirtableTableRow, BdProspect, Lead } from '../sweep/types.js';

/**
 * Ties Sofía's Airtable records to our BD prospects and Leads without ever creating rows from them: the
 * pipeline stays FastMoss/manual, her base stays hers, and the overlap is shown as a label. A record and a
 * local row are the same company when they share a web domain (hers from Accounts, Website Enquiries,
 * Apollo Intake and contact emails; ours from the prospect's site and its decision makers' emails), or
 * the same brand name once legal suffixes, markets and shop words are stripped. A looser name match
 * (one name inside the other) is kept for a human to confirm or dismiss.
 */

export interface CrmRef { table: string; table_id: string; record_id: string; primary: string | null; fields: Record<string, unknown>; modified_at: string | null }
export interface CrmMatch { ref: CrmRef; confidence: number; how: string }

const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.de', 'hotmail.fr', 'hotmail.es', 'hotmail.it', 'hotmail.co.uk', 'live.com', 'yahoo.com', 'yahoo.de', 'yahoo.fr', 'yahoo.es', 'yahoo.co.uk', 'icloud.com', 'me.com', 'web.de', 'gmx.de', 'gmx.net', 'gmx.com', 't-online.de', 'orange.fr', 'free.fr', 'wanadoo.fr', 'libero.it', 'protonmail.com', 'proton.me', 'aol.com', 'mail.com', 'tiktok.com', 'airtable.com', 'fastmoss.com', 'linkedin.com', 'apollo.io']);
const LEGAL = new Set(['gmbh', 'ag', 'ug', 'kg', 'ohg', 'ltd', 'limited', 'llc', 'inc', 'co', 'corp', 'plc', 'sl', 'sa', 'sas', 'sarl', 'srl', 'spa', 'bv', 'nv', 'oy', 'ab', 'aps', 'as', 'group', 'holding', 'the', 'and', 'und', 'et', 'y', 'e']);
const SHOPWORDS = new Set(['official', 'store', 'shop', 'tiktok', 'tiktokshop', 'online', 'onlineshop', 'eu', 'europe', 'global', 'international', 'de', 'fr', 'es', 'it', 'uk', 'gb', 'us', 'ie', 'nl', 'deutschland', 'germany', 'france', 'spain', 'italy', 'italia', 'españa', 'espana', ]);

/** "https://www.Brand.de/shop?x=1" or "name@brand.de" → "brand.de"; empty for free mail, tools, or nothing usable. */
export function domainKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#\s]/)[0] ?? '';
  s = s.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!s.includes('.') || /\s/.test(s)) return '';
  if (FREEMAIL.has(s)) return '';
  return s;
}

/** "Kijimea · DE", "KIJIMEA GmbH", "kijimea_official" → "kijimea": the brand with suffixes, markets and shop words removed. */
export function nameKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.split(/\s[·|–—-]\s|\s\(|\s\[|\s\/\s/)[0] ?? s; // "Brand · DE", "Brand (Germany)", "Brand / Sister brand" → the brand
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = s.split(' ').filter(Boolean);
  // Drop legal forms anywhere; shop words and market codes only from the ends, so "Beauty Pie" or "Berlin Brands" keep their words.
  let kept = tokens.filter((t) => !LEGAL.has(t));
  while (kept.length > 1 && SHOPWORDS.has(kept[kept.length - 1])) kept.pop();
  while (kept.length > 1 && SHOPWORDS.has(kept[0])) kept.shift();
  if (!kept.length) kept = tokens;
  const key = kept.join(' ');
  return key.length >= 3 ? key : '';
}

const domainsIn = (v: unknown): string[] => (typeof v === 'string' ? v.split(/[\s,;]+/) : Array.isArray(v) ? v.map(String) : []).map(domainKey).filter(Boolean);

export class CrmIndex {
  private byDomain = new Map<string, CrmRef[]>();
  private byName = new Map<string, CrmRef[]>();
  private names: { key: string; ref: CrmRef }[] = [];
  private records = new Map<string, CrmRef>();
  readonly tables = new Map<string, string>(); // table name → id

  constructor(tables: AirtableTableRow[], rows: (table: AirtableTableRow) => AirtableRecordRow[]) {
    const refOf = (t: AirtableTableRow, r: AirtableRecordRow): CrmRef => ({ table: t.name, table_id: t.table_id, record_id: r.record_id, primary: r.primary, fields: r.fields, modified_at: r.modified_at });
    const all = new Map<string, { t: AirtableTableRow; r: AirtableRecordRow }[]>();
    for (const t of tables) { this.tables.set(t.name, t.table_id); all.set(t.name, rows(t).map((r) => ({ t, r }))); for (const r of rows(t)) this.records.set(r.record_id, refOf(t, r)); }
    const add = (map: Map<string, CrmRef[]>, key: string, ref: CrmRef) => { if (!key) return; const list = map.get(key) ?? []; if (!list.some((x) => x.record_id === ref.record_id)) { list.push(ref); map.set(key, list); } };
    const name = (ref: CrmRef, v: unknown) => { const k = nameKey(v); if (!k) return; add(this.byName, k, ref); if (!this.names.some((n) => n.key === k && n.ref.record_id === ref.record_id)) this.names.push({ key: k, ref }); };
    const domain = (ref: CrmRef, v: unknown) => { for (const d of domainsIn(v)) add(this.byDomain, d, ref); };
    for (const { t, r } of all.get('Accounts') ?? []) {
      const ref = refOf(t, r);
      name(ref, r.fields['Account name']);
      for (const part of String(r.fields['Brands / notes on group'] ?? '').split(/[,;/|]+/)) if (part.trim().length <= 40) name(ref, part);
      domain(ref, r.fields['Email domains']); domain(ref, r.fields.Website);
    }
    for (const { t, r } of all.get('Deals') ?? []) name(refOf(t, r), r.fields['Deal name']);
    for (const { t, r } of all.get('Target Intelligence') ?? []) name(refOf(t, r), r.fields.Target);
    for (const { t, r } of all.get('Website Enquiries') ?? []) { const ref = refOf(t, r); name(ref, r.fields['Company / enquiry']); domain(ref, r.fields.Website); domain(ref, r.fields.Email); }
    for (const { t, r } of all.get('Apollo Intake') ?? []) { const ref = refOf(t, r); name(ref, r.fields.Company); domain(ref, r.fields['Company domain']); domain(ref, r.fields['Work email']); }
    // A contact's work email domain points at their account.
    for (const { r } of all.get('Contacts') ?? []) {
      const accounts = (Array.isArray(r.fields.Account) ? (r.fields.Account as unknown[]) : []).map((id) => this.records.get(String(id))).filter((x): x is CrmRef => Boolean(x));
      for (const acc of accounts) { domain(acc, r.fields.Email); domain(acc, r.fields['Alt email']); }
    }
  }

  get size(): number { return this.records.size; }
  record(id: string): CrmRef | null { return this.records.get(id) ?? null; }

  /** Everything that matches a set of domains and names, best reason first; one entry per record. */
  find(keys: { domains: string[]; names: string[] }): CrmMatch[] {
    const out = new Map<string, CrmMatch>();
    const put = (ref: CrmRef, confidence: number, how: string) => { const cur = out.get(ref.record_id); if (!cur || cur.confidence < confidence) out.set(ref.record_id, { ref, confidence, how }); };
    const domains = [...new Set(keys.domains.map(domainKey).filter(Boolean))];
    const names = [...new Set(keys.names.map(nameKey).filter(Boolean))];
    for (const d of domains) for (const ref of this.byDomain.get(d) ?? []) put(ref, 1, `same domain ${d}`);
    for (const n of names) for (const ref of this.byName.get(n) ?? []) put(ref, 0.9, `same name "${n}"`);
    for (const n of names) {
      if (n.length < 5) continue;
      for (const { key, ref } of this.names) {
        if (key === n || out.has(ref.record_id)) continue;
        const [long, short] = key.length >= n.length ? [key, n] : [n, key];
        if (short.length < 5 || !` ${long} `.includes(` ${short} `)) continue;
        put(ref, 0.6, `"${short}" inside "${long}"`);
      }
    }
    // A matched account carries its deals and its targets; a matched deal carries its account.
    for (const m of [...out.values()]) {
      const linked = (field: string) => (Array.isArray(m.ref.fields[field]) ? (m.ref.fields[field] as unknown[]) : []).map((id) => this.records.get(String(id))).filter((x): x is CrmRef => Boolean(x));
      if (m.ref.table === 'Accounts') for (const d of [...linked('Deals'), ...linked('Target Intelligence'), ...linked('Apollo Intake')]) put(d, m.confidence, `${m.how}, via ${m.ref.primary ?? 'the account'}`);
      if (m.ref.table === 'Deals' || m.ref.table === 'Target Intelligence' || m.ref.table === 'Website Enquiries') for (const a of [...linked('Account'), ...linked('Existing account'), ...linked('CRM deal')]) put(a, m.confidence, `${m.how}, via ${m.ref.primary ?? 'the deal'}`);
    }
    return [...out.values()].sort((a, b) => b.confidence - a.confidence || TABLE_RANK(a.ref.table) - TABLE_RANK(b.ref.table));
  }
}

const TABLE_ORDER = ['Deals', 'Accounts', 'Target Intelligence', 'Website Enquiries', 'Apollo Intake'];
export const TABLE_RANK = (name: string): number => { const i = TABLE_ORDER.indexOf(name); return i < 0 ? TABLE_ORDER.length : i; };

export const prospectKeys = (p: BdProspect): { domains: string[]; names: string[] } => ({ domains: [p.domain, p.website, ...p.contacts.map((c) => c.email)].filter((x): x is string => Boolean(x)), names: [p.shop_name, p.brand].filter((x): x is string => Boolean(x)) });
export const leadKeys = (l: Lead): { domains: string[]; names: string[] } => ({ domains: [], names: [l.name] });

/** What a record tells us at a glance, by table: the stage-like field, who has it, the next step, the last contact. */
export function summarise(ref: CrmRef, teamName: (id: string) => string | null): { stage: string | null; detail: string | null; owner: string | null; next_action: string | null; next_action_date: string | null; last_contact: string | null } {
  const f = ref.fields; const s = (k: string) => (typeof f[k] === 'string' && (f[k] as string).trim() ? (f[k] as string).trim() : null);
  const people = (k: string) => (Array.isArray(f[k]) ? (f[k] as unknown[]).map((id) => teamName(String(id))).filter(Boolean).join(', ') || null : null);
  switch (ref.table) {
    case 'Deals': return { stage: s('Stage'), detail: [s('Action state'), s('Priority')].filter(Boolean).join(' · ') || null, owner: people('Owner'), next_action: s('Next action'), next_action_date: s('Next action date'), last_contact: s('Last contact date') };
    case 'Accounts': return { stage: s('TikTok Shop status') ?? s('Account type'), detail: s('Category'), owner: null, next_action: null, next_action_date: null, last_contact: s('Brief updated') };
    case 'Target Intelligence': return { stage: s('CRM status') ?? s('Review state'), detail: [s('Opportunity signal'), s('BD/Ops status')].filter(Boolean).join(' · ') || null, owner: null, next_action: s('Best route in'), next_action_date: null, last_contact: s('Last reviewed') };
    case 'Website Enquiries': return { stage: s('Status'), detail: s('Priority'), owner: people('Assigned AM') ?? people('Handled by'), next_action: s('Next action'), next_action_date: s('Next action date'), last_contact: s('Last contacted') };
    case 'Apollo Intake': return { stage: s('Intake status'), detail: s('Decision-maker fit'), owner: null, next_action: s('Recommended action'), next_action_date: null, last_contact: s('Research date') };
    default: return { stage: null, detail: null, owner: null, next_action: null, next_action_date: null, last_contact: null };
  }
}
