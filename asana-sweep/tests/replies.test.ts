import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { buildContext, cruvaShopFor, renderPrompt } from '../src/inbox/context';
import { CruvaRest } from '../src/cruva/rest';
import { defaultPolicy, inQuietHours, onlyFilterBlocker, parseClassification, prefilter, processConversations, repliesData, sampleThread, savePolicy, startOfDay, summary, weeklyDigest, feedback } from '../src/inbox/replies';
import { parseOrder } from '../src/health/tts-pull';
import type { InboxChannel } from '../src/sweep/types';

const SHOP = 'replyshop1';
const setup = () => {
  const q = new Queries(openTestDb());
  const account = q.createAccount({ name: 'Nutori', markets: 'DE', am_name: 'Elena', aa_name: 'DM', enabled: true, notes: null, commission_pct: 12, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
  q.upsertTtsShop({ id: SHOP, name: 'Nutori DE', region: 'DE', seller_type: 'LOCAL', cipher: 'x' }, { access_token: 'a', refresh_token: 'r', access_token_expire_in: 9999999999, refresh_token_expire_in: 9999999999 });
  q.linkTtsShop(SHOP, account.id, 'DE');
  q.setSetting('auto_reply_master', '1');
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  return { q, account };
};
const thread = (q: Queries, channel: InboxChannel, text: string, opts: { id?: string; who?: string; userId?: string; at?: number } = {}) => {
  const at = opts.at ?? Date.now() - 10 * 60000;
  const id = opts.id ?? `c-${Math.random().toString(36).slice(2, 8)}`;
  const up = q.upsertConversation({ tts_shop_id: SHOP, channel, conversation_id: id, counterpart_name: opts.who ?? (channel === 'cs' ? 'Anna' : 'creator.one'), counterpart_id: opts.userId ?? null, last_message_id: `${id}-1`, last_sender: 'them', last_message_text: text, last_message_at: new Date(at).toISOString(), can_send: true });
  q.upsertMessages(up.id, [{ message_id: `${id}-1`, sender_role: 'them', text, created_at: new Date(at).toISOString() }]);
  return up.id;
};
const llmOk = (reply = 'Hallo Anna, deine Bestellung ist unterwegs.', extra: Record<string, unknown> = {}) => async () => JSON.stringify({ needs_reply: true, intent: 'order_status', escalate: false, escalation: null, confidence: 0.92, reply, ...extra });
const noSend = async () => ({ message_id: 'tt-1' });
const sent: string[] = [];
const fakeSend = async (q: Queries, c: { id: number }, replyId: number, text: string) => { sent.push(text); q.markReplySent(replyId, `tt-${replyId}`, null); return { message_id: `tt-${replyId}` }; };

describe('prefilter across locales', () => {
  it('drops thanks, acknowledgements, greetings, emojis and cards in every market language', () => {
    for (const t of ['Thanks!', 'thank you so much', 'ok', 'Danke schön', 'Vielen Dank', 'alles klar', 'Merci beaucoup', "d'accord", 'Grazie mille', 'va bene', 'Gracias', 'vale', 'Bedankt!', 'dank je wel', 'Dziękuję bardzo', 'dobrze', 'Obrigada', 'Tack så mycket', '👍', '🙏🙏', '❤️', 'Hallo', 'Hola!', '[product card 123]', '[image]']) {
      expect(prefilter(t), t).not.toBeNull();
    }
  });
  it('lets real questions through in every language', () => {
    for (const t of ['Where is my parcel?', 'Wo bleibt meine Bestellung?', 'Quand arrive ma commande ?', 'Dov\'è il mio pacco?', '¿Cuándo llega mi pedido?', 'Waar blijft mijn pakket?', 'Gdzie jest moja paczka?', 'Onde está a minha encomenda?', 'Var är mitt paket?', 'Danke, aber wann kommt es?', 'ok but when?', '?']) {
      expect(prefilter(t), t).toBeNull();
    }
    expect(prefilter(null, 'IMAGE')).toBe('image without text');
  });
});

describe('policy, cap, quiet hours and classification', () => {
  it('defaults to off with the escalating intents locked to a human', () => {
    const p = defaultPolicy(1, 'affiliate');
    expect(p.mode).toBe('off');
    expect(p.never).toContain('retainer_or_payment');
    expect(p.only).toEqual(['not_do_not_contact']);
    expect(defaultPolicy(1, 'cs').never).toContain('refund_amount');
  });
  it('computes shop-day boundaries and quiet windows in the shop timezone', () => {
    const noon = Date.parse('2026-06-10T10:00:00Z'); // 12:00 Berlin
    expect(startOfDay('Europe/Berlin', noon)).toBe('2026-06-09T22:00:00.000Z');
    expect(startOfDay('Europe/London', noon)).toBe('2026-06-09T23:00:00.000Z');
    expect(inQuietHours({ quiet_from: '22:00', quiet_to: '08:00' }, 'Europe/Berlin', noon)).toBe(false);
    expect(inQuietHours({ quiet_from: '22:00', quiet_to: '08:00' }, 'Europe/Berlin', Date.parse('2026-06-10T21:30:00Z'))).toBe(true);
    expect(inQuietHours({ quiet_from: '11:00', quiet_to: '13:00' }, 'Europe/Berlin', noon)).toBe(true);
    expect(inQuietHours({ quiet_from: null, quiet_to: null }, 'Europe/Berlin', noon)).toBe(false);
  });
  it('parses the model JSON and falls back safely on prose', () => {
    expect(parseClassification('Sure! {"needs_reply": true, "intent": "commission", "escalate": false, "confidence": 0.8, "reply": "Hi!"}', 'affiliate')).toMatchObject({ needs_reply: true, intent: 'commission', confidence: 0.8, reply: 'Hi!' });
    expect(parseClassification('{"needs_reply": false, "intent": "made_up", "reply": null}', 'cs')).toMatchObject({ needs_reply: false, intent: 'other' });
    expect(parseClassification('Hallo, gerne helfe ich.', 'cs')).toMatchObject({ escalate: true, reply: 'Hallo, gerne helfe ich.' });
  });
  it('saves a policy with clamped values and known keys only', () => {
    const { q, account } = setup();
    const p = savePolicy(q, account.id, 'cs', { mode: 'auto', daily_cap: 9999, only: ['has_order', 'bogus'], never: ['legal'], quiet_from: '22:00', quiet_to: 'nope', max_age_hours: 0 });
    expect(p).toMatchObject({ mode: 'auto', daily_cap: 5000, only: ['has_order'], never: ['legal'], quiet_from: '22:00', quiet_to: null, max_age_hours: 1 });
    expect(savePolicy(q, account.id, 'cs', { daily_cap: null }).daily_cap).toBeNull();
    expect(() => savePolicy(q, account.id, 'cs', { mode: 'yes' })).toThrow(/mode/);
  });
});

describe('processing conversations', () => {
  it('does nothing while the policy is off, drafts in draft mode, sends in auto mode and never answers the same message twice', async () => {
    const { q, account } = setup();
    sent.length = 0;
    const id = thread(q, 'cs', 'Wo bleibt meine Bestellung? Nummer 576123456789012345', { userId: 'u1' });
    expect(await processConversations(q, [id], { llm: llmOk(), send: fakeSend })).toMatchObject({ drafted: 0, auto_sent: 0 });
    savePolicy(q, account.id, 'cs', { mode: 'draft' });
    const r1 = await processConversations(q, [id], { llm: llmOk(), send: fakeSend });
    expect(r1.drafted).toBe(1);
    expect(q.pendingDraft(id)!.text).toMatch(/unterwegs/);
    expect(sent).toHaveLength(0);
    // Same message, nothing new happens.
    expect(await processConversations(q, [id], { llm: llmOk(), send: fakeSend })).toMatchObject({ drafted: 0, auto_sent: 0 });
    savePolicy(q, account.id, 'cs', { mode: 'auto' });
    const id2 = thread(q, 'cs', 'Wann kommt mein Paket?', { userId: 'u2' });
    const r2 = await processConversations(q, [id2], { llm: llmOk(), send: fakeSend });
    expect(r2.auto_sent).toBe(1);
    expect(sent).toEqual(['Hallo Anna, deine Bestellung ist unterwegs.']);
    const ev = q.replyEventFor(id2, `${q.getConversation(id2)!.conversation_id}-1`)!;
    expect(ev.decision).toBe('auto_sent');
    expect(ev.intent).toBe('order_status');
    expect(ev.context.chips).toContain('German');
    expect(ev.context.their_text).toBe('Wann kommt mein Paket?');
  });

  it('skips messages needing no reply without calling the model, escalates money and low confidence, honours never-intents', async () => {
    const { q, account } = setup();
    savePolicy(q, account.id, 'cs', { mode: 'auto' });
    let calls = 0;
    const counting = async () => { calls += 1; return JSON.stringify({ needs_reply: true, intent: 'refund_amount', escalate: false, confidence: 0.9, reply: 'Wir erstatten 20 €.' }); };
    const thanks = thread(q, 'cs', 'Vielen Dank!');
    const refund = thread(q, 'cs', 'Wie viel bekomme ich zurück?');
    const r = await processConversations(q, [thanks, refund], { llm: counting, send: noSend });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ skipped: 1, escalated: 1, auto_sent: 0 });
    const ev = q.listReplyEvents({ conversationRef: refund })[0];
    expect(ev.decision).toBe('escalated');
    expect(ev.escalation).toMatch(/Refund amount/);
    expect(q.pendingDraft(refund)!.text).toBe('Wir erstatten 20 €.');
    // Low confidence waits for a human too.
    const vague = thread(q, 'cs', 'Hm, das Produkt ist komisch?');
    await processConversations(q, [vague], { llm: llmOk('Kannst du mir mehr sagen?', { intent: 'product_question', confidence: 0.4 }), send: noSend });
    expect(q.listReplyEvents({ conversationRef: vague })[0].escalation).toMatch(/low confidence/);
    // Model says no reply needed: skipped, nothing drafted.
    const nothing = thread(q, 'cs', 'Ich melde mich dann nochmal bei euch.');
    await processConversations(q, [nothing], { llm: async () => JSON.stringify({ needs_reply: false, intent: 'other', escalate: false, confidence: 0.9, reply: null }), send: noSend });
    expect(q.listReplyEvents({ conversationRef: nothing })[0].decision).toBe('skipped');
    expect(q.pendingDraft(nothing)).toBeNull();
  });

  it('stops at the daily cap, respects quiet hours, the master switch, pauses and the only-filters', async () => {
    const { q, account } = setup();
    savePolicy(q, account.id, 'affiliate', { mode: 'auto', daily_cap: 2, only: [] });
    const llm = llmOk('Hi! Your sample ships this week.', { intent: 'sample_status' });
    const ids = [1, 2, 3].map((i) => thread(q, 'affiliate', `Hey, where is my sample? (${i})`, { who: `creator${i}` }));
    const r = await processConversations(q, ids, { llm, send: noSend });
    expect(r).toMatchObject({ auto_sent: 2, capped: 1 });
    expect(q.listReplyEvents({ accountId: account.id, channel: 'affiliate', limit: 10 }).find((e) => e.decision === 'capped')!.escalation).toMatch(/daily cap of 2/);
    savePolicy(q, account.id, 'affiliate', { daily_cap: null, quiet_from: '00:00', quiet_to: '23:59' });
    const quiet = thread(q, 'affiliate', 'Any update on the commission?', { who: 'creator4' });
    expect((await processConversations(q, [quiet], { llm, send: noSend })).quiet).toBe(1);
    savePolicy(q, account.id, 'affiliate', { quiet_from: null, quiet_to: null });
    q.setSetting('auto_reply_master', '0');
    const master = thread(q, 'affiliate', 'Can I promote the new flavour?', { who: 'creator5' });
    const rm = await processConversations(q, [master], { llm, send: noSend });
    expect(rm.drafted).toBe(1);
    expect(q.listReplyEvents({ conversationRef: master })[0].escalation).toMatch(/master switch/);
    q.setSetting('auto_reply_master', '1');
    const paused = thread(q, 'affiliate', 'Hello again, still waiting', { who: 'creator6' });
    q.setSetting(`reply_pause:${paused}`, '1');
    expect((await processConversations(q, [paused], { llm, send: noSend })).skipped).toBe(1);
    // Only-filter: creators with a sample request. No Cruva, so no samples known → drafted, not sent.
    savePolicy(q, account.id, 'affiliate', { only: ['has_sample'] });
    const filtered = thread(q, 'affiliate', 'When does my sample arrive?', { who: 'creator7' });
    expect((await processConversations(q, [filtered], { llm, send: noSend })).drafted).toBe(1);
    expect(q.listReplyEvents({ conversationRef: filtered })[0].escalation).toMatch(/only: Creators with a sample request/);
  });

  it('records an error event when the model fails or the send fails, and the summary and digest reflect it all', async () => {
    const { q, account } = setup();
    savePolicy(q, account.id, 'cs', { mode: 'auto' });
    const bad = thread(q, 'cs', 'Wo ist mein Paket?');
    const r = await processConversations(q, [bad], { llm: async () => { throw new Error('model down'); }, send: noSend });
    expect(r.error).toBe(1);
    const fail = thread(q, 'cs', 'Und meine zweite Bestellung?');
    const r2 = await processConversations(q, [fail], { llm: llmOk(), send: async () => { throw new Error('TikTok 500'); } });
    expect(r2.error).toBe(1);
    expect(q.listReplyEvents({ conversationRef: fail })[0].escalation).toMatch(/send failed: TikTok 500/);
    const rows = summary(q, () => true);
    const cs = rows.find((x) => x.account_id === account.id && x.channel === 'cs')!;
    expect(cs.mode).toBe('auto');
    expect(cs.waiting).toBe(2);
    expect(weeklyDigest(q)).toMatch(/Nutori\* buyers \(auto\): 0 sent automatically, 0 drafted, 0 to a human, 0 needed no answer, 2 errors/);
  });

  it('feedback marks the event and teaching adds a library note scoped to the account and language', async () => {
    const { q, account } = setup();
    savePolicy(q, account.id, 'cs', { mode: 'auto' });
    const id = thread(q, 'cs', 'Wie lange dauert der Versand nach Österreich?');
    await processConversations(q, [id], { llm: llmOk('3 Tage.', { intent: 'delivery_times' }), send: noSend });
    const ev = q.listReplyEvents({ conversationRef: id })[0];
    const updated = feedback(q, ev.id, 'wrong', 'AT takes longer', { body: 'Versand nach Österreich dauert 4-6 Werktage.' }, 'Elena');
    expect(updated.feedback).toBe('wrong');
    const notes = q.contextFor('de', 'cs', account.id);
    expect(notes.some((n) => n.body.includes('4-6 Werktage') && n.account_id === account.id && n.language === 'de')).toBe(true);
    const d = repliesData(q, q.getAccount(account.id)!, 'cs', () => true, Date.now(), { main: true, affiliate: true });
    expect(d.counts.wrong_7d).toBe(1);
    expect(d.counts.auto_today).toBe(1);
    expect(d.knowledge.find((k) => k.label === 'Context library')!.state).toBe('ok');
    expect(d.channel_ready).toBe(true);
    expect(repliesData(q, q.getAccount(account.id)!, 'cs', () => false, Date.now(), { main: true, affiliate: true }).channel_note).toMatch(/scope is still under review/);
    expect(repliesData(q, q.getAccount(account.id)!, 'affiliate', () => true, Date.now(), { main: true, affiliate: true }).channel_note).toMatch(/affiliate app/);
  });

  it('a sample thread drafts with the real context and is never sent', async () => {
    const { q, account } = setup();
    const out = await sampleThread(q, q.getAccount(account.id)!, 'cs', 'Wo bleibt meine Bestellung 576123456789012345?', 'de', { llm: llmOk(), send: async () => { throw new Error('must not send'); } });
    expect(out.draft!.text).toMatch(/unterwegs/);
    expect(out.event!.decision).toBe('drafted');
    expect(out.event!.escalation).toMatch(/sample thread/);
    expect(q.getReplyPolicy(account.id, 'cs')?.mode ?? 'off').toBe('off');
  });
});

