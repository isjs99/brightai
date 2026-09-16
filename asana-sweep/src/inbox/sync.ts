import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { liveEvents } from '../live/events.js';
import { tts, TtsClient } from '../tts/client.js';
import { shopCredentials } from '../tts/promotions.js';
import { config } from '../config.js';
import type { InboxConversation, InboxMessage, InboxSettings } from '../sweep/types.js';
import { buildContext, renderPrompt } from './context.js';
import { draftWithClaude } from './llm.js';
import { guessLanguage } from './language.js';

let syncing = false;

export function inboxSettings(q: Queries): InboxSettings {
  return {
    auto_reply_master: q.getSetting('auto_reply_master', '0') === '1',
    inbox_enabled: q.getSetting('inbox_enabled', '1') === '1',
    poll_seconds: Math.max(30, Number(q.getSetting('inbox_poll_seconds', '120')) || 120),
    max_age_hours: Math.max(1, Number(q.getSetting('auto_reply_max_age_hours', '48')) || 48),
    llm_configured: Boolean(config.anthropicApiKey),
    model: config.replyModel,
    tts_configured: tts.configured,
    last_sync_at: q.getSetting('inbox_last_sync_at', '') || null,
    last_sync_error: q.getSetting('inbox_last_sync_error', '') || null,
    cruva_configured: Boolean(process.env.CRUVA_API_KEY?.trim()),
  };
}

const parseText = (content: unknown): string | null => {
  if (typeof content !== 'string') return null;
  try {
    const j = JSON.parse(content) as Record<string, unknown>;
    if (typeof j.content === 'string') return j.content;
    if (typeof j.title === 'string') return `${j.title}${typeof j.content === 'string' ? `: ${j.content}` : ''}`;
    if (j.product_id) return `[product card ${j.product_id}]`;
    if (j.order_id) return `[order card ${j.order_id}]`;
    if (j.url) return '[image]';
    return null;
  } catch {
    return content;
  }
};
const iso = (unix: unknown): string | null => (typeof unix === 'number' && unix > 0 ? new Date((unix > 1e12 ? unix : unix * 1000)).toISOString() : typeof unix === 'string' && /^\d+$/.test(unix) ? new Date(Number(unix) * (unix.length > 12 ? 1 : 1000)).toISOString() : null);

/** Map a customer-service message to our shape. Shop-side roles (SHOP, CUSTOMER_SERVICE, ROBOT) count as "us". */
export function mapCsMessage(m: Record<string, unknown>): { message_id: string; sender_role: InboxMessage['sender_role']; sender_name: string | null; type: string; text: string | null; created_at: string } | null {
  const id = String(m.id ?? '');
  if (!id || m.is_visible === false) return null;
  const sender = (m.sender as Record<string, unknown> | undefined) ?? {};
  const role = String(sender.role ?? '').toUpperCase();
  const type = String(m.type ?? 'TEXT');
  const sender_role: InboxMessage['sender_role'] = role === 'BUYER' ? 'them' : role === 'SHOP' || role === 'CUSTOMER_SERVICE' || role === 'ROBOT' ? 'us' : type === 'TEXT' || type === 'IMAGE' ? 'them' : 'system';
  return { message_id: id, sender_role: ['NOTIFICATION', 'ALLOCATED_SERVICE', 'BUYER_ENTER_FROM_TRANSFER'].includes(type) ? 'system' : sender_role, sender_name: (sender.nickname as string | null) ?? null, type, text: parseText(m.content), created_at: iso(m.create_time) ?? new Date().toISOString() };
}

/** Map an affiliate message. The shop's own IM id is not returned, so anything not from the creator counts as "us". */
export function mapAffMessage(m: Record<string, unknown>, creatorImId: string | null): { message_id: string; sender_role: InboxMessage['sender_role']; sender_name: string | null; type: string; text: string | null; created_at: string } | null {
  const body = (m.message_body as Record<string, unknown> | undefined) ?? m;
  const id = String(body.id ?? '');
  if (!id) return null;
  const type = String(body.type ?? 'TEXT');
  const sender = String(body.sender_id ?? '');
  const system = type === 'SYSTEM' || type === 'NOTIFICATION';
  return { message_id: id, sender_role: system ? 'system' : creatorImId && sender === creatorImId ? 'them' : !creatorImId ? 'them' : 'us', sender_name: null, type, text: parseText(body.content), created_at: iso(body.create_time) ?? new Date().toISOString() };
}

