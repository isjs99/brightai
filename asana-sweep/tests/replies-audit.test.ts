import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { auditSlackText, parseAudit, replyRules, runAudit, sampleEvents, undoAuditAction } from '../src/inbox/audit';
import { getPolicy, parseClassification, processConversations, repliesData, savePolicy } from '../src/inbox/replies';

const SHOP = 'auditshop';
const setup = () => {
  const q = new Queries(openTestDb());
  const account = q.createAccount({ name: 'Belively', markets: 'DE', am_name: 'Elena', aa_name: null, enabled: true, notes: null, commission_pct: 12, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
  q.upsertTtsShop({ id: SHOP, name: 'Belively DE', region: 'DE', seller_type: 'LOCAL', cipher: 'x' }, { access_token: 'a', refresh_token: 'r', access_token_expire_in: 9999999999, refresh_token_expire_in: 9999999999 });
  q.linkTtsShop(SHOP, account.id, 'DE');
  q.setSetting('auto_reply_master', '1');
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  savePolicy(q, account.id, 'affiliate', { mode: 'auto', daily_cap: null, answer_all: true });
  return { q, account };
};
const thread = (q: Queries, text: string, id: string, ageMs = 3600000) => {
  const at = new Date(Date.now() - ageMs).toISOString();
  const up = q.upsertConversation({ tts_shop_id: SHOP, channel: 'affiliate', conversation_id: id, counterpart_name: `creator.${id}`, last_message_id: `${id}-1`, last_sender: 'them', last_message_text: text, last_message_at: at, can_send: true });
  q.upsertMessages(up.id, [{ message_id: `${id}-1`, sender_role: 'them', text, created_at: at }]);
  q.setConversationLanguage(up.id, 'de');
  return up.id;
};
const send = async (q: Queries, _c: { id: number }, replyId: number) => { q.markReplySent(replyId, `m-${replyId}`, null); return { message_id: `m-${replyId}` }; };
const writer = (intent: string, reply: string, checks?: { facts: boolean; policy: boolean }) => async () => JSON.stringify({ needs_reply: true, intent, escalate: false, confidence: 0.9, reply, ...(checks ? { checks } : {}) });

describe('reply audit', () => {
  it('parses the auditor, fails a zero on facts or policy, normalises the note key and drops unknown faults', () => {
    const v = parseAudit('Here: {"scores": {"answers": 2, "facts": 0, "language": 2, "tone": 1, "policy": 2, "next_step": 2}, "why": "Promised shipping in 2 days.", "unverified_claim": "2 days", "note_key": "Shipping Time!", "note": "Shipping takes 3 to 5 working days.", "fault": "promise_without_fact"}');
    expect(v).toMatchObject({ total: 9, fail: true, note_key: 'shipping_time', fault: 'promise_without_fact', unverified_claim: '2 days' });
    const ok = parseAudit('{"scores": {"answers": 2, "facts": 2, "language": 2, "tone": 2, "policy": 2, "next_step": 1}, "why": "fine", "fault": "made_up", "note_key": null}');
    expect(ok).toMatchObject({ total: 11, fail: false, fault: null, note: null });
    expect(() => parseAudit('no json')).toThrow(/JSON/);
    expect(parseClassification('{"needs_reply": true, "intent": "commission", "confidence": 0.9, "reply": "x", "checks": {"facts": false, "policy": true}}', 'affiliate').checks).toEqual({ facts: false, policy: true });
  });

  it('the writer\'s own check escalates a draft it cannot stand behind', async () => {
    const { q } = setup();
    const id = thread(q, 'Wann kommt mein Sample?', 'selfcheck');
    const r = await processConversations(q, [id], { llm: writer('sample_status', 'Morgen!', { facts: false, policy: true }), send });
    expect(r).toMatchObject({ escalated: 1, auto_sent: 0 });
    expect(q.listReplyEvents({ conversationRef: id })[0].escalation).toMatch(/self-check/);
  });

  it('samples every topic, scores, ranks, adds a note, a rule and a hand-over, then restores and retires what did not help', async () => {
    const { q, account } = setup();
    // Twelve replies: four topics, the commission ones promise a retainer (policy fail), the shipping ones invent a date.
    const texts: [string, string, string][] = [];
    for (let i = 0; i < 3; i++) texts.push([`c${i}`, 'commission', 'Wir zahlen 500€ Retainer im Monat.']);
    for (let i = 0; i < 3; i++) texts.push([`s${i}`, 'shipping', 'Es kommt in 2 Tagen an. Beste Grüße, Team']);
    for (let i = 0; i < 3; i++) texts.push([`q${i}`, 'sample_status', 'Dein Sample ist unterwegs.']);
    for (let i = 0; i < 3; i++) texts.push([`p${i}`, 'product_question', 'Das Produkt hat 20g Protein.']);
    for (const [id, intent, reply] of texts) { const c = thread(q, `Frage ${id}`, id); await processConversations(q, [c], { llm: writer(intent, reply), send }); }
    expect(q.listReplyEvents({ accountId: account.id, limit: 50 }).filter((e) => e.decision === 'auto_sent')).toHaveLength(12);
    const since = new Date(Date.now() - 72 * 3600000).toISOString();
    const sample = sampleEvents(q, { since, perAccount: 6 });
    expect(sample).toHaveLength(6);
    expect(new Set(sample.map((e) => e.intent)).size).toBe(4); // round robin over topics

    const auditor = async (_s: string, u: string) => {
      const reply = u.match(/The reply that went out: (.*)/)?.[1] ?? '';
      if (/Retainer/.test(reply)) return JSON.stringify({ scores: { answers: 2, facts: 2, language: 2, tone: 2, policy: 0, next_step: 1 }, why: 'Promised a retainer.', note_key: 'no_retainer', note: 'We never pay retainers; commission only, 12%.', fault: null });
      if (/2 Tagen/.test(reply)) return JSON.stringify({ scores: { answers: 2, facts: 0, language: 2, tone: 1, policy: 2, next_step: 2 }, why: 'Invented a delivery date.', unverified_claim: '2 days', note_key: 'shipping_time', note: 'Delivery takes 3 to 5 working days.', fault: 'signoff_block' });
      return JSON.stringify({ scores: { answers: 2, facts: 2, language: 2, tone: 2, policy: 2, next_step: 2 }, why: 'Good.', note_key: null, fault: null });
    };
    const a1 = await runAudit(q, { llm: auditor, context: async () => null, perAccount: 12 });
    expect(a1.sampled).toBe(12);
    expect(a1.fail_rate).toBeCloseTo(0.5, 2);
    expect(a1.summary.by_intent[0].intent).toMatch(/commission|shipping/);
    expect(a1.summary.by_account[0]).toMatchObject({ account_name: 'Belively', channel: 'affiliate', n: 12 });
    expect(a1.summary.red).toEqual(['Belively (creators)']);
    expect(a1.summary.by_rubric.find((r) => r.key === 'policy')!.zeros).toBe(3);
    // Self-audit: two notes (each issue three times), one rule (sign-off seen three times), two topics handed to a human.
    const notes = a1.actions.filter((x) => x.kind === 'note');
    expect(notes.map((n) => (n as { note_key: string }).note_key).sort()).toEqual(['no_retainer', 'shipping_time']);
    expect(q.listContext().filter((e) => e.account_id === account.id && e.enabled && e.title.startsWith('Audit:'))).toHaveLength(2);
    expect(q.listContext().find((e) => e.title === 'Audit: no retainer')!.language).toBe('de');
    expect(a1.actions.filter((x) => x.kind === 'rule')).toHaveLength(1);
    expect(replyRules(q)[0]).toMatch(/sign-off/);
    const nudges = a1.actions.filter((x) => x.kind === 'nudge');
    expect(nudges.map((n) => (n as { intent: string }).intent).sort()).toEqual(['commission', 'shipping']);
    expect(getPolicy(q, account.id, 'affiliate').never).toEqual(expect.arrayContaining(['commission', 'shipping']));
    // The badge reaches the account's log.
    const d = repliesData(q, account, 'affiliate', () => true);
    expect(d.log.filter((e) => e.audit).length).toBe(12);
    expect(d.log.find((e) => e.context.reply_text?.includes('Retainer'))!.audit).toMatchObject({ fail: true });
    // Slack text names the numbers and the hand-overs.
    const text = auditSlackText(a1, 'https://ops.example');
    expect(text).toMatch(/12 replies scored/);
    expect(text).toMatch(/switched to a human/);
    expect(text).toMatch(/\/replies\/audit$/);

    // Undo a hand-over: the intent is automatic again.
    const idx = a1.actions.findIndex((x) => x.kind === 'nudge' && (x as { intent: string }).intent === 'shipping');
    const undone = undoAuditAction(q, a1.id, idx);
    expect(undone.actions[idx].undone).toBe(true);
    expect(getPolicy(q, account.id, 'affiliate').never).not.toContain('shipping');

    // Second run: only replies not yet audited are sampled. Commission is drafted now (handed to a human) and the drafts score well, so it is restored; the shipping note did not help.
    for (let i = 0; i < 3; i++) { const c = thread(q, `Provision ${i}`, `cc${i}`); await processConversations(q, [c], { llm: writer('commission', 'Wir arbeiten auf Provisionsbasis, 12%.'), send }); }
    for (let i = 0; i < 3; i++) { const c = thread(q, `Versand ${i}`, `ss${i}`); await processConversations(q, [c], { llm: writer('shipping', 'Es kommt in 2 Tagen an. Beste Grüße, Team'), send }); }
    expect(q.listReplyEvents({ accountId: account.id, limit: 50 }).filter((e) => e.decision === 'escalated' && e.intent === 'commission')).toHaveLength(3);
    const a2 = await runAudit(q, { llm: auditor, context: async () => null, perAccount: 30 });
    expect(a2.prev_mean).toBe(a1.mean);
    expect(a2.actions.find((x) => x.kind === 'nudge' && (x as { intent: string }).intent === 'commission')).toMatchObject({ direction: 'restored' });
    expect(getPolicy(q, account.id, 'affiliate').never).not.toContain('commission');
    expect(a2.actions.some((x) => x.kind === 'note_checked' && (x as { note_key: string }).note_key === 'no_retainer')).toBe(true);
    // Third run with the shipping issue still there: the note is switched off.
    for (let i = 0; i < 3; i++) { const c = thread(q, `Versand ${i}`, `sss${i}`); await processConversations(q, [c], { llm: writer('shipping', 'Es kommt in 2 Tagen an. Beste Grüße, Team'), send }); }
    const a3 = await runAudit(q, { llm: auditor, context: async () => null, perAccount: 30 });
    const disabled = a3.actions.find((x) => x.kind === 'note_disabled');
    expect(disabled).toMatchObject({ note_key: 'shipping_time' });
    expect(q.listContext().find((e) => e.title === 'Audit: shipping time')!.enabled).toBe(false);
  });
});
