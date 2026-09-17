import type { Queries } from '../db/queries.js';
import type { PlaybookData, PlaybookItem, PlaybookKind, PlaybookSetupCell } from '../sweep/types.js';
import { cruvaCrm, cruvaEndpoints, type CruvaCrmClient } from '../gmv/cruva.js';
import { SEED_PLAYBOOK } from './seed.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Cruva best-practice matrix: which of the standard groups, automations, workflows and email
 * campaigns each shop has, and a bulk "apply" that creates the missing ones (through the Cruva
 * REST API when the endpoints are configured, otherwise as a ready-to-run pack for the Cruva MCP).
 * The remote state comes from the API when configured or from a pasted MCP listing.
 */

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Name patterns that count as "this playbook item exists", learnt from how the team names things across shops. */
const ALIASES: Record<string, RegExp[]> = {
  sample_sent: [/sample sent/, /sample verschickt/, /echantillon envoye/, /campione inviato/, /muestra enviada/],
  content_not_posted: [/content not posted/, /no content posted/, /not posted/, /kein content/, /pas de contenu/, /nessun contenuto/, /sin contenido/],
  push_more_videos: [/push more videos/, /more videos/, /mehr videos/, /plus de videos/, /piu video/, /mas videos/],
  retarget_bonus: [/retarget/, /re target/, /bonus/, /reactivation/, /win back/],
  deals_info_existing: [/deals info/, /deal info/, /deals? (info|message|reminder)/, /existing creators/],
  first_outreach: [/first outreach/, /big first outreach/, /new (year|spring|summer|autumn|winter)/, /big outreach/, /new creators/, /first contact/],
  monthly_deals_outreach: [/(january|february|march|april|may|june|july|august|september|october|november|december) deals/, /deals outreach/, /deals big outreach/],
  new_product_outreach: [/new (product|bundles?|fruits?|flavou?rs?|launch)/, /neue? produkt/, /nouveau produit/, /nuovo prodotto/, /nuevo producto/],
  ai_auto_replies: [/ai auto repl/, /auto repl/],
  top_creators_collab: [/target collab/, /top ?\d* creators/, /top creators/, /collab/],
  top_creators: [/top creators/, /top performer/, /best creators/],
  inactive_creators: [/inactive/, /retarget/, /bonus/, /inaktiv/],
  existing_creators: [/existing creators/, /all creators/, /alle creator/, /bestehende/],
  sample_chase: [/sample .*chase/, /sample .*post/, /no post/],
  creator_newsletter: [/newsletter/, /deals/],
};

export function matchesItem(key: string, name: string, remoteName: string): boolean {
  const r = norm(remoteName);
  const n = norm(name);
  if (!r) return false;
  if (r === n || r.includes(n)) return true;
  return (ALIASES[key] ?? []).some((re) => re.test(r));
}

/** Parse the plain-text output of the Cruva MCP list tools (automations, groups, workflows, email campaigns). */
export function parseMcpListing(text: string): { kind: PlaybookKind; remote_id: string; name: string; enabled: boolean; raw: Record<string, string> }[] {
  const out: { kind: PlaybookKind; remote_id: string; name: string; enabled: boolean; raw: Record<string, string> }[] = [];
  let section: PlaybookKind | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const head = line.match(/^(Automations|Groups|Workflows|Email campaigns|Lists)\b/i);
    if (head) { section = ({ automations: 'automation', groups: 'group', workflows: 'workflow', 'email campaigns': 'email_campaign', lists: 'list' } as Record<string, PlaybookKind>)[head[1].toLowerCase()]; continue; }
    const m = line.match(/^-\s+(.+?)\s+\(ID:\s*([A-Za-z0-9_-]+)\)(.*)$/);
    if (!m) continue;
    const rest = m[3];
    const fields: Record<string, string> = {};
    for (const part of rest.split('|')) { const kv = part.split(':'); if (kv.length >= 2) fields[kv[0].trim().toLowerCase()] = kv.slice(1).join(':').trim(); }
    let kind: PlaybookKind = section ?? 'automation';
    if (!section) { if (fields.creators !== undefined) kind = 'group'; else if (fields.trigger !== undefined || fields.steps !== undefined) kind = 'workflow'; else if (fields.subject !== undefined || fields.sender !== undefined) kind = 'email_campaign'; }
    out.push({ kind, remote_id: m[2], name: m[1].trim(), enabled: !/stopped|archived|paused/i.test(fields.status ?? ''), raw: fields });
  }
  return out;
}