/** Pull conversations and new messages for every authorised shop, then auto-reply where switched on. */
export async function syncInbox(q: Queries, client: TtsClient = tts): Promise<{ ok: boolean; error?: string; conversations: number; new_messages: number; auto_replies: number }> {
  if (syncing) return { ok: false, error: 'Inbox sync already running.', conversations: 0, new_messages: 0, auto_replies: 0 };
  syncing = true;
  const result = { ok: true, conversations: 0, new_messages: 0, auto_replies: 0 } as { ok: boolean; error?: string; conversations: number; new_messages: number; auto_replies: number };
  const errors: string[] = [];
  try {
    if (!client.configured) throw new Error('TikTok Shop app is not configured (TTS_APP_KEY / TTS_APP_SECRET).');
    const shops = q.listTtsShops().filter((s) => s.token_ok);
    if (!shops.length) throw new Error('No authorised TikTok shops yet. Connect shops under Promotions > Connection.');
    const changedIds: number[] = [];
    for (const shop of shops) {
      let creds: { accessToken: string; cipher: string };
      try {
        creds = await shopCredentials(q, shop.id, client);
      } catch (err) {
        errors.push(`${shop.name}: ${(err as Error).message}`);
        continue;
      }
      // Customer service
      try {
        const { conversations } = await client.csConversations(creds);
        for (const c of conversations) {
          const lm = (c.latest_message as Record<string, unknown> | undefined) ?? {};
          const mapped = lm.id ? mapCsMessage(lm) : null;
          const buyer = ((c.participants as Record<string, unknown>[] | undefined) ?? []).find((p) => String(p.role ?? '').toUpperCase() === 'BUYER');
          const up = q.upsertConversation({
            tts_shop_id: shop.id,
            channel: 'cs',
            conversation_id: String(c.id),
            counterpart_name: (buyer?.nickname as string | null) ?? null,
            counterpart_id: (buyer?.im_user_id as string | null) ?? null,
            unread_count: Number(c.unread_count ?? 0),
            can_send: c.can_send_message !== false,
            last_message_at: mapped?.created_at ?? iso(c.create_time),
            last_message_text: mapped?.text ?? null,
            last_sender: mapped?.sender_role ?? null,
            last_message_id: mapped?.message_id ?? null,
          });
          result.conversations += 1;
          if (up.changed) {
            const { messages } = await client.csMessages(creds, String(c.id));
            const rows = messages.map(mapCsMessage).filter((m): m is NonNullable<typeof m> => m !== null);
            result.new_messages += q.upsertMessages(up.id, rows);
            changedIds.push(up.id);
          }
        }
      } catch (err) {
        errors.push(`${shop.name} CS: ${(err as Error).message}`);
      }
      // Affiliates
      try {
        const { conversations } = await client.affConversations(creds);
        for (const c of conversations) {
          const creatorId = (c.creator_im_id as string | null) ?? null;
          const up = q.upsertConversation({ tts_shop_id: shop.id, channel: 'affiliate', conversation_id: String(c.id), counterpart_name: (c.username as string | null) ?? null, counterpart_id: creatorId, unread_count: Number(c.unread_count ?? 0), can_send: true });
          result.conversations += 1;
          const prev = q.getConversation(up.id)!;
          // No latest-message summary in the listing, so pull the thread when it is new, has unread, or on a slow cadence.
          const stale = !prev.synced_at || Date.now() - Date.parse(prev.updated_at) > 6 * 3600000;
          if (up.changed || Number(c.unread_count ?? 0) > 0 || stale) {
            const { messages } = await client.affMessages(creds, String(c.id));
            const rows = messages.map((m) => mapAffMessage(m, creatorId)).filter((m): m is NonNullable<typeof m> => m !== null);
            const added = q.upsertMessages(up.id, rows);
            result.new_messages += added;
            const newest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
            if (newest) q.upsertConversation({ tts_shop_id: shop.id, channel: 'affiliate', conversation_id: String(c.id), last_message_at: newest.created_at, last_message_text: newest.text, last_sender: newest.sender_role, last_message_id: newest.message_id });
            if (added || up.changed) changedIds.push(up.id);
          }
        }
      } catch (err) {
        errors.push(`${shop.name} affiliates: ${(err as Error).message}`);
      }
    }
    for (const id of new Set(changedIds)) {
      const c = q.getConversation(id);
      if (c && !c.language) q.setConversationLanguage(id, guessLanguage(c.last_message_text, c.market));
    }
    result.auto_replies = await autoReplyPass(q, client, [...new Set(changedIds)]);
    q.setSetting('inbox_last_sync_at', new Date().toISOString());
    q.setSetting('inbox_last_sync_error', errors.length ? errors.slice(0, 3).join(' | ') : '');
    if (errors.length && result.conversations === 0) {
      result.ok = false;
      result.error = errors.join(' | ');
    }
    if (changedIds.length || errors.length) liveEvents.emitUpdate({ kind: 'inbox' });
    return result;
  } catch (err) {
    const message = (err as Error).message;
    q.setSetting('inbox_last_sync_at', new Date().toISOString());
    q.setSetting('inbox_last_sync_error', message);
    liveEvents.emitUpdate({ kind: 'inbox' });
    return { ...result, ok: false, error: message };
  } finally {
    syncing = false;
  }
}

