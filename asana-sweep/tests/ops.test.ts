import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { projectRows, projectionCsv, velocityOf } from '../src/stock/index';
import { incidentsFromFlags, renderSlackIncident, IncidentEngine } from '../src/incidents/index';
import { markdownToSlack, periodBounds, templateReport, renderReportPrompt, gatherReportData } from '../src/reports/client';
import { brandify, matchesItem, parseMcpListing, PlaybookEngine, shopLanguage } from '../src/playbook/index';
import { SEED_PLAYBOOK } from '../src/playbook/seed';
import { looksLikeQuestion, searchEvidence, tokens, Copilot } from '../src/copilot/index';
import { pickBestContact, bulkCandidates } from '../src/bd/bulk';
import { ApolloClient, ApolloCreditsError, isCreditsError } from '../src/bd/apollo';
import { FastmossClient, FastmossQuotaError, fastmossStatus, pullFastMoss, toolResultJson, unwrapShops } from '../src/bd/fastmoss';
import { existsSync, rmSync } from 'node:fs';
import { suggestTtsContact } from '../src/bd/sequence';
import { guessMarketFromSubject, parseSignature } from '../src/bd/tts-directory';
import type { TtsContact } from '../src/sweep/types';
import { apolloStatus, EnrichJob, enrichProspect, markApolloExhausted, personAtCompany, refreshApolloCredits } from '../src/bd/enrich';
import { dropExclamations, tailoredOpener, templateDraft, renderOutreachPrompt } from '../src/bd/outreach';
import type { Account, BdContact, BdProspect, StockSku } from '../src/sweep/types';

const sku = (o: Partial<StockSku> = {}): StockSku => ({ shop_id: 's1', account_id: 1, product_id: 'p1', product_title: 'Probiotic 30', sku_id: 'k1', sku_name: null, seller_sku: 'PRO-30', product_status: 'ACTIVATE', on_hand: 100, sold_7d: 35, sold_30d: 120, captured_at: '2026-09-17T00:00:00.000Z', velocity_override: null, exclude: false, note: null, ...o });

describe('stock countdown and projection', () => {
  it('blends weekly and monthly velocity, honours overrides', () => {
    expect(velocityOf(sku())).toBe(4.6); // 0.6*5 + 0.4*4
    expect(velocityOf(sku({ sold_7d: 0, sold_30d: 30 }))).toBe(1);
    expect(velocityOf(sku({ velocity_override: 2.5 }))).toBe(2.5);
  });
  it('computes days left, levels and send-in for the chosen cover', () => {
    const rows = projectRows([sku(), sku({ sku_id: 'k2', on_hand: 0 }), sku({ sku_id: 'k3', on_hand: 10, sold_7d: 14 }), sku({ sku_id: 'k4', sold_7d: 0, sold_30d: 0 })], { coverDays: 30, leadDays: 5, critDays: 7, warnDays: 14 });
    expect(rows[0].days_left).toBe(21.7);
    expect(rows[0].level).toBe('ok');
    expect(rows[0].send_in).toBe(Math.ceil(4.6 * 35) - 100);
    expect(rows[1].level).toBe('out');
    expect(rows[2].level).toBe('crit');
    expect(rows[3].level).toBe('idle');
    expect(rows[3].send_in).toBe(0);
  });
  it('writes the replenishment CSV with only the SKUs that need sending in', () => {
    const rows = projectRows([sku(), sku({ sku_id: 'k2', on_hand: 5000 })], { coverDays: 30 });
    const csv = projectionCsv({ shop_id: 's1', shop_name: 'Kijimea DE', account_id: 1, account_name: 'Kijimea', cover_days: 30, lead_days: 0, captured_at: null, rows, totals: { skus: 2, send_in_units: 0, send_in_skus: 1, out: 0, crit: 0, warn: 0 } }, { onlyNeeded: true });
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('Send in (30 days cover)');
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith('Kijimea DE,Probiotic 30,,PRO-30,k1,ACTIVATE,100,35,120,4.6,21.7,')).toBe(true);
  });
  it('stores snapshots and overrides', () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Kijimea DE', markets: 'DE', am_name: null, aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    expect(q.replaceStockSnapshot('shop1', a.id, [{ product_id: 'p', product_title: 'T', sku_id: 'k', sku_name: null, seller_sku: null, product_status: 'ACTIVATE', on_hand: 3, sold_7d: 1, sold_30d: 4 }])).toBe(1);
    q.setStockOverride('shop1', 'k', { velocity: 2, exclude: true });
    const rows = q.listStock('shop1');
    expect(rows[0].velocity_override).toBe(2);
    expect(rows[0].exclude).toBe(true);
    q.setStockOverride('shop1', 'k', { velocity: null, exclude: false });
    expect(q.listStock('shop1')[0].velocity_override).toBeNull();
  });
});

