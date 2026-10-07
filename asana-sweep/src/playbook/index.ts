import type { Queries } from '../db/queries.js';
import type { Account, PlaybookCellStatus, PlaybookData, PlaybookDraft, PlaybookDraftStatus, PlaybookItem, PlaybookKind, PlaybookLearned, PlaybookProfile, PlaybookRollout, PlaybookSetupCell, PlaybookShop, PlaybookVoice } from '../sweep/types.js';
import { cruvaCrm, cruvaEndpoints } from '../gmv/cruva.js';
import { cruvaMcp, dmMessagesFromDetail, idFromResult, inviteDetailsFromDetail, outreachFiltersFromDetail, parseListing, unwrap, type ListingRow, type McpCaller } from '../cruva/mcp.js';
import { SEED_PLAYBOOK } from './seed.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { textHash, translateToEnglish } from '../inbox/translate.js';
import { fromEnglishPrompt, WALK_STEPS, walkIndexOf } from './walk.js';
import { pullContent } from './content.js';
import { materialChange, parseProfile, parseVoice, profileFacts, profilePrompt, voiceFacts, voicePrompt } from './profile.js';

/**
 * Cruva best-practice rollout. The library (seed.ts, editable) lists what every shop should have; the
 * check reads each shop through the Cruva MCP and marks every item set / paused / drift / missing /
 * manual; prepare drafts the missing pieces per shop (language, brand, products, categories and the
 * brief link filled in from what the shop already has), the reviewer amends and approves, and the
 * rollout creates them through the same MCP tools Claude uses, paused unless told otherwise.
 */

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Name patterns that count as "this playbook item exists", learnt from how the team names things across shops. */
const ALIASES: Record<string, RegExp[]> = {
  sample_sent: [/sample sent/, /sample shipped/, /crm sample/, /sample verschickt/, /echantillon envoye/, /campione inviato/, /muestra enviada/, /^shipped$/],
  content_pending: [/content pending/, /^delivered/, /sample delivered/, /zugestellt/, /livre/, /consegnato/, /entregad/],
  delivered: [/^delivered/, /sample delivered/, /content pending/, /zugestellt/, /consegnato/, /entregad/],
  first_sale: [/first sale/, /erster verkauf/, /premiere vente/, /prima vendita/, /primera venta/],
  content_not_posted: [/content not posted/, /no content posted/, /not posted/, /unfulfilled/, /kein content/, /pas de contenu/, /nessun contenuto/, /sin contenido/],
  no_post_10d: [/no post in/, /quiet/, /10 days/, /gone dark/, /ghost/],
  rejected: [/rejected/, /abgelehnt/, /refuse/, /rifiutat/, /rechazad/],
  push_more_videos: [/push more videos/, /more videos/, /mehr videos/, /plus de videos/, /piu video/, /mas videos/],
  retarget_bonus: [/retarget/, /re target/, /bonus/, /reactivation/, /win back/],
  deals_info_existing: [/deals info/, /deal info/, /deals? (info|message|reminder)/, /existing creators/],
  first_outreach: [/first outreach/, /big first outreach/, /new (year|spring|summer|autumn|winter)/, /big outreach/, /new creators/, /first contact/, /^new outreach/],
  monthly_deals_outreach: [/(january|february|march|april|may|june|july|august|september|october|november|december) deals/, /deals outreach/, /deals big outreach/],
  new_product_outreach: [/new (product|bundles?|fruits?|flavou?rs?|launch)/, /neue? produkt/, /nouveau produit/, /nuovo prodotto/, /nuevo producto/],
  ai_auto_replies: [/ai auto repl/, /auto repl/],
  top_creators_collab: [/target collab/, /top ?\d* creators/, /top creators/, /collab/, /top perfor/],
  top_creators: [/top creators/, /top performer/, /best creators/, /top ?\d+/],
  inactive_creators: [/inactive/, /retarget/, /bonus/, /inaktiv/],
  existing_creators: [/existing creators/, /all creators/, /alle creator/, /bestehende/, /deals info/],
  posted_no_gmv: [/no sales/, /no gmv/, /0 gmv/, /zero gmv/, /nicht verkauft/],
  ai_search_list: [/top ?\d* creator/, /ai search/, /category/],
  sample_chase: [/sample/, /nudge/, /chase/],
  welcome_new: [/welcome/, /willkommen/, /bienvenue/, /benvenut/, /bienvenid/],
  creator_newsletter: [/newsletter/, /deals/],
  do_not_contact: [/do.?not.?contact/, /blacklist/, /dnc/],
  vip: [/^vip$/],
};

const ANY_OF_KIND: PlaybookKind[] = ['brief', 'sender'];
const KIND_ORDER: Record<PlaybookKind, number> = { group: 0, list: 1, brief: 2, automation: 3, email_campaign: 4, workflow: 5, sender: 6, tag: 7, manual: 8 };
const CREATE_TOOL: Partial<Record<PlaybookKind, string>> = { group: 'create_group', list: 'create_list_from_ai_search', brief: 'create_creator_brief', automation: 'create_automation', email_campaign: 'create_email_campaign', workflow: 'create_workflow' };
const TOGGLE_TOOL: Partial<Record<PlaybookKind, string>> = { automation: 'toggle_automation', email_campaign: 'toggle_email_campaign', workflow: 'toggle_workflow' };
const DELETE_TOOL: Partial<Record<PlaybookKind, string>> = { group: 'delete_group', list: 'delete_list', brief: 'delete_creator_brief', automation: 'delete_automation', email_campaign: 'delete_email_campaign', workflow: 'delete_workflow' };
const ID_ARG: Partial<Record<PlaybookKind, string>> = { automation: 'campaign_id', email_campaign: 'campaign_id', workflow: 'workflow_id', group: 'group_id', list: 'list_id', brief: 'brief_id' };
const LIST_TOOL: Record<PlaybookKind, { tool: string; args: Record<string, unknown> } | null> = {
  automation: { tool: 'list_automations', args: { page_size: 100 } }, group: { tool: 'list_groups', args: { page_size: 100 } }, workflow: { tool: 'list_workflows', args: { page_size: 100 } },
  email_campaign: { tool: 'list_email_campaigns', args: { page_size: 100 } }, list: { tool: 'list_lists', args: { page_size: 100 } }, brief: { tool: 'list_creator_briefs', args: { page_size: 100 } },
  sender: { tool: 'list_sender_emails', args: {} }, tag: { tool: 'list_tags', args: {} }, manual: null,
};
const MARKET_TZ: Record<string, string> = { DE: 'Europe/Berlin', AT: 'Europe/Vienna', FR: 'Europe/Paris', IT: 'Europe/Rome', ES: 'Europe/Madrid', UK: 'Europe/London', GB: 'Europe/London', IE: 'Europe/Dublin', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', PL: 'Europe/Warsaw', AU: 'Australia/Sydney' };
const MARKET_RE = /\s*[-·]?\s*\b(DE|FR|IT|ES|UK|GB|IE|NL|BE|PL|AT|AU|MX|US)\b\s*$/i;

export function matchesItem(key: string, name: string, remoteName: string): boolean {
  const r = norm(remoteName);
  const n = norm(name.replace(/\[month\]\s*/g, ''));
  if (!r) return false;
  if (n && (r === n || r.includes(n))) return true;
  return (ALIASES[key] ?? []).some((re) => re.test(r));
}

/** Parse a pasted MCP listing (several tools' output in one paste) into typed remote items. */
export function parseMcpListing(text: string): { kind: PlaybookKind; remote_id: string; name: string; enabled: boolean; raw: Record<string, string> }[] {
  const out: { kind: PlaybookKind; remote_id: string; name: string; enabled: boolean; raw: Record<string, string> }[] = [];
  let section: PlaybookKind | null = null;
  const chunks: { kind: PlaybookKind | null; lines: string[] }[] = [{ kind: null, lines: [] }];
  for (const raw of unwrap(text).split('\n')) {
    const head = raw.trim().match(/^(Automations|Groups|Workflows|Email campaigns|Lists|Briefs|Creator briefs|Tags)\b/i);
    if (head) { section = ({ automations: 'automation', groups: 'group', workflows: 'workflow', 'email campaigns': 'email_campaign', lists: 'list', briefs: 'brief', 'creator briefs': 'brief', tags: 'tag' } as Record<string, PlaybookKind>)[head[1].toLowerCase()] ?? null; chunks.push({ kind: section, lines: [] }); continue; }
    chunks[chunks.length - 1].lines.push(raw);
  }
  for (const c of chunks) {
    for (const row of parseListing(c.lines.join('\n'))) {
      let kind: PlaybookKind = c.kind ?? 'automation';
      if (!c.kind) { if (row.fields.creators !== undefined) kind = 'group'; else if (row.fields.trigger !== undefined || row.fields.steps !== undefined) kind = 'workflow'; else if (row.fields.subject !== undefined) kind = 'email_campaign'; else if (row.fields.affiliates !== undefined) kind = 'list'; }
      out.push({ kind, remote_id: row.remote_id, name: row.name, enabled: row.enabled, raw: row.fields });
    }
  }
  return out;
}

/** Replace [brand] in every string of a config. */
export function brandify<T>(v: T, brand: string): T {
  return substitute(v, { '[brand]': brand });
}

export function substitute<T>(v: T, map: Record<string, string>): T {
  if (typeof v === 'string') { let s: string = v; for (const [k, val] of Object.entries(map)) s = s.split(k).join(val); return s as unknown as T; }
  if (Array.isArray(v)) return v.map((x) => substitute(x, map)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, substitute(x, map)])) as T;
  return v;
}

export function shopLanguage(market: string | null | undefined): string {
  return ({ DE: 'de', AT: 'de', FR: 'fr', BE: 'fr', IT: 'it', ES: 'es', MX: 'es' } as Record<string, string>)[(market ?? '').toUpperCase()] ?? 'en';
}

