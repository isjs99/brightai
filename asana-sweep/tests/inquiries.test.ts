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