describe('incidents', () => {
  const account = (q: Queries, extra: Partial<Account> = {}) => q.createAccount({ name: 'Kijimea DE', markets: 'DE', am_name: 'Ana', aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: '#acct-kijimea', client_slack_channel: null, client_domain: null, ...extra });
  it('maps monitor flags to incident kinds', () => {
    const d = incidentsFromFlags([{ id: 1, account_id: 1, account_name: 'K', shop_id: 's', code: 'tts_unshipped', severity: 'crit', message: 'K: 3 orders waiting', detail: 'a, b', first_seen_at: '', last_seen_at: '', resolved_at: null, acknowledged_at: null }, { id: 2, account_id: 1, account_name: 'K', shop_id: null, code: 'tts_low_stock', severity: 'warn', message: 'x', detail: null, first_seen_at: '', last_seen_at: '', resolved_at: null, acknowledged_at: null }]);
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe('overdue_shipment');
    expect(d[0].message).toContain('a, b');
  });
  it('creates, posts, dedupes and resolves incidents with owner and channel', async () => {
    const q = new Queries(openTestDb());
    const a = account(q);
    q.createPerson({ name: 'Ana', role: 'am', email: null, slack_user_id: 'U123', notify: true });
    const posts: { channel: string; text: string; thread?: string | null }[] = [];
    const slack = { configured: true, channelId: async (c: string) => `C_${c.replace('#', '')}`, post: async (channel: string, text: string, o: { thread_ts?: string | null } = {}) => { posts.push({ channel, text, thread: o.thread_ts }); return { ts: '1.1', channel }; } };
    const eng = new IncidentEngine(q, slack as never, { configured: false } as never, null);
    const r1 = await eng.apply('tts', [{ account_id: a.id, shop_id: 's1', kind: 'negative_balance', message: 'Kijimea DE: 1 statement settled negative (-120 EUR on 2026-09-10)', fingerprint: 'st1' }]);
    expect(r1.opened).toHaveLength(1);
    expect(r1.opened[0].owner).toBe('Ana');
    expect(r1.opened[0].owner_slack_id).toBe('U123');
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe('C_acct-kijimea');
    expect(posts[0].text).toContain('[CRITICAL] Kijimea DE: Negative balance');
    expect(posts[0].text).toContain('<@U123>');
    expect(posts[0].text).toContain('Recommended action');
    const r2 = await eng.apply('tts', [{ account_id: a.id, shop_id: 's1', kind: 'negative_balance', message: 'same', fingerprint: 'st1' }]);
    expect(r2.opened).toHaveLength(0);
    expect(posts).toHaveLength(1);
    const r3 = await eng.apply('tts', []);
    expect(r3.resolved).toHaveLength(1);
    expect(posts[1].thread).toBe('1.1');
    expect(q.listIncidents({ open: true })).toHaveLength(0);
    expect(renderSlackIncident({ ...r1.opened[0], owner_slack_id: null })).toContain('*Owner:* Ana');
  });
  it('falls back to the default channel and records post errors', async () => {
    const q = new Queries(openTestDb());
    const a = account(q, { slack_channel: null, am_name: null });
    q.setSetting('incidents_default_channel', '#ops');
    const slack = { configured: true, channelId: async (c: string) => c, post: async () => { throw new Error('not_in_channel'); } };
    const eng = new IncidentEngine(q, slack as never, { configured: false } as never, null);
    const r = await eng.apply('ingest', [{ account_id: a.id, shop_id: null, kind: 'campaign_issue', message: 'GMV Max DE rejected' }]);
    expect(r.opened[0].slack_channel).toBe('#ops');
    expect(q.getIncident(r.opened[0].id)?.post_error).toContain('not_in_channel');
  });
});

describe('client reports', () => {
  it('computes weekly and monthly period bounds', () => {
    expect(periodBounds('weekly', '2026-09-13')).toEqual({ start: '2026-09-07', end: '2026-09-13', prev_start: '2026-08-31', prev_end: '2026-09-06' });
    expect(periodBounds('weekly', null, new Date('2026-09-17T10:00:00Z'))).toEqual({ start: '2026-09-07', end: '2026-09-13', prev_start: '2026-08-31', prev_end: '2026-09-06' });
    expect(periodBounds('monthly', null, new Date('2026-09-17T10:00:00Z'))).toEqual({ start: '2026-08-01', end: '2026-08-31', prev_start: '2026-07-01', prev_end: '2026-07-31' });
    expect(periodBounds('monthly', '2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28', prev_start: '2026-01-01', prev_end: '2026-01-31' });
  });
  it('gathers GMV, calls and market context and renders the prompt and template', async () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Kijimea DE', markets: 'DE', am_name: 'Ana', aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: '#ext-kijimea', client_domain: 'kijimea.com' });
    q.addShop(a.id, 'cr1', 'Kijimea DE', 'EUR');
    q.upsertGmv([{ shop_id: 'cr1', date: '2026-09-08', total_gmv: 1000, affiliate_gmv: 600, units: 40 }, { shop_id: 'cr1', date: '2026-09-10', total_gmv: 500, affiliate_gmv: 200, units: 20 }, { shop_id: 'cr1', date: '2026-09-02', total_gmv: 800, affiliate_gmv: 300, units: 30 }]);
    q.createProspect({ shop_name: 'Beper IT', market: 'DE', rise_score: 0.3, gmv_7d: 37733, currency: 'EUR', category: 'Home' } as never);
    const tldv = { configured: true, listMeetings: async () => [{ id: 'm1', name: 'Kijimea weekly', happenedAt: '2026-09-09T10:00:00Z', url: 'https://tldv.io/m1', organizer: null, invitees: [{ email: 'gia@kijimea.com' }] }, { id: 'm2', name: 'Other', happenedAt: '2026-09-09T10:00:00Z', url: null, organizer: null, invitees: [] }], highlights: async () => ['Creatives: new batch agreed for 20 Sept'], transcript: async () => '' };
    const bounds = periodBounds('weekly', '2026-09-13');
    const data = await gatherReportData(q, a, bounds, { tldv: tldv as never, tts: { configured: false } as never });
    expect(data.gmv.total).toBe(1500);
    expect(data.gmv.prev_total).toBe(800);
    expect(data.gmv.affiliate).toBe(800);
    expect(data.calls).toHaveLength(1);
    expect(data.calls[0].notes[0]).toContain('new batch');
    expect(data.market[0].market).toBe('DE');
    expect(data.market[0].prospects).toBeGreaterThanOrEqual(1);
    expect(data.market[0].surging).toBeGreaterThanOrEqual(1);
    expect(data.market[0].category_leaders.length).toBeGreaterThanOrEqual(1);
    const { system, user } = renderReportPrompt(a, 'weekly', bounds, data);
    expect(system).toContain('client Kijimea DE');
    expect(user).toContain('| Total GMV | €1,500 | €800 | +88% |');
    expect(user).toContain('Kijimea weekly');
    const t = templateReport(a, 'weekly', bounds, data);
    expect(t.title).toBe('Kijimea DE: weekly report 2026-09-07 to 2026-09-13');
    expect(t.body).toContain('## The numbers');
    expect(markdownToSlack(`# Title\n\n**Bold** point\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |`)).toBe('*Title*\n\n*Bold* point\n\n• one\n• two\n\n```\na   b\n1   2\n```');
  });
});