export function monthName(language: string, now = new Date()): string {
  const locale = ({ de: 'de-DE', fr: 'fr-FR', it: 'it-IT', es: 'es-ES' } as Record<string, string>)[language] ?? 'en-GB';
  const m = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(now);
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** The shop's brand as it reads in messages: the shop name without the market suffix and the Cruva decorations. */
export function brandOf(shopName: string): string {
  return shopName.replace(/\[external\]/gi, '').replace(/\s*\([^)]*\)\s*$/, '').replace(MARKET_RE, '').replace(/\s+-\s*$/, '').trim() || shopName;
}

const emptyLearned = (): PlaybookLearned => ({ categories: [], products: [], contact_email: null, timezone: null, sender_emails: [], lists: [], brief_link: null, plan: null });

/** Normalised copy for drift comparison: brand and placeholders neutralised, emoji and punctuation dropped. */
const copyKey = (s: string) => norm(s.replace(/\[[a-z_ ]+\]/gi, ' ').replace(/https?:\/\/\S+/g, ' '));

export class PlaybookEngine {
  private checking = false;
  private progress: { done: number; total: number } | null = null;
  constructor(private q: Queries, private mcp: McpCaller = cruvaMcp, private llm: ((system: string, user: string) => Promise<string>) | null | undefined = undefined) {}

  /** Seed the library on first run, and add any seed item a later version introduced (edited items are never overwritten). */
  seed(): void {
    const n = this.q.seedPlaybookIfEmpty(SEED_PLAYBOOK.map((s) => ({ ...s, description: s.description ?? null })));
    if (n) { log.info(`Cruva playbook seeded with ${n} items`); return; }
    const have = new Set(this.q.listPlaybook().map((i) => `${i.kind}:${i.key}:${i.language}`));
    let added = 0;
    for (const s of SEED_PLAYBOOK) if (!have.has(`${s.kind}:${s.key}:${s.language}`)) { this.q.upsertPlaybookItem({ ...s, description: s.description ?? null, source: 'seed' }); added += 1; }
    if (added) log.info(`Cruva playbook: ${added} new library item(s) added`);
  }

  endpoints(): Record<string, string> { return cruvaEndpoints(this.q.getSetting('cruva_endpoints', '') || null); }

  private learnedFor(shopId: string): PlaybookLearned | null {
    const raw = this.q.getSetting(`playbook_learned_${shopId}`, '');
    if (!raw) return null;
    try { return { ...emptyLearned(), ...(JSON.parse(raw) as Partial<PlaybookLearned>) }; } catch { return null; }
  }

  private voiceFor(shopId: string): PlaybookVoice | null {
    const raw = this.q.getSetting(`playbook_voice_${shopId}`, '');
    if (!raw) return null;
    try { return JSON.parse(raw) as PlaybookVoice; } catch { return null; }
  }

  private llmOrNull(maxTokens: number, feature: 'playbook' = 'playbook'): ((system: string, user: string) => Promise<string>) | null {
    if (this.llm !== undefined) return this.llm;
    return config.anthropicApiKey ? (sys: string, user: string) => draftWithClaude(sys, user, { maxTokens, feature }) : null;
  }

  shops(): PlaybookShop[] {
    const accounts = new Map(this.q.listAccounts().map((a) => [a.id, a]));
    const tts = this.q.listTtsShops();
    return this.q.listShops('cruva').map((s) => {
      const a = accounts.get(s.account_id);
      const fromName = s.shop_name.match(MARKET_RE)?.[1]?.toUpperCase() ?? null;
      const market = fromName ?? tts.find((t) => t.account_id === s.account_id)?.market ?? (a?.markets ?? '').split(/[,\s/]+/)[0] ?? null;
      const override = this.q.getSetting(`playbook_lang_${s.shop_id}`, '');
      return { shop_id: s.shop_id, shop_name: s.shop_name, account_id: s.account_id, account_name: a?.name ?? '', am_name: a?.am_name ?? null, market: market || null, language: override || shopLanguage(market), plan: this.q.getSetting(`playbook_plan_${s.shop_id}`, '') || null, remote_counts: {}, checked_at: null, learned: this.learnedFor(s.shop_id), profile: this.q.listProfiles(s.shop_id, 1)[0] ?? null, voice: this.voiceFor(s.shop_id), top_pct: Number(this.q.getSetting(`playbook_top_pct_${s.shop_id}`, '10')) || 10, auto_update: this.q.getSetting(`playbook_auto_update_${s.shop_id}`, '') === '1', error: this.q.getSetting(`playbook_shop_error_${s.shop_id}`, '') || null };
    }).filter((s) => accounts.get(s.account_id)?.enabled !== false);
  }

  /** Check state only, for the sync strip. */
  status(): { mcp_configured: boolean; cruva_configured: boolean; last_check_at: string | null; last_error: string | null; checking: boolean } {
    return { mcp_configured: this.mcp.configured, cruva_configured: cruvaCrm.configured, last_check_at: this.q.getSetting('playbook_last_check_at', '') || null, last_error: this.q.getSetting('playbook_last_error', '') || null, checking: this.checking };
  }

  data(): PlaybookData {
    const remote = this.q.listRemoteItems();
    const shops = this.shops().map((s) => {
      const mine = remote.filter((r) => r.shop_id === s.shop_id);
      const counts: Record<string, number> = {};
      for (const r of mine) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      return { ...s, remote_counts: counts, checked_at: mine.map((r) => r.seen_at).sort().pop() ?? null };
    });
    const items = this.q.listPlaybook();
    let unlinked: PlaybookData['unlinked'] = [];
    try { unlinked = JSON.parse(this.q.getSetting('playbook_unlinked_json', '[]')) as PlaybookData['unlinked']; } catch { unlinked = []; }
    return { items, shops, unlinked, cells: this.q.listPlaybookCells(), languages: [...new Set(items.map((i) => i.language))].sort(), mcp_configured: this.mcp.configured, cruva_configured: cruvaCrm.configured, endpoints: this.endpoints(), last_error: this.q.getSetting('playbook_last_error', '') || null, last_check_at: this.q.getSetting('playbook_last_check_at', '') || null, checking: this.checking, progress: this.progress, rollouts: this.q.listRollouts() };
  }

  // ---- Shops ----

  /** Pull the Cruva shop list and link each one to an account by name; the rest wait under "unlinked". */
  async syncShops(): Promise<{ linked: number; unlinked: number }> {
    const rows = parseListing(await this.mcp.call('list_shops', {}));
    const accounts = this.q.listAccounts().filter((a) => a.enabled);
    const known = new Set(this.q.listShops().map((s) => s.shop_id));
    const unlinked: PlaybookData['unlinked'] = [];
    let linked = 0;
    for (const r of rows) {
      if (r.fields.plan) this.q.setSetting(`playbook_plan_${r.remote_id}`, r.fields.plan);
      if (known.has(r.remote_id)) continue;
      const brand = norm(brandOf(r.name));
      const acc = accounts.find((a) => norm(a.name) === brand) ?? accounts.find((a) => brand.startsWith(norm(a.name)) || norm(a.name).startsWith(brand));
      if (acc && !/external/i.test(r.name)) { this.q.addShop(acc.id, r.remote_id, r.name.trim(), 'EUR', 'cruva'); linked += 1; this.learnSoon(r.remote_id); } else unlinked.push({ shop_id: r.remote_id, shop_name: r.name.trim(), plan: r.fields.plan ?? null });
    }
    this.q.setSetting('playbook_unlinked_json', JSON.stringify(unlinked));
    liveEvents.emitUpdate({ kind: 'playbook' });
    return { linked, unlinked: unlinked.length };
  }

  linkShop(shopId: string, shopName: string, accountId: number): void {
    this.q.addShop(accountId, shopId, shopName, 'EUR', 'cruva');
    this.learnSoon(shopId);
    let unlinked: PlaybookData['unlinked'] = [];
    try { unlinked = JSON.parse(this.q.getSetting('playbook_unlinked_json', '[]')) as PlaybookData['unlinked']; } catch { unlinked = []; }
    this.q.setSetting('playbook_unlinked_json', JSON.stringify(unlinked.filter((u) => u.shop_id !== shopId)));
    liveEvents.emitUpdate({ kind: 'playbook' });
  }

  // ---- Check ----

  private libraryItems(): PlaybookItem[] { return this.q.listPlaybook().filter((i) => i.enabled); }

  /** One library entry per kind:key (the language variants collapse), the shop's language preferred. */
  /** The library as one shop sees it: its own adopted or saved copy first, then its language, then the generic item. */
  private itemsFor(language: string, shopId?: string): PlaybookItem[] {
    const byKey = new Map<string, PlaybookItem[]>();
    for (const i of this.libraryItems()) { if (i.language.startsWith('shop:') && i.language !== `shop:${shopId ?? ''}`) continue; const k = `${i.kind}:${i.key}`; byKey.set(k, [...(byKey.get(k) ?? []), i]); }
    const rank = (i: PlaybookItem) => (shopId && i.language === `shop:${shopId}` ? -1 : i.language === language ? 0 : i.language === '*' ? 1 : i.language === 'en' ? 2 : 3);
    return [...byKey.values()].map((list) => [...list].sort((a, b) => rank(a) - rank(b))[0]);
  }

