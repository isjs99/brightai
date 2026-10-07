import type { Queries } from '../db/queries.js';
import type { InboxMessage } from '../sweep/types.js';
import { cruvaMcp, type CruvaMcp } from '../cruva/mcp.js';
import { marketOfShopName } from '../gmv/market.js';
import { guessLanguage } from './language.js';
import { processConversations, sweepDeferred, type ProcessDeps } from './replies.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * The creator inbox through Cruva: for every linked Cruva shop, list the conversations that are waiting
 * for us (and the recent ones), read the threads that are new or unread, store them next to the TikTok
 * ones, and let the reply engine draft or auto-reply. Replies go back through Cruva's send_dm. This
 * covers every account the agency runs through Cruva, with no TikTok affiliate app authorisation needed.
 */

export interface CruvaInboxRow { handle: string; unread: number; conversation_id: string }
export interface CruvaDm { message_id: string; sender: 'brand' | 'creator' | 'unknown'; sender_id: string | null; created_at: string; text: string }

/** "@handle - unread: 1 - conversation_id: 7672…" lines, and the next page token when there is one. */
export function parseInbox(text: string): { rows: CruvaInboxRow[]; next: string | null } {
  const rows: CruvaInboxRow[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*@?([^\s-]+)\s+-\s+unread:\s*(\d+)\s+-\s+conversation_id:\s*(\S+)/i);
    if (m) rows.push({ handle: m[1].replace(/^@/, ''), unread: Number(m[2]), conversation_id: m[3] });
  }
  const next = text.match(/page_token="([^"]+)"/)?.[1] ?? text.match(/next_page_token[^A-Za-z0-9]*([A-Za-z0-9_=-]{6,})/)?.[1] ?? null;
  return { rows, next };
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseStamp(s: string): string {
  // "Oct 06, 2026 12:03 AM UTC"
  const m = s.match(/([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(); }
  let h = Number(m[4]) % 12;
  if ((m[6] ?? '').toUpperCase() === 'PM') h += 12;
  return new Date(Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase()] ?? 0, Number(m[2]), h, Number(m[5]))).toISOString();
}

/** The read_dms text: one "[stamp] sender (message_id: X): text" block per message, text running on until the next stamp. */
export function parseDms(text: string): CruvaDm[] {
  const out: CruvaDm[] = [];
  const re = /^\[([^\]]+)\]\s+(brand|creator|sender_id\s+(\S+))\s+\(message_id:\s*([^)]+)\):\s?/i;
  let cur: CruvaDm | null = null;
  for (const raw of text.split('\n')) {
    const m = raw.match(re);
    if (m) {
      if (cur) out.push(cur);
      const who = m[2].toLowerCase();
      cur = { message_id: m[4].trim(), sender: who === 'brand' ? 'brand' : who === 'creator' ? 'creator' : 'unknown', sender_id: m[3] ?? null, created_at: parseStamp(m[1]), text: raw.slice(m[0].length) };
    } else if (cur) cur.text += `\n${raw}`;
  }
  if (cur) out.push(cur);
  return out.map((d) => ({ ...d, text: d.text.trim() })).filter((d) => d.message_id);
}

export interface CruvaInboxDeps { mcp?: CruvaMcp; maxThreadsPerShop?: number; pages?: number; /** false skips the deferred sweep (tests). */ sweep?: boolean; processDeps?: ProcessDeps }

let syncing = false;

