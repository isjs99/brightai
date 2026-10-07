import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { syncCruvaInbox } from '../src/inbox/cruva-inbox';
import { defaultPolicy, isDeferred, processConversations, repliesData, savePolicy, sweepDeferred, withLateLine } from '../src/inbox/replies';
import type { CruvaMcp } from '../src/cruva/mcp';

const SHOP = 'sweepshop';
const setup = (master = true) => {
  const q = new Queries(openTestDb());
  const account = q.createAccount({ name: 'Belively', markets: 'DE', am_name: 'Elena', aa_name: null, enabled: true, notes: null, commission_pct: 12, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
  q.upsertTtsShop({ id: SHOP, name: 'Belively DE', region: 'DE', seller_type: 'LOCAL', cipher: 'x' }, { access_token: 'a', refresh_token: 'r', access_token_expire_in: 9999999999, refresh_token_expire_in: 9999999999 });
  q.linkTtsShop(SHOP, account.id, 'DE');
  q.setSetting('auto_reply_master', master ? '1' : '0');
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  savePolicy(q, account.id, 'affiliate', { mode: 'auto', daily_cap: 2 });
  return { q, account };
};
const thread = (q: Queries, text: string, ageMs: number, id = `c-${Math.random().toString(36).slice(2, 8)}`) => {
  const at = new Date(Date.now() - ageMs).toISOString();
  const up = q.upsertConversation({ tts_shop_id: SHOP, channel: 'affiliate', conversation_id: id, counterpart_name: 'creator.one', last_message_id: `${id}-1`, last_sender: 'them', last_message_text: text, last_message_at: at, can_send: true });
  q.upsertMessages(up.id, [{ message_id: `${id}-1`, sender_role: 'them', text, created_at: at }]);
  return up.id;
};
const counting = () => { const n = { calls: 0 }; const llm = async () => { n.calls += 1; return JSON.stringify({ needs_reply: true, intent: 'sample_status', escalate: false, escalation: null, confidence: 0.9, reply: 'Dein Sample ist unterwegs.' }); }; return { n, llm }; };
const sends: string[] = [];
const send = async (q: Queries, _c: { id: number }, replyId: number, text: string) => { sends.push(text); q.markReplySent(replyId, `m-${replyId}`, null); return { message_id: `m-${replyId}` }; };
const eventsFor = (q: Queries, id: number) => q.listReplyEvents({ conversationRef: id, limit: 50 });

describe('deferred decisions and the sweep', () => {
  it('creators keep a week by default, and the late line is only added after a day', () => {
    expect(defaultPolicy(1, 'affiliate').max_age_hours).toBe(168);
    expect(defaultPolicy(1, 'cs').max_age_hours).toBe(48);
    const now = Date.now();
    expect(withLateLine('Hallo!', 'de', new Date(now - 3600000).toISOString(), now)).toBe('Hallo!');
    expect(withLateLine('Hallo!', 'de', new Date(now - 30 * 3600000).toISOString(), now)).toBe('Sorry für die späte Antwort! Hallo!');
    expect(withLateLine('Hi', null, new Date(now - 30 * 3600000).toISOString(), now)).toBe('Sorry for the slow reply! Hi');
  });

  it('a draft held by the master switch goes out when the switch is on, without a second model call, once', async () => {
    const { q, account } = setup(false);
    const id = thread(q, 'Wo bleibt mein Sample?', 30 * 3600000);
    const { n, llm } = counting();
    expect(await processConversations(q, [id], { llm, send })).toMatchObject({ drafted: 1 });
    expect(n.calls).toBe(1);
    const held = eventsFor(q, id)[0];
    expect(held.escalation).toMatch(/master switch off/);
    expect(isDeferred(held)).toBe(true);
    // Still off: the sweep looks, finds the same answer, records nothing.
    const s0 = await sweepDeferred(q, { accountId: account.id, channel: 'affiliate', deps: { llm, send } });
    expect(s0.candidates).toBe(1);
    expect(eventsFor(q, id)).toHaveLength(1);
    // On: the stored draft is sent with the late line, no model call.
    q.setSetting('auto_reply_master', '1');
    const s1 = await sweepDeferred(q, { accountId: account.id, channel: 'affiliate', deps: { llm, send } });
    expect(s1.result.auto_sent).toBe(1);
    expect(n.calls).toBe(1);
    expect(sends.at(-1)).toBe('Sorry für die späte Antwort! Dein Sample ist unterwegs.');
    const ev = eventsFor(q, id);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ decision: 'auto_sent', intent: 'sample_status' });
    expect(isDeferred(ev[0])).toBe(false);
    // Final now: another sweep does nothing.
    expect((await sweepDeferred(q, { accountId: account.id, channel: 'affiliate', deps: { llm, send } })).candidates).toBe(0);
    const d = repliesData(q, account, 'affiliate', () => true);
    expect(d.counts.auto_today).toBe(1);
  });

  it('a capped thread goes out the next day, oldest first, inside the cap', async () => {
    const { q, account } = setup();
    savePolicy(q, account.id, 'affiliate', { daily_cap: 1 });
    const a = thread(q, 'Frage 1', 3 * 3600000, 'older');
    const b = thread(q, 'Frage 2', 1 * 3600000, 'newer');
    const { n, llm } = counting();
    const r = await processConversations(q, [a, b], { llm, send });
    expect(r).toMatchObject({ auto_sent: 1, capped: 1 });
    const tomorrow = Date.now() + 24 * 3600000;
    const s = await sweepDeferred(q, { accountId: account.id, channel: 'affiliate', deps: { llm, send, now: tomorrow } });
    expect(s.result.auto_sent).toBe(1);
    expect(n.calls).toBe(2); // one per thread, never a third
    expect(eventsFor(q, a).concat(eventsFor(q, b)).filter((e) => e.decision === 'auto_sent')).toHaveLength(2);
  });

  it('a message inside the burst window is marked waiting and answered on the next pass', async () => {
    const { q, account } = setup();
    const id = thread(q, 'Hey, ist das Sample schon raus?', 30000);
    const { n, llm } = counting();
    expect(await processConversations(q, [id], { llm, send })).toMatchObject({ waiting: 1 });
    expect(n.calls).toBe(0);
    expect(eventsFor(q, id)[0].decision).toBe('waiting');
    // Same pass again: still inside the window, no second waiting event.
    await processConversations(q, [id], { llm, send });
    expect(eventsFor(q, id)).toHaveLength(1);
    const s = await sweepDeferred(q, { accountId: account.id, channel: 'affiliate', deps: { llm, send, now: Date.now() + 10 * 60000 } });
    expect(s.result.auto_sent).toBe(1);
    expect(n.calls).toBe(1);
  });

  it('a failed send retries after an hour with the same text; a failed model call retries with a new call', async () => {
    const { q, account } = setup();
    const a = thread(q, 'Wann kommt das Sample an?', 2 * 3600000, 'sendfail');
    const b = thread(q, 'Welche Provision gibt es?', 2 * 3600000, 'modelfail');
    const { n, llm } = counting();
    expect((await processConversations(q, [a], { llm, send: async () => { throw new Error('Cruva 500'); } })).error).toBe(1);
    expect((await processConversations(q, [b], { llm: async () => { throw new Error('model down'); }, send })).error).toBe(1);
    // Under an hour: left alone.
    expect((await sweepDeferred(q, { accountId: account.id, channel: 'affiliate', deps: { llm, send } })).candidates).toBe(0);
    const later = Date.now() + 2 * 3600000;
    const s = await sweepDeferred(q, { accountId: account.id, channel: 'affiliate', deps: { llm, send, now: later } });
    expect(s.result.auto_sent).toBe(2);
    expect(n.calls).toBe(2); // the send failure reused its text; the model failure needed one call
    expect(eventsFor(q, a)[0]).toMatchObject({ decision: 'auto_sent', intent: 'sample_status' });
  });

  it('threads older than the limit and accounts that are off are never swept; the blockers panel explains the rest', async () => {
    const { q, account } = setup(false);
    thread(q, 'old', 8 * 24 * 3600000);
    const fresh = thread(q, 'fresh', 3600000);
    const { n, llm } = counting();
    const s = await sweepDeferred(q, { accountId: account.id, channel: 'affiliate', deps: { llm, send } });
    expect(s.candidates).toBe(1);
    expect(n.calls).toBe(1);
    const d = repliesData(q, account, 'affiliate', () => true);
    expect(d.blockers[0]).toMatchObject({ deferred: true, count: 1 });
    expect(d.blockers[0].reason).toMatch(/Master switch off/);
    expect(d.blockers[0].examples[0].id).toBe(fresh);
    savePolicy(q, account.id, 'affiliate', { mode: 'off' });
    expect((await sweepDeferred(q, { accountId: account.id, channel: 'affiliate', deps: { llm, send } })).candidates).toBe(0);
  });
});

