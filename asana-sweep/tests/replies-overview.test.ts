import { expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { overview, repliesData } from '../src/inbox/replies';

it('builds the replies overview for 12 accounts and 2,400 open threads in one pass, fast', { timeout: 60000 }, () => {
  const q = new Queries(openTestDb());
  const ids: number[] = [];
  for (let a = 0; a < 12; a++) {
    const acc = q.createAccount({ name: `Brand ${a}`, markets: 'DE', am_name: 'Elena', aa_name: null, enabled: true, notes: null, commission_pct: 10, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    ids.push(acc.id);
    const shop = `shop${a}`;
    q.upsertTtsShop({ id: shop, name: `Brand ${a} DE`, region: 'DE', seller_type: 'LOCAL', cipher: 'x' }, { access_token: 'a', refresh_token: 'r', access_token_expire_in: 9999999999, refresh_token_expire_in: 9999999999 });
    q.linkTtsShop(shop, acc.id, 'DE');
    for (const channel of ['affiliate', 'cs'] as const) {
      for (let i = 0; i < 100; i++) {
        const at = new Date(Date.now() - i * 3600000).toISOString();
        const up = q.upsertConversation({ tts_shop_id: shop, channel, conversation_id: `${channel}-${i}`, counterpart_name: `creator${i}`, last_message_id: `m${i}`, last_sender: 'them', last_message_text: 'Wo ist mein Sample?', last_message_at: at, can_send: true });
        q.upsertMessages(up.id, [{ message_id: `m${i}`, sender_role: 'them', text: 'Wo ist mein Sample?', created_at: at }]);
        if (i % 2) q.addReplyEvent({ conversation_ref: up.id, account_id: acc.id, channel, message_id: `m${i}`, needs_reply: true, intent: 'sample_status', escalation: i % 4 === 1 ? 'low confidence' : null, confidence: 0.8, language: 'de', context: { chips: [], their_text: 'x', reply_text: 'y', counterpart: 'c' }, decision: i % 4 === 1 ? 'escalated' : 'drafted', reply_id: null, model: 'm' });
        if (i % 3 === 0) q.addReply({ conversation_ref: up.id, text: 'Hallo', mode: 'draft', in_reply_to: `m${i}` });
      }
    }
  }
  const t0 = performance.now();
  const o = overview(q, () => true);
  const rows = o.rows; const waiting = o.waiting;
  const t1 = performance.now(); const t2 = t1;
  const acc = q.listAccounts().find((a) => a.id === ids[0])!;
  const d = repliesData(q, acc, 'affiliate', () => true);
  const t3 = performance.now();
  const mine = rows.filter((r) => ids.includes(r.account_id));
  expect(mine).toHaveLength(24);
  // Threads without a decision count as waiting only inside the policy's window: two days for buyers (the 26 even-hour ones older than that drop out), a week for creators (all 100 within it).
  expect(new Set(mine.filter((r) => r.channel === 'cs').map((r) => r.waiting))).toEqual(new Set([74]));
  expect(new Set(mine.filter((r) => r.channel === 'affiliate').map((r) => r.waiting))).toEqual(new Set([100]));
  expect([...new Set(mine.map((r) => r.escalated))]).toEqual([25]);
  expect(waiting).toHaveLength(40);
  expect(waiting[0].reason).not.toBeUndefined();
  expect(d.counts).toMatchObject({ waiting: 100, escalated: 25, drafts: 34 });
  expect(d.knowledge.find((k) => k.label === 'Conversation history')!.detail).toMatch(/^100 creator thread/);
  // Three queries per account and channel instead of two per thread: well under a second even on a slow machine.
  expect(t1 - t0).toBeLessThan(3000);
  expect(t3 - t2).toBeLessThan(1000);
});
