import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { AirtableClient, AirtableMirror, type Fetcher } from '../src/airtable/index';
import { EnquiryWriteback, enquiryFields } from '../src/airtable/writeback';

const SCHEMA = { tables: [{ id: 'tblEnq', name: 'Website Enquiries', primaryFieldId: 'f1', fields: [{ id: 'f1', name: 'Company / enquiry', type: 'singleLineText' }, { id: 'f2', name: 'Contact name', type: 'singleLineText' }, { id: 'f3', name: 'Email', type: 'email' }, { id: 'f4', name: 'Country / market', type: 'singleSelect' }, { id: 'f5', name: 'Enquiry message', type: 'multilineText' }, { id: 'f6', name: 'Received at', type: 'dateTime' }, { id: 'f7', name: 'Status', type: 'singleSelect' }, { id: 'f8', name: 'Source', type: 'singleSelect' }, { id: 'f9', name: 'Notes', type: 'multilineText' }, { id: 'f10', name: 'Follow-up due', type: 'formula' }, { id: 'f11', name: 'CRM deal', type: 'multipleRecordLinks' }] }] };

function fake(state: { records: Record<string, unknown>[]; calls: { method: string; path: string; body: unknown }[] }): Fetcher {
  const ok = (body: unknown) => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  return async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ method: init.method ?? 'GET', path: u.pathname, body });
    if (u.pathname.endsWith('/meta/bases')) return ok({ bases: [] });
    if (u.pathname.endsWith('/tables')) return ok(SCHEMA);
    if (init.method === 'POST') { const rec = { id: `rec${state.records.length + 1}`, createdTime: new Date().toISOString(), fields: body.fields }; state.records.push(rec); return ok(rec); }
    if (init.method === 'PATCH') { const id = u.pathname.split('/').pop(); const rec = state.records.find((r) => r.id === id) as { fields: Record<string, unknown> }; Object.assign(rec.fields, body.fields); return ok(rec); }
    if (u.pathname.endsWith('/tblEnq')) return ok({ records: state.records });
    return { status: 404, json: async () => ({}), text: async () => 'nope' };
  };
}

describe('website enquiries into her base', () => {
  it('creates a record for a new enquiry, updates it as the status moves, and never writes a formula or a link', async () => {
    const q = new Queries(openTestDb());
    q.setSetting('airtable_base_id', 'appTEST');
    const state = { records: [] as Record<string, unknown>[], calls: [] as { method: string; path: string; body: unknown }[] };
    const mirror = new AirtableMirror(q, new AirtableClient('pat', fake(state), 0));
    await mirror.sync({ full: true });
    const wb = new EnquiryWriteback(q, mirror);
    const inq = q.createInquiry({ kind: 'contact', name: 'Anna Beispiel', email: 'anna@brand.de', brand: 'Brand GmbH', message: 'We want to launch on TikTok Shop DE.', language: 'de' });
    const r1 = await wb.push(inq, 'new');
    expect(r1.action).toBe('created');
    const post = state.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ fields: { 'Company / enquiry': 'Brand GmbH', 'Contact name': 'Anna Beispiel', Email: 'anna@brand.de', 'Country / market': 'DE', Status: 'New', Source: 'Website' }, typecast: true });
    expect(Object.keys((post.body as { fields: Record<string, unknown> }).fields)).not.toContain('Follow-up due');
    // Mirrored straight away, linked, logged.
    expect(mirror.records('tblEnq').total).toBe(1);
    expect(q.listAirtableLinks('appTEST', 'enquiry')).toHaveLength(1);
    expect(q.listAirtableWrites('appTEST').map((w) => w.field)).toContain('Status');
    // Nothing changed: no call.
    const before = state.calls.length;
    expect((await wb.push(q.getInquiry(inq.id)!, 'update')).action).toBe('skipped');
    expect(state.calls.length).toBe(before);
    // The status moves: one PATCH with the changed fields only.
    q.updateInquiry(inq.id, { status: 'qualified', assigned_to: 'Sofía', note: 'Call booked' });
    const r2 = await wb.push(q.getInquiry(inq.id)!, 'update');
    expect(r2.action).toBe('updated');
    const patch = state.calls.filter((c) => c.method === 'PATCH').pop()!;
    expect(patch.body).toEqual({ fields: { Status: 'Qualified', Notes: 'Handled in the dashboard by Sofía. Call booked' }, typecast: true });
    expect(q.listAirtableWrites('appTEST').find((w) => w.field === 'Status' && w.new === 'Qualified')?.old).toBe('New');
    // Off switch.
    q.setSetting('airtable_write_enquiries', '0');
    expect((await wb.push(q.getInquiry(inq.id)!, 'update')).detail).toBe('write-back off');
  });

  it('links to a record she already has for the same email on the same day instead of creating a second one', async () => {
    const q = new Queries(openTestDb());
    q.setSetting('airtable_base_id', 'appTEST');
    const today = new Date().toISOString();
    const state = { records: [{ id: 'recOld', createdTime: today, fields: { 'Company / enquiry': 'Brand', Email: 'anna@brand.de', 'Received at': today, Status: 'New' } }] as Record<string, unknown>[], calls: [] as { method: string; path: string; body: unknown }[] };
    const mirror = new AirtableMirror(q, new AirtableClient('pat', fake(state), 0));
    await mirror.sync({ full: true });
    const wb = new EnquiryWriteback(q, mirror);
    const inq = q.createInquiry({ kind: 'call', name: 'Anna', email: 'Anna@brand.de', message: 'Call me', preferred_time: 'mornings' });
    const r = await wb.push(inq, 'new');
    expect(r.action).toBe('updated');
    expect(r.record_id).toBe('recOld');
    expect(state.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(enquiryFields(inq)['Preferred time']).toBe('mornings');
  });
});
