import type { Queries } from '../db/queries.js';
import type { AirtableData, AirtableRecordRow, AirtableTableSchema } from '../sweep/types.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { liveEvents } from '../live/events.js';

/**
 * Mirror of Sofía's Airtable base ("Brightform Leads Pipeline") inside the platform. The base stays her
 * working tool; the platform reads it every fifteen minutes (only records changed since the last pull,
 * a full listing twice a day to catch deletions) and keeps every record as JSON with its table's schema,
 * so the pages can show her fields next to ours and the matchers can tie her records to our leads,
 * prospects, contacts and enquiries. Formula fields are read like any other and never written.
 */

export const DEFAULT_BASE_ID = 'appGXOv46TTb9fpwa';
const API = 'https://api.airtable.com/v0';

export interface AirtableRecord { id: string; createdTime: string; fields: Record<string, unknown> }
export type Fetcher = (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Five requests a second per base: calls queue up behind a 210 ms gap. */
export class AirtableClient {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(private token: string, private fetcher: Fetcher = (url, init) => fetch(url, init), private gapMs = 210) {}
  get configured(): boolean { return Boolean(this.token); }

  private call<T>(path: string, params: Record<string, string | string[]> = {}, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.last + this.gapMs - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); this.last = Date.now();
      const url = new URL(`${API}${path}`);
      for (const [k, v] of Object.entries(params)) { if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x); else url.searchParams.set(k, v); }
      for (let attempt = 0; ; attempt += 1) {
        const res = await this.fetcher(url.href, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
        if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 30000)); continue; }
        if (res.status >= 400) { const t = await res.text(); throw new Error(`Airtable ${res.status}${t ? `: ${t.slice(0, 200)}` : ''}`); }
        return (await res.json()) as T;
      }
    };
    const next = this.chain.then(run); this.chain = next.catch(() => undefined); return next;
  }

  listBases(): Promise<{ bases: { id: string; name: string; permissionLevel: string }[] }> { return this.call('/meta/bases'); }
  schema(baseId: string): Promise<{ tables: AirtableTableSchema[] }> { return this.call(`/meta/bases/${baseId}/tables`); }

  /** Every page of a table, optionally only records modified after a moment. */
  async listRecords(baseId: string, tableId: string, opts: { modifiedAfter?: string | null; fields?: string[]; pageSize?: number } = {}): Promise<AirtableRecord[]> {
    const out: AirtableRecord[] = [];
    let offset: string | undefined;
    const params: Record<string, string | string[]> = { pageSize: String(opts.pageSize ?? 100), cellFormat: 'json' };
    if (opts.modifiedAfter) params.filterByFormula = `IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('${opts.modifiedAfter}'))`;
    if (opts.fields) params['fields[]'] = opts.fields;
    do {
      const page = await this.call<{ records: AirtableRecord[]; offset?: string }>(`/${baseId}/${encodeURIComponent(tableId)}`, offset ? { ...params, offset } : params);
      out.push(...page.records);
      offset = page.offset;
    } while (offset);
    return out;
  }

  async updateRecord(baseId: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<AirtableRecord> {
    return this.call(`/${baseId}/${encodeURIComponent(tableId)}/${recordId}`, {}, { method: 'PATCH', body: { fields, typecast: true } });
  }

  async createRecord(baseId: string, tableId: string, fields: Record<string, unknown>): Promise<AirtableRecord> {
    return this.call(`/${baseId}/${encodeURIComponent(tableId)}`, {}, { method: 'POST', body: { fields, typecast: true } });
  }
}

/** The modified time Airtable reports in a record, when the table carries a last-modified field; else the sync time. */
const lastModified = (schema: AirtableTableSchema, fields: Record<string, unknown>): string | null => {
  const f = schema.fields.find((x) => x.type === 'lastModifiedTime');
  const v = f ? fields[f.name] : undefined;
  return typeof v === 'string' ? v : null;
};

/** A text value for searching and display: the primary field's value as a string. */
export const primaryOf = (schema: AirtableTableSchema, fields: Record<string, unknown>): string | null => {
  const f = schema.fields.find((x) => x.id === schema.primaryFieldId) ?? schema.fields[0];
  const v = f ? fields[f.name] : undefined;
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x && 'name' in (x as object) ? String((x as { name: unknown }).name) : String(x))).join(', ');
  if (typeof v === 'object' && 'name' in (v as object)) return String((v as { name: unknown }).name);
  return JSON.stringify(v);
};