/** Replace [brand] in every string of a config. */
export function brandify<T>(v: T, brand: string): T {
  if (typeof v === 'string') return v.replace(/\[brand\]/g, brand) as T;
  if (Array.isArray(v)) return v.map((x) => brandify(x, brand)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, brandify(x, brand)])) as T;
  return v;
}

export function shopLanguage(market: string | null | undefined): string {
  return ({ DE: 'de', AT: 'de', FR: 'fr', IT: 'it', ES: 'es' } as Record<string, string>)[(market ?? '').toUpperCase()] ?? 'en';
}

export class PlaybookEngine {
  constructor(private q: Queries, private client: CruvaCrmClient = cruvaCrm) {}

  seed(): void {
    const n = this.q.seedPlaybookIfEmpty(SEED_PLAYBOOK.map((s) => ({ ...s, description: s.description ?? null })));
    if (n) log.info(`Cruva playbook seeded with ${n} items`);
  }

  endpoints(): Record<string, string> {
    return cruvaEndpoints(this.q.getSetting('cruva_endpoints', '') || null);
  }

  private shops() {
    const accounts = new Map(this.q.listAccounts().map((a) => [a.id, a]));
    const tts = this.q.listTtsShops();
    return this.q.listShops().map((s) => {
      const a = accounts.get(s.account_id);
      const market = tts.find((t) => t.account_id === s.account_id)?.market ?? (a?.markets ?? '').split(/[,\s/]+/)[0] ?? null;
      const override = this.q.getSetting(`playbook_lang_${s.shop_id}`, '');
      return { shop_id: s.shop_id, shop_name: s.shop_name, account_id: s.account_id, account_name: a?.name ?? '', market: market || null, language: override || shopLanguage(market) };
    }).filter((s) => accounts.get(s.account_id)?.enabled !== false);
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
    return { items, shops, cells: this.q.listPlaybookCells(), languages: [...new Set(items.map((i) => i.language))].sort(), cruva_configured: this.client.configured, endpoints: this.endpoints(), last_error: this.q.getSetting('playbook_last_error', '') || null };
  }

  /** Recompute set / missing for one shop from the stored remote items. */
  reconcile(shopId: string): void {
    const remote = this.q.listRemoteItems(shopId);
    if (!remote.length) return;
    const now = new Date().toISOString();
    const keys = new Map<string, PlaybookItem>();
    for (const i of this.q.listPlaybook()) if (i.enabled && !keys.has(`${i.kind}:${i.key}`)) keys.set(`${i.kind}:${i.key}`, i);
    const cells = this.q.listPlaybookCells();
    for (const item of keys.values()) {
      const hit = remote.find((r) => r.kind === item.kind && matchesItem(item.key, item.name, r.name));
      const cur = cells.find((c) => c.shop_id === shopId && c.kind === item.kind && c.playbook_key === item.key);
      if (hit) this.q.setPlaybookCell({ shop_id: shopId, kind: item.kind, playbook_key: item.key, status: 'set', remote_id: hit.remote_id, remote_name: hit.name, checked_at: now, note: hit.enabled ? null : 'exists but stopped' });
      else if (cur?.status === 'queued') this.q.setPlaybookCell({ shop_id: shopId, kind: item.kind, playbook_key: item.key, status: 'queued', checked_at: now });
      else this.q.setPlaybookCell({ shop_id: shopId, kind: item.kind, playbook_key: item.key, status: 'missing', remote_id: null, remote_name: null, checked_at: now, note: null });
    }
  }

