import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';

describe('website enquiries', () => {
  it('stores, lists, dedupes and updates enquiries', () => {
    const q = new Queries(openTestDb());
    const a = q.createInquiry({ name: 'Ada Lovelace', email: 'ada@acme.com', brand: 'Acme', message: 'We sell supplements in DE and want to launch on TikTok Shop.', language: 'en', page: '/contact', ip: '1.2.3.4' });
    expect(a.status).toBe('new');
    expect(q.listInquiries()).toHaveLength(1);
    expect(q.recentInquiryFrom('ADA@acme.com', 2)?.id).toBe(a.id);
    expect(q.recentInquiryFrom('someone@else.com', 2)).toBeNull();
    const upd = q.updateInquiry(a.id, { status: 'replied', assigned_to: 'Tamara', note: 'Call booked', replied_at: '2026-09-27T10:00:00.000Z' })!;
    expect(upd.status).toBe('replied');
    expect(upd.assigned_to).toBe('Tamara');
    expect(upd.note).toBe('Call booked');
    expect(q.updateInquiry(999, { status: 'closed' })).toBeNull();
  });
});

describe('call requests and the email forward', () => {
  it('stores the kind, phone and preferred time, and records the forward', () => {
    const q = new Queries(openTestDb());
    const c = q.createInquiry({ kind: 'call', name: 'Grace Hopper', email: 'grace@navy.mil', brand: 'Cobol Co', phone: '+1 555 0100', preferred_time: 'morning: Mornings (9–12 CET)', message: 'Launch in DE and FR', language: 'fr' });
    expect(c.kind).toBe('call');
    expect(c.phone).toBe('+1 555 0100');
    expect(c.preferred_time).toBe('morning: Mornings (9–12 CET)');
    expect(c.forwarded_at).toBeNull();
    const plain = q.createInquiry({ name: 'Ada', email: 'ada@acme.com', message: 'Hi' });
    expect(plain.kind).toBe('contact');
    expect(q.updateInquiry(c.id, { forwarded_at: '2026-09-27T10:00:00.000Z' })?.forwarded_at).toBe('2026-09-27T10:00:00.000Z');
    expect(q.listInquiries().map((i) => i.kind)).toEqual(['contact', 'call']);
  });
});