export class AirtableMirror {
  private syncing = false;
  private lastError: string | null = null;
  private runs = 0;
  constructor(private q: Queries, private client: AirtableClient = new AirtableClient(config.airtableToken)) {}

  get baseId(): string { return this.q.getSetting('airtable_base_id', '') || DEFAULT_BASE_ID; }
  get configured(): boolean { return this.client.configured; }

  data(): AirtableData {
    return { configured: this.configured, base_id: this.baseId, base_name: this.q.getSetting('airtable_base_name', '') || null, tables: this.q.listAirtableTables(this.baseId), last_sync_at: this.q.getSetting('airtable_last_sync_at', '') || null, last_error: this.lastError ?? (this.q.getSetting('airtable_last_error', '') || null), syncing: this.syncing, interval_minutes: 15 };
  }

  /** Pull the schema and every table: changed records since the last pull, or everything (with deletions) on a full sync. */
  async sync(opts: { full?: boolean } = {}): Promise<{ tables: number; records: number; removed: number; errors: string[] }> {
    if (!this.configured) throw new Error('AIRTABLE_TOKEN is not set.');
    if (this.syncing) return { tables: 0, records: 0, removed: 0, errors: ['A sync is already running'] };
    this.syncing = true; this.runs += 1;
    const out = { tables: 0, records: 0, removed: 0, errors: [] as string[] };
    const baseId = this.baseId;
    try {
      try { const bases = await this.client.listBases(); const b = bases.bases.find((x) => x.id === baseId); if (b) this.q.setSetting('airtable_base_name', b.name); } catch (err) { log.info(`Airtable bases: ${(err as Error).message}`); }
      const { tables } = await this.client.schema(baseId);
      for (const t of tables) this.q.upsertAirtableTable({ base_id: baseId, table_id: t.id, name: t.name, schema: t });
      const known = this.q.listAirtableTables(baseId);
      // A full listing twice a day (every 48th quarter-hour run) or when asked, so deletions are caught; otherwise only what changed.
      const full = opts.full || this.runs % 48 === 1;
      for (const t of tables) {
        const since = full ? null : known.find((k) => k.table_id === t.id)?.synced_at ?? null;
        try {
          const records = await this.client.listRecords(baseId, t.id, { modifiedAfter: since });
          const syncedAt = new Date().toISOString();
          this.q.upsertAirtableRecords(baseId, t.id, records.map((r) => ({ id: r.id, primary: primaryOf(t, r.fields), fields: r.fields, modified_at: lastModified(t, r.fields) ?? syncedAt })), syncedAt);
          if (full) out.removed += this.q.pruneAirtableRecords(baseId, t.id, records.map((r) => r.id));
          this.q.markAirtableTableSynced(baseId, t.id, { synced_at: syncedAt, ...(full ? { full_synced_at: syncedAt } : {}), error: null });
          out.tables += 1; out.records += records.length;
        } catch (err) { out.errors.push(`${t.name}: ${(err as Error).message}`); this.q.markAirtableTableSynced(baseId, t.id, { error: (err as Error).message }); }
      }
      this.q.setSetting('airtable_last_sync_at', new Date().toISOString());
      this.lastError = out.errors.length ? out.errors.join(' | ') : null;
      this.q.setSetting('airtable_last_error', this.lastError ?? '');
    } catch (err) {
      this.lastError = (err as Error).message; this.q.setSetting('airtable_last_error', this.lastError); out.errors.push(this.lastError);
    } finally { this.syncing = false; liveEvents.emitUpdate({ kind: 'airtable' }); }
    return out;
  }

  /** Records of a table with link fields resolved to the linked records' names ("Account": ["rec…"] → ["Kijimea"]). */
  records(tableId: string, opts: { q?: string; limit?: number; offset?: number } = {}): { rows: (AirtableRecordRow & { resolved: Record<string, string[]> })[]; total: number; schema: AirtableTableSchema | null } {
    const table = this.q.listAirtableTables(this.baseId).find((t) => t.table_id === tableId) ?? null;
    const { rows, total } = this.q.listAirtableRecords(this.baseId, tableId, opts);
    return { rows: this.resolve(rows, table?.schema ?? null), total, schema: table?.schema ?? null };
  }