/** Pull the creator inbox for every Cruva shop (or one), store threads and messages, then run the reply engine. */
export async function syncCruvaInbox(q: Queries, opts: { shopId?: string; accountId?: number } = {}, deps: CruvaInboxDeps = {}): Promise<{ ok: boolean; shops: number; conversations: number; new_messages: number; auto_replies: number; errors: string[] }> {
  const mcp = deps.mcp ?? cruvaMcp;
  const result = { ok: true, shops: 0, conversations: 0, new_messages: 0, auto_replies: 0, errors: [] as string[] };
  if (!mcp.configured) return { ...result, ok: false, errors: ['CRUVA_API_KEY is not set.'] };
  if (syncing) return { ...result, ok: false, errors: ['Cruva inbox sync already running.'] };
  syncing = true;
  const startedAt = Date.now();
  const changed: number[] = [];
  try {
    const shops = q.listShops('cruva').filter((s) => s.account_id && (!opts.shopId || s.shop_id === opts.shopId) && (!opts.accountId || s.account_id === opts.accountId));
    const maxThreads = deps.maxThreadsPerShop ?? 100;
    for (const shop of shops) {
      try {
        const seen = new Map<string, CruvaInboxRow>();
        // Waiting on us first (every page up to the cap), then the first page of everything for recent context.
        let token: string | null = null;
        for (let page = 0; page < (deps.pages ?? 3); page += 1) {
          const { rows, next } = parseInbox(await mcp.call('list_inbox', { shop_id: shop.shop_id, conversation_status: 'UNREPLIED', page_size: 50, ...(token ? { page_token: token } : {}) }));
          for (const r of rows) seen.set(r.conversation_id, r);
          token = next;
          if (!token || !rows.length) break;
        }
        try { for (const r of parseInbox(await mcp.call('list_inbox', { shop_id: shop.shop_id, conversation_status: 'ALL', page_size: 50 })).rows) if (!seen.has(r.conversation_id)) seen.set(r.conversation_id, r); } catch { /* the UNREPLIED page is enough */ }
        result.shops += 1;
        let read = 0; let skippedForBudget = 0;
        for (const row of seen.values()) {
          // Cruva keeps unread > 0 until the brand answers, so an unanswered thread would be re-read every pass and
          // starve the ones after it. A thread read in the last 30 minutes with the same unread count waits its turn.
          const before = q.findConversation(shop.shop_id, 'affiliate', row.conversation_id);
          const freshRead = Boolean(before && before.last_message_at && Date.now() - Date.parse(before.synced_at) < 30 * 60000 && before.unread_count === row.unread && before.counterpart_name === row.handle);
          const up = q.upsertConversation({ tts_shop_id: shop.shop_id, channel: 'affiliate', conversation_id: row.conversation_id, counterpart_name: row.handle, unread_count: row.unread, can_send: true, source: 'cruva' });
          result.conversations += 1;
          const prev = q.getConversation(up.id)!;
          const stale = !prev.last_message_at || Date.now() - Date.parse(prev.updated_at) > 12 * 3600000;
          if (!(up.changed || row.unread > 0 || stale) || freshRead) continue;
          if (read >= maxThreads) { skippedForBudget += 1; continue; }
          read += 1;
          let dms: CruvaDm[] = [];
          try { dms = parseDms(await mcp.call('read_dms', { shop_id: shop.shop_id, handle: row.handle })); } catch (err) { result.errors.push(`${shop.shop_name} @${row.handle}: ${(err as Error).message.slice(0, 160)}`); continue; }
          const rows = dms.map((d) => ({ message_id: d.message_id, sender_role: (d.sender === 'brand' ? 'us' : d.sender === 'creator' ? 'them' : 'them') as InboxMessage['sender_role'], sender_name: d.sender === 'brand' ? 'brand' : row.handle, type: 'TEXT', text: d.text || null, created_at: d.created_at }));
          const added = q.upsertMessages(up.id, rows);
          q.markConversationSynced(up.id);
          result.new_messages += added;
          const newest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
          if (newest) q.upsertConversation({ tts_shop_id: shop.shop_id, channel: 'affiliate', conversation_id: row.conversation_id, last_message_at: newest.created_at, last_message_text: newest.text, last_sender: newest.sender_role, last_message_id: newest.message_id, unread_count: row.unread, source: 'cruva' });
          if (added || up.changed) changed.push(up.id);
        }
        if (skippedForBudget) log.warn(`Cruva inbox: ${shop.shop_name} has ${skippedForBudget} thread(s) past the ${maxThreads}-thread read budget; they are read on the next pass`);
      } catch (err) {
        result.errors.push(`${shop.shop_name}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    for (const id of new Set(changed)) {
      const c = q.getConversation(id);
      if (c && !c.language) q.setConversationLanguage(id, guessLanguage(c.last_message_text, c.market ?? marketOfShopName(c.shop_name)));
    }
    if (changed.length) {
      const decisions = await processConversations(q, [...new Set(changed)]);
      result.auto_replies = decisions.auto_sent;
    }
    // Then everything still open that no pass has settled: deferred decisions and threads that never got a read.
    if (deps.sweep !== false) {
      const swept = await sweepDeferred(q, { accountId: opts.accountId, channel: 'affiliate', source: 'cruva', deps: deps.processDeps });
      result.auto_replies += swept.result.auto_sent;
    }
    q.setSetting('cruva_inbox_last_sync_at', new Date().toISOString());
    q.setSetting('cruva_inbox_last_sync_error', result.errors.length ? result.errors.slice(0, 3).join(' | ').slice(0, 500) : '');
    if (result.errors.length && !result.shops) result.ok = false;
  } catch (err) {
    result.ok = false;
    result.errors.push((err as Error).message);
    q.setSetting('cruva_inbox_last_sync_error', (err as Error).message);
  } finally {
    syncing = false;
    log.info(`Cruva inbox sync: ${result.shops} shop(s), ${result.conversations} thread(s), ${result.new_messages} new message(s) in ${Math.round((Date.now() - startedAt) / 1000)}s${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`);
    if (changed.length || result.errors.length) liveEvents.emitUpdate({ kind: 'inbox' });
  }
  if (result.shops) log.info(`Cruva inbox: ${result.shops} shop(s), ${result.conversations} thread(s), ${result.new_messages} new message(s)${result.auto_replies ? `, ${result.auto_replies} auto-reply` : ''}${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`);
  return result;
}

/** Send a creator DM through Cruva; returns the message id when Cruva reports one, else a local stamp. */
export async function sendCruvaDm(shopId: string, conversationId: string, handle: string | null, text: string, mcp: CruvaMcp = cruvaMcp): Promise<{ message_id: string }> {
  const out = await mcp.call('send_dm', { shop_id: shopId, conversation_id: conversationId, ...(handle ? { handle } : {}), message: text });
  const id = out.match(/message_id[^A-Za-z0-9]*([0-9]{3,})/)?.[1] ?? `cruva-${Date.now()}`;
  return { message_id: id };
}

/** Polls Cruva for creator messages on every linked shop. */
export class CruvaInboxWatcher {
  private timer: NodeJS.Timeout | null = null;
  constructor(private q: Queries) {}

  get everyMinutes(): number { return Math.max(3, Number(this.q.getSetting('cruva_inbox_every_minutes', '10')) || 10); }

  start(): void {
    this.stop();
    if (!cruvaMcp.configured) { log.info('Cruva inbox sync is off (CRUVA_API_KEY not set)'); return; }
    this.timer = setInterval(() => void syncCruvaInbox(this.q), this.everyMinutes * 60000);
    this.timer.unref?.();
    setTimeout(() => void syncCruvaInbox(this.q), 120000);
    log.info(`Cruva inbox sync every ${this.everyMinutes} min`);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  status(): { configured: boolean; last_sync_at: string | null; last_sync_error: string | null; every_minutes: number } {
    return { configured: cruvaMcp.configured, last_sync_at: this.q.getSetting('cruva_inbox_last_sync_at', '') || null, last_sync_error: this.q.getSetting('cruva_inbox_last_sync_error', '') || null, every_minutes: this.everyMinutes };
  }
}
