import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { GmailClient } from '../src/bd/gmail';
import { SendQueue, inSendWindow, queueBlocker, sendSettings, saveSendSettings } from '../src/bd/sendqueue';

async function setup() {
  const q = new Queries(openTestDb());
  const { config } = await import('../src/config');
  config.googleClientId = 'cid';
  config.googleClientSecret = 'sec';
  q.setSetting('gmail_refresh_token', 'shared');
  q.setSetting('gmail_email', 'isaac@brightform.agency');
  const sends: { to: string; raw: string }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (u.endsWith('/messages/send')) { const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw; sends.push({ to: '', raw }); if (raw.length % 1 === 0 && sends.length === 99) return new Response('{}', { status: 500 }); return new Response(JSON.stringify({ id: `s${sends.length}`, threadId: `t${sends.length}` }), { status: 200 }); }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const gmail = new GmailClient(q, fetchFn);
  const sq = new SendQueue(q, gmail);
  const p = q.listProspects()[0];
  const mk = (email: string, extra: Partial<{ body: string; subject: string }> = {}) => q.createDraft({ prospect_id: p.id, contact_id: null, to_name: 'Ann', to_email: email, subject: extra.subject ?? 'Hello', body: extra.body ?? 'Hi Ann,\n\nShort note.\n\nIsaac', language: 'en', style: 'short', generator: 'template', created_by: 'Isaac' });
  return { q, gmail, sq, p, mk, sends };
}

describe('send queue', () => {
  it('knows its sending window in the account time zone', () => {
    const s = { hours: '08:30-18:00', weekdays_only: true, timezone: 'Europe/Madrid' };
    expect(inSendWindow(new Date('2026-10-01T08:00:00Z'), s)).toBe(true); // 10:00 Madrid, Thursday
    expect(inSendWindow(new Date('2026-10-01T05:00:00Z'), s)).toBe(false); // 07:00 Madrid
    expect(inSendWindow(new Date('2026-10-01T16:30:00Z'), s)).toBe(false); // 18:30 Madrid
    expect(inSendWindow(new Date('2026-10-03T10:00:00Z'), s)).toBe(false); // Saturday
    expect(inSendWindow(new Date('2026-10-03T10:00:00Z'), { ...s, weekdays_only: false })).toBe(true);
  });

  it('refuses drafts that are not ready and remembers who was already emailed', async () => {
    const { q, mk, p } = await setup();
    expect(queueBlocker(q, mk('a@b.co', { body: 'Hi [first name], see [case study]' }))).toMatch(/placeholder/);
    expect(queueBlocker(q, mk('not-an-email'))).toMatch(/email/);
    const ok = mk('ann@acme.co');
    expect(queueBlocker(q, ok)).toBeNull();
    q.updateDraft(ok.id, { status: 'sent' });
    expect(queueBlocker(q, mk('ANN@acme.co'))).toMatch(/last 30 days/);
    q.patchProspect(p.id, { outreach_gmail: true }, 'test');
    expect(queueBlocker(q, mk('other@acme.co'))).toMatch(/already emailed/);
    expect(queueBlocker(q, mk('other2@acme.co'), { force: true })).toBeNull();
  });

  it('queues, sends one per tick inside the window with the gap and cap, and books it on the prospect', async () => {
    const { q, sq, mk, p, sends } = await setup();
    const a = mk('ann@acme.co'); const b = mk('bob@beta.co'); const bad = mk('x@y.co', { subject: '' });
    const r = sq.queue([a.id, b.id, bad.id, 999], 'Isaac');
    expect(r.queued.map((d) => d.id)).toEqual([a.id, b.id]);
    expect(r.skipped.map((s) => s.id)).toEqual([bad.id, 999]);
    expect(q.getDraft(a.id)!.status).toBe('queued');
    expect(q.getDraft(a.id)!.send_account).toBe('');
    expect(sq.state(new Date('2026-10-01T08:00:00Z')).queued).toBe(2);

    expect(await sq.tick(new Date('2026-10-01T05:00:00Z'))).toBeNull(); // before hours
    const first = await sq.tick(new Date('2026-10-01T08:00:00Z'));
    expect(first?.id).toBe(a.id);
    expect(first?.status).toBe('sent');
    expect(first?.gmail_message_id).toBe('s1');
    expect(first?.gmail_url).toContain('#sent/s1');
    expect(sends).toHaveLength(1);
    expect(q.getProspect(p.id)!.outreach_gmail).toBe(true);
    expect(q.getProspect(p.id)!.status).toBe('contacted');

    expect(await sq.tick(new Date('2026-10-01T08:00:30Z'))).toBeNull(); // gap not passed
    saveSendSettings(q, { send_daily_cap: 1 });
    expect(await sq.tick(new Date('2026-10-01T08:10:00Z'))).toBeNull(); // cap reached
    saveSendSettings(q, { send_daily_cap: 30, send_paused: true });
    expect(await sq.tick(new Date('2026-10-01T08:10:00Z'))).toBeNull(); // paused
    saveSendSettings(q, { send_paused: false });
    const second = await sq.tick(new Date('2026-10-01T08:10:00Z'));
    expect(second?.id).toBe(b.id);
    expect(sq.state(new Date('2026-10-01T08:11:00Z')).sent_today).toBe(2);
    expect(sq.unqueue(a.id)?.status).toBe('sent'); // unqueue leaves sent drafts alone
  });

  it('drops a failed send back to draft with the error and keeps going', async () => {
    const { q, sq, mk } = await setup();
    q.setSetting('gmail_refresh_token:Giorgia', 'g1');
    q.setSetting('gmail_email:Giorgia', 'giorgia@brightform.agency');
    const d = mk('ann@acme.co');
    sq.queue([d.id], 'Giorgia');
    expect(q.getDraft(d.id)!.send_account).toBe('Giorgia');
    q.setSetting('gmail_refresh_token:Giorgia', ''); // disconnected before the send
    expect(await sq.tick(new Date('2026-10-01T08:00:00Z'))).toBeNull();
    const after = q.getDraft(d.id)!;
    expect(after.status).toBe('draft');
    expect(after.send_error).toMatch(/no longer connected/);
    expect(sq.state().last_error).toMatch(/ann@acme.co/);
    expect(sendSettings(q).daily_cap).toBe(30);
  });
});
