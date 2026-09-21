import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { advanceLinkedin, suggestTtsContact } from '../src/bd/sequence';
import { isRecentLaunch, nameMatches, scanEnterpriseAlerts, syncWatchlistFromSheet } from '../src/bd/alerts';
import { bodyToHtml, brandDisplayName, templateDraft } from '../src/bd/outreach';
import { buildRawMessage, fromB64url } from '../src/bd/gmail';
import { AccountMonitor } from '../src/monitor/index';
import { draftCallFollowups, externalAttendee, TldvClient } from '../src/bd/tldv';
import type { BdProspect } from '../src/sweep/types';

const setup = () => new Queries(openTestDb());

describe('brand names and Gmail formatting', () => {
  it('uses the brand, else a cleaned shop name, never the handle', () => {
    expect(brandDisplayName({ shop_name: 'ulefone.fr', brand: null })).toBe('Ulefone');
    expect(brandDisplayName({ shop_name: 'philips.maison', brand: null })).toBe('Philips Maison');
    expect(brandDisplayName({ shop_name: 'VEVOR Store ES', brand: 'VEVOR' })).toBe('VEVOR');
    expect(brandDisplayName({ shop_name: 'Ninja Kitchen DE', brand: null })).toBe('Ninja Kitchen');
    expect(brandDisplayName({ shop_name: 'PUFFIT.UK.SHOP', brand: null })).toBe('PUFFIT');
    expect(brandDisplayName({ shop_name: 'medicube UK', brand: 'medicube' })).toBe('medicube');
  });

  it('renders headings bold, bullets as lists and links as anchors, with no asterisks', () => {
    const html = bodyToHtml('Hi Ann,\n\nWhy Brightform:\n- #1 partner by GMV\n- Own live studio\n\nGrab a slot: https://cal.com/x\n\nVery best,\nIsaac');
    expect(html).toContain('<b>Why Brightform:</b>');
    expect(html).toContain('<ul');
    expect(html).toContain('<li>#1 partner by GMV</li>');
    expect(html).toContain('<a href="https://cal.com/x">https://cal.com/x</a>');
    expect(html).toContain('Very best,<br>Isaac');
    expect(html).not.toContain('*');
    expect(bodyToHtml('a <b> & c')).toContain('a &lt;b&gt; &amp; c');
  });

  it('builds a multipart/alternative message when html is given', () => {
    const raw = fromB64url(buildRawMessage({ to: 'a@b.c', subject: 'S', body: 'Hi', html: '<p>Hi</p>' }));
    expect(raw).toContain('Content-Type: multipart/alternative; boundary=');
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(raw.match(/--bf_/g)!.length).toBe(3);
  });

  it('template draft is condensed and uses the brand name', () => {
    const q = setup();
    const p = q.listProspects().find((x) => x.shop_name === 'ulefone.fr')!;
    const inputs = { examples: [], pitch: '', senderName: 'Isaac Sinclair', senderTitle: 'CEO', bookingUrl: 'https://cal.com/x' };
    const d = templateDraft({ prospect: p, contact: { name: 'Ansen Xiong', title: 'CEO', email: 'a@ulefone.com' }, language: 'en', style: 'intro', ...inputs });
    expect(d.subject).toBe('Ulefone x TikTok Shop France');
    expect(d.body).not.toContain('ulefone.fr');
    expect(d.body).toContain('Why us:');
    expect(d.body).not.toContain('*');
    expect(d.body.split(/\s+/).length).toBeLessThan(150);
  });
});