describe('Cruva read budget', () => {
  it('reads every unreplied thread across passes instead of the same first few', async () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Kijimea', markets: 'DE', am_name: 'Ana', aa_name: null, enabled: true, notes: null, commission_pct: 15, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    q.addShop(a.id, 'cr-1', 'Kijimea DE', 'EUR', 'cruva');
    const handles = Array.from({ length: 40 }, (_, i) => `creator${i}`);
    const list = `Inbox (UNREPLIED) — 40 conversation(s):\n\n${handles.map((h, i) => `@${h} - unread: 1 - conversation_id: 70000${i}`).join('\n')}\n`;
    const reads: string[] = [];
    const mcp = { configured: true, call: async (tool: string, args: Record<string, unknown>) => { if (tool === 'list_inbox') return args.conversation_status === 'ALL' ? 'Inbox (ALL) — 0 conversation(s).' : list; if (tool === 'read_dms') { reads.push(String(args.handle)); return `[Oct 06, 2026 12:03 AM UTC] creator (message_id: m-${args.handle}): Welches Produkt zuerst?`; } return ''; } } as unknown as CruvaMcp;
    const r1 = await syncCruvaInbox(q, { accountId: a.id }, { mcp, maxThreadsPerShop: 25, sweep: false });
    expect(r1.new_messages).toBe(25);
    const r2 = await syncCruvaInbox(q, { accountId: a.id }, { mcp, maxThreadsPerShop: 25, sweep: false });
    expect(r2.new_messages).toBe(15);
    expect(new Set(reads).size).toBe(40);
    // Everyone read once; the third pass re-reads nobody within the half hour.
    const before = reads.length;
    await syncCruvaInbox(q, { accountId: a.id }, { mcp, maxThreadsPerShop: 25, sweep: false });
    expect(reads.length).toBe(before);
  });
});

