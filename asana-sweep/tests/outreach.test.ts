import { describe, it, expect } from 'vitest';
import { buildRawMessage, cleanSentBody, extractPlainText, fromB64url, gmailComposeUrl, gmailDraftUrl, GmailClient } from '../src/bd/gmail';
import { parseDraftJson, prospectFacts, renderOutreachPrompt, tailoredOpener, templateDraft } from '../src/bd/outreach';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import type { BdProspect } from '../src/sweep/types';

const prospect = (o: Partial<BdProspect> = {}): BdProspect => ({
  id: 1, seller_id: '7', shop_name: 'Displayz', brand: null, market: 'FR', category: 'Collectibles', gmv_7d: 237925, gmv_total: 744843, units_7d: 243, units_total: 2656, currency: 'EUR', shop_type: 'local', tiktok_handle: null, rating: 4.9, products: 71,
  rise_score: 0.32, launched_at: '2026-05-16', gmv_started_at: null, new_shop_30d: false, gmv_started_30d: true, age_estimate_days: 22, fastmoss_url: 'https://www.fastmoss.com/shop-marketing/detail/7', is_client: false,
  domain: null, website: null, apollo_org_id: null, status: 'new', owner_id: null, owner_name: null, notes: null,
  outreach_tts_am: false, outreach_gmail: false, outreach_linkedin: true, outreach_tts_am_at: null, outreach_gmail_at: null, outreach_linkedin_at: '2026-09-10T10:00:00.000Z', outreach_complete: false,
  source: 'fastmoss', pulled_at: '2026-09-16', archived: false, created_at: '', updated_at: '', contacts: [], outreach_log: [], ...o,
});
const inputs = { examples: [], pitch: '*Credentials*\n- #1 TikTok Shop Partner in the EU', senderName: 'Isaac Sinclair', senderTitle: 'Co-Founder/CEO, Brightform', bookingUrl: 'https://calendly.com/isaac/30min' };
const contact = { name: 'Ann Smith', title: 'Founder', email: 'ann@displayz.fr' };

describe('outreach drafting', () => {
  it('turns FastMoss numbers into facts and a tailored opener', () => {
    const facts = prospectFacts(prospect());
    expect(facts[0]).toContain('Company / brand: Displayz');
    expect(facts[0]).toContain('on TikTok Shop France');
    expect(facts).toContain('GMV last 7 days: €237,925 (243 units)');
    expect(facts.some((f) => f.startsWith('Momentum: surging'))).toBe(true);
    expect(facts.some((f) => f.includes('Sales only started in roughly the last 22 days'))).toBe(true);
    expect(tailoredOpener(prospect())).toContain('Displayz only just started selling on TikTok Shop France');
    expect(tailoredOpener(prospect({ gmv_started_30d: false, new_shop_30d: true }))).toContain('for under a month');
    expect(tailoredOpener(prospect({ gmv_started_30d: false, rise_score: 0.2 }))).toContain('fastest-rising shops');
    expect(tailoredOpener(prospect({ gmv_started_30d: false, rise_score: 0.01, currency: 'GBP', market: 'UK' }))).toContain('TikTok Shop UK');
  });

  it('renders a prompt with voice samples, pitch, facts and history, asking for JSON', () => {
    const { system, user } = renderOutreachPrompt({ prospect: prospect(), contact, language: 'en', style: 'short', instructions: 'mention padel', ...inputs, examples: [{ id: 1, subject: 'WPP x Brightform', body: 'Hi Cindy,\n\nVery best,\nIsaac', kind: 'cold', to_domain: 'wpp.com', sent_at: null, source: 'seed', gmail_id: null, enabled: true }], previousDrafts: [{ subject: 'Old one', status: 'sent', created_at: '2026-09-01T00:00:00Z' }] });
    expect(system).toContain('Isaac Sinclair, Co-Founder/CEO, Brightform');
    expect(system).toContain('### WPP x Brightform (cold, to wpp.com)');
    expect(system).toContain('#1 TikTok Shop Partner in the EU');
    expect(system).toContain('Output JSON only');
    expect(system).toContain('Call the company "Displayz"');
    expect(system).toContain('No markdown, no asterisks');
    expect(system).toContain('Write the email in English');
    expect(system).toContain('Shape requested: short note');
    expect(user).toContain('Ann Smith, Founder <ann@displayz.fr>');
    expect(user).toContain('- LinkedIn: contacted on 2026-09-10');
    expect(user).toContain('"Old one" (sent)');
    expect(user).toContain('mention padel');
    expect(renderOutreachPrompt({ prospect: prospect(), contact, language: 'de', style: 'intro', ...inputs }).system).toContain('Write the email in German');
  });

  it('parses the model output leniently', () => {
    expect(parseDraftJson('{"subject":"Hi","body":"Hello\\n\\nBye"}')).toEqual({ subject: 'Hi', body: 'Hello\n\nBye' });
    expect(parseDraftJson('Sure:\n```json\n{"subject": "Displayz x TikTok Shop", "body": "Hi Ann,\\r\\n\\r\\nVery best,\\r\\nIsaac"}\n```')).toEqual({ subject: 'Displayz x TikTok Shop', body: 'Hi Ann,\n\nVery best,\nIsaac' });
    expect(parseDraftJson('Subject: Quick one\n\nHi Ann,\nbody here')).toEqual({ subject: 'Quick one', body: 'Hi Ann,\nbody here' });
    expect(() => parseDraftJson('nothing useful')).toThrow();
  });

  it('template draft follows the intro structure with a tailored opener and booking link', () => {
    const short = templateDraft({ prospect: prospect(), contact, language: 'en', style: 'short', ...inputs });
    expect(short.subject).toBe('Displayz x TikTok Shop France');
    expect(short.body.startsWith('Hi Ann,\n\nDisplayz only just started selling')).toBe(true);
    expect(short.body).toContain(inputs.bookingUrl);
    expect(short.body.endsWith('Very best,\nIsaac')).toBe(true);
    expect(short.body).not.toContain('*');
    const intro = templateDraft({ prospect: prospect({ brand: 'Displayz Toys' }), contact, language: 'en', style: 'intro', ...inputs });
    expect(intro.subject).toBe('Displayz Toys x TikTok Shop France');
    expect(intro.body).toContain('Why us:\n- ');
    expect(intro.body).not.toContain('*');
  });
});

