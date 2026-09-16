import { describe, it, expect } from 'vitest';
import { guessLanguage } from '../src/inbox/language';
import { autoReplyBlocker, mapAffMessage, mapCsMessage } from '../src/inbox/sync';
import { buildContext, renderPrompt } from '../src/inbox/context';
import { openDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import type { InboxConversation } from '../src/sweep/types';

describe('language guessing', () => {
  it('reads the message first, then the market, then English', () => {
    expect(guessLanguage('Hallo, wann kommt meine Bestellung? Danke', 'UK')).toBe('de');
    expect(guessLanguage('Bonjour, je n\'ai pas reçu ma commande, merci', 'DE')).toBe('fr');
    expect(guessLanguage('ok', 'IT')).toBe('it');
    expect(guessLanguage(null, 'UK')).toBe('en');
    expect(guessLanguage(null, null)).toBe('en');
    expect(guessLanguage('Hallo danke bestellung', 'DE', 'en')).toBe('en');
  });
});

describe('TikTok message mapping', () => {
  it('maps buyer and shop roles and unwraps JSON content', () => {
    const buyer = mapCsMessage({ id: '1', type: 'TEXT', content: '{"content":"Where is my parcel?"}', create_time: 1700000000, sender: { role: 'BUYER', nickname: 'Anna' } })!;
    expect(buyer).toMatchObject({ message_id: '1', sender_role: 'them', sender_name: 'Anna', text: 'Where is my parcel?', created_at: '2023-11-14T22:13:20.000Z' });
    expect(mapCsMessage({ id: '2', type: 'TEXT', content: '{"content":"On its way"}', create_time: 1700000100, sender: { role: 'CUSTOMER_SERVICE' } })!.sender_role).toBe('us');
    expect(mapCsMessage({ id: '3', type: 'NOTIFICATION', content: '{"content":"Agent joined"}', create_time: 1700000100, sender: { role: 'SHOP' } })!.sender_role).toBe('system');
    expect(mapCsMessage({ id: '4', type: 'TEXT', content: '{"content":"hidden"}', is_visible: false, sender: { role: 'SHOP' } })).toBeNull();
    expect(mapCsMessage({ id: '5', type: 'PRODUCT_CARD', content: '{"product_id":"99"}', create_time: 1700000100, sender: { role: 'BUYER' } })!.text).toBe('[product card 99]');
  });

  it('maps affiliate messages by creator im id', () => {
    const m = mapAffMessage({ conversation_index: '1', message_body: { id: 'a1', type: 'TEXT', content: '{"content":"Can I get a sample?"}', create_time: 1700000000, sender_id: 'creator1' } }, 'creator1')!;
    expect(m).toMatchObject({ message_id: 'a1', sender_role: 'them', text: 'Can I get a sample?' });
    expect(mapAffMessage({ message_body: { id: 'a2', type: 'TEXT', content: '{"content":"Sure"}', create_time: 1700000001, sender_id: 'shop9' } }, 'creator1')!.sender_role).toBe('us');
  });
});

describe('auto-reply gate', () => {
  const conv = (o: Partial<InboxConversation>): InboxConversation => ({ id: 1, tts_shop_id: 's', shop_name: 'Shop', account_id: 1, account_name: 'Acme', market: 'DE', channel: 'cs', conversation_id: 'c', counterpart_name: 'Anna', counterpart_id: 'u1', unread_count: 1, last_message_at: new Date(Date.now() - 3600000).toISOString(), last_message_text: 'Where is my parcel?', last_sender: 'them', last_message_id: 'm1', can_send: true, status: 'open', language: 'de', needs_reply: true, auto_reply_on: true, synced_at: '', updated_at: '', ...o });
  const on = { auto_reply_master: true, max_age_hours: 48, llm_configured: true };

  it('only fires with every switch on, a fresh message from them, and no prior auto reply', () => {
    expect(autoReplyBlocker(conv({}), on, false, null)).toBeNull();
    expect(autoReplyBlocker(conv({}), { ...on, auto_reply_master: false }, false, null)).toBe('master switch off');
    expect(autoReplyBlocker(conv({ auto_reply_on: false }), on, false, null)).toMatch(/auto-reply off/);
    expect(autoReplyBlocker(conv({ last_sender: 'us' }), on, false, null)).toBe('last message is ours');
    expect(autoReplyBlocker(conv({ can_send: false }), on, false, null)).toMatch(/does not allow/);
    expect(autoReplyBlocker(conv({ last_message_at: new Date(Date.now() - 80 * 3600000).toISOString() }), on, false, null)).toBe('older than 48h');
    expect(autoReplyBlocker(conv({}), on, true, null)).toBe('already auto-replied to this message');
    expect(autoReplyBlocker(conv({}), on, false, new Date(Date.now() - 60000).toISOString())).toMatch(/less than 10 minutes/);
    expect(autoReplyBlocker(conv({ status: 'closed' }), on, false, null)).toBe('conversation closed');
    expect(autoReplyBlocker(conv({}), { ...on, llm_configured: false }, false, null)).toBe('ANTHROPIC_API_KEY not set');
  });
});

describe('inbox storage and context', () => {
  const setup = () => {
    const q = new Queries(openDb(':memory:'));
    const account = q.listAccounts()[0];
    q.upsertTtsShop({ id: 'shop1', name: 'Acme DE', region: 'DE', seller_type: 'LOCAL', cipher: 'x' }, { access_token: 'a', refresh_token: 'r', access_token_expire_in: 9999999999, refresh_token_expire_in: 9999999999 });
    q.linkTtsShop('shop1', account.id, 'DE');
    return { q, account };
  };

  it('upserts conversations, reopens on a new incoming message and stores messages once', () => {
    const { q } = setup();
    const a = q.upsertConversation({ tts_shop_id: 'shop1', channel: 'cs', conversation_id: 'c1', counterpart_name: 'Anna', last_message_id: 'm1', last_sender: 'them', last_message_text: 'Hallo', last_message_at: '2026-09-16T10:00:00.000Z' });
    expect(a.changed).toBe(true);
    expect(q.upsertMessages(a.id, [{ message_id: 'm1', sender_role: 'them', text: 'Hallo', created_at: '2026-09-16T10:00:00.000Z' }])).toBe(1);
    expect(q.upsertMessages(a.id, [{ message_id: 'm1', sender_role: 'them', text: 'Hallo', created_at: '2026-09-16T10:00:00.000Z' }])).toBe(0);
    q.setConversationStatus(a.id, 'replied');
    const same = q.upsertConversation({ tts_shop_id: 'shop1', channel: 'cs', conversation_id: 'c1', last_message_id: 'm1', last_sender: 'them' });
    expect(same.changed).toBe(false);
    expect(q.getConversation(a.id)!.status).toBe('replied');
    const next = q.upsertConversation({ tts_shop_id: 'shop1', channel: 'cs', conversation_id: 'c1', last_message_id: 'm2', last_sender: 'them', last_message_text: 'Noch da?' });
    expect(next.changed).toBe(true);
    const c = q.getConversation(a.id)!;
    expect(c.status).toBe('open');
    expect(c.needs_reply).toBe(true);
    expect(c.account_name).toBe(q.listAccounts()[0].name);
  });

  it('builds context from the library, account switch and history, and renders a prompt', () => {
    const { q, account } = setup();
    q.setAccountReply(account.id, { auto_reply_cs: true });
    q.createContext({ language: 'de', scope: 'cs', account_id: account.id, title: 'Lieferzeit', body: 'Lieferung in DE dauert 2-4 Werktage.' });
    q.createContext({ language: 'fr', scope: 'cs', account_id: null, title: 'FR only', body: 'nope' });
    q.createContext({ language: '*', scope: 'affiliate', account_id: null, title: 'Aff only', body: 'nope' });
    const older = q.upsertConversation({ tts_shop_id: 'shop1', channel: 'cs', conversation_id: 'old', counterpart_id: 'u1', counterpart_name: 'Anna', last_message_id: 'o1', last_sender: 'us' });
    q.upsertMessages(older.id, [{ message_id: 'o1', sender_role: 'them', text: 'Ich hatte schon mal ein Problem', created_at: '2026-09-01T10:00:00.000Z' }]);
    const cur = q.upsertConversation({ tts_shop_id: 'shop1', channel: 'cs', conversation_id: 'new', counterpart_id: 'u1', counterpart_name: 'Anna', last_message_id: 'n1', last_sender: 'them', last_message_text: 'Hallo, wann kommt meine Bestellung bitte? Danke' });
    q.upsertMessages(cur.id, [{ message_id: 'n1', sender_role: 'them', sender_name: 'Anna', text: 'Hallo, wann kommt meine Bestellung bitte? Danke', created_at: '2026-09-16T10:00:00.000Z' }]);
    const c = q.getConversation(cur.id)!;
    expect(c.auto_reply_on).toBe(true);
    const ctx = buildContext(q, c, q.listMessages(cur.id));
    expect(ctx.language).toBe('de');
    expect(ctx.library.map((l) => l.title)).toContain('Lieferzeit');
    expect(ctx.library.map((l) => l.title)).not.toContain('FR only');
    expect(ctx.library.map((l) => l.title)).not.toContain('Aff only');
    expect(ctx.history[0].text).toBe('Ich hatte schon mal ein Problem');
    const { system, user } = renderPrompt(c, q.listMessages(cur.id), ctx);
    expect(system).toContain('Lieferung in DE dauert 2-4 Werktage.');
    expect(system).toContain('Reply language: de');
    expect(user).toContain('BUYER (Anna): Hallo, wann kommt meine Bestellung bitte? Danke');
  });

  it('records replies and auto-reply bookkeeping', () => {
    const { q } = setup();
    const c = q.upsertConversation({ tts_shop_id: 'shop1', channel: 'affiliate', conversation_id: 'a1', last_message_id: 'x1', last_sender: 'them' });
    const r = q.addReply({ conversation_ref: c.id, text: 'Hi!', mode: 'auto', in_reply_to: 'x1' });
    expect(q.autoRepliedTo(c.id, 'x1')).toBe(false);
    q.markReplySent(r.id, 'tt1', null);
    expect(q.autoRepliedTo(c.id, 'x1')).toBe(true);
    expect(q.lastAutoReplyAt(c.id)).not.toBeNull();
    expect(q.countAutoRepliesSince('2000-01-01')).toBe(1);
    expect(q.upsertCruvaOutreach([{ account_id: null, creator_handle: '@Creator.One', summary: 'Sent sample invite', occurred_at: '2026-09-01' }, { account_id: null, creator_handle: 'creator.one', summary: 'Sent sample invite' }])).toBe(1);
    expect(q.cruvaOutreachFor('Creator.One', null)[0].summary).toBe('Sent sample invite');
  });
});