describe('answer everything', () => {
  it('sends money and complaint intents and ignores the only-filters when the switch is on; escalates them when off', async () => {
    const { q, account } = setup();
    savePolicy(q, account.id, 'affiliate', { daily_cap: null, only: ['has_sample'] });
    const llm = async () => JSON.stringify({ needs_reply: true, intent: 'retainer_or_payment', escalate: false, escalation: null, confidence: 0.75, reply: 'Wir arbeiten nur auf Provisionsbasis, 12%.' });
    const a = thread(q, 'Zahlt ihr auch ein Fixum?', 3600000, 'fee-off');
    expect(await processConversations(q, [a], { llm, send })).toMatchObject({ escalated: 1 });
    expect(eventsFor(q, a)[0].escalation).toMatch(/needs a human|always a human/);
    const on = savePolicy(q, account.id, 'affiliate', { answer_all: true });
    expect(on.answer_all).toBe(true);
    const b = thread(q, 'Zahlt ihr auch ein Fixum?', 3600000, 'fee-on');
    expect(await processConversations(q, [b], { llm, send })).toMatchObject({ auto_sent: 1 });
    // The model's own hand-over still wins, and so does a very low confidence.
    const c = thread(q, 'Ich gehe zum Anwalt.', 3600000, 'legal');
    expect(await processConversations(q, [c], { llm: async () => JSON.stringify({ needs_reply: true, intent: 'legal', escalate: true, escalation: 'legal threat', confidence: 0.9, reply: 'x' }), send })).toMatchObject({ escalated: 1 });
    const d = thread(q, '???', 3600000, 'vague');
    expect(await processConversations(q, [d], { llm: async () => JSON.stringify({ needs_reply: true, intent: 'other', escalate: false, confidence: 0.3, reply: 'Hm?' }), send })).toMatchObject({ escalated: 1 });
    const data = repliesData(q, account, 'affiliate', () => true);
    expect(data.policy.answer_all).toBe(true);
  });
});