describe('cruva playbook', () => {
  it('matches remote names to playbook keys and parses MCP listings', () => {
    expect(matchesItem('sample_sent', 'Sample sent', 'Sample sent')).toBe(true);
    expect(matchesItem('content_not_posted', 'Content not posted', 'No content posted')).toBe(true);
    expect(matchesItem('first_outreach', 'First outreach', 'Big first outreach')).toBe(true);
    expect(matchesItem('monthly_deals_outreach', 'Monthly deals outreach', 'September Deals - Big Outreach')).toBe(true);
    expect(matchesItem('retarget_bonus', 'Retarget + bonus', 'Retarget + bonus')).toBe(true);
    expect(matchesItem('sample_sent', 'Sample sent', 'Lark invite')).toBe(false);
    const rows = parseMcpListing('Automations (total: 2):\n\n- Sample sent (ID: 699dd0cc90eea5de3df33a9e) | Status: active | Message: dm | Audience: groups | Sent: 1,714 | Replies: 222 | GMV: $265304.9\n- New outreach summer (ID: 6a4d1ea9) | Status: archived | Message: dm | Audience: new_affiliates\n\nGroups (total: 1):\n\n- Retarget + bonus (ID: 697a3eb4) | Creators: 22,006\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'automation', remote_id: '699dd0cc90eea5de3df33a9e', name: 'Sample sent', enabled: true });
    expect(rows[1].enabled).toBe(false);
    expect(rows[2]).toMatchObject({ kind: 'group', name: 'Retarget + bonus' });
    expect(brandify({ a: 'Hi from [brand]', b: ['[brand] x'] }, 'Kijimea')).toEqual({ a: 'Hi from Kijimea', b: ['Kijimea x'] });
    expect(shopLanguage('DE')).toBe('de');
    expect(shopLanguage('UK')).toBe('en');
  });
  it('seeds the library, imports a listing, reconciles and builds an apply pack', async () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'GreatVita', markets: 'DE', am_name: null, aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    q.addShop(a.id, 'gv', 'GreatVita DE', 'EUR');
    const eng = new PlaybookEngine(q, { configured: false } as never);
    eng.seed();
    expect(q.listPlaybook().length).toBe(SEED_PLAYBOOK.length);
    const d0 = eng.data();
    expect(d0.shops.find((x) => x.shop_id === 'gv')?.language).toBe('de');
    eng.importListing('gv', 'Automations (total: 2):\n\n- Sample sent (ID: x1) | Status: active | Message: dm | Audience: groups\n- Big first outreach (ID: x2) | Status: stopped | Message: dm | Audience: new_affiliates\n\nGroups (total: 1):\n\n- Sample sent (ID: g1) | Creators: 12');
    const cells = q.listPlaybookCells();
    expect(cells.find((c) => c.kind === 'automation' && c.playbook_key === 'sample_sent')?.status).toBe('set');
    expect(cells.find((c) => c.kind === 'automation' && c.playbook_key === 'first_outreach')?.note).toBe('exists but stopped');
    expect(cells.find((c) => c.kind === 'group' && c.playbook_key === 'sample_sent')?.remote_id).toBe('g1');
    expect(cells.find((c) => c.kind === 'automation' && c.playbook_key === 'content_not_posted')?.status).toBe('missing');
    const r = await eng.apply({ shop_ids: ['gv'], keys: ['group:content_not_posted', 'automation:content_not_posted', 'automation:sample_sent', 'automation:top_creators_collab'] });
    expect(r.created).toBe(0);
    expect(r.queued).toBe(1); // the group (automation needs the group first, collab needs a list)
    expect(r.blocked).toBe(2);
    const group = r.pack.find((p) => p.tool === 'create_group')!;
    expect(group.payload).toMatchObject({ shop_id: 'gv', title: 'Content not posted' });
    const auto = r.pack.find((p) => p.tool === 'create_automation' && (p.payload.title as string) === 'Content not posted')!;
    expect(auto.blockers[0]).toContain('needs the "content_not_posted" group');
    expect((auto.payload.dm_messages as { content: string }[])[0].content).toContain('GreatVita');
    expect((auto.payload.dm_messages as { content: string }[])[0].content).toContain('Sample ist gut bei dir angekommen');
    expect(q.listPlaybookCells().find((c) => c.kind === 'group' && c.playbook_key === 'content_not_posted')?.status).toBe('queued');
  });
});