describe('LinkedIn sequence and follow-ups', () => {
  it('walks requested -> connected -> messaged with reminders, history and ticks', async () => {
    const q = setup();
    const p = q.listProspects().find((x) => x.shop_name === 'Nutrition Geeks')!;
    const c = p.contacts[0];
    const r1 = await advanceLinkedin(q, c.id, 'requested', { actor: 'Isaac' });
    expect(r1.contact.linkedin_status).toBe('requested');
    expect(r1.prospect.outreach_linkedin).toBe(true);
    expect(r1.prospect.status).toBe('contacted');
    expect(r1.followup?.kind).toBe('linkedin_check');
    expect(Date.parse(r1.followup!.due_at)).toBeGreaterThan(Date.now() + 2 * 86400000);
    expect(q.listFollowups().length).toBe(1);
    // A second "requested" click refreshes the same reminder rather than stacking one.
    await advanceLinkedin(q, c.id, 'requested', { actor: 'Isaac' });
    expect(q.listFollowups().length).toBe(1);

    const r2 = await advanceLinkedin(q, c.id, 'connected', { actor: 'Isaac' });
    expect(r2.contact.linkedin_status).toBe('connected');
    expect(r2.message?.text.length).toBeGreaterThan(40);
    expect(r2.message!.text.length).toBeLessThanOrEqual(300);
    expect(r2.message!.text).toContain('Nutrition Geeks');
    expect(r2.message!.text.endsWith('http')).toBe(false);
    expect(r2.followup?.kind).toBe('linkedin_message');
    expect(r2.followup?.note).toBe(r2.message!.text);
    const open = q.listFollowups();
    expect(open.map((f) => f.kind)).toEqual(['linkedin_message']); // check reminder closed

    const r3 = await advanceLinkedin(q, c.id, 'messaged', { actor: 'Isaac', note: r2.message!.text });
    expect(r3.contact.linkedin_status).toBe('messaged');
    expect(q.listFollowups().map((f) => f.kind)).toEqual(['email_chase']);
    const log = q.getProspect(p.id)!.outreach_log;
    expect(log.map((e) => e.action)).toEqual(['contacted', 'note', 'status', 'contacted']);
    expect(log.every((e) => e.actor === 'Isaac')).toBe(true);

    const act = q.bdActivity(30);
    const isaac = act.rows.find((r) => r.actor === 'Isaac')!;
    expect(isaac.linkedin_requests).toBe(1);
    expect(isaac.linkedin_connected).toBe(1);
    expect(isaac.linkedin).toBe(2);
    expect(isaac.prospects_touched).toBe(1);
    expect(act.weekly.length).toBe(1);
  });

  it('completes and snoozes follow-ups', () => {
    const q = setup();
    const p = q.listProspects()[0];
    const f = q.addFollowup({ prospect_id: p.id, kind: 'custom', title: 'Call back', due_at: new Date(Date.now() - 3600000).toISOString(), created_by: 'Elena' });
    expect(q.getFollowup(f.id)!.overdue).toBe(true);
    const s = q.snoozeFollowup(f.id, new Date(Date.now() + 2 * 86400000).toISOString())!;
    expect(s.overdue).toBe(false);
    expect(q.completeFollowup(f.id, 'done on the phone')!.done_at).not.toBeNull();
    expect(q.listFollowups().length).toBe(0);
    expect(q.listFollowups({ includeDone: true }).length).toBe(1);
  });

  it('suggests the category contact, else the agency manager', () => {
    const contacts = [
      { id: 1, market: 'DE', category: null, name: 'Anna', role: 'Agency manager', lark: 'anna.l', email: null, notes: null, is_agency_manager: true },
      { id: 2, market: 'DE', category: 'Beauty', name: 'Ben', role: 'Category manager', lark: 'ben', email: null, notes: null, is_agency_manager: false },
    ];
    expect(suggestTtsContact(contacts, { market: 'DE', category: 'Beauty & Personal Care' }).contact?.name).toBe('Ben');
    const r = suggestTtsContact(contacts, { market: 'DE', category: 'Furniture' });
    expect(r.contact).toBeNull();
    expect(r.fallback?.name).toBe('Anna');
    expect(r.reason).toContain('TSP manager');
    // No French contacts at all: the nearest agency manager is still offered rather than nothing.
    const fr = suggestTtsContact(contacts, { market: 'FR', category: 'Beauty' });
    expect(fr.tier).toBe('tsp_manager');
    expect(fr.fallback?.name).toBe('Anna');
    expect(suggestTtsContact([], { market: 'FR', category: 'Beauty' }).reason).toContain('No TikTok Shop contacts');
  });
});

describe('enterprise alerts', () => {
  it('matches household names as whole words or prefixes, not substrings', () => {
    expect(nameMatches('Bosch Home DE', null, 'Bosch')).toBe(true);
    expect(nameMatches('Olay UK', null, 'Olay')).toBe(true);
    expect(nameMatches('sharkninjauk', null, 'SharkNinja')).toBe(true);
    expect(nameMatches("L'Oréal Paris ES", null, "L'Oreal")).toBe(true);
    expect(nameMatches('Marshmallow Co', null, 'Mars')).toBe(false);
    expect(nameMatches('Nikeya Fashion', null, 'Nike')).toBe(false);
    expect(nameMatches('Some Shop', 'Dyson', 'Dyson')).toBe(true);
  });

  it('flags a watchlist name on a recently launched shop and dedupes', () => {
    const q = setup();
    const p = q.createProspect({ shop_name: 'Bosch Home DE', market: 'DE', launched_at: new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10), gmv_7d: 16755, gmv_total: 6500 });
    expect(isRecentLaunch(q.getProspect(p.id)!).recent).toBe(true);
    // Seeded shops with a big name but no launch signal do not fire on the first scan.
    expect(isRecentLaunch(q.listProspects().find((x) => x.shop_name === 'QVC UK')!).recent).toBe(false);
    const r = scanEnterpriseAlerts(q);
    expect(r.new_alerts).toBeGreaterThanOrEqual(1);
    const alert = q.listAlerts().find((a) => a.prospect_id === p.id)!;
    expect(alert.watch_name).toBe('Bosch');
    expect(alert.message).toContain('shop created');
    expect(scanEnterpriseAlerts(q).new_alerts).toBe(0);
    expect(q.dismissAlert(alert.id)).toBe(true);
    expect(q.listAlerts().find((a) => a.id === alert.id)).toBeUndefined();
    // An old, steady shop with a big name does not alert.
    const old = q.createProspect({ shop_name: 'Philips Germany', market: 'DE', launched_at: '2024-01-01', gmv_7d: 100, gmv_total: 1000000 });
    expect(isRecentLaunch({ ...q.getProspect(old.id)!, created_at: '2024-01-01T00:00:00.000Z' } as BdProspect, { baseline: '2025-01-01T00:00:00.000Z' }).recent).toBe(false);
    // A shop first seen after the baseline counts as new on the radar.
    expect(isRecentLaunch({ ...q.getProspect(old.id)!, launched_at: null } as BdProspect, { baseline: '2026-01-01T00:00:00.000Z' }).recent).toBe(true);
  });

  it('syncs names from a sheet tab', async () => {
    const q = setup();
    q.setSetting('leads_sheet_id', 'sheet123');
    q.setSetting('watchlist_sheet_tab', 'Enterprise');
    const r = await syncWatchlistFromSheet(q, async (url) => { expect(url).toContain('sheet=Enterprise'); return 'Client Name,Stage\nDr. Oetker,Cold\nHaribo,Cold\n,\nBosch,Warm\n'; });
    expect(r.total).toBe(3);
    expect(r.added).toBe(1); // Haribo and Bosch already seeded
    expect(q.listWatchlist().find((w) => w.name === 'Dr. Oetker')?.source).toBe('sheet');
  });
});