describe('context for replies', () => {
  it('matches the buyer\'s orders by user id, typed order number and recipient name, and lists products with price and stock', async () => {
    const { q, account } = setup();
    const o = (id: string, user_id: string, name: string) => parseOrder({ id, user_id, status: 'IN_TRANSIT', create_time: 1760000000, collection_time: 1760100000, shipping_provider: 'DHL', recipient_address: { name }, payment: { total_amount: '29.90', currency: 'EUR' }, line_items: [{ product_id: 'p1', sku_id: 's1', sale_price: '29.90' }] });
    expect(o('1', 'u9', 'Max M').user_id).toBe('u9');
    q.upsertHealthPull({ shop_id: SHOP, account_id: account.id, source: 'tts', pull_date: '2026-10-04', ok: true, metrics: {}, rows: { orders: [o('576123456789012345', 'u1', 'Anna Schmidt'), o('576000000000000001', 'u2', 'Max Muster'), o('576000000000000002', 'u3', 'Lena Berg')], products: [{ id: 'p1', title: 'Nutori Magnesium', status: 'ACTIVATE', audit_status: null, quality_tier: null, skus: [{ id: 's1', seller_sku: null, price: 29.9, currency: 'EUR', qty: 120, status: null }] }], returns: [{ return_id: 'r1', order_id: '576000000000000001', status: 'RETURN_OR_REFUND_REQUEST_PENDING', type: 'REFUND', create_time: 1760200000, update_time: null, role: 'BUYER', next_action: 'APPROVE', next_deadline: null, refund_total: 29.9, currency: 'EUR' }] } });
    const byUser = thread(q, 'cs', 'Wo ist mein Paket?', { userId: 'u1', who: 'anna_s' });
    const ctx = await buildContext(q, q.getConversation(byUser)!, q.listMessages(byUser));
    expect(ctx.orders.map((x) => x.id)).toEqual(['576123456789012345']);
    expect(ctx.orders[0]).toMatchObject({ status: 'IN_TRANSIT', carrier: 'DHL', total: 29.9, currency: 'EUR', items: ['Nutori Magnesium'] });
    expect(ctx.products[0]).toMatchObject({ title: 'Nutori Magnesium', price: 29.9, stock: 120 });
    const typed = thread(q, 'cs', 'Meine Bestellung 576000000000000001 fehlt', { who: 'someone' });
    const ctx2 = await buildContext(q, q.getConversation(typed)!, q.listMessages(typed));
    expect(ctx2.orders.map((x) => x.id)).toEqual(['576000000000000001']);
    expect(ctx2.returns[0]).toMatchObject({ id: 'r1', refund: 29.9 });
    const byName = thread(q, 'cs', 'Hallo, wo ist es?', { who: 'Lena Berg' });
    expect((await buildContext(q, q.getConversation(byName)!, q.listMessages(byName))).orders.map((x) => x.id)).toEqual(['576000000000000002']);
    const nobody = thread(q, 'cs', 'Wo ist mein Paket?', { who: 'ghost' });
    const ctx4 = await buildContext(q, q.getConversation(nobody)!, q.listMessages(nobody));
    expect(ctx4.orders).toEqual([]);
    expect(ctx4.notes.join(' ')).toMatch(/ask for the order number/);
    const { system } = renderPrompt(q.getConversation(byUser)!, q.listMessages(byUser), ctx, { json: true, intents: [{ key: 'order_status', label: 'x', escalates: false }] });
    expect(system).toContain('Order 576123456789012345: IN_TRANSIT');
    expect(system).toContain('"needs_reply"');
    expect(system).toContain('Never promise a refund amount');
  });

  it('pulls creator, samples, campaigns and commission from Cruva REST for affiliate threads', async () => {
    const { q, account } = setup();
    q.addShop(account.id, 'cruva-de', 'Nutori (DE)', 'EUR', 'cruva');
    expect(cruvaShopFor(q, account.id, 'DE')).toBe('cruva-de');
    const calls: string[] = [];
    const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(`${url.replace('https://api.cruva.com', '')} ${init?.headers?.['x-shop-id']}`);
      const body = url.includes('/crm/list') ? { results: [{ handle: 'creator.one', follower_cnt: 12000, gmv: 540, video_count: 3, showcasing: true, tags: ['vip'] }] }
        : url.includes('/samples/list') ? { data: { results: [{ handle: 'creator.one', product_name: 'Magnesium', status: 'shipped', timestamp: '2026-09-20T00:00:00Z' }] } }
        : url.includes('/outreach/logs') ? { data: { results: [{ timestamp: '2026-09-18T00:00:00Z', campaign_name: 'Sample sent', message_type: 'dm', status: 'sent' }] } }
        : url.includes('/shop/products') ? { data: [{ product_id: 'p9', product_name: 'Nutori Zinc', price: 19.9, stock: 40, is_open_plan: true }] }
        : { data: { results: [{ title: 'October push', campaign_type: 'video', status: 'active', share_link: 'https://cruva.com/c/1', end_date: '2026-10-31' }] } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const rest = new CruvaRest('key', 'https://api.cruva.com', fetchFn);
    const id = thread(q, 'affiliate', 'Hey! Where is my sample and what is the commission?', { who: 'creator.one' });
    const ctx = await buildContext(q, q.getConversation(id)!, q.listMessages(id), null, rest);
    expect(ctx.creator).toMatchObject({ handle: 'creator.one', followers: 12000, videos: 3, showcasing: true });
    expect(ctx.samples[0]).toMatchObject({ product: 'Magnesium', status: 'shipped' });
    expect(ctx.campaigns[0].link).toBe('https://cruva.com/c/1');
    expect(ctx.products.some((p) => p.title === 'Nutori Zinc' && p.price === 19.9)).toBe(true);
    expect(ctx.commission.pct).toBe(12);
    expect(calls.every((c) => c.endsWith(' cruva-de'))).toBe(true);
    const { system } = renderPrompt(q.getConversation(id)!, q.listMessages(id), ctx);
    expect(system).toContain('Commission: 12%');
    expect(system).toContain('Magnesium: shipped');
    expect(system).toContain('Never promise retainers');
    // Only-filters read the same context.
    expect(onlyFilterBlocker({ ...defaultPolicy(account.id, 'affiliate'), only: ['has_sample', 'posted_before', 'gmv_floor', 'not_do_not_contact'] }, ctx)).toBeNull();
    expect(onlyFilterBlocker({ ...defaultPolicy(account.id, 'affiliate'), only: ['not_do_not_contact'] }, { ...ctx, creator: { ...ctx.creator!, tags: ['Do not contact'] } })).toMatch(/do-not-contact/);
    // A failing Cruva call becomes a note, never an error.
    const broken = new CruvaRest('key', 'https://api.cruva.com', (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
    const ctx2 = await buildContext(q, q.getConversation(id)!, q.listMessages(id), null, broken);
    expect(ctx2.creator).toBeNull();
    expect(ctx2.notes.some((n) => n.startsWith('Cruva creator'))).toBe(true);
  });
});