describe('client copilot', () => {
  it('tokenises, spots questions and ranks evidence with snippets', () => {
    expect(tokens('When will the new creatives go live?')).toEqual(['new', 'creativ', 'live']);
    expect(looksLikeQuestion('Any update on the EPR registration?')).toBe(true);
    expect(looksLikeQuestion('Wann kommen die neuen Samples')).toBe(true);
    expect(looksLikeQuestion('Thanks all')).toBe(false);
    const rows = [
      { kind: 'call', title: 'Kijimea weekly', text: 'Ana: the new creatives go live on 20 September once the client signs off the storyboard. Gianluca: fine.', url: null, occurred_at: '2026-09-09T10:00:00Z' },
      { kind: 'sop', title: 'Sample SOP', text: 'Samples are approved within 24h and shipped by TikTok.', url: null, occurred_at: null },
    ];
    const hits = searchEvidence(rows, 'When will the new creatives go live?');
    expect(hits[0].title).toBe('Kijimea weekly');
    expect(hits[0].snippet).toContain('20 September');
    expect(hits.some((h) => h.title === 'Sample SOP')).toBe(false);
  });
  it('indexes SOPs and account data, drafts an answer with sources, and sends it to the Slack thread', async () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Kijimea DE', markets: 'DE', am_name: null, aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: '#ext-kijimea', client_domain: 'kijimea.com' });
    q.createContext({ language: '*', scope: 'both', account_id: a.id, title: 'Reporting cadence', body: 'We send the weekly report every Monday before noon and the monthly report on the 3rd working day.', enabled: true });
    const posts: { channel: string; text: string; thread?: string | null }[] = [];
    const slack = { configured: true, channelId: async (c: string) => c, post: async (channel: string, text: string, o: { thread_ts?: string | null } = {}) => { posts.push({ channel, text, thread: o.thread_ts }); return { ts: '2', channel }; }, history: async () => [], tryDm: async () => null };
    const cp = new Copilot(q, { slack: slack as never, tldv: { configured: false } as never, gmail: null, llm: async (_s: string, u: string) => `We send the weekly report every Monday before noon [1].${u.includes('Reporting cadence') ? '' : ' (no source)'}` });
    const idx = await cp.index();
    expect(idx.added).toBeGreaterThanOrEqual(1);
    const qn = await cp.ask({ account_id: a.id, question: 'When do you send the weekly report?', source: 'slack', channel: '#ext-kijimea', thread_ts: '1.0', external_id: '1.0', asked_by: 'U9' });
    expect(qn?.status).toBe('drafted');
    expect(qn?.sources[0].title).toBe('Reporting cadence');
    expect(qn?.answer).toContain('[1]');
    expect(await cp.ask({ account_id: a.id, question: 'dup', source: 'slack', external_id: '1.0' })).toBeNull();
    const sent = await cp.send(qn!.id);
    expect(sent.mode).toBe('slack');
    expect(posts[0]).toMatchObject({ channel: '#ext-kijimea', thread: '1.0' });
    expect(posts[0].text).not.toContain('[1]');
    expect(q.getQuestion(qn!.id)?.status).toBe('answered');
  });
});

describe('bulk cold emails', () => {
  const contact = (o: Partial<BdContact>): BdContact => ({ id: 1, prospect_id: 1, name: 'A', title: null, email: 'a@x.com', linkedin_url: null, phone: null, source: 'apollo', apollo_id: null, enriched: true, notes: null, linkedin_status: 'none', linkedin_requested_at: null, linkedin_connected_at: null, linkedin_messaged_at: null, created_at: '', ...o });
  it('picks the most senior relevant contact with an email', () => {
    const p = { market: 'DE', contacts: [contact({ id: 1, name: 'Intern', title: 'Marketing Intern' }), contact({ id: 2, name: 'Head', title: 'Head of E-Commerce DACH' }), contact({ id: 3, name: 'CEO', title: 'CEO', email: null }), contact({ id: 4, name: 'Info', title: 'Founder', email: 'info@x.com' })] };
    expect(pickBestContact(p)?.name).toBe('Head');
    expect(pickBestContact(p, { emailedIds: new Set([2]) })?.name).toBe('Info');
    expect(pickBestContact({ market: 'DE', contacts: [] })).toBeNull();
  });
  it('lists candidates once per prospect, skipping clients, won/lost and already drafted', () => {
    const q = new Queries(openTestDb());
    const p1 = q.createProspect({ shop_name: 'Beper IT', market: 'IT', rise_score: 0.3, gmv_7d: 37733, currency: 'EUR' } as never);
    const p2 = q.createProspect({ shop_name: 'Won Co', market: 'IT', rise_score: 0.2 } as never);
    const p3 = q.createProspect({ shop_name: 'Drafted Co', market: 'DE', rise_score: 0.1 } as never);
    for (const [p, email] of [[p1, 'g@beper.it'], [p2, 'x@won.it'], [p3, 'y@drafted.de']] as const) q.addContact(p.id, { name: 'Gianluca Bosetto', title: 'Head of Ecommerce', email });
    q.patchProspect(p2.id, { status: 'won' }, null);
    const c3 = q.getProspect(p3.id)!.contacts[0];
    q.createDraft({ prospect_id: p3.id, contact_id: c3.id, to_name: c3.name, to_email: c3.email!, subject: 's', body: 'b', language: 'en', style: 'short', generator: 'template', created_by: null });
    const ids = [p1.id, p2.id, p3.id];
    const all = bulkCandidates(q, { ids });
    expect(all.map((c) => c.prospect.shop_name)).toEqual(['Beper IT']);
    expect(bulkCandidates(q, { ids, include_drafted: true }).map((c) => c.prospect.shop_name)).toEqual(['Beper IT', 'Drafted Co']);
    expect(bulkCandidates(q, { ids, market: 'DE', include_drafted: true })).toHaveLength(1);
  });
  it('opener has no category, no exclamation marks, and the template follows the reference email', () => {
    const p = { shop_name: 'beper_it', brand: 'Beper', market: 'IT', category: 'Home Appliances', gmv_7d: 37733, currency: 'EUR', rise_score: 0.08, new_shop_30d: false, gmv_started_30d: false, outreach_log: [], contacts: [] } as unknown as BdProspect;
    expect(tailoredOpener(p)).toBe('Beper is climbing on TikTok Shop Italy, with €37,733 in the last seven days.');
    expect(tailoredOpener({ ...p, new_shop_30d: true })).not.toContain('Home Appliances');
    const d = templateDraft({ prospect: p, contact: { name: 'Gianluca Bosetto', title: null, email: 'g@beper.it' }, language: 'en', style: 'short', examples: [], pitch: '', senderName: 'Isaac Sinclair', senderTitle: 'CEO', bookingUrl: 'https://calendly.com/isaacsinclair/30min' });
    expect(d.body).toBe('Hi Gianluca,\n\nBeper is climbing on TikTok Shop Italy, with €37,733 in the last seven days.\n\nI run Brightform, the #1 TikTok Shop Partner in the EU by GMV, with 42 shops under management across DE, FR, IT, ES and the UK. We run affiliate and creator programmes at scale, live commerce from our own studio and GMV Max, and act as Merchant of Record for brands without a local entity.\n\nWould you be open to a quick call to see whether there\'s a fit? Grab a slot here: https://calendly.com/isaacsinclair/30min\n\nVery best,\nIsaac');
    expect(d.body).not.toContain('!');
    expect(dropExclamations('Great news! Beper is climbing! Really')).toBe('Great news. Beper is climbing. Really');
    const { system } = renderOutreachPrompt({ prospect: p, contact: { name: 'G', title: null, email: 'g@b.it' }, language: 'en', style: 'short', examples: [], pitch: '', senderName: 'Isaac Sinclair', senderTitle: 'CEO', bookingUrl: '' });
    expect(system).toContain('Never use an exclamation mark');
    expect(system).toContain('## Reference email');
  });
});