/** Why a conversation would not be auto-replied to right now, or null when it is eligible. */
export function autoReplyBlocker(c: InboxConversation, settings: { auto_reply_master: boolean; max_age_hours: number; llm_configured: boolean }, alreadyReplied: boolean, lastAutoAt: string | null, now = Date.now()): string | null {
  if (!settings.auto_reply_master) return 'master switch off';
  if (!settings.llm_configured) return 'ANTHROPIC_API_KEY not set';
  if (!c.auto_reply_on) return `auto-reply off for ${c.account_name ?? c.shop_name} (${c.channel})`;
  if (c.status === 'closed') return 'conversation closed';
  if (c.last_sender !== 'them') return 'last message is ours';
  if (!c.can_send) return 'TikTok does not allow the shop to message this buyer right now';
  if (!c.last_message_text) return 'last message has no text';
  if (!c.last_message_at || now - Date.parse(c.last_message_at) > settings.max_age_hours * 3600000) return `older than ${settings.max_age_hours}h`;
  if (alreadyReplied) return 'already auto-replied to this message';
  if (lastAutoAt && now - Date.parse(lastAutoAt) < 10 * 60000) return 'auto-replied less than 10 minutes ago';
  return null;
}

async function autoReplyPass(q: Queries, client: TtsClient, ids: number[]): Promise<number> {
  const settings = inboxSettings(q);
  if (!settings.auto_reply_master || !ids.length) return 0;
  let sent = 0;
  for (const id of ids) {
    const c = q.getConversation(id);
    if (!c) continue;
    const blocker = autoReplyBlocker(c, settings, c.last_message_id ? q.autoRepliedTo(id, c.last_message_id) : false, q.lastAutoReplyAt(id));
    if (blocker) continue;
    try {
      const messages = q.listMessages(id);
      const ctx = buildContext(q, c, messages);
      const { system, user } = renderPrompt(c, messages, ctx);
      const text = await draftWithClaude(system, user);
      const reply = q.addReply({ conversation_ref: id, text, mode: 'auto', created_by: 'auto-reply', in_reply_to: c.last_message_id });
      await sendReply(q, c, reply.id, text, client);
      sent += 1;
    } catch (err) {
      log.error(`Auto-reply failed for ${c.shop_name} ${c.channel} ${c.conversation_id}: ${(err as Error).message}`);
    }
  }
  if (sent) log.info(`Auto-reply sent ${sent} message(s)`);
  return sent;
}

/** Send a stored reply through TikTok and record the outcome. */
export async function sendReply(q: Queries, c: InboxConversation, replyId: number, text: string, client: TtsClient = tts): Promise<{ message_id: string }> {
  try {
    const creds = await shopCredentials(q, c.tts_shop_id, client);
    const res = c.channel === 'cs' ? await client.csSendText(creds, c.conversation_id, text) : await client.affSendText(creds, c.conversation_id, text);
    q.markReplySent(replyId, res.message_id, null);
    const reply = q.getReply(replyId)!;
    q.upsertMessages(c.id, [{ message_id: res.message_id, sender_role: 'us', sender_name: reply.mode === 'auto' ? 'auto-reply' : (reply.created_by ?? 'dashboard'), type: 'TEXT', text, created_at: new Date().toISOString() }]);
    q.upsertConversation({ tts_shop_id: c.tts_shop_id, channel: c.channel, conversation_id: c.conversation_id, last_message_at: new Date().toISOString(), last_message_text: text, last_sender: 'us', last_message_id: res.message_id, unread_count: 0 });
    q.setConversationStatus(c.id, reply.mode === 'auto' ? 'auto_replied' : 'replied');
    if (c.channel === 'cs') await client.csMarkRead(creds, c.conversation_id).catch(() => undefined);
    liveEvents.emitUpdate({ kind: 'inbox' });
    return res;
  } catch (err) {
    q.markReplySent(replyId, null, (err as Error).message);
    liveEvents.emitUpdate({ kind: 'inbox' });
    throw err;
  }
}

/** Polls TikTok for new buyer and creator messages. */
export class InboxWatcher {
  private timer: NodeJS.Timeout | null = null;
  constructor(private q: Queries) {}

  start(): void {
    this.stop();
    const s = inboxSettings(this.q);
    if (!s.inbox_enabled || !s.tts_configured) {
      log.info('Inbox sync is off' + (s.tts_configured ? '' : ' (TikTok app not configured)'));
      return;
    }
    this.timer = setInterval(() => void syncInbox(this.q), s.poll_seconds * 1000);
    this.timer.unref?.();
    log.info(`Inbox sync every ${s.poll_seconds}s, auto-reply master ${s.auto_reply_master ? 'ON' : 'off'}`);
    void syncInbox(this.q);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