  /** Store a pasted MCP listing (or JSON array) as the shop's remote state. */
  importListing(shopId: string, text: string): { imported: number } {
    let rows: { kind: PlaybookKind; remote_id: string; name: string; enabled: boolean; raw?: unknown }[] = [];
    const trimmed = text.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const j = JSON.parse(trimmed) as unknown;
        const arr = Array.isArray(j) ? j : Object.values(j as Record<string, unknown>).flat();
        rows = (arr as Record<string, unknown>[]).filter((x) => x && typeof x === 'object').map((x) => ({ kind: (String(x.kind ?? x.type ?? 'automation') as PlaybookKind), remote_id: String(x.id ?? x.remote_id ?? x.campaign_id ?? ''), name: String(x.name ?? x.title ?? x.campaign_name ?? ''), enabled: !/stopped|archived|paused/i.test(String(x.status ?? 'active')), raw: x })).filter((r) => r.remote_id && r.name);
      } catch { rows = parseMcpListing(trimmed); }
    } else rows = parseMcpListing(trimmed);
    if (!rows.length) throw new Error('Nothing recognised. Paste the output of the Cruva MCP list_automations / list_groups / list_workflows / list_email_campaigns tools, or a JSON array.');
    const byKind = new Map<PlaybookKind, typeof rows>();
    for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
    let n = 0;
    for (const [kind, list] of byKind) n += this.q.replaceRemoteItems(shopId, kind, list);
    this.reconcile(shopId);
    liveEvents.emitUpdate({ kind: 'playbook' });
    return { imported: n };
  }

  /** Pull the remote state over the REST API for one shop (or all). */
  async check(shopId?: string): Promise<{ shops: number; errors: string[] }> {
    if (!this.client.configured) throw new Error('CRUVA_API_KEY is not set. Paste the MCP listing per shop instead.');
    const errors: string[] = [];
    const paths = this.endpoints();
    let shops = 0;
    for (const s of this.shops().filter((x) => !shopId || x.shop_id === shopId)) {
      try {
        for (const kind of ['automation', 'group', 'workflow', 'email_campaign'] as PlaybookKind[]) {
          const list = await this.client.list(paths[kind], s.shop_id);
          this.q.replaceRemoteItems(s.shop_id, kind, list.map((x) => ({ remote_id: String(x.id ?? x._id ?? x.campaign_id ?? ''), name: String(x.name ?? x.title ?? x.campaign_name ?? ''), enabled: !/stopped|archived|paused/i.test(String(x.status ?? 'active')), raw: x })).filter((r) => r.remote_id && r.name));
        }
        this.reconcile(s.shop_id);
        shops += 1;
      } catch (err) {
        errors.push(`${s.shop_name}: ${(err as Error).message}`);
      }
    }
    this.q.setSetting('playbook_last_error', errors.join(' · ').slice(0, 500));
    liveEvents.emitUpdate({ kind: 'playbook' });
    return { shops, errors };
  }

  /** The exact create payload for a shop and item, brand-substituted, with group references resolved when the group exists. */
  payloadFor(shopId: string, item: PlaybookItem, brand: string): { tool: string; payload: Record<string, unknown>; blockers: string[] } {
    const cfg = brandify({ ...item.config }, brand) as Record<string, unknown>;
    const blockers: string[] = [];
    delete cfg.manual;
    if (typeof cfg.group_key === 'string') {
      const cell = this.q.listPlaybookCells().find((c) => c.shop_id === shopId && c.kind === 'group' && c.playbook_key === cfg.group_key && c.status === 'set');
      if (cell?.remote_id) cfg.group_id = cell.remote_id; else blockers.push(`needs the "${cfg.group_key}" group first`);
      delete cfg.group_key;
    }
    if (Array.isArray(cfg.list_ids) && !cfg.list_ids.length && cfg.outreach_audience === 'list') blockers.push('needs a saved creator list (build one with the Cruva AI search)');
    if (Array.isArray(cfg.sender_emails) && !cfg.sender_emails.length) blockers.push('needs a sender email linked in Cruva');
    if (item.config.manual) blockers.push('set up in the Cruva UI');
    const tool = ({ automation: 'create_automation', group: 'create_group', workflow: 'create_workflow', email_campaign: 'create_email_campaign', list: 'create_list' } as Record<string, string>)[item.kind];
    return { tool, payload: { shop_id: shopId, ...cfg }, blockers };
  }

  /** Create the missing items on the chosen shops: over REST when configured, else queued as a pack for the MCP. Groups go first so automations can reference them. */
  async apply(opts: { shop_ids: string[]; keys: string[]; language?: string | null; brands?: Record<string, string> }): Promise<{ created: number; queued: number; blocked: number; errors: string[]; pack: { shop_id: string; shop_name: string; tool: string; payload: Record<string, unknown>; blockers: string[] }[] }> {
    const items = this.q.listPlaybook().filter((i) => i.enabled);
    const shops = this.shops().filter((s) => opts.shop_ids.includes(s.shop_id));
    const paths = this.endpoints();
    const order: Record<string, number> = { group: 0, list: 1, automation: 2, workflow: 3, email_campaign: 4 };
    const wanted = [...new Set(opts.keys)].map((k) => { const [kind, key] = k.includes(':') ? k.split(':') : [null, k]; return { kind, key }; });
    const pack: { shop_id: string; shop_name: string; tool: string; payload: Record<string, unknown>; blockers: string[] }[] = [];
    const errors: string[] = [];
    let created = 0; let queued = 0; let blocked = 0;
    for (const s of shops) {
      const brand = opts.brands?.[s.shop_id] ?? s.shop_name.replace(/\s+(DE|FR|IT|ES|UK|AT|NL|BE|PL)\b.*$/i, '').trim();
      const lang = opts.language || s.language;
      const chosen = wanted.map((w) => items.filter((i) => i.key === w.key && (!w.kind || i.kind === w.kind)).sort((a, b) => (a.language === lang ? 0 : a.language === '*' ? 1 : a.language === 'en' ? 2 : 3) - (b.language === lang ? 0 : b.language === '*' ? 1 : b.language === 'en' ? 2 : 3))[0]).filter((i): i is PlaybookItem => Boolean(i)).sort((a, b) => order[a.kind] - order[b.kind]);
      for (const item of chosen) {
        const cell = this.q.listPlaybookCells().find((c) => c.shop_id === s.shop_id && c.kind === item.kind && c.playbook_key === item.key);
        if (cell?.status === 'set') continue;
        const p = this.payloadFor(s.shop_id, item, brand);
        if (p.blockers.length) { blocked += 1; pack.push({ shop_id: s.shop_id, shop_name: s.shop_name, ...p }); this.q.setPlaybookCell({ shop_id: s.shop_id, kind: item.kind, playbook_key: item.key, status: 'queued', note: p.blockers.join('; ') }); continue; }
        if (this.client.configured) {
          try {
            const { shop_id: _sid, ...body } = p.payload;
            const r = await this.client.request<Record<string, unknown>>('POST', paths[item.kind], s.shop_id, body);
            const id = String(r.id ?? (r.data as Record<string, unknown> | undefined)?.id ?? r._id ?? '');
            this.q.setPlaybookCell({ shop_id: s.shop_id, kind: item.kind, playbook_key: item.key, status: 'set', remote_id: id || null, remote_name: String(body.title ?? body.name ?? item.name), applied_at: new Date().toISOString(), checked_at: new Date().toISOString(), note: null });
            created += 1;
            continue;
          } catch (err) {
            errors.push(`${s.shop_name} / ${item.name}: ${(err as Error).message}`);
            this.q.setPlaybookCell({ shop_id: s.shop_id, kind: item.kind, playbook_key: item.key, status: 'error', note: (err as Error).message.slice(0, 200) });
            pack.push({ shop_id: s.shop_id, shop_name: s.shop_name, ...p });
            continue;
          }
        }
        queued += 1;
        pack.push({ shop_id: s.shop_id, shop_name: s.shop_name, ...p });
        this.q.setPlaybookCell({ shop_id: s.shop_id, kind: item.kind, playbook_key: item.key, status: 'queued', note: 'queued: run the pack with the Cruva MCP, then paste the listing back' });
      }
    }
    liveEvents.emitUpdate({ kind: 'playbook' });
    return { created, queued, blocked, errors, pack };
  }

  /** Mark a cell by hand (set up in the Cruva UI, or not applicable). */
  mark(shopId: string, kind: PlaybookKind, key: string, status: PlaybookSetupCell['status'], note?: string | null): void {
    this.q.setPlaybookCell({ shop_id: shopId, kind, playbook_key: key, status, note: note ?? null, checked_at: new Date().toISOString(), ...(status === 'set' ? { applied_at: new Date().toISOString() } : {}) });
    liveEvents.emitUpdate({ kind: 'playbook' });
  }
}