  private async listing(kind: PlaybookKind, shopId: string): Promise<ListingRow[]> {
    const spec = LIST_TOOL[kind];
    if (!spec) return [];
    const text = await this.mcp.call(spec.tool, { shop_id: shopId, ...spec.args });
    const rows = parseListing(text);
    if (kind === 'sender' && !rows.length) return [...new Set(unwrap(text).match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])].map((e) => ({ remote_id: e, name: e, enabled: true, status: null, fields: {}, detail: '' }));
    if (kind === 'tag' && !rows.length) return unwrap(text).split('\n').map((l) => l.trim()).filter((l) => l && !/^no tags/i.test(l) && !/^tags\b/i.test(l)).map((l) => { const m = l.match(/^[-•]?\s*(.+?)\s*(?:\((\d[\d,]*)\s*creators?\))?$/); const name = (m?.[1] ?? l).replace(/[:·|].*$/, '').trim(); return { remote_id: name, name, enabled: true, status: null, fields: {}, detail: '' }; });
    return rows;
  }

  /** Read one shop's setup through the MCP: every listing, drift on the bots we recognise, and what to reuse when drafting. */
  async checkShop(shop: PlaybookShop, deep = true): Promise<void> {
    const kinds: PlaybookKind[] = ['automation', 'group', 'workflow', 'email_campaign', 'list', 'brief', 'sender', 'tag'];
    const rows = new Map<PlaybookKind, ListingRow[]>();
    for (const kind of kinds) rows.set(kind, await this.listing(kind, shop.shop_id));
    for (const kind of kinds) this.q.replaceRemoteItems(shop.shop_id, kind, (rows.get(kind) ?? []).map((r) => ({ remote_id: r.remote_id, name: r.name, enabled: r.enabled, raw: { ...r.fields, detail: r.detail.slice(0, 2000) } })));
    const learned: PlaybookLearned = { ...emptyLearned(), ...(this.learnedFor(shop.shop_id) ?? {}), plan: shop.plan };
    learned.sender_emails = (rows.get('sender') ?? []).map((r) => r.remote_id).filter((e) => e.includes('@'));
    learned.lists = (rows.get('list') ?? []).map((r) => ({ id: r.remote_id, name: r.name, count: Number((r.fields.affiliates ?? '0').replace(/[^\d]/g, '')) || 0 }));
    const brief = (rows.get('brief') ?? [])[0];
    if (brief) learned.brief_link = brief.fields.link ?? brief.detail.match(/https?:\/\/\S+/)?.[0] ?? brief.fields.url ?? learned.brief_link;
    const drift = new Map<string, boolean>();
    const copies = new Map<string, string>();
    if (deep) {
      // Drift only matters for the lifecycle bots on CRM groups; outreach copy is each shop's own.
      const items = this.itemsFor(shop.language, shop.shop_id).filter((i) => i.kind === 'automation' && !i.config.manual && i.config.outreach_audience === 'groups');
      const autos = rows.get('automation') ?? [];
      const brand = brandOf(shop.shop_name);
      // Learn categories, products, contact email and timezone from the shop's strongest outreach automations.
      const gmv = (r: ListingRow) => Number((r.fields.gmv ?? '0').replace(/[^\d.]/g, '')) || 0;
      const outreach = autos.filter((r) => /new_affiliates/.test(r.fields.audience ?? '')).sort((a, b) => gmv(b) - gmv(a)).slice(0, 2);
      const invites = autos.filter((r) => /invite/.test(r.fields.message ?? '')).sort((a, b) => gmv(b) - gmv(a)).slice(0, 1);
      const detailOf = new Map<string, string>();
      const fetchDetail = async (id: string) => { if (!detailOf.has(id)) { try { const t = await this.mcp.call('list_automations', { shop_id: shop.shop_id, campaign_id: id }); detailOf.set(id, parseListing(t)[0]?.detail ?? unwrap(t)); } catch (err) { detailOf.set(id, ''); log.warn(`Cruva detail for ${id}: ${(err as Error).message}`); } } return detailOf.get(id)!; };
      for (const r of [...outreach, ...invites]) {
        const d = await fetchDetail(r.remote_id);
        const f = outreachFiltersFromDetail(d);
        if (f && Array.isArray(f.categories) && f.categories.length && !learned.categories.length) learned.categories = (f.categories as string[]).slice(0, 8);
        const inv = inviteDetailsFromDetail(d);
        if (inv) {
          if (Array.isArray(inv.products) && inv.products.length && !learned.products.length) learned.products = (inv.products as { product_id?: string }[]).map((p) => String(p.product_id ?? '')).filter(Boolean).slice(0, 20);
          if (typeof inv.contact_email === 'string' && inv.contact_email) learned.contact_email = inv.contact_email;
        }
        const dms = dmMessagesFromDetail(d);
        if (dms && !learned.products.length) for (const m of dms) if (Array.isArray((m as { products?: unknown }).products)) { learned.products = ((m as { products: unknown[] }).products).map(String).slice(0, 20); break; }
        const tz = d.match(/Daily limits timezone:\s*(\S+)/)?.[1]; if (tz) learned.timezone = tz;
      }
      // Drift: a recognised bot whose message no longer reads like the library copy.
      for (const item of items) {
        const hit = autos.find((r) => matchesItem(item.key, item.name, r.name) && !/completed/.test(r.status ?? ''));
        if (!hit) continue;
        const lib = (item.config.dm_messages as { type?: string; content?: string }[] | undefined)?.filter((m) => m.type === 'message').map((m) => m.content ?? '').join('\n');
        if (!lib) continue;
        const d = await fetchDetail(hit.remote_id);
        const dms = dmMessagesFromDetail(d);
        if (!dms) continue;
        const remote = dms.filter((m) => (m.type ?? 'message') !== 'invite_card').map((m) => m.content ?? '').join('\n');
        copies.set(`${item.kind}:${item.key}`, remote);
        this.q.patchRemoteRaw(shop.shop_id, 'automation', hit.remote_id, { copy: remote });
        const differs = copyKey(remote) !== copyKey(brandify(lib, brand));
        // What the shop already runs is the standard for that shop: adopt it as the shop's own library item the first time, so drafts start from it and it never reads as drift.
        if (differs && !item.language.startsWith('shop:') && remote.trim() && this.q.getSetting('playbook_adopt_existing', '1') === '1') {
          this.q.upsertPlaybookItem({ kind: item.kind, key: item.key, language: `shop:${shop.shop_id}`, name: item.name, description: `${shop.shop_name}: the copy running in Cruva, adopted on ${new Date().toISOString().slice(0, 10)}`, config: { ...item.config, dm_messages: dms, adopted_from: hit.remote_id }, source: 'cruva' });
          drift.set(hit.remote_id, false);
        } else drift.set(hit.remote_id, differs);
      }
      // The copy of the shop's strongest messages, for the voice and as the reference next to every draft.
      const strongest = [...autos].sort((a, b) => gmv(b) - gmv(a) || Number((b.fields.sent ?? '0').replace(/[^\d]/g, '')) - Number((a.fields.sent ?? '0').replace(/[^\d]/g, ''))).slice(0, 8);
      for (const r of strongest) {
        const d = await fetchDetail(r.remote_id);
        const dms = dmMessagesFromDetail(d);
        const copy = dms?.filter((m) => (m.type ?? 'message') !== 'invite_card').map((m) => m.content ?? '').join('\n').trim();
        if (copy) this.q.patchRemoteRaw(shop.shop_id, 'automation', r.remote_id, { copy, sent: Number((r.fields.sent ?? '').replace(/[^\d]/g, '')) || null, replies: Number((r.fields.replies ?? '').replace(/[^\d]/g, '')) || null, gmv: gmv(r) });
      }
    }
    if (!learned.contact_email) learned.contact_email = `team+${norm(brandOf(shop.shop_name)).replace(/\s+/g, '')}@brightform.agency`;
    if (!learned.timezone) learned.timezone = MARKET_TZ[(shop.market ?? '').toUpperCase()] ?? 'Europe/Madrid';
    this.q.setSetting(`playbook_learned_${shop.shop_id}`, JSON.stringify(learned));
    this.reconcile(shop.shop_id, drift);
    for (const [k, copy] of copies) { const [kind, key] = k.split(':'); this.q.setPlaybookCellCopy(shop.shop_id, kind as PlaybookKind, key, copy); }
  }

  /** Recompute every cell for one shop from the stored remote items. */
  reconcile(shopId: string, drift: Map<string, boolean> = new Map()): void {
    const remote = this.q.listRemoteItems(shopId);
    const shop = this.shops().find((s) => s.shop_id === shopId);
    const now = new Date().toISOString();
    const cells = this.q.listPlaybookCells();
    for (const item of this.itemsFor(shop?.language ?? 'en', shopId)) {
      const cur = cells.find((c) => c.shop_id === shopId && c.kind === item.kind && c.playbook_key === item.key);
      const manual = Boolean(item.config.manual) || item.kind === 'manual';
      const pool = remote.filter((r) => r.kind === item.kind || (item.kind === 'tag' && r.kind === 'tag'));
      // Several remote objects can match one item (an old completed outreach and the live one): a running one wins.
      const hits = item.kind === 'manual' ? [] : ANY_OF_KIND.includes(item.kind) ? pool.slice(0, 1) : pool.filter((r) => matchesItem(item.key, typeof item.config.tag === 'string' ? item.config.tag : item.name, r.name));
      const hit = hits.find((h) => h.enabled) ?? hits[0];
      const byHand = cur?.status === 'set' && !cur.remote_id && /by hand/.test(cur.note ?? '');
      let status: PlaybookCellStatus;
      let note: string | null = null;
      if (hit) { status = !hit.enabled ? 'paused' : drift.get(hit.remote_id) ? 'drift' : 'set'; note = status === 'paused' ? 'exists but stopped' : status === 'drift' ? 'message differs from the library' : null; }
      else if (byHand) { status = 'set'; note = cur!.note; }
      else if (manual) { status = 'manual'; note = 'set up in the Cruva UI, then tick it here'; }
      else if (cur?.status === 'queued') { status = 'queued'; note = cur.note; }
      else if (!remote.length) { status = 'unknown'; }
      else { status = 'missing'; }
      this.q.setPlaybookCell({ shop_id: shopId, kind: item.kind, playbook_key: item.key, status, remote_id: hit?.remote_id ?? (byHand ? null : null), remote_name: hit?.name ?? null, checked_at: now, note });
    }
  }

  /** Store a pasted MCP listing (or JSON array) as the shop's remote state. */
  importListing(shopId: string, text: string): { imported: number } {
    let rows: { kind: PlaybookKind; remote_id: string; name: string; enabled: boolean; raw?: unknown }[] = [];
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed) as Record<string, unknown>[];
        rows = arr.filter((x) => x && typeof x === 'object').map((x) => ({ kind: String(x.kind ?? x.type ?? 'automation') as PlaybookKind, remote_id: String(x.id ?? x.remote_id ?? x.campaign_id ?? ''), name: String(x.name ?? x.title ?? x.campaign_name ?? ''), enabled: !/stopped|archived|paused|completed/i.test(String(x.status ?? '')), raw: x }));
      } catch { rows = parseMcpListing(trimmed); }
    } else rows = parseMcpListing(trimmed);
    if (!rows.length) throw new Error('Nothing recognised. Paste the output of the Cruva MCP list_automations / list_groups / list_workflows / list_email_campaigns tools.');
    const byKind = new Map<PlaybookKind, typeof rows>();
    for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
    let n = 0;
    for (const [kind, list] of byKind) n += this.q.replaceRemoteItems(shopId, kind, list);
    this.reconcile(shopId);
    liveEvents.emitUpdate({ kind: 'playbook' });
    return { imported: n };
  }

  /** Check one shop or all of them over the MCP. */
  async check(shopId?: string, deep = true): Promise<{ shops: number; errors: string[] }> {
    if (!this.mcp.configured) throw new Error('CRUVA_API_KEY is not set: generate one under Cruva › Dashboard › API and add it to the server secrets.');
    if (this.checking) return { shops: 0, errors: ['A check is already running'] };
    this.checking = true;
    const errors: string[] = [];
    let shops = 0;
    try {
      liveEvents.emitUpdate({ kind: 'playbook' });
      const targets = this.shops().filter((s) => !shopId || s.shop_id === shopId);
      if (!targets.length) errors.push(shopId ? 'Shop not linked to an account' : 'No Cruva shops linked yet: press Sync shops');
      this.progress = { done: 0, total: targets.length };
      for (const s of targets) {
        try {
          await this.checkShop(s, deep);
          shops += 1;
          this.q.setSetting(`playbook_shop_error_${s.shop_id}`, '');
        } catch (err) {
          const message = (err as Error).message;
          errors.push(`${s.shop_name}: ${message}`);
          this.q.setSetting(`playbook_shop_error_${s.shop_id}`, message.slice(0, 300));
          log.warn(`Cruva check failed for ${s.shop_name}: ${message}`);
        }
        this.progress = { done: this.progress.done + 1, total: targets.length };
        liveEvents.emitUpdate({ kind: 'playbook' });
      }
      this.q.setSetting('playbook_last_error', errors.length ? `${errors.length} of ${targets.length} shop(s) failed: ${errors.slice(0, 3).join(' · ')}`.slice(0, 600) : '');
      this.q.setSetting('playbook_last_check_at', new Date().toISOString());
    } finally {
      this.checking = false;
      this.progress = null;
      liveEvents.emitUpdate({ kind: 'playbook' });
    }
    return { shops, errors };
  }

  // ---- Prepare (drafts) ----

  /** The exact tool payload for a shop and item, with brand, month, language, products, categories, groups, lists and senders filled in from what the shop has. */
  payloadFor(shop: PlaybookShop, item: PlaybookItem, ctx: { groupIds: Map<string, string>; listIds: Map<string, string>; briefLink: string | null; pendingKeys: Set<string> }): { tool: string; payload: Record<string, unknown>; copy: string | null; blockers: string[]; inputs: string[] } {
    const brand = brandOf(shop.shop_name);
    const learned = shop.learned ?? emptyLearned();
    const month = monthName(shop.language);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    let cfg = substitute({ ...item.config }, { '[brand]': brand, '[month]': month, '[tomorrow]': tomorrow }) as Record<string, unknown>;
    const blockers: string[] = []; const inputs: string[] = [];
    for (const k of ['manual', 'core', 'email_body_by_language']) delete cfg[k];
    if (item.kind === 'email_campaign' && item.config.email_body_by_language) { const by = item.config.email_body_by_language as Record<string, string>; cfg.email_body = substitute(by[shop.language] ?? by.en ?? String(cfg.email_body ?? ''), { '[brand]': brand, '[month]': month }); }
    // Group and list references.
    if (typeof cfg.group_key === 'string') {
      const id = ctx.groupIds.get(cfg.group_key);
      if (id) cfg.group_id = id; else if (ctx.pendingKeys.has(`group:${cfg.group_key}`)) cfg.group_id = `[group:${cfg.group_key}]`; else blockers.push(`needs the "${cfg.group_key}" group first`);
      delete cfg.group_key;
    }
    if (typeof cfg.list_key === 'string') {
      const id = ctx.listIds.get(cfg.list_key) ?? learned.lists.find((l) => /top|collab/i.test(l.name))?.id;
      if (id) cfg.list_ids = [Number(id) || id]; else if (ctx.pendingKeys.has(`list:${cfg.list_key}`)) cfg.list_ids = [`[list:${cfg.list_key}]`]; else blockers.push('needs a saved creator list (the AI search item builds one)');
      delete cfg.list_key;
    }
    // Brief link in the copy.
    const link = ctx.briefLink ?? learned.brief_link;
    cfg = substitute(cfg, { '[brief_link]': link ?? (ctx.pendingKeys.has('brief:creator_brief') ? '[brief_link]' : '') });
    if (!link && !ctx.pendingKeys.has('brief:creator_brief') && JSON.stringify(item.config).includes('[brief_link]')) inputs.push('brief link (no creator brief on the shop yet: the line is dropped)');
    cfg = stripEmptyBriefLines(cfg);
    // Outreach filters, products, contact email, timezone, senders.
    const of = cfg.outreach_filters as Record<string, unknown> | undefined;
    if (of && Array.isArray(of.categories) && !of.categories.length) { if (learned.categories.length) of.categories = learned.categories; else inputs.push('categories (outreach_filters.categories): none learnt from the shop yet'); }
    const fl = cfg.filters as Record<string, unknown> | undefined;
    if (item.kind === 'list' && fl && Array.isArray(fl.categories) && !fl.categories.length) { if (learned.categories.length) fl.categories = learned.categories; else inputs.push('categories (filters.categories)'); }
    const inv = cfg.invite_details as Record<string, unknown> | undefined;
    if (inv) {
      const commission = Number(inv.commission ?? 20); const ads = Number(inv.shop_ads_commission ?? 5); delete inv.commission; delete inv.shop_ads_commission;
      if (Array.isArray(inv.products) && !inv.products.length) { if (learned.products.length) inv.products = learned.products.map((p) => ({ product_id: p, commission, shop_ads_commission: ads })); else inputs.push('products (invite_details.products): none learnt from the shop yet'); }
      if (!inv.contact_email) inv.contact_email = learned.contact_email ?? `team+${norm(brand).replace(/\s+/g, '')}@brightform.agency`;
    }
    if (item.kind === 'automation' && !cfg.daily_limits_timezone) cfg.daily_limits_timezone = learned.timezone ?? MARKET_TZ[(shop.market ?? '').toUpperCase()] ?? 'Europe/Madrid';
    if (Array.isArray(cfg.sender_emails) && !cfg.sender_emails.length) { if (learned.sender_emails.length) cfg.sender_emails = learned.sender_emails.slice(0, 10); else blockers.push('needs a sender email on the shop (Outreach › Email Campaigns › Manage Sender Emails)'); }
    if (item.kind === 'brief' && !cfg.support_email) cfg.support_email = learned.contact_email;
    const tool = CREATE_TOOL[item.kind] ?? '';
    if (!tool) blockers.push('set up in the Cruva UI');
    return { tool, payload: { shop_id: shop.shop_id, ...cfg }, copy: copyOf(cfg), blockers, inputs };
  }

  /** Draft every missing, paused or drifted item for the chosen shops into a new rollout, nothing sent to Cruva yet. */
  prepare(opts: { shop_ids: string[]; keys?: string[]; created_by?: string | null; /** Items to redo even where they are live (an update with the current copy), e.g. after the weekly learning. */ updateKeys?: string[]; note?: string | null; /** false leaves the drafts as the library wrote them; by default they are rewritten in the shop's voice with the content profile in the background. */ tailor?: boolean }): { rollout: PlaybookRollout; drafts: PlaybookDraft[] } {
    const shops = this.shops().filter((s) => opts.shop_ids.includes(s.shop_id));
    if (!shops.length) throw new Error('Pick at least one linked shop.');
    const cells = this.q.listPlaybookCells();
    const rollout = this.q.createRollout(shops.map((s) => s.shop_id), opts.created_by ?? null, opts.note ?? null);
    const drafts: PlaybookDraft[] = [];
    const wanted = opts.keys?.length ? new Set(opts.keys) : null;
    const redo = new Set(opts.updateKeys ?? []);
    for (const shop of shops) {
      const items = this.itemsFor(shop.language, shop.shop_id).filter((i) => (!wanted || wanted.has(`${i.kind}:${i.key}`) || wanted.has(i.key)) && !i.config.manual && !['manual', 'sender', 'tag'].includes(i.kind)).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
      const cellOf = (i: PlaybookItem) => cells.find((c) => c.shop_id === shop.shop_id && c.kind === i.kind && c.playbook_key === i.key) ?? null;
      const groupIds = new Map<string, string>(); const listIds = new Map<string, string>();
      for (const c of cells.filter((c) => c.shop_id === shop.shop_id && c.remote_id && ['set', 'paused', 'drift'].includes(c.status))) { if (c.kind === 'group') groupIds.set(c.playbook_key, c.remote_id!); if (c.kind === 'list') listIds.set(c.playbook_key, c.remote_id!); }
      const pendingKeys = new Set<string>(items.filter((i) => ['missing', 'unknown', 'error', 'queued'].includes(cellOf(i)?.status ?? 'unknown')).map((i) => `${i.kind}:${i.key}`));
      const briefCell = cells.find((c) => c.shop_id === shop.shop_id && c.kind === 'brief' && c.status === 'set');
      let order = 0;
      for (const item of items) {
        const cell = cellOf(item);
        const st = cell?.status ?? 'unknown';
        const redoLive = st === 'set' && cell?.remote_id && item.kind === 'automation' && (redo.has(`${item.kind}:${item.key}`) || redo.has(item.key));
        if ((st === 'set' && !redoLive) || st === 'manual') continue;
        const action: PlaybookDraft['action'] = st === 'paused' ? 'start' : st === 'drift' || redoLive ? 'update' : 'create';
        let tool: string; let payload: Record<string, unknown>; let copy: string | null = null; let blockers: string[] = []; let inputs: string[] = [];
        if (action === 'start') {
          tool = TOGGLE_TOOL[item.kind] ?? ''; payload = { shop_id: shop.shop_id, [ID_ARG[item.kind] ?? 'id']: cell!.remote_id, status: 'active' };
          if (!tool) continue;
        } else {
          const p = this.payloadFor(shop, item, { groupIds, listIds, briefLink: briefCell ? shop.learned?.brief_link ?? null : null, pendingKeys });
          tool = p.tool; payload = p.payload; copy = p.copy; blockers = p.blockers; inputs = p.inputs;
          if (action === 'update') { tool = item.kind === 'automation' ? 'update_automation' : tool; if (item.kind === 'automation') payload = { shop_id: shop.shop_id, campaign_id: cell!.remote_id, dm_messages: payload.dm_messages, title: payload.title }; }
          if (!tool) continue;
        }
        const status: PlaybookDraftStatus = blockers.length ? 'blocked' : inputs.length ? 'needs_input' : 'ready';
        const existingCopy = cell?.remote_copy ?? (copy ? this.nearestCopy(shop.shop_id, cell?.remote_id ?? null) : null);
        drafts.push(this.q.addRolloutDraft({ existing_copy: existingCopy, rollout_id: rollout.id, shop_id: shop.shop_id, shop_name: shop.shop_name, account_id: shop.account_id, kind: item.kind, key: item.key, name: String(payload.title ?? payload.name ?? item.name), description: item.description, language: item.language === '*' ? shop.language : item.language, action, tool, payload, copy, blockers: [...blockers, ...inputs], status, start_after: action === 'start' ? true : Boolean(item.config.core) && item.kind !== 'automation' ? false : item.kind === 'automation' && (item.config.outreach_audience === 'groups'), save_override: false, remote_id: cell?.remote_id ?? null, remote_name: cell?.remote_name ?? null, order_no: order++ }));
        if (cell) this.q.setPlaybookCell({ shop_id: shop.shop_id, kind: item.kind, playbook_key: item.key, status: 'queued', note: `in rollout #${rollout.id}` });
      }
    }
    liveEvents.emitUpdate({ kind: 'playbook' });
    if (opts.tailor !== false && drafts.some((d) => d.copy) && shops.some((sh) => sh.voice || sh.profile || this.campaignFacts(sh.shop_id, null).length)) void this.tailorRollout(rollout.id).catch((err) => log.warn(`Cruva tailoring: ${(err as Error).message}`));
    return { rollout: this.q.getRollout(rollout.id)!, drafts };
  }

  /** The copy of the shop's strongest existing message, as the reference next to a draft that creates something new. */
  private nearestCopy(shopId: string, exceptRemoteId: string | null): string | null {
    const withCopy = this.q.listRemoteRaw(shopId, 'automation').filter((r) => typeof r.raw.copy === 'string' && r.raw.copy && r.remote_id !== exceptRemoteId).sort((a, b) => Number(b.raw.gmv ?? 0) - Number(a.raw.gmv ?? 0) || Number(b.raw.sent ?? 0) - Number(a.raw.sent ?? 0));
    return withCopy[0] ? `${withCopy[0].name}:\n${String(withCopy[0].raw.copy)}` : null;
  }

  // ---- Learning: the shop's voice from the copy it runs, and the content profile from its top videos ----

  private learnQueue: Promise<unknown> = Promise.resolve();
  /** Learn a shop in the background, one at a time, without anyone pressing anything (a newly linked shop, a shop that was never learnt). */
  learnSoon(shopId: string): void {
    if (!this.mcp.configured || (this.llm === undefined && !config.anthropicApiKey)) return;
    this.learnQueue = this.learnQueue.then(async () => {
      const shop = this.shops().find((sh) => sh.shop_id === shopId);
      if (!shop || (shop.profile && shop.voice)) return;
      if (!this.q.listRemoteItems(shopId).length) { try { await this.checkShop(shop, true); } catch (err) { log.warn(`Cruva learn ${shop.shop_name}: check failed: ${(err as Error).message}`); } }
      const r = await this.learnShop(shopId);
      if (r.errors.length) log.warn(`Cruva learn ${shop.shop_name}: ${r.errors.join(' | ')}`);
      else log.info(`Cruva learnt ${shop.shop_name}: ${r.profile ? `top ${r.profile.top_count} of ${r.profile.videos} videos` : 'no videos'}${r.voice ? ', voice' : ''}`);
    }).catch((err) => log.warn(`Cruva learn: ${(err as Error).message}`));
  }

  /** Every linked shop without a profile or a voice, queued for learning (after boot and after a sync). */
  learnMissing(): number {
    const missing = this.shops().filter((sh) => !sh.profile || !sh.voice);
    for (const sh of missing) this.learnSoon(sh.shop_id);
    return missing.length;
  }

  /** Learn now when the shop has not been learnt, so a rollout is always tailored to it. */
  async ensureLearned(shopId: string): Promise<void> {
    const shop = this.shops().find((sh) => sh.shop_id === shopId);
    if (!shop || (shop.profile && shop.voice)) return;
    await this.learnQueue; // a background learn of this shop may be running
    const again = this.shops().find((sh) => sh.shop_id === shopId);
    if (again && again.profile && again.voice) return;
    const r = await this.learnShop(shopId);
    if (r.errors.length) log.warn(`Cruva learn ${shop.shop_name}: ${r.errors.join(' | ')}`);
  }

  /** Prepare for the walk: the shops learnt first where they were not, the drafts written, then tailored in walk order in the background. */
  async prepareTailored(opts: Parameters<PlaybookEngine['prepare']>[0]): Promise<{ rollout: PlaybookRollout; drafts: PlaybookDraft[] }> {
    for (const id of opts.shop_ids) { try { await this.ensureLearned(id); } catch (err) { log.warn(`Cruva learn before prepare: ${(err as Error).message}`); } }
    return this.prepare(opts);
  }

  /** The campaigns that work on the shop, by replies and GMV, as lines for the tailoring prompt. */
  private campaignFacts(shopId: string, exceptRemoteId: string | null): string[] {
    const rows = this.q.listRemoteRaw(shopId, 'automation').filter((r) => typeof r.raw.copy === 'string' && r.raw.copy && r.remote_id !== exceptRemoteId);
    const score = (r: (typeof rows)[number]) => Number(r.raw.gmv ?? 0) * 10 + Number(r.raw.replies ?? 0);
    return rows.sort((a, b) => score(b) - score(a)).slice(0, 3).map((r) => { const sent = Number(r.raw.sent ?? 0); const replies = Number(r.raw.replies ?? 0); const gmv = Number(r.raw.gmv ?? 0); return `"${r.name}"${r.enabled ? '' : ' (stopped)'}: ${sent ? `sent ${sent.toLocaleString()}, ` : ''}${replies ? `${replies} replies${sent ? ` (${((replies / sent) * 100).toFixed(1)}%)` : ''}, ` : ''}${gmv ? `${Math.round(gmv).toLocaleString()} GMV` : 'no GMV yet'}. Opens: "${String(r.raw.copy).split('\n').filter((l) => l.trim())[0]?.slice(0, 120) ?? ''}"`; });
  }

  async learnVoice(shop: PlaybookShop): Promise<PlaybookVoice | null> {
    const llm = this.llmOrNull(900);
    if (!llm) throw new Error('ANTHROPIC_API_KEY is not set.');
    let raws = this.q.listRemoteRaw(shop.shop_id, 'automation').filter((r) => typeof r.raw.copy === 'string' && r.raw.copy);
    if (!raws.length && this.mcp.configured) {
      // No copy stored yet: read the strongest automations now.
      for (const r of this.q.listRemoteRaw(shop.shop_id, 'automation').slice(0, 8)) {
        try { const t = await this.mcp.call('list_automations', { shop_id: shop.shop_id, campaign_id: r.remote_id }); const d = parseListing(t)[0]?.detail ?? unwrap(t); const dms = dmMessagesFromDetail(d); const copy = dms?.filter((m) => (m.type ?? 'message') !== 'invite_card').map((m) => m.content ?? '').join('\n').trim(); if (copy) this.q.patchRemoteRaw(shop.shop_id, 'automation', r.remote_id, { copy }); } catch { /* next */ }
      }
      raws = this.q.listRemoteRaw(shop.shop_id, 'automation').filter((r) => typeof r.raw.copy === 'string' && r.raw.copy);
    }
    if (!raws.length) return null;
    const samples = raws.sort((a, b) => Number(b.raw.gmv ?? 0) - Number(a.raw.gmv ?? 0) || Number(b.raw.sent ?? 0) - Number(a.raw.sent ?? 0)).slice(0, 6).map((r) => ({ name: r.name, kind: 'automation', sent: r.raw.sent === undefined ? null : Number(r.raw.sent) || null, replies: r.raw.replies === undefined ? null : Number(r.raw.replies) || null, copy: String(r.raw.copy).slice(0, 2000) }));
    const { system, user } = voicePrompt({ shop_name: shop.shop_name, language: shop.language, samples });
    const voice = parseVoice(await llm(system, user), samples);
    this.q.setSetting(`playbook_voice_${shop.shop_id}`, JSON.stringify(voice));
    return voice;
  }

  async learnProfile(shop: PlaybookShop, now = Date.now()): Promise<PlaybookProfile | null> {
    if (!this.mcp.configured) throw new Error('CRUVA_API_KEY is not set.');
    const llm = this.llmOrNull(8000);
    if (!llm) throw new Error('ANTHROPIC_API_KEY is not set.');
    const to = new Date(now).toISOString().slice(0, 10); const from = new Date(now - 28 * 86400000).toISOString().slice(0, 10);
    const { videos, total } = await pullContent(this.mcp, shop.shop_id, { from, to, pct: shop.top_pct });
    this.q.replaceContent(shop.shop_id, to, videos);
    const top = videos.filter((v) => v.top);
    if (!top.length) return null;
    const contrast = videos.filter((v) => !v.top).slice(0, 8);
    const { system, user } = profilePrompt({ shop_name: shop.shop_name, language: shop.language, market: shop.market, top: top.slice(0, 30), all: [...top.slice(0, 30), ...contrast], total, window_from: from, window_to: to });
    // One retry: an empty or cut-off reply from the model is rare and usually passes the second time.
    let raw: string;
    try { raw = await llm(system, user); } catch (err) { if (!/empty reply|cut off/.test((err as Error).message)) throw err; log.warn(`Cruva profile for ${shop.shop_name}: ${(err as Error).message}; retrying once`); raw = await llm(system, user); }
    const profile = parseProfile(raw, videos, { window_from: from, window_to: to, total, now });
    this.q.addProfile(shop.shop_id, profile);
    // The top creators get the VIP tag when the shop has one; best effort, Cruva's tag tools vary.
    const vip = this.q.listPlaybookCells().find((c) => c.shop_id === shop.shop_id && c.kind === 'tag' && c.playbook_key === 'vip' && c.status === 'set');
    if (vip && profile.top_creators.length) { try { await this.mcp.call('tag_creators', { shop_id: shop.shop_id, handles: profile.top_creators.slice(0, 20).map((c) => c.handle), tags: ['VIP'] }); } catch (err) { log.info(`Cruva VIP tag on ${shop.shop_name}: ${(err as Error).message}`); } }
    return profile;
  }

  /** Both passes for one shop; errors come back as text rather than stopping the others. */
  async learnShop(shopId: string): Promise<{ profile: PlaybookProfile | null; voice: PlaybookVoice | null; errors: string[] }> {
    const shop = this.shops().find((s) => s.shop_id === shopId);
    if (!shop) throw new Error('Shop not found');
    const errors: string[] = [];
    let voice: PlaybookVoice | null = null; let profile: PlaybookProfile | null = null;
    try { voice = await this.learnVoice(shop); } catch (err) { errors.push(`voice: ${(err as Error).message}`); }
    try { profile = await this.learnProfile(shop); } catch (err) { errors.push(`content: ${(err as Error).message}`); }
    this.q.setSetting(`playbook_learned_at_${shopId}`, new Date().toISOString());
    liveEvents.emitUpdate({ kind: 'playbook' });
    return { profile, voice, errors };
  }

  /** Rewrite one draft's copy in the shop's voice with the content profile; the existing copy (an update) or the nearest message is the base, the library copy the checklist of what must be in it. */
  async tailorDraft(id: number, opts: { instruction?: string | null; now?: number } = {}): Promise<PlaybookDraft> {
    const d = this.q.getRolloutDraft(id);
    if (!d) throw new Error('Draft not found');
    if (!d.copy) throw new Error('This draft has no message.');
    if (['done', 'undone'].includes(d.status)) throw new Error('This draft has already run.');
    const shop = this.shops().find((s) => s.shop_id === d.shop_id);
    if (!shop) throw new Error('Shop not found');
    const llm = this.llmOrNull(1000);
    if (!llm) throw new Error('ANTHROPIC_API_KEY is not set.');
    if (!shop.voice && !shop.profile && !opts.instruction && !this.campaignFacts(d.shop_id, d.remote_id).length) return d;
    const lang = ({ de: 'German', fr: 'French', it: 'Italian', es: 'Spanish', nl: 'Dutch', pl: 'Polish' } as Record<string, string>)[d.language] ?? 'English';
    const brand = brandOf(d.shop_name);
    const system = [
      `You write TikTok Shop creator messages for ${brand} in ${lang}, in the brand's own voice. The message has a job (what the library copy below asks for); keep that job, every fact in it, and every placeholder exactly as written ([affiliate_name], [brand], [brief_link], [month], URLs). No hashtags, no corporate filler. Output only the message.`,
      ...(shop.voice ? ['', 'The brand\'s voice, learnt from the messages it already runs:', ...voiceFacts(shop.voice).map((l) => `- ${l}`)] : []),
      ...(shop.profile ? ['', 'What sells for this shop right now (from its top videos). Use what fits this message: a hook or content idea in a message about what to film, the product that carries in a message about products, the offer where a deal is mentioned. Do not list it all.', ...profileFacts(shop.profile).map((l) => `- ${l}`)] : []),
      ...((): string[] => { const c = this.campaignFacts(d.shop_id, d.remote_id); return c.length ? ['', 'Campaigns that work on this shop (by replies and GMV); match what they do well:', ...c.map((l) => `- ${l}`)] : []; })(),
      d.existing_copy ? `\nThe shop's existing message for reference (its structure and phrasing are the base when they fit):\n${d.existing_copy.slice(0, 1800)}` : '',
    ].join('\n');
    const user = `${opts.instruction ? `Instruction from the team: ${opts.instruction}\n\n` : ''}Library copy (the job and the facts):\n\n${d.copy}`;
    const text = (await llm(system, user)).trim().replace(/^["“]|["”]$/g, '');
    if (!text) return d;
    const updated = this.updateDraft(id, { copy: text, save_override: true });
    this.q.updateRolloutDraft(id, { tailored_at: new Date(opts.now ?? Date.now()).toISOString() });
    liveEvents.emitUpdate({ kind: 'playbook' });
    return this.q.getRolloutDraft(id) ?? updated;
  }

  tailoringState(rolloutId: number): { running: boolean; done: number; total: number; errors: string[] } {
    try { return { running: false, done: 0, total: 0, errors: [], ...(JSON.parse(this.q.getSetting(`playbook_tailoring_${rolloutId}`, '') || '{}') as Partial<{ running: boolean; done: number; total: number; errors: string[] }>) }; } catch { return { running: false, done: 0, total: 0, errors: [] }; }
  }

  /** Tailor every draft in the rollout, in the order the walk shows them, so the first step is ready first; progress is kept so the walk can show it. */
  async tailorRollout(rolloutId: number): Promise<{ tailored: number; errors: string[] }> {
    const errors: string[] = []; let tailored = 0;
    const todo = this.q.listRolloutDrafts(rolloutId).filter((d) => d.copy && !d.tailored_at && ['ready', 'needs_input', 'blocked'].includes(d.status)).sort((a, b) => a.shop_id.localeCompare(b.shop_id) || walkIndexOf(a.kind, a.key) - walkIndexOf(b.kind, b.key) || a.order_no - b.order_no);
    const state = (running: boolean) => { this.q.setSetting(`playbook_tailoring_${rolloutId}`, JSON.stringify({ running, done: tailored + errors.length, total: todo.length, errors })); liveEvents.emitUpdate({ kind: 'playbook' }); };
    state(true);
    try {
      for (const d of todo) {
        try { await this.tailorDraft(d.id); tailored += 1; } catch (err) { errors.push(`${d.shop_name} / ${d.name}: ${(err as Error).message}`); }
        state(true);
      }
    } finally { state(false); }
    return { tailored, errors };
  }

  /** Monday: learn every shop again; where the profile moved, redo the live lifecycle bots as an update rollout (approved and run on its own where the shop allows it). */
  async weeklyUpdate(opts: { shopIds?: string[] } = {}): Promise<{ shops: number; learned: number; rollouts: { shop: string; rollout_id: number; reasons: string[]; auto: boolean; done: number }[]; errors: string[] }> {
    const out = { shops: 0, learned: 0, rollouts: [] as { shop: string; rollout_id: number; reasons: string[]; auto: boolean; done: number }[], errors: [] as string[] };
    const LIFECYCLE = ['sample_sent', 'delivered', 'first_sale', 'content_not_posted', 'no_post_10d', 'rejected', 'push_more_videos'];
    for (const shop of this.shops().filter((sh) => !opts.shopIds || opts.shopIds.includes(sh.shop_id))) {
      out.shops += 1;
      const before = this.q.listProfiles(shop.shop_id, 1)[0] ?? null;
      const r = await this.learnShop(shop.shop_id);
      out.errors.push(...r.errors.map((e) => `${shop.shop_name}: ${e}`));
      if (!r.profile) continue;
      out.learned += 1;
      const reasons = materialChange(before, r.profile);
      if (!reasons.length) continue;
      const cells = this.q.listPlaybookCells().filter((c) => c.shop_id === shop.shop_id && c.kind === 'automation' && c.status === 'set' && c.remote_id && LIFECYCLE.includes(c.playbook_key));
      if (!cells.length) continue;
      const keys = cells.map((c) => `automation:${c.playbook_key}`);
      try {
        const { rollout } = this.prepare({ shop_ids: [shop.shop_id], keys, updateKeys: keys, created_by: 'weekly learning', note: `Weekly learning: ${reasons.join('; ')}`, tailor: false });
        await this.tailorRollout(rollout.id);
        let done = 0;
        if (shop.auto_update) {
          for (const d of this.q.listRolloutDrafts(rollout.id)) if (d.status === 'ready') this.updateDraft(d.id, { status: 'approved' });
          if (this.q.getRollout(rollout.id)?.counts.approved) done = (await this.runRollout(rollout.id, 'weekly learning')).done;
        }
        out.rollouts.push({ shop: shop.shop_name, rollout_id: rollout.id, reasons, auto: shop.auto_update, done });
      } catch (err) { out.errors.push(`${shop.shop_name}: ${(err as Error).message}`); }
    }
    liveEvents.emitUpdate({ kind: 'playbook' });
    return out;
  }

  drafts(rolloutId: number): { rollout: PlaybookRollout; drafts: PlaybookDraft[]; walk: Record<string, number>; steps: typeof WALK_STEPS; tailoring: { running: boolean; done: number; total: number; errors: string[] } } {
    const rollout = this.q.getRollout(rolloutId);
    if (!rollout) throw new Error('Rollout not found');
    return { rollout, drafts: this.q.listRolloutDrafts(rolloutId), walk: this.walkState(rolloutId), steps: WALK_STEPS, tailoring: this.tailoringState(rolloutId) };
  }

  /** Where each shop's walk through a rollout stands (step index), shared between the people reviewing it. */
  walkState(rolloutId: number): Record<string, number> {
    try { return JSON.parse(this.q.getSetting(`playbook_walk:${rolloutId}`, '') || '{}') as Record<string, number>; } catch { return {}; }
  }

  setWalkIndex(rolloutId: number, shopId: string, index: number): Record<string, number> {
    const state = { ...this.walkState(rolloutId), [shopId]: Math.max(0, Math.floor(index)) };
    this.q.setSetting(`playbook_walk:${rolloutId}`, JSON.stringify(state));
    return state;
  }

  /** The draft's copy in English for the reviewer who does not read the shop's language (kept per text). */
  async englishForDraft(id: number): Promise<{ english: string | null }> {
    const d = this.q.getRolloutDraft(id);
    if (!d) throw new Error('Draft not found');
    if (!d.copy) return { english: null };
    if (d.language === 'en') return { english: d.copy };
    const [english] = await translateToEnglish(this.q, [d.copy], { accountId: d.account_id, ...(this.llm ? { llm: this.llm } : {}) });
    return { english };
  }

  /** The reviewer edited the English: render the shop-language copy again from it, placeholders intact. */
  async copyFromEnglish(id: number, english: string): Promise<PlaybookDraft> {
    const d = this.q.getRolloutDraft(id);
    if (!d) throw new Error('Draft not found');
    const text = english.trim();
    if (!text) throw new Error('The English text is empty.');
    if (d.language === 'en') return this.updateDraft(id, { copy: text });
    const llm = this.llm !== undefined ? this.llm : config.anthropicApiKey ? (s: string, u: string) => draftWithClaude(s, u, { maxTokens: 900, feature: 'playbook', accountId: d.account_id }) : null;
    if (!llm) throw new Error('ANTHROPIC_API_KEY is not set, so the English cannot be rendered back.');
    const { system, user } = fromEnglishPrompt(d.language, text, brandOf(d.shop_name));
    const out = (await llm(system, user)).trim().replace(/^["“]|["”]$/g, '');
    const updated = this.updateDraft(id, { copy: out });
    // The edited English is the translation of the new copy: keep it so the walk shows it without another call.
    this.q.putTranslation(textHash(out), out, text);
    return updated;
  }

  /** Reviewer edits: the copy, the whole payload, approval, start-after, save-as-override. Blockers are re-read from the payload. */
  updateDraft(id: number, patch: { copy?: string | null; payload?: Record<string, unknown>; status?: PlaybookDraftStatus; start_after?: boolean; save_override?: boolean; name?: string }): PlaybookDraft {
    const d = this.q.getRolloutDraft(id);
    if (!d) throw new Error('Draft not found');
    if (['done', 'undone'].includes(d.status)) throw new Error('This draft has already run.');
    let payload = patch.payload ?? d.payload;
    if (patch.copy !== undefined && patch.copy !== null) payload = withCopy(payload, patch.copy);
    const blockers = draftBlockers(payload, d.kind, d.action);
    let status = patch.status ?? d.status;
    if (patch.status === undefined && ['ready', 'needs_input', 'blocked'].includes(d.status)) status = blockers.hard.length ? 'blocked' : blockers.soft.length ? 'needs_input' : 'ready';
    if (patch.status === 'approved' && blockers.hard.length) throw new Error(`Cannot approve: ${blockers.hard.join('; ')}`);
    const out = this.q.updateRolloutDraft(id, { payload, copy: patch.copy !== undefined ? patch.copy : copyOf(payload), blockers: [...blockers.hard, ...blockers.soft], status, start_after: patch.start_after, save_override: patch.save_override, name: patch.name ?? String(payload.title ?? payload.name ?? d.name) })!;
    liveEvents.emitUpdate({ kind: 'playbook' });
    return out;
  }

  /** Rewrite the draft's copy in the brand's voice and the shop's language with Claude. */
  async rewriteDraft(id: number, instruction?: string | null): Promise<PlaybookDraft> {
    const d = this.q.getRolloutDraft(id);
    if (!d) throw new Error('Draft not found');
    const llm = this.llm !== undefined ? this.llm : config.anthropicApiKey ? (s: string, u: string) => draftWithClaude(s, u, { maxTokens: 700, feature: 'playbook' }) : null;
    if (!llm) throw new Error('ANTHROPIC_API_KEY is not set, so there is nothing to rewrite with.');
    if (!d.copy) throw new Error('This draft has no message to rewrite.');
    const lang = ({ de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' } as Record<string, string>)[d.language] ?? 'English';
    const examples = this.q.listExamples(true).slice(0, 3).map((e) => (e as { body?: string; text?: string }).body ?? (e as { text?: string }).text ?? '').filter(Boolean);
    const system = `You write short TikTok Shop creator messages for ${brandOf(d.shop_name)}, an affiliate programme run by Brightform. Write in ${lang}. Warm, direct, no corporate filler, no hashtags. Keep every placeholder exactly as written ([affiliate_name], [brief_link], links, emoji are fine). Keep the same facts and the same ask. One message, at most 900 characters, no subject line, no quotes around it. Return only the message.${examples.length ? `\n\nThe team's voice, for reference:\n${examples.map((e) => `---\n${e.slice(0, 600)}`).join('\n')}` : ''}`;
    const user = `${instruction ? `Instruction: ${instruction}\n\n` : ''}Rewrite this message:\n\n${d.copy}`;
    const text = (await llm(system, user)).trim().replace(/^["“]|["”]$/g, '');
    return this.updateDraft(id, { copy: text });
  }

  /** Create, update and start the approved drafts through the MCP, in dependency order, then re-check the shops touched. */
  async runRollout(id: number, actor: string | null): Promise<{ done: number; errors: string[] }> {
    const rollout = this.q.getRollout(id);
    if (!rollout) throw new Error('Rollout not found');
    if (!this.mcp.configured) throw new Error('CRUVA_API_KEY is not set.');
    if (rollout.status === 'running') throw new Error('This rollout is already running.');
    this.q.setRolloutStatus(id, 'running');
    liveEvents.emitUpdate({ kind: 'playbook' });
    const errors: string[] = []; let done = 0;
    const touched = new Set<string>();
    try {
      const all = this.q.listRolloutDrafts(id).filter((d) => d.status === 'approved').sort((a, b) => a.shop_id.localeCompare(b.shop_id) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.order_no - b.order_no);
      const created = new Map<string, string>(); // `${shop}:${kind}:${key}` -> remote id
      const briefLinks = new Map<string, string>();
      for (const d of all) {
        touched.add(d.shop_id);
        try {
          let payload = resolveRefs(d.payload, (kind, key) => created.get(`${d.shop_id}:${kind}:${key}`) ?? null);
          const link = briefLinks.get(d.shop_id);
          payload = substitute(payload, { '[brief_link]': link ?? '' });
          payload = stripEmptyBriefLines(payload);
          const unresolved = JSON.stringify(payload).match(/\[(group|list):[a-z_]+\]/);
          if (unresolved) throw new Error(`${unresolved[0]} was not created in this rollout (skipped or failed)`);
          const text = await this.mcp.call(d.tool, payload);
          let remoteId = d.remote_id;
          if (d.action === 'create') { remoteId = idFromResult(text) ?? null; created.set(`${d.shop_id}:${d.kind}:${d.key}`, remoteId ?? ''); if (d.kind === 'brief') { const l = unwrap(text).match(/https?:\/\/\S+/)?.[0]; if (l) { briefLinks.set(d.shop_id, l); const learned = this.learnedFor(d.shop_id) ?? emptyLearned(); learned.brief_link = l; this.q.setSetting(`playbook_learned_${d.shop_id}`, JSON.stringify(learned)); } } }
          if (d.start_after && d.action !== 'start' && TOGGLE_TOOL[d.kind] && remoteId) { try { await this.mcp.call(TOGGLE_TOOL[d.kind]!, { shop_id: d.shop_id, [ID_ARG[d.kind] ?? 'id']: remoteId, status: 'active' }); } catch (err) { errors.push(`${d.shop_name} / ${d.name}: created but not started (${(err as Error).message})`); } }
          this.q.updateRolloutDraft(d.id, { status: 'done', remote_id: remoteId, remote_name: d.name, result: unwrap(text).slice(0, 600) });
          this.q.setPlaybookCell({ shop_id: d.shop_id, kind: d.kind, playbook_key: d.key, status: d.start_after || d.action === 'start' || d.kind !== 'automation' ? 'set' : 'paused', remote_id: remoteId, remote_name: d.name, applied_at: new Date().toISOString(), checked_at: new Date().toISOString(), note: d.start_after || d.action === 'start' || d.kind !== 'automation' ? null : 'created paused: start it when ready' });
          if (d.save_override) { const item = this.libraryItems().find((i) => i.kind === d.kind && i.key === d.key); if (item) this.q.upsertPlaybookItem({ kind: d.kind, key: d.key, language: `shop:${d.shop_id}`, name: item.name, description: `${d.shop_name} override`, config: { ...item.config, ...stripShopFields(d.payload) }, source: 'override' }); }
          done += 1;
        } catch (err) {
          const msg = (err as Error).message;
          errors.push(`${d.shop_name} / ${d.name}: ${msg}`);
          this.q.updateRolloutDraft(d.id, { status: 'error', result: msg.slice(0, 600) });
          this.q.setPlaybookCell({ shop_id: d.shop_id, kind: d.kind, playbook_key: d.key, status: 'error', note: msg.slice(0, 200) });
        }
        liveEvents.emitUpdate({ kind: 'playbook' });
      }
      for (const shopId of touched) { const shop = this.shops().find((s) => s.shop_id === shopId); if (shop) { try { await this.checkShop(shop, false); } catch (err) { errors.push(`${shop.shop_name}: re-check failed (${(err as Error).message})`); } } }
      this.q.setRolloutStatus(id, 'done', new Date().toISOString());
      log.info(`Cruva rollout #${id} by ${actor ?? 'unknown'}: ${done} done, ${errors.length} error(s)`);
    } finally {
      if (this.q.getRollout(id)?.status === 'running') this.q.setRolloutStatus(id, 'done', new Date().toISOString());
      liveEvents.emitUpdate({ kind: 'playbook' });
    }
    return { done, errors };
  }

  /** Delete what a rollout created and stop what it started. Updates cannot be undone from here. */
  async undoRollout(id: number): Promise<{ undone: number; errors: string[] }> {
    const errors: string[] = []; let undone = 0;
    for (const d of this.q.listRolloutDrafts(id).filter((x) => x.status === 'done')) {
      try {
        if (d.action === 'create' && d.remote_id && DELETE_TOOL[d.kind]) await this.mcp.call(DELETE_TOOL[d.kind]!, { shop_id: d.shop_id, [ID_ARG[d.kind] ?? 'id']: d.remote_id });
        else if (d.action === 'start' && d.remote_id && TOGGLE_TOOL[d.kind]) await this.mcp.call(TOGGLE_TOOL[d.kind]!, { shop_id: d.shop_id, [ID_ARG[d.kind] ?? 'id']: d.remote_id, status: 'stopped' });
        else if (d.action === 'update') { errors.push(`${d.shop_name} / ${d.name}: an update cannot be undone automatically`); continue; }
        this.q.updateRolloutDraft(d.id, { status: 'undone' });
        this.q.setPlaybookCell({ shop_id: d.shop_id, kind: d.kind, playbook_key: d.key, status: d.action === 'start' ? 'paused' : 'missing', remote_id: d.action === 'start' ? d.remote_id : null, remote_name: d.action === 'start' ? d.remote_name : null, note: 'undone' });
        undone += 1;
      } catch (err) { errors.push(`${d.shop_name} / ${d.name}: ${(err as Error).message}`); }
    }
    this.q.setRolloutStatus(id, 'undone');
    liveEvents.emitUpdate({ kind: 'playbook' });
    return { undone, errors };
  }

  deleteRollout(id: number): void {
    for (const d of this.q.listRolloutDrafts(id)) { const cell = this.q.listPlaybookCells().find((c) => c.shop_id === d.shop_id && c.kind === d.kind && c.playbook_key === d.key); if (cell?.status === 'queued') this.q.setPlaybookCell({ shop_id: d.shop_id, kind: d.kind, playbook_key: d.key, status: d.action === 'start' ? 'paused' : d.action === 'update' ? 'drift' : 'missing', note: null }); }
    this.q.deleteRollout(id);
    liveEvents.emitUpdate({ kind: 'playbook' });
  }

  /** Mark a cell by hand (set up in the Cruva UI, or not applicable). */
  mark(shopId: string, kind: PlaybookKind, key: string, status: PlaybookSetupCell['status'], note?: string | null): void {
    this.q.setPlaybookCell({ shop_id: shopId, kind, playbook_key: key, status, note: status === 'set' ? `by hand${note ? `: ${note}` : ''}` : (note ?? null), checked_at: new Date().toISOString(), ...(status === 'set' ? { applied_at: new Date().toISOString(), remote_id: null, remote_name: null } : {}) });
    liveEvents.emitUpdate({ kind: 'playbook' });
  }

  /** Per account: how many library items are in place out of the ones that can be checked, for the overview and the monitor. */
  coverageByAccount(): Map<number, { set: number; total: number; missing_core: string[]; paused_core: string[] }> {
    const out = new Map<number, { set: number; total: number; missing_core: string[]; paused_core: string[] }>();
    const cells = this.q.listPlaybookCells();
    const core = new Set(this.libraryItems().filter((i) => i.config.core).map((i) => `${i.kind}:${i.key}`));
    const names = new Map(this.libraryItems().map((i) => [`${i.kind}:${i.key}`, i.name]));
    for (const s of this.shops()) {
      const mine = cells.filter((c) => c.shop_id === s.shop_id && c.status !== 'unknown' && c.status !== 'manual');
      if (!mine.length) continue;
      const cur = out.get(s.account_id) ?? { set: 0, total: 0, missing_core: [], paused_core: [] };
      for (const c of mine) {
        cur.total += 1;
        if (c.status === 'set' || c.status === 'drift') cur.set += 1;
        const k = `${c.kind}:${c.playbook_key}`;
        if (core.has(k) && c.status === 'missing') cur.missing_core.push(`${s.shop_name}: ${names.get(k) ?? c.playbook_key}`);
        if (core.has(k) && c.status === 'paused') cur.paused_core.push(`${s.shop_name}: ${names.get(k) ?? c.playbook_key}`);
      }
      out.set(s.account_id, cur);
    }
    return out;
  }
}

// ---- helpers ----

/** The human copy inside a payload: the last DM message, the invite message, or the email body. */
export function copyOf(payload: Record<string, unknown>): string | null {
  const dms = payload.dm_messages as { type?: string; content?: string }[] | undefined;
  if (Array.isArray(dms)) { const m = [...dms].reverse().find((x) => (x.type ?? 'message') === 'message' && typeof x.content === 'string'); if (m) return m.content!; }
  if (typeof payload.email_body === 'string') return payload.email_body;
  const inv = payload.invite_details as { message?: string } | undefined;
  if (inv && typeof inv.message === 'string') return inv.message;
  return null;
}

export function withCopy(payload: Record<string, unknown>, copy: string): Record<string, unknown> {
  const out = { ...payload };
  const dms = out.dm_messages as { type?: string; content?: string }[] | undefined;
  if (Array.isArray(dms)) { const idx = dms.map((x, i) => ((x.type ?? 'message') === 'message' ? i : -1)).filter((i) => i >= 0).pop(); if (idx !== undefined) { out.dm_messages = dms.map((x, i) => (i === idx ? { ...x, content: copy } : x)); return out; } }
  if (typeof out.email_body === 'string') { out.email_body = copy; return out; }
  const inv = out.invite_details as { message?: string } | undefined;
  if (inv) out.invite_details = { ...inv, message: copy };
  return out;
}

/** Hard blockers stop approval; soft ones are inputs the reviewer should look at. */
export function draftBlockers(payload: Record<string, unknown>, kind: PlaybookKind, action: PlaybookDraft['action']): { hard: string[]; soft: string[] } {
  const hard: string[] = []; const soft: string[] = [];
  if (action === 'start') return { hard, soft };
  if (kind === 'email_campaign' && (!Array.isArray(payload.sender_emails) || !payload.sender_emails.length)) hard.push('needs a sender email on the shop');
  if (kind === 'automation') {
    if (payload.outreach_audience === 'groups' && !payload.group_id) hard.push('needs a group id');
    if (payload.outreach_audience === 'list' && (!Array.isArray(payload.list_ids) || !payload.list_ids.length)) hard.push('needs a list');
    const of = payload.outreach_filters as Record<string, unknown> | undefined;
    if (payload.outreach_audience === 'new_affiliates' && of && Array.isArray(of.categories) && !of.categories.length) soft.push('categories empty: the whole affiliate pool');
    const inv = payload.invite_details as Record<string, unknown> | undefined;
    if (/invite/.test(String(payload.message_type ?? '')) && inv && Array.isArray(inv.products) && !inv.products.length) hard.push('invite needs at least one product');
    if (!copyOf(payload) && !/invite$/.test(String(payload.message_type ?? ''))) hard.push('the DM has no message');
  }
  if (kind === 'list') { const f = payload.filters as Record<string, unknown> | undefined; if (f && Array.isArray(f.categories) && !f.categories.length && !payload.searchable_query) soft.push('categories empty: the list would be the top-GMV creators of the whole platform'); }
  if (kind === 'group' && (!payload.filters || !Object.keys(payload.filters as object).length)) hard.push('a group needs at least one filter');
  return { hard, soft };
}

function resolveRefs<T>(v: T, lookup: (kind: string, key: string) => string | null): T {
  if (typeof v === 'string') { const m = v.match(/^\[(group|list):([a-z_]+)\]$/); if (m) { const id = lookup(m[1], m[2]); return (id ? (m[1] === 'list' ? (Number(id) || id) : id) : v) as T; } return v; }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, lookup)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolveRefs(x, lookup)])) as T;
  return v;
}

/** Drop a "👉 " line whose link was never filled, so a message never ships with an empty pointer. */
function stripEmptyBriefLines<T>(v: T): T {
  if (typeof v === 'string') return v.split('\n').filter((l) => !/^\s*(👉|->|→)?\s*$/.test(l) || l === '').reduce<string[]>((acc, l) => { if (l === '' && acc[acc.length - 1] === '') return acc; acc.push(l); return acc; }, []).join('\n').replace(/\n{3,}/g, '\n\n').trim() as T;
  if (Array.isArray(v)) return v.map((x) => stripEmptyBriefLines(x)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, stripEmptyBriefLines(x)])) as T;
  return v;
}

function stripShopFields(payload: Record<string, unknown>): Record<string, unknown> {
  const { shop_id: _s, group_id: _g, list_ids: _l, campaign_id: _c, sender_emails: _e, ...rest } = payload;
  return rest;
}