describe('account monitor', () => {
  it('raises dashboard flags and resolves them on the next scan', () => {
    const q = setup();
    const m = new AccountMonitor(q);
    const enabled = new Set(m.rules().map((r) => r.code));
    const found = m.dashboardRules(enabled);
    // Seeded accounts have no commission terms and no promotions.
    expect(found.some((f) => f.code === 'no_deal_terms')).toBe(true);
    expect(found.some((f) => f.code === 'no_live_promotion')).toBe(true);
    const r = q.applyScan(found);
    expect(r.opened).toBe(found.length);
    expect(q.listFlags().length).toBe(found.length);
    const again = q.applyScan(found.filter((f) => f.code !== 'no_deal_terms'));
    expect(again.opened).toBe(0);
    expect(again.resolved).toBeGreaterThan(0);
    expect(q.listFlags().every((f) => f.code !== 'no_deal_terms')).toBe(true);
    m.setRule('no_live_promotion', false);
    expect(m.rules().find((x) => x.code === 'no_live_promotion')!.enabled).toBe(false);
    expect(m.dashboardRules(new Set(m.rules().filter((x) => x.enabled).map((x) => x.code))).some((f) => f.code === 'no_live_promotion')).toBe(false);
    expect(m.data().accounts.length).toBeGreaterThan(0);
  });
});

describe('tl;dv call follow-ups', () => {
  it('drafts one follow-up per call to the external attendee and links it to the prospect', async () => {
    const q = setup();
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/meetings?')) return new Response(JSON.stringify({ results: [{ id: 'm1', name: 'Nutrition Geeks x Brightform', happenedAt: '2026-09-16T10:00:00.000Z', organizer: { name: 'Isaac Sinclair', email: 'isaac@brightform.agency' }, invitees: [{ name: 'Rishi Shah', email: 'rishi@nutritiongeeks.co' }] }] }));
      if (u.endsWith('/transcript')) return new Response(JSON.stringify({ data: [{ speaker: 'Rishi', text: 'We want to launch in Germany in Q4.' }] }));
      if (u.endsWith('/highlights')) return new Response(JSON.stringify({ data: [{ text: 'Send the deck and price card', topic: { title: 'Next steps' } }] }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const client = new TldvClient('key', 'https://pasta.tldv.io/v1alpha1', fetchFn);
    const meetings = await client.listMeetings();
    expect(externalAttendee(meetings[0])).toEqual({ name: 'Rishi Shah', email: 'rishi@nutritiongeeks.co' });
    const r = await draftCallFollowups(q, { client, llm: async (system, user) => { expect(system).toContain('What we discussed:'); expect(user).toContain('launch in Germany'); return JSON.stringify({ subject: 'Nutrition Geeks x Brightform: next steps', body: 'Hi Rishi,\n\nThanks for the time today.\n\nWhat we discussed:\n- Germany in Q4\n\nNext steps:\n- Deck and price card attached\n\nVery best,\nIsaac' }); } });
    expect(r).toMatchObject({ checked: 1, drafted: 1, errors: [] });
    const d = q.draftForMeeting('m1')!;
    expect(d.kind).toBe('followup');
    expect(d.to_email).toBe('rishi@nutritiongeeks.co');
    expect(d.shop_name).toBe('Nutrition Geeks');
    expect(d.created_by).toBe('tldv');
    // Second run does not draft again.
    const r2 = await draftCallFollowups(q, { client, llm: async () => { throw new Error('should not be called'); } });
    expect(r2.drafted).toBe(0);
    expect(q.getSetting('tldv_since')).toBe('2026-09-16T10:00:00.000Z');
  });
});
