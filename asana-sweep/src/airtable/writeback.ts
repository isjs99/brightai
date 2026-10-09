import type { Queries } from '../db/queries.js';
import type { SiteInquiry } from '../sweep/types.js';
import { log } from '../logger.js';
import type { AirtableMirror } from './index.js';

/**
 * Write-back, rule by rule, into fields Sofía's base owns. First group: website enquiries. Every enquiry
 * that lands on brightform.agency becomes a record in her "Website Enquiries" table (unless the same
 * email is already there from the same day), and the platform's status, owner and note follow it as they
 * change. Each write is logged in airtable_writes with what it replaced, so it can be read back or undone.
 * Default on, switchable with the setting airtable_write_enquiries.
 */

export const ENQUIRY_TABLE = 'Website Enquiries';
const STATUS: Record<SiteInquiry['status'], string> = { new: 'New', replied: 'Replied', qualified: 'Qualified', closed: 'Closed' };
const MARKET: Record<string, string> = { de: 'DE', en: 'UK', fr: 'FR', es: 'ES', it: 'IT' };

export const enquiriesEnabled = (q: Queries): boolean => q.getSetting('airtable_write_enquiries', '1') === '1';

/** What her record holds for one of our enquiries; a formula or a link is never written. */
export function enquiryFields(i: SiteInquiry): Record<string, unknown> {
  return {
    'Company / enquiry': i.brand?.trim() || i.name,
    'Contact name': i.name,
    Email: i.email,
    ...(i.language && MARKET[i.language.toLowerCase().slice(0, 2)] ? { 'Country / market': MARKET[i.language.toLowerCase().slice(0, 2)] } : {}),
    'Enquiry message': [i.message, i.phone ? `Phone: ${i.phone}` : null, i.preferred_time ? `Preferred time: ${i.preferred_time}` : null].filter(Boolean).join('\n'),
    'Received at': i.created_at,
    Status: STATUS[i.status],
    Source: 'Website',
    ...(i.assigned_to ? { Notes: `Handled in the dashboard by ${i.assigned_to}${i.note ? `. ${i.note}` : ''}` } : i.note ? { Notes: i.note } : {}),
    ...(i.kind === 'call' ? { 'Preferred time': i.preferred_time ?? '' } : {}),
  };
}

export class EnquiryWriteback {
  constructor(private q: Queries, private mirror: AirtableMirror) {}

  /** The record id her base holds for this enquiry, through the link table or a same-email same-day record in the mirror. */
  linked(i: SiteInquiry): { table_id: string; record_id: string } | null {
    const table = this.mirror.table(ENQUIRY_TABLE);
    if (!table) return null;
    const link = this.q.listAirtableLinks(this.mirror.baseId, 'enquiry').find((l) => l.local_id === String(i.id) && l.table_id === table.table_id && l.status !== 'rejected');
    if (link) return { table_id: table.table_id, record_id: link.record_id };
    const day = i.created_at.slice(0, 10);
    const same = this.q.listAirtableRecords(this.mirror.baseId, table.table_id, { q: i.email, limit: 20 }).rows.find((r) => String(r.fields.Email ?? '').toLowerCase() === i.email.toLowerCase() && String(r.fields['Received at'] ?? r.modified_at ?? '').slice(0, 10) === day);
    if (same) { this.q.linkAirtable({ base_id: this.mirror.baseId, table_id: table.table_id, record_id: same.record_id, kind: 'enquiry', local_id: String(i.id), confidence: 1, how: 'same email, same day', status: 'auto' }); return { table_id: table.table_id, record_id: same.record_id }; }
    return null;
  }

  /** Create or update her record for an enquiry. Returns what happened, never throws (the enquiry itself is already saved). */
  async push(i: SiteInquiry, reason: string): Promise<{ action: 'created' | 'updated' | 'skipped'; record_id: string | null; detail: string | null }> {
    if (!enquiriesEnabled(this.q)) return { action: 'skipped', record_id: null, detail: 'write-back off' };
    if (!this.mirror.configured) return { action: 'skipped', record_id: null, detail: 'Airtable not configured' };
    const table = this.mirror.table(ENQUIRY_TABLE);
    if (!table) return { action: 'skipped', record_id: null, detail: `no "${ENQUIRY_TABLE}" table in the mirror yet` };
    const fields = enquiryFields(i);
    const allowed = new Set(table.schema.fields.filter((f) => !['formula', 'rollup', 'count', 'multipleLookupValues', 'autoNumber', 'createdTime', 'lastModifiedTime', 'multipleRecordLinks'].includes(f.type)).map((f) => f.name));
    const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.has(k)));
    try {
      const have = this.linked(i);
      if (have) {
        const current = this.q.getAirtableRecord(this.mirror.baseId, have.table_id, have.record_id);
        const changed = Object.fromEntries(Object.entries(safe).filter(([k, v]) => JSON.stringify(current?.fields[k] ?? null) !== JSON.stringify(v)));
        delete changed['Received at']; delete changed['Enquiry message']; // hers to edit once it is there
        if (!Object.keys(changed).length) return { action: 'skipped', record_id: have.record_id, detail: 'nothing changed' };
        const rec = await this.mirror.update(have.table_id, have.record_id, changed, `enquiry:${reason}`, current?.fields ?? {});
        return { action: 'updated', record_id: rec.id, detail: Object.keys(changed).join(', ') };
      }
      const rec = await this.mirror.create(table.table_id, safe, `enquiry:${reason}`);
      this.q.linkAirtable({ base_id: this.mirror.baseId, table_id: table.table_id, record_id: rec.id, kind: 'enquiry', local_id: String(i.id), confidence: 1, how: 'created by the platform', status: 'confirmed' });
      return { action: 'created', record_id: rec.id, detail: null };
    } catch (err) {
      log.warn(`Airtable enquiry write-back (${i.email}): ${(err as Error).message}`);
      return { action: 'skipped', record_id: null, detail: (err as Error).message.slice(0, 200) };
    }
  }
}