  resolve(rows: AirtableRecordRow[], schema: AirtableTableSchema | null): (AirtableRecordRow & { resolved: Record<string, string[]> })[] {
    const linkFields = (schema?.fields ?? []).filter((f) => f.type === 'multipleRecordLinks').map((f) => f.name);
    const ids = new Set<string>();
    for (const r of rows) for (const f of linkFields) for (const id of (Array.isArray(r.fields[f]) ? (r.fields[f] as unknown[]) : [])) if (typeof id === 'string') ids.add(id);
    const names = this.q.airtablePrimaries(this.baseId, [...ids]);
    return rows.map((r) => ({ ...r, resolved: Object.fromEntries(linkFields.map((f) => [f, (Array.isArray(r.fields[f]) ? (r.fields[f] as unknown[]) : []).map((id) => names.get(String(id))?.primary ?? String(id))])) }));
  }

  /** Text search across every table (primary and any text field), for the MCP tool and the page. */
  search(q: string, opts: { table?: string; limit?: number } = {}): { table: string; table_id: string; record_id: string; primary: string | null; snippet: string; url: string }[] {
    const out: { table: string; table_id: string; record_id: string; primary: string | null; snippet: string; url: string }[] = [];
    const k = q.toLowerCase();
    for (const t of this.q.listAirtableTables(this.baseId)) {
      if (opts.table && t.name.toLowerCase() !== opts.table.toLowerCase() && t.table_id !== opts.table) continue;
      for (const r of this.q.listAirtableRecords(this.baseId, t.table_id, { q, limit: opts.limit ?? 20 }).rows) {
        const hit = Object.entries(r.fields).find(([, v]) => typeof v === 'string' && v.toLowerCase().includes(k));
        out.push({ table: t.name, table_id: t.table_id, record_id: r.record_id, primary: r.primary, snippet: hit ? `${hit[0]}: ${String(hit[1]).slice(0, 160)}` : '', url: this.url(t.table_id, r.record_id) });
      }
    }
    return out.slice(0, opts.limit ?? 20);
  }

  url(tableId: string, recordId?: string): string { return `https://airtable.com/${this.baseId}/${tableId}${recordId ? `/${recordId}` : ''}`; }

  /** One deal with everything linked to it, for the MCP tool and the panels. */
  deal(ref: string): Record<string, unknown> | null {
    const tables = this.q.listAirtableTables(this.baseId);
    const deals = tables.find((t) => t.name === 'Deals'); if (!deals) return null;
    const row = this.q.listAirtableRecords(this.baseId, deals.table_id, { q: ref, limit: 1 }).rows.find((r) => (r.primary ?? '').toLowerCase().includes(ref.toLowerCase())) ?? this.q.getAirtableRecord(this.baseId, deals.table_id, ref);
    if (!row) return null;
    const [resolved] = this.resolve([row], deals.schema);
    const linked = (field: string, tableName: string) => { const t = tables.find((x) => x.name === tableName); if (!t) return []; return (Array.isArray(row.fields[field]) ? (row.fields[field] as string[]) : []).map((id) => this.q.getAirtableRecord(this.baseId, t.table_id, id)).filter((x): x is AirtableRecordRow => Boolean(x)).map((x) => ({ record_id: x.record_id, ...x.fields } as Record<string, unknown>)); };
    const plain = Object.fromEntries(Object.entries(row.fields).filter(([k]) => !(k in resolved.resolved)));
    return { record_id: row.record_id, url: this.url(deals.table_id, row.record_id), modified_at: row.modified_at, ...plain, ...resolved.resolved, account: linked('Account', 'Accounts'), contacts: linked('Contacts', 'Contacts'), key_dates: linked('Key dates', 'Key dates'), activities: linked('Activities', 'Activities').sort((a, b) => String(b.Date ?? '').localeCompare(String(a.Date ?? ''))).slice(0, 10) };
  }
}