describe('gmail helpers', () => {
  it('builds a base64url RFC 2822 message with UTF-8 subject and body', () => {
    const raw = buildRawMessage({ to: 'ann@displayz.fr', toName: 'Ann Smith', from: 'isaac@brightform.agency', fromName: 'Isaac Sinclair', subject: 'Displayz × TikTok Shop', body: 'Hi Ann,\n\nVery best,\nIsaac' });
    expect(raw).not.toMatch(/[+/=]/);
    const text = fromB64url(raw);
    expect(text).toContain('To: Ann Smith <ann@displayz.fr>');
    expect(text).toContain('From: Isaac Sinclair <isaac@brightform.agency>');
    expect(text).toContain('Subject: =?UTF-8?B?');
    expect(text).toContain('Content-Type: text/plain; charset="UTF-8"');
    const body = Buffer.from(text.split('\r\n\r\n')[1], 'base64').toString('utf8');
    expect(body).toBe('Hi Ann,\r\n\r\nVery best,\r\nIsaac');
  });

  it('draft and compose URLs target the connected account', () => {
    expect(gmailDraftUrl('18abc', 'isaac@brightform.agency')).toBe('https://mail.google.com/mail/?authuser=isaac%40brightform.agency#drafts/18abc');
    expect(gmailDraftUrl('18abc')).toBe('https://mail.google.com/mail/u/0/#drafts/18abc');
    const u = new URL(gmailComposeUrl({ to: 'a@b.c', subject: 'S & T', body: 'Hi\n\nBye', account: 'isaac@brightform.agency' }));
    expect(u.searchParams.get('view')).toBe('cm');
    expect(u.searchParams.get('to')).toBe('a@b.c');
    expect(u.searchParams.get('su')).toBe('S & T');
    expect(u.searchParams.get('body')).toBe('Hi\n\nBye');
    expect(u.searchParams.get('authuser')).toBe('isaac@brightform.agency');
  });

  it('extracts plain text from nested payloads and cleans signatures and quotes', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const payload = { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hi</p>') } }, { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: b64('Hi Jamie,\n\nplain') } }] }] };
    expect(extractPlainText(payload)).toBe('Hi Jamie,\n\nplain');
    expect(extractPlainText({ mimeType: 'text/html', body: { data: b64('<div>Hi<br>there &amp; you</div>') } })).toBe('Hi\nthere & you');
    const sent = `Hi Niccolo,\n\nYou might remember me from Nicpic (still doing\nwell!)\n\nGrab a slot here:\n\nhttps://www.google.com/url?q=https://calendly.com/isaacsinclair/30min&source=gmail\n<https://bitli.pro/2ThcL_e04c2c53>\n\nVery best,\nIsaac\n\n<http://www.brightform.agency/>\nIsaac Sinclair\nCo-Founder/CEO | Brightform.\n\nThe content of this email is confidential and intended for the recipient\n\nOn Tue, 15 Sept 2026 at 19:28, Lorenzo <l@q.it> wrote:\n> old stuff`;
    const clean = cleanSentBody(sent);
    expect(clean).toContain('You might remember me from Nicpic (still doing well!)');
    expect(clean).toContain('https://calendly.com/isaacsinclair/30min');
    expect(clean).not.toContain('bitli.pro');
    expect(clean).not.toContain('Co-Founder/CEO');
    expect(clean).not.toContain('old stuff');
    expect(clean.endsWith('Very best,\nIsaac')).toBe(true);
  });

  it('creates a Gmail draft through the API with a refreshed token', async () => {
    const q = new Queries(openTestDb());
    q.setSetting('gmail_refresh_token', 'r1');
    q.setSetting('gmail_email', 'isaac@brightform.agency');
    const calls: { url: string; body: string | null; auth: string | null }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? String(init.body) : null, auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null });
      if (u.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      if (u.endsWith('/drafts')) return new Response(JSON.stringify({ id: 'd1', message: { id: 'm1' } }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'sec';
    const { config } = await import('../src/config');
    config.googleClientId = 'cid';
    config.googleClientSecret = 'sec';
    const g = new GmailClient(q, fetchFn);
    expect(g.connected).toBe(true);
    const r = await g.createDraft({ to: 'ann@displayz.fr', toName: 'Ann', subject: 'S', body: 'B' });
    expect(r).toEqual({ draft_id: 'd1', message_id: 'm1', url: 'https://mail.google.com/mail/?authuser=isaac%40brightform.agency#drafts/m1' });
    expect(calls[0].body).toContain('grant_type=refresh_token');
    expect(calls[1].auth).toBe('Bearer tok');
    const raw = (JSON.parse(calls[1].body!) as { message: { raw: string } }).message.raw;
    expect(fromB64url(raw)).toContain('To: Ann <ann@displayz.fr>');
    await g.createDraft({ to: 'b@c.d', subject: 'S2', body: 'B2' });
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(1); // token cached
  });
});

describe('email drafts and voice examples', () => {
  const setup = () => new Queries(openTestDb());

  it('seeds voice samples and pitch settings', () => {
    const q = setup();
    const ex = q.listExamples();
    expect(ex.length).toBe(6);
    expect(ex.every((e) => e.source === 'seed' && e.enabled)).toBe(true);
    expect(ex.map((e) => e.kind).sort()).toEqual(['cold', 'cold', 'cold', 'intro', 'intro', 'reply']);
    expect(q.getSetting('outreach_pitch')).toContain('Credentials:');
    expect(q.getSetting('outreach_pitch')).not.toContain('*');
    expect(ex.every((e) => !e.body.includes('*Who we are*'))).toBe(true);
    expect(q.getSetting('outreach_sender_name')).toBe('Isaac Sinclair');
    expect(q.addExample({ subject: 'x', body: 'y', gmail_id: 'g1', source: 'gmail' })).not.toBeNull();
    expect(q.addExample({ subject: 'x', body: 'y', gmail_id: 'g1', source: 'gmail' })).toBeNull();
    expect(q.setExampleEnabled(ex[0].id, false)).toBe(true);
    expect(q.listExamples(true).length).toBe(6);
  });

  it('drafts live per prospect, carry Gmail ids and can be discarded', () => {
    const q = setup();
    const p = q.listProspects().find((x) => x.shop_name === 'Nutrition Geeks')!;
    const c = p.contacts[0];
    const d = q.createDraft({ prospect_id: p.id, contact_id: c.id, to_name: c.name, to_email: c.email!, subject: 'S', body: 'B', language: 'en', style: 'short', generator: 'template', created_by: 'admin' });
    expect(d).toMatchObject({ shop_name: 'Nutrition Geeks', market: 'UK', status: 'draft', to_email: 'rishi@nutritiongeeks.co' });
    const u = q.updateDraft(d.id, { status: 'gmail', gmail_draft_id: 'd1', gmail_message_id: 'm1', gmail_url: 'https://mail.google.com/mail/u/0/#drafts/m1', subject: 'S2' })!;
    expect(u.status).toBe('gmail');
    expect(u.subject).toBe('S2');
    expect(u.updated_at >= d.updated_at).toBe(true);
    expect(q.listDrafts({ prospectId: p.id }).length).toBe(1);
    q.updateDraft(d.id, { status: 'discarded' });
    expect(q.listDrafts().length).toBe(0);
    expect(q.listDrafts({ includeDiscarded: true }).length).toBe(1);
    expect(q.deleteDraft(d.id)).toBe(true);
    expect(q.getDraft(d.id)).toBeNull();
  });
});