describe('apollo credits and deeper enrichment', () => {
  const client = (routes: Record<string, (body: Record<string, unknown>) => Response | Promise<Response>>) => new ApolloClient('key', 'https://api.apollo.io/api/v1', (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const h = routes[u.pathname.replace('/api/v1', '')];
    return h ? h({ ...body, __query: Object.fromEntries(u.searchParams) }) : new Response('{"error":"nope"}', { status: 404 });
  }) as typeof fetch);
  it('reads the balance from the API profile, falls back to usage stats, and flags credit errors', async () => {
    const c1 = client({ '/users/api_profile': () => new Response(JSON.stringify({ num_credits_remaining: 8510, effective_num_lead_credits: 10010, num_lead_credits_used: 0 })) });
    expect(await c1.credits()).toMatchObject({ remaining: 8510, limit: 10010, used: 1500, source: 'profile' });
    const c2 = client({ '/usage_stats/credit_usage_stats': () => new Response(JSON.stringify({ credit_usage_stats: { lead_credit: { limit: 10010, consumed: 1500, left_over: 8510 } }, current_credit_cycle: { start_date: '2026-09-19T12:39:46.000+00:00', end_date: '2026-10-19T12:39:47.000+00:00' } })) });
    expect(await c2.credits()).toMatchObject({ remaining: 8510, used: 1500, cycle_end: '2026-10-19T12:39:47.000+00:00', source: 'usage_stats' });
    const c3 = client({ '/people/bulk_match': () => new Response(JSON.stringify({ error: 'Insufficient credits' }), { status: 402 }) });
    await expect(c3.bulkMatch(['a'])).rejects.toBeInstanceOf(ApolloCreditsError);
    expect(isCreditsError(new Error('Apollo 403: You do not have enough credits'))).toBe(true);
    const c4 = client({ '/auth/health': () => new Response(JSON.stringify({ is_logged_in: true })) });
    expect(await c4.health()).toBe(true);
  });
  it('caches the balance, marks exhausted, and the job pauses and resumes with credits', async () => {
    const q = new Queries(openTestDb());
    const good = client({ '/users/api_profile': () => new Response(JSON.stringify({ num_credits_remaining: 12, effective_num_lead_credits: 100 })) });
    const s1 = await refreshApolloCredits(q, good);
    expect(s1).toMatchObject({ ok: true, remaining: 12, limit: 100, exhausted: false });
    markApolloExhausted(q);
    expect(apolloStatus(q, good).exhausted).toBe(true);
    const job = new EnrichJob(q, good);
    expect(job.start({ mode: 'new' }).stopped_reason).toBe('credits');
    const s2 = await refreshApolloCredits(q, good);
    expect(s2.exhausted).toBe(false);
    const empty = client({ '/users/api_profile': () => new Response(JSON.stringify({ num_credits_remaining: 0, effective_num_lead_credits: 100 })) });
    expect((await refreshApolloCredits(q, empty)).exhausted).toBe(true);
  });
  it('candidate modes: new, no_email and all', () => {
    const q = new Queries(openTestDb());
    const fresh = q.createProspect({ shop_name: 'Fresh Co', market: 'DE' } as never);
    const noEmail = q.createProspect({ shop_name: 'NoEmail Co', market: 'DE' } as never);
    q.addContact(noEmail.id, { name: 'A', title: 'CEO', source: 'apollo', apollo_id: 'x' });
    const withEmail = q.createProspect({ shop_name: 'Email Co', market: 'DE' } as never);
    q.addContact(withEmail.id, { name: 'B', email: 'b@e.com', source: 'apollo', apollo_id: 'y' });
    const recent = q.createProspect({ shop_name: 'Recent Co', market: 'DE' } as never);
    q.addContact(recent.id, { name: 'C', source: 'apollo', apollo_id: 'z' });
    q.patchProspect(recent.id, { enriched_at: new Date().toISOString() });
    const job = new EnrichJob(q, client({}));
    const ids = (m: 'new' | 'no_email' | 'all') => job.candidates(m).filter((p) => [fresh.id, noEmail.id, withEmail.id, recent.id].includes(p.id)).map((p) => p.shop_name).sort();
    expect(ids('new')).toEqual(['Fresh Co']);
    expect(ids('no_email')).toEqual(['NoEmail Co']);
    expect(ids('all')).toEqual(['Fresh Co', 'NoEmail Co']);
  });
  it('guards name-only searches by employer and stores company details', async () => {
    expect(personAtCompany({ id: '1', name: 'A', title: null, email: null, linkedin_url: null, phone: null, organization: 'Beper S.p.A.', email_status: null, city: null, country: null }, 'Beper')).toBe(true);
    expect(personAtCompany({ id: '1', name: 'A', title: null, email: null, linkedin_url: null, phone: null, organization: 'Deloitte', email_status: null, city: null, country: null }, 'Beper')).toBe(false);
    expect(personAtCompany({ id: '1', name: 'A', title: null, email: null, linkedin_url: null, phone: null, organization: 'X', email_status: null, city: null, country: null, organization_id: 'o1' }, 'Beper', 'o1')).toBe(true);
    const q = new Queries(openTestDb());
    const p = q.createProspect({ shop_name: 'Beper IT', brand: 'Beper', market: 'IT' } as never);
    const c = client({
      '/mixed_companies/search': () => new Response(JSON.stringify({ organizations: [{ id: 'o1', name: 'Beper', primary_domain: 'beper.com' }] })),
      '/organizations/enrich': () => new Response(JSON.stringify({ organization: { id: 'o1', name: 'Beper', primary_domain: 'beper.com', industry: 'consumer goods', estimated_num_employees: 120, linkedin_url: 'https://linkedin.com/company/beper', city: 'Bergamo', country: 'Italy' } })),
      '/mixed_people/api_search': (b) => new Response(JSON.stringify({ people: b.person_titles ? [{ id: 'p1', name: 'Gianluca Bosetto', title: 'President', organization: { id: 'o1', name: 'Beper' } }] : [{ id: 'p2', name: 'Anna Rossi', title: 'Head of Digital', organization: { id: 'o1', name: 'Beper' } }] })),
      '/people/bulk_match': (b) => new Response(JSON.stringify({ matches: (b.details as { id: string }[]).map((d) => ({ id: d.id, name: d.id === 'p1' ? 'Gianluca Bosetto' : 'Anna Rossi', email: `${d.id}@beper.com`, email_status: 'verified' })) })),
    });
    const r = await enrichProspect(q, p.id, { reveal: 2 }, c);
    expect(r).toMatchObject({ matched: true, domain: 'beper.com', found: 2, kept: 2, revealed: 2, with_email: 2 });
    const after = q.getProspect(p.id)!;
    expect(after.company_industry).toBe('consumer goods');
    expect(after.company_employees).toBe(120);
    expect(after.company_location).toBe('Bergamo, Italy');
    expect(after.enrich_note).toContain('2 revealed');
    expect(after.contacts.map((x) => x.email).sort()).toEqual(['p1@beper.com', 'p2@beper.com']);
  });
});

describe('fastmoss mcp client and pull', () => {
  const fake = (opts: { rowsFor?: (region: string, page: number) => Record<string, unknown>[]; quotaAfter?: number; sse?: boolean; rejectKey?: boolean; credits?: number } = {}) => {
    const calls: { method: string; params: Record<string, unknown>; headers: Record<string, string> }[] = [];
    let n = 0;
    const reply = (id: unknown, result: unknown) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id, result });
      return opts.sse ? new Response(`event: message\ndata: ${body}\n\n`, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' } }) : new Response(body, { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
    };
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const msg = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method: string; params: Record<string, unknown> };
      calls.push({ method: msg.method, params: msg.params, headers });
      if (opts.rejectKey || headers.authorization !== 'Bearer key-1') return new Response('unauthorized', { status: 401 });
      if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: '2025-03-26', serverInfo: { name: 'fastmoss-mcp', version: '1.0.5' } });
      if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (msg.method === 'tools/list') return reply(msg.id, { tools: [{ name: 'shop_search' }, { name: 'credit_usage_summary' }] });
      if (msg.method === 'tools/call') {
        const { name, arguments: a } = msg.params as { name: string; arguments: Record<string, unknown> };
        if (name === 'credit_usage_summary') return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({ balance: { available_credits: opts.credits ?? 756, total_granted_credits: 5500, total_consumed_credits: 3390 }, entitlements: { monthly_credits: 1800, plan_expire_at: '2026-10-03 00:16:30' }, subscriptions: [{ package_name: 'Pro' }] }) }] });
        n += 1;
        if (opts.quotaAfter !== undefined && n > opts.quotaAfter) return reply(msg.id, { isError: true, content: [{ type: 'text', text: 'Insufficient credits, please recharge' }] });
        const region = (a.filter as { region: string }).region;
        const rows = opts.rowsFor ? opts.rowsFor(region, Number(a.page ?? 1)) : [];
        return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({ shops: rows, total: 500 }) }] });
      }
      return new Response('{"jsonrpc":"2.0","error":{"code":-32601,"message":"no such method"}}', { status: 200 });
    }) as typeof fetch;
    return { calls, client: new FastmossClient('key-1', 'https://mcp.fastmoss.com/mcp', fetchFn, 'http') };
  };
  const shop = (region: string, i: number, rise: number) => ({ shop_name: `${region} Shop ${i}`, seller_id: `${region}${i}`, region, gmv_last_7d: 1000 * rise, total_gmv: 1000, units_sold_last_7d: 10, total_units_sold: 100, currency_code: region === 'UK' ? 'GBP' : 'EUR', main_category: { name: 'Beauty' } });
  it('initialises once, keeps the session id, calls shop_search with the tool arguments, parses JSON and SSE replies', async () => {
    for (const sse of [false, true]) {
      const { calls, client } = fake({ rowsFor: (r, p) => [shop(r, p, 0.2)], sse });
      const rows = await client.shopSearch({ region: 'DE', page: 2 });
      expect(rows).toHaveLength(1);
      expect(calls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
      expect(calls[2].params).toMatchObject({ name: 'shop_search', arguments: { filter: { region: 'DE' }, orderby: [{ field: 'day7_gmv', order: 'desc' }], page: 2, pagesize: 10 } });
      expect(calls[2].headers['mcp-session-id']).toBe('sess-1');
      expect(calls[2].headers['x-api-key']).toBe('key-1');
      await client.shopSearch({ region: 'FR' });
      expect(calls.filter((c) => c.method === 'initialize')).toHaveLength(1);
      expect(await client.credits()).toMatchObject({ available: 756, monthly: 1800, plan: 'Pro' });
    }
    expect(toolResultJson({ content: [{ type: 'text', text: 'Result:\n{"a":1}' }] })).toEqual({ a: 1 });
    expect(unwrapShops({ data: { list: [{ seller_id: 'x' }] } })).toHaveLength(1);
  });
  it('reports a rejected key and quota errors', async () => {
    const { client } = fake({ rejectKey: true });
    const t = await client.test();
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/401/);
    const { client: c2 } = fake({ rowsFor: (r) => [shop(r, 1, 0.5)], quotaAfter: 0 });
    await expect(c2.shopSearch({ region: 'DE' })).rejects.toBeInstanceOf(FastmossQuotaError);
    const { client: c3 } = fake({ rowsFor: (r) => [shop(r, 1, 0.5)] });
    expect(await c3.test()).toMatchObject({ ok: true, transport: 'http', server: 'fastmoss-mcp 1.0.5', tools: 2, rows: 1 });
  });
  it('pulls the risers plus the top three pages, writes the file, upserts, records credits, and stops on quota', async () => {
    const q = new Queries(openTestDb());
    const dir = `${process.cwd()}/tests/.tmp-pulls-${Date.now()}`;
    process.env.BD_PULLS_DIR = dir;
    try {
      const { client, calls } = fake({ rowsFor: (r, p) => Array.from({ length: 10 }, (_, i) => shop(r, p * 10 + i, p <= 3 ? 0.01 : i === 0 ? 0.3 : 0.01)) });
      const r = await pullFastMoss(q, client, { markets: ['DE', 'UK'], pages: 5, date: '2026-09-21', delayMs: 0, sorts: ['day7_gmv'], minGmv7d: 0 });
      expect(r.markets.map((m) => [m.market, m.pages, m.kept])).toEqual([['DE', 5, 32], ['UK', 5, 32]]);
      expect(r.added).toBe(64);
      expect(r.new_surging).toBe(4); // one 30% riser per page on pages 4 and 5, both markets
      expect(r.file).toBe('2026-09-21.json');
      expect(existsSync(`${dir}/2026-09-21.json`)).toBe(true);
      expect(calls.filter((c) => c.method === 'tools/call' && (c.params as { name: string }).name === 'shop_search')).toHaveLength(10);
      const p = q.listProspects(false).find((x) => x.shop_name === 'UK Shop 40')!;
      expect(p).toMatchObject({ market: 'UK', currency: 'GBP', category: 'Beauty', source: 'fastmoss' });
      expect(JSON.parse(q.getSetting('bd_pulls_imported', '[]'))).toContain('2026-09-21.json');
      const st = fastmossStatus(q, client);
      expect(st.last_pull?.added).toBe(64);
      expect(st.credits?.available).toBe(756);
      expect(st.quota_hit_at).toBeNull();
      const { client: c2 } = fake({ rowsFor: (r, p) => [shop(r, p, 0.5)], quotaAfter: 1 });
      const r2 = await pullFastMoss(q, c2, { markets: ['DE', 'FR'], pages: 3, date: '2026-09-22', delayMs: 0, sorts: ['day7_gmv'], minGmv7d: 0 });
      expect(r2.quota_hit).toBe(true);
      expect(r2.markets[0].kept).toBe(1);
      expect(fastmossStatus(q, c2).quota_hit_at).not.toBeNull();
    } finally {
      delete process.env.BD_PULLS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tiktok shop AM suggestion and gmail directory', () => {
  const c = (o: Partial<TtsContact>): TtsContact => ({ id: Math.floor(Math.random() * 1e6), market: 'DE', category: null, name: 'X', role: null, lark: null, email: null, notes: null, is_agency_manager: false, ...o });
  it('picks the obvious category owner, otherwise the TSP manager, ranked by closeness and seniority', () => {
    const list = [
      c({ id: 1, name: 'Marina Kress', category: 'Beauty', role: 'Account Manager Beauty', notes: 'Closeness 7 · gives us active leads' }),
      c({ id: 2, name: 'Laurie', category: 'FMCG & Beauty', role: 'FMCG / Beauty DE', notes: 'Closeness 10 · gives us active leads' }),
      c({ id: 3, name: 'Finja Zeyss', category: 'Beauty', role: 'Senior AM Beauty', notes: 'Closeness 6 · No Apollo record: likely moved on' }),
      c({ id: 4, name: 'Ningxin Wu', role: 'Multi-Category Lead' }),
      c({ id: 5, name: 'Ali Atahan Demirci', role: 'TSP partner manager DE', is_agency_manager: true, notes: 'No Apollo record' }),
      c({ id: 6, name: 'Saniah Ahmed', role: 'Head of Agency Partnerships', is_agency_manager: true, notes: 'Primary TSP contact · Closeness 8' }),
      c({ id: 7, market: 'ES', name: 'Gerard Ferreiro', category: 'FMCG (Food & Beverages)', role: 'FMCG Category Manager' }),
      c({ id: 8, market: 'ES', name: 'Tingyu L', role: 'Partnerships lead', is_agency_manager: true }),
      c({ id: 9, market: 'ES', name: 'Wilbur Hu', role: 'TSP manager ES', is_agency_manager: true, notes: 'Primary TSP contact' }),
    ];
    const beauty = suggestTtsContact(list, { market: 'DE', category: 'Beauty & Personal Care' });
    expect(beauty.tier).toBe('category');
    expect(beauty.contact?.name).toBe('Laurie');
    expect(beauty.fallback?.name).toBe('Saniah Ahmed');
    const phones = suggestTtsContact(list, { market: 'DE', category: 'Phones & Electronics' });
    expect(phones.tier).toBe('tsp_manager');
    expect(phones.contact).toBeNull();
    expect(phones.fallback?.name).toBe('Saniah Ahmed');
    const esFood = suggestTtsContact(list, { market: 'ES', category: 'Food & Beverages' });
    expect(esFood.contact?.name).toBe('Gerard Ferreiro');
    const esToys = suggestTtsContact(list, { market: 'ES', category: 'Toys' });
    expect(esToys.tier).toBe('tsp_manager');
    expect(esToys.fallback?.name).toBe('Wilbur Hu');
    const fr = suggestTtsContact(list, { market: 'FR', category: 'Beauty' });
    expect(fr.tier).toBe('tsp_manager');
    expect(fr.fallback?.name).toBe('Saniah Ahmed');
  });
  it('reads role, Lark link and market from a signature', () => {
    const sig = parseSignature('Ningxin Wu', 'Hi Deb,\n\nHerewith, let me introduce you to Isaac.\n\nBest regards,\nNingxin\n\nNingxin Wu\nMulti-Category Lead\n +4915222933667 <http://tel:+4915222933667>\n ningxin.wu@tiktok.com\nClick here to add me on Lark\n<https://www.larkoffice.com/invitation/page/add_contact/?token=abc&amp;unique_id=SHw==>\nTikTok - Munich');
    expect(sig.role).toBe('Multi-Category Lead');
    expect(sig.lark).toBe('https://www.larkoffice.com/invitation/page/add_contact/?token=abc&unique_id=SHw==');
    expect(sig.marketHint).toBe('DE');
    const es = parseSignature('Gerard Ferreiro', 'Thanks,\n--\n*Gerard Ferreiro*\nFMCG Category Manager\nPaseo de la Castellana 81, Piso 13\nMadrid 28046\nTel: +34 626 35 86 68\ngerard.ferreiro@tiktok.com');
    expect(es.role).toBe('FMCG Category Manager');
    expect(es.categoryHint).toBe('Food & Beverages');
    expect(es.marketHint).toBe('ES');
    const inline = parseSignature('Saniah Ahmed', 'Best,\nSaniah\n\n*Saniah Ahmed **|* *TikTok Global E-Commerce Partnership Development*\nEmail: saniah.ahmed@tiktok.com');
    expect(inline.role).toContain('Partnership Development');
    expect(guessMarketFromSubject('Accepted: Brightform Spain x TikTok Shop Spain')).toBe('ES');
    expect(parseSignature('Joshua Gerstendorf', "joshua.gerstendorf@tiktok.com 's invitation\nBrightform x TikTok - Weekly").role).toBeNull();
  });
  it('the counterpart map is seeded and drives the suggestion', () => {
    const q = new Queries(openTestDb());
    const all = q.listTtsContacts();
    expect(all.length).toBeGreaterThanOrEqual(170);
    expect(all.some((x) => x.name === 'Joshua Gerstendorf' && x.is_agency_manager && x.market === 'DE')).toBe(true);
    expect(all.some((x) => x.name === 'Gerard Ferreiro' && x.market === 'ES' && /FMCG/.test(x.category ?? ''))).toBe(true);
    expect(all.filter((x) => x.market === 'ES').length).toBe(46);
    expect(suggestTtsContact(all, { market: 'DE', category: 'Beauty & Personal Care' }).contact?.name).toBe('Laurie');
    expect(suggestTtsContact(all, { market: 'DE', category: 'Phones & Electronics' }).contact?.name).toBe('Niklas Brunn');
    expect(suggestTtsContact(all, { market: 'DE', category: 'Home Supplies' }).contact?.name).toBe('Giulia');
    const deToys = suggestTtsContact(all, { market: 'DE', category: 'Toys & Hobbies' });
    expect(deToys.tier).toBe('tsp_manager');
    expect(deToys.fallback?.name).toBe('Saniah Ahmed');
    expect(suggestTtsContact(all, { market: 'ES', category: 'Beauty & Personal Care' }).fallback?.name).toBe('Wilbur Hu');
    expect(suggestTtsContact(all, { market: 'UK', category: 'Sports & Outdoor' }).contact?.name).toBe('Massimo Rocchelli');
    expect(suggestTtsContact(all, { market: 'IT', category: 'Fashion' }).fallback?.name).toBe('Vincenzo Santillo');
    expect(suggestTtsContact(all, { market: 'FR', category: 'Fashion' }).fallback?.name).toBe('Alexandre Giraudeau');
    expect(suggestTtsContact(all, { market: 'NL', category: 'Fashion' }).fallback?.name).toBe('Jiayue Ren');
  });
});
