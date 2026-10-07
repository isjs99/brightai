import { Queries } from '../db/queries.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { liveEvents } from '../live/events.js';
import type { Account, InboxChannel, InboxConversation, InboxMessage, InboxReply, RepliesData, RepliesSummaryRow, ReplyContext, ReplyDecision, ReplyEvent, ReplyPolicy } from '../sweep/types.js';
import { buildContext, cruvaShopFor, renderPrompt } from './context.js';
import { cruvaMcp } from '../cruva/mcp.js';
import { marketOfShopName } from '../gmv/market.js';
import { draftWithClaude, LlmBudgetError, modelFor } from './llm.js';
import { LANGUAGE_NAMES } from './language.js';
import { tts, ttsAffiliate, TtsClient } from '../tts/client.js';
import { inboxSettings, sendReply } from './sync.js';
import { cruvaRest } from '../cruva/rest.js';

/**
 * Replies per account and channel. Every new message from a creator or buyer goes through one pass:
 * a cheap multilingual prefilter (thanks, emojis, cards need no answer), then one model call that
 * classifies the message, decides whether a human must take over and writes the reply with the
 * account's full context. The policy for the account decides what happens with it: nothing, a draft
 * for the team, or an automatic send within the daily cap, the quiet hours and the "only" filters.
 * Every decision is logged as a reply event so the team can audit, mark wrong and teach.
 */

export interface Intent { key: string; label: string; escalates: boolean }

export const INTENTS: Record<InboxChannel, Intent[]> = {
  affiliate: [
    { key: 'sample_status', label: 'Where is my sample', escalates: false },
    { key: 'sample_request', label: 'Asks for a (new) sample', escalates: false },
    { key: 'commission', label: 'Commission & terms', escalates: false },
    { key: 'shipping', label: 'Shipping / tracking', escalates: false },
    { key: 'product_question', label: 'Product question', escalates: false },
    { key: 'content_help', label: 'Content ideas / brief', escalates: false },
    { key: 'deal_terms', label: 'Collab / deal terms', escalates: false },
    { key: 'retainer_or_payment', label: 'Retainer, fee or payment', escalates: true },
    { key: 'complaint', label: 'Complaint / angry', escalates: true },
    { key: 'damaged_sample', label: 'Damaged or wrong sample', escalates: true },
    { key: 'legal', label: 'Legal / threats', escalates: true },
    { key: 'other', label: 'Other', escalates: false },
  ],
  cs: [
    { key: 'order_status', label: 'Where is my order', escalates: false },
    { key: 'delivery_times', label: 'Delivery times', escalates: false },
    { key: 'product_question', label: 'Product question', escalates: false },
    { key: 'return_how', label: 'How to return', escalates: false },
    { key: 'discount', label: 'Discount / promo code', escalates: false },
    { key: 'cancel_before_shipping', label: 'Cancel before shipping', escalates: false },
    { key: 'refund_amount', label: 'Refund amount / money', escalates: true },
    { key: 'damaged', label: 'Damaged or wrong item', escalates: true },
    { key: 'cancel_after_shipping', label: 'Cancel after shipping', escalates: true },
    { key: 'health_claim', label: 'Health / side effects', escalates: true },
    { key: 'legal', label: 'Legal / threats', escalates: true },
    { key: 'other', label: 'Other', escalates: false },
  ],
};

export const ONLY_FILTERS: Record<InboxChannel, { key: string; label: string }[]> = {
  affiliate: [
    { key: 'has_sample', label: 'Creators with a sample request' },
    { key: 'posted_before', label: 'Creators who posted for us' },
    { key: 'gmv_floor', label: 'Creators with sales for us' },
    { key: 'not_do_not_contact', label: 'Skip do-not-contact / blacklist tags' },
  ],
  cs: [
    { key: 'has_order', label: 'Buyers with a matched order' },
    { key: 'no_open_return', label: 'No open return on the order' },
  ],
};

export const MARKET_TZ: Record<string, string> = { DE: 'Europe/Berlin', AT: 'Europe/Vienna', CH: 'Europe/Zurich', FR: 'Europe/Paris', IT: 'Europe/Rome', ES: 'Europe/Madrid', UK: 'Europe/London', GB: 'Europe/London', IE: 'Europe/Dublin', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', PL: 'Europe/Warsaw', PT: 'Europe/Lisbon', SE: 'Europe/Stockholm', US: 'America/New_York', AU: 'Australia/Sydney' };

export function defaultPolicy(accountId: number, channel: InboxChannel): ReplyPolicy {
  return { account_id: accountId, channel, mode: 'off', daily_cap: channel === 'affiliate' ? 50 : 100, answer_all: false, only: channel === 'affiliate' ? ['not_do_not_contact'] : [], never: INTENTS[channel].filter((i) => i.escalates).map((i) => i.key), auto_intents: [], quiet_from: null, quiet_to: null, max_age_hours: channel === 'affiliate' ? 168 : 48, shops_off: [], languages: {}, updated_at: null };
}

export function getPolicy(q: Queries, accountId: number, channel: InboxChannel): ReplyPolicy {
  return q.getReplyPolicy(accountId, channel) ?? defaultPolicy(accountId, channel);
}

// ---- Prefilter: messages that never need an answer, in every market language ----

const THANKS = /^(?:(?:ok(?:ay|ey|é)?|okk+|k|yes|yep|yeah|no|nope|sure|great|perfect|cool|nice|super|top|fine|alright|will do|got it|noted|thanks?(?: you| u)?(?: so much| a lot)?|thx|ty|tysm|cheers|you(?:'re| are) welcome|no problem|np|received|done)|(?:ja|nein|jo|okay|alles klar|passt|super|perfekt|prima|gerne|danke(?:schön| dir| sehr| schön| vielmals)?|vielen dank|dankeschön|bitte|verstanden|gut|top|klasse)|(?:oui|non|ok|d'accord|merci(?: beaucoup| bien)?|parfait|super|génial|top|bien reçu|reçu|de rien|avec plaisir|c'est noté|compris)|(?:sì|si|no|ok|va bene|perfetto|grazie(?: mille| tante)?|ottimo|certo|ricevuto|prego|capito)|(?:sí|si|no|vale|ok|perfecto|genial|gracias|muchas gracias|de nada|recibido|entendido|claro)|(?:ja|nee|oké|oke|prima|top|bedankt|dank je(?: wel)?|dankjewel|dank u|graag gedaan|begrepen|ontvangen|is goed)|(?:tak|nie|ok|dobrze|super|dzięki|dziękuję(?: bardzo)?|jasne|rozumiem|otrzymałem|otrzymałam)|(?:sim|não|nao|ok|perfeito|obrigad[oa](?: pela ajuda)?|certo|entendido|recebido|de nada)|(?:ja|nej|okej|toppen|perfekt|tack(?: så mycket)?|uppfattat|förstått|mottaget))[\s!.,]*$/iu;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s❤♥️✨🙏👍🔥💯‍]+$/u;
const GREETING_ONLY = /^(?:hi|hello|hey|hallo|hola|ciao|salut|bonjour|hej|cześć|czesc|olá|ola|guten tag|moin|servus|buongiorno|buenas|goedemiddag|goedemorgen|dzień dobry)[\s!.,]*$/i;

/** A short reason when the message needs no answer, or null when it should go to the model. */
export function prefilter(text: string | null | undefined, type = 'TEXT'): string | null {
  const t = (text ?? '').trim();
  if (!t) return type === 'TEXT' ? 'empty message' : `${type.toLowerCase()} without text`;
  if (/^\[(?:product|order) card [^\]]*\]$/i.test(t) || t === '[image]') return 'card or image only';
  if (EMOJI_ONLY.test(t)) return 'emoji only';
  if (t.length <= 2 && !/[?¿]/.test(t)) return 'too short to answer';
  if (THANKS.test(t)) return 'thanks or acknowledgement';
  if (GREETING_ONLY.test(t)) return 'greeting only, wait for the question';
  return null;
}

// ---- Day boundaries and quiet hours in the shop's timezone ----

export function tzFor(q: Queries, market: string | null | undefined): string {
  return MARKET_TZ[(market ?? '').toUpperCase()] ?? q.getSetting('check_timezone', 'Europe/Madrid');
}

/** ISO instant of local midnight today in the timezone. */
export function startOfDay(tz: string, now = Date.now()): string {
  const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: tz }));
  const offset = local.getTime() - Math.floor(now / 1000) * 1000;
  const midnight = new Date(local);
  midnight.setHours(0, 0, 0, 0);
  return new Date(midnight.getTime() - offset).toISOString();
}

export function localHHMM(tz: string, now = Date.now()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now)).replace('24:', '00:');
}

export function inQuietHours(policy: Pick<ReplyPolicy, 'quiet_from' | 'quiet_to'>, tz: string, now = Date.now()): boolean {
  if (!policy.quiet_from || !policy.quiet_to || policy.quiet_from === policy.quiet_to) return false;
  const hhmm = localHHMM(tz, now);
  return policy.quiet_from < policy.quiet_to ? hhmm >= policy.quiet_from && hhmm < policy.quiet_to : hhmm >= policy.quiet_from || hhmm < policy.quiet_to;
}

// ---- The model call ----

export interface Classification { needs_reply: boolean; intent: string; escalate: boolean; escalation: string | null; confidence: number; reply: string | null }

/** Parse the model's JSON answer; a plain-text answer still becomes a low-confidence draft rather than a lost message. */
export function parseClassification(raw: string, channel: InboxChannel): Classification {
  const keys = new Set(INTENTS[channel].map((i) => i.key));
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const intent = String(j.intent ?? 'other').toLowerCase().replace(/[^a-z_]/g, '');
      const confidence = typeof j.confidence === 'number' ? Math.max(0, Math.min(1, j.confidence)) : Number(j.confidence) || 0.5;
      const reply = typeof j.reply === 'string' && j.reply.trim() ? j.reply.trim() : null;
      return { needs_reply: j.needs_reply !== false && Boolean(reply), intent: keys.has(intent) ? intent : 'other', escalate: Boolean(j.escalate), escalation: typeof j.escalation === 'string' && j.escalation.trim() ? j.escalation.trim() : null, confidence, reply };
    } catch { /* fall through */ }
  }
  const text = raw.trim();
  return { needs_reply: Boolean(text), intent: 'other', escalate: true, escalation: 'model did not return JSON', confidence: 0.4, reply: text || null };
}

export type Llm = (system: string, user: string) => Promise<string>;

const chipsFor = (c: InboxConversation, ctx: ReplyContext, cls: Classification): string[] => {
  const chips: string[] = [LANGUAGE_NAMES[ctx.language] ?? ctx.language];
  chips.push(`${INTENTS[c.channel].find((i) => i.key === cls.intent)?.label ?? cls.intent}`);
  if (ctx.creator) chips.push(`${ctx.creator.followers ?? '?'} followers`, `${ctx.creator.videos ?? 0} videos for us`);
  for (const s of ctx.samples.slice(0, 2)) chips.push(`sample ${s.status}`);
  for (const o of ctx.orders.slice(0, 2)) chips.push(`order ${o.id.slice(-6)} ${o.status.toLowerCase()}`);
  if (ctx.returns.length) chips.push(`${ctx.returns.length} return(s)`);
  const live = ctx.promotions.filter((p) => p.status === 'live').length;
  if (live) chips.push(`${live} live promo(s)`);
  if (ctx.commission.pct !== null && c.channel === 'affiliate') chips.push(`${ctx.commission.pct}% commission`);
  if (ctx.brief_link && c.channel === 'affiliate') chips.push('brief link');
  if (ctx.campaigns.length) chips.push(`${ctx.campaigns.length} campaign(s)`);
  if (ctx.library.length) chips.push(`${ctx.library.length} library note(s)`);
  if (ctx.products.length) chips.push(`${ctx.products.length} products`);
  return chips.slice(0, 10);
};

/** Does the conversation satisfy every "only" filter on the policy? Returns the first failing label. */
export function onlyFilterBlocker(policy: ReplyPolicy, ctx: ReplyContext): string | null {
  for (const key of policy.only) {
    const label = ONLY_FILTERS[policy.channel].find((f) => f.key === key)?.label ?? key;
    const ok =
      key === 'has_sample' ? ctx.samples.length > 0
      : key === 'posted_before' ? (ctx.creator?.videos ?? 0) > 0
      : key === 'gmv_floor' ? (ctx.creator?.gmv_for_us ?? 0) > 0
      : key === 'not_do_not_contact' ? !(ctx.creator?.tags ?? []).some((t) => /do.?not.?contact|blacklist|blocked|dnc/i.test(t))
      : key === 'has_order' ? ctx.orders.length > 0
      : key === 'no_open_return' ? !ctx.returns.some((r) => !/COMPLETE|CLOSED|CANCEL|REJECT/i.test(r.status))
      : true;
    if (!ok) return label;
  }
  return null;
}

/**
 * A decision that said "not now" rather than "no": the master switch was off, the cap or quiet hours stopped it,
 * the message was too fresh, or the model or the send failed. These are looked at again on every pass until they
 * resolve; everything else (sent, escalated, drafted for the team, no reply needed) is final for that message.
 */
export function isDeferred(ev: ReplyEvent, now = Date.now()): boolean {
  if (ev.decision === 'waiting' || ev.decision === 'capped' || ev.decision === 'quiet') return true;
  if (ev.decision === 'drafted' && /master switch off/i.test(ev.escalation ?? '')) return true;
  // Errors retry once an hour, so a dead API key or an empty account does not burn a Claude call every ten minutes.
  if (ev.decision === 'error') return now - Date.parse(ev.created_at) > 3600000;
  return false;
}

/** One line in the creator's language when we answer a message that waited more than a day. */
const LATE_LINES: Record<string, string> = { en: 'Sorry for the slow reply!', de: 'Sorry für die späte Antwort!', fr: 'Désolé pour la réponse tardive !', it: 'Scusa per la risposta in ritardo!', es: '¡Perdona por la respuesta tardía!', nl: 'Sorry voor het late antwoord!', pl: 'Przepraszam za późną odpowiedź!', pt: 'Desculpa pela resposta tardia!', sv: 'Förlåt för det sena svaret!' };
export function withLateLine(text: string, language: string | null, theirAt: string | null, now = Date.now()): string {
  if (!theirAt || now - Date.parse(theirAt) < 24 * 3600000) return text;
  const line = LATE_LINES[(language ?? 'en').slice(0, 2).toLowerCase()] ?? LATE_LINES.en;
  return text.startsWith(line) ? text : `${line} ${text}`;
}

// Passes never overlap: the Cruva sync, the TikTok sync, the sweep and the buttons all queue behind each other,
// so two passes can never answer the same thread twice.
let passQueue: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = passQueue.then(fn, fn);
  passQueue = run.catch(() => undefined);
  return run;
}

export interface ProcessDeps { client?: TtsClient; llm?: Llm; now?: number; send?: (q: Queries, c: InboxConversation, replyId: number, text: string, client: TtsClient) => Promise<unknown> }

/** Run the policy over these conversations (after a sync). Returns the decisions taken. */
export function processConversations(q: Queries, ids: number[], deps: ProcessDeps = {}): Promise<Record<ReplyDecision, number>> {
  return queued(() => processNow(q, ids, deps));
}

async function processNow(q: Queries, ids: number[], deps: ProcessDeps = {}): Promise<Record<ReplyDecision, number>> {
  const out: Record<ReplyDecision, number> = { auto_sent: 0, drafted: 0, skipped: 0, escalated: 0, capped: 0, quiet: 0, error: 0, waiting: 0 };
  if (!ids.length) return out;
  const settings = inboxSettings(q);
  const now = deps.now ?? Date.now();
  const client = deps.client ?? tts;
  const send = deps.send ?? ((qq, c, rid, text, cl) => sendReply(qq, c, rid, text, cl));
  for (const id of [...new Set(ids)]) {
    const c = q.getConversation(id);
    if (!c || !c.account_id || c.status === 'closed' || c.last_sender !== 'them' || !c.last_message_id) continue;
    const prior = q.replyEventFor(c.id, c.last_message_id);
    if (prior && !isDeferred(prior, now)) continue;
    const policy = getPolicy(q, c.account_id, c.channel);
    if (policy.mode === 'off' || policy.shops_off.includes(c.tts_shop_id)) continue;
    const messages = q.listMessages(id);
    const last = [...messages].reverse().find((m) => m.message_id === c.last_message_id) ?? null;
    const theirText = last?.text ?? c.last_message_text;
    const theirAt = last?.created_at ?? c.last_message_at;
    const replyRef = `reply:${c.id}:${c.last_message_id}`;
    const llm = deps.llm ?? ((s: string, u: string) => draftWithClaude(s, u, { maxTokens: 900, feature: 'reply', accountId: c.account_id, ref: replyRef }));
    const base = { conversation_ref: c.id, account_id: c.account_id, channel: c.channel, message_id: c.last_message_id, language: c.language, model: deps.llm ? config.replyModel : modelFor('reply') };
    const record = (decision: ReplyDecision, extra: Partial<Omit<ReplyEvent, 'id' | 'created_at' | 'feedback' | 'feedback_note'>> & { chips?: string[]; reply_text?: string | null }) => {
      const { chips = [], reply_text = null, ...rest } = extra;
      q.addReplyEvent({ ...base, needs_reply: true, intent: null, escalation: null, confidence: null, reply_id: null, decision, context: { chips, their_text: theirText, reply_text, counterpart: c.counterpart_name, their_at: theirAt }, ...rest });
      out[decision] += 1;
    };
    if (q.getSetting(`reply_pause:${c.id}`, '') === '1') { record('skipped', { escalation: 'paused by the team' }); continue; }
    if (!c.last_message_at || now - Date.parse(c.last_message_at) > policy.max_age_hours * 3600000) { record('skipped', { escalation: `older than ${policy.max_age_hours}h` }); continue; }
    // A deferred decision with the reply already written: apply the gates again without calling the model.
    if (prior && prior.decision !== 'waiting' && prior.context.reply_text) {
      const text = prior.context.reply_text;
      const common = { needs_reply: true, intent: prior.intent, confidence: prior.confidence, chips: prior.context.chips, language: prior.language };
      const tz = tzFor(q, c.market);
      const again = (decision: ReplyDecision, escalation: string | null) => {
        if (prior.decision === decision && (prior.escalation ?? '') === (escalation ?? '')) return; // same answer as last time: nothing to record
        const reply_id = prior.reply_id ?? q.addReply({ conversation_ref: c.id, text, mode: 'draft', created_by: 'auto-reply', in_reply_to: c.last_message_id }).id;
        record(decision, { ...common, escalation, reply_id, reply_text: text });
      };
      if (policy.mode === 'draft') { again('drafted', null); continue; }
      if (!settings.auto_reply_master) { again('drafted', 'master switch off (Settings)'); continue; }
      if (inQuietHours(policy, tz, now)) { again('quiet', `quiet hours ${policy.quiet_from}–${policy.quiet_to} (${tz})`); continue; }
      if (policy.daily_cap !== null && q.countReplyEvents(c.account_id, c.channel, 'auto_sent', startOfDay(tz, now)) >= policy.daily_cap) { again('capped', `daily cap of ${policy.daily_cap} reached`); continue; }
      const outText = withLateLine(text, prior.language ?? c.language, theirAt, now);
      const reply = q.addReply({ conversation_ref: c.id, text: outText, mode: 'auto', created_by: 'auto-reply', in_reply_to: c.last_message_id });
      try {
        await send(q, c, reply.id, outText, client);
        record('auto_sent', { ...common, reply_id: reply.id, reply_text: outText });
      } catch (err) {
        record('error', { ...common, reply_id: reply.id, reply_text: outText, escalation: `send failed: ${(err as Error).message.slice(0, 200)}` });
      }
      continue;
    }
    const why = prefilter(theirText, last?.type ?? 'TEXT');
    if (why) { record('skipped', { needs_reply: false, intent: 'no_reply_needed', escalation: why }); continue; }
    if (!settings.llm_configured && !deps.llm) { record('error', { escalation: 'ANTHROPIC_API_KEY not set' }); continue; }
    // A burst of messages: wait for the dust to settle so one reply answers them all.
    if (last && now - Date.parse(last.created_at) < 90000 && c.channel === 'affiliate') { if (prior?.decision !== 'waiting') record('waiting', { escalation: 'message under 90 seconds old: read again on the next pass' }); continue; }
    let ctx: ReplyContext;
    let cls: Classification;
    try {
      ctx = await buildContext(q, c, messages, policy.languages[c.tts_shop_id] ?? null, cruvaRest);
      const { system, user } = renderPrompt(c, messages, ctx, { json: true, intents: INTENTS[c.channel], answerAll: policy.answer_all });
      cls = parseClassification(await llm(system, user), c.channel);
    } catch (err) {
      if (err instanceof LlmBudgetError) { log.warn(`Replies paused: ${err.message}`); record('error', { escalation: err.message.slice(0, 200) }); break; }
      log.error(`Reply pass failed for ${c.shop_name} ${c.channel} ${c.conversation_id}: ${(err as Error).message}`);
      record('error', { escalation: (err as Error).message.slice(0, 200) });
      continue;
    }
    const chips = chipsFor(c, ctx, cls);
    const common = { needs_reply: cls.needs_reply, intent: cls.intent, confidence: cls.confidence, chips, language: ctx.language };
    if (!cls.needs_reply || !cls.reply) { record('skipped', { ...common, needs_reply: false, escalation: cls.escalation ?? 'no answer expected' }); continue; }
    const intentDef = INTENTS[c.channel].find((i) => i.key === cls.intent);
    // "Answer everything": the topic lists are ignored; the model's own hand-over and a very low confidence are the only brakes.
    const escalation =
      cls.escalate ? (cls.escalation ?? 'model asked for a human')
      : !policy.answer_all && policy.never.includes(cls.intent) ? `${intentDef?.label ?? cls.intent}: always a human on this account`
      : !policy.answer_all && intentDef?.escalates ? `${intentDef.label}: needs a human`
      : cls.confidence < (policy.answer_all ? 0.4 : 0.6) ? `low confidence (${Math.round(cls.confidence * 100)}%)`
      : !policy.answer_all && c.channel === 'cs' && policy.auto_intents.length && !policy.auto_intents.includes(cls.intent) ? `${intentDef?.label ?? cls.intent}: not on the automatic list`
      : !c.can_send && !c.conversation_id.startsWith('sample-') ? 'TikTok does not allow the shop to message this buyer right now'
      : null;
    const sample = c.conversation_id.startsWith('sample-');
    const draft = () => q.addReply({ conversation_ref: c.id, text: cls.reply!, mode: 'draft', created_by: 'auto-reply', in_reply_to: c.last_message_id });
    if (escalation) { const d = draft(); record('escalated', { ...common, escalation, reply_id: d.id, reply_text: cls.reply }); continue; }
    if (policy.mode === 'draft' || sample) { const d = draft(); record('drafted', { ...common, reply_id: d.id, reply_text: cls.reply, escalation: sample ? 'sample thread, never sent' : null }); continue; }
    const only = policy.answer_all ? null : onlyFilterBlocker(policy, ctx);
    if (only) { const d = draft(); record('drafted', { ...common, escalation: `only: ${only}`, reply_id: d.id, reply_text: cls.reply }); continue; }
    if (!settings.auto_reply_master) { const d = draft(); record('drafted', { ...common, escalation: 'master switch off (Settings)', reply_id: d.id, reply_text: cls.reply }); continue; }
    const tz = tzFor(q, c.market);
    if (inQuietHours(policy, tz, now)) { const d = draft(); record('quiet', { ...common, escalation: `quiet hours ${policy.quiet_from}–${policy.quiet_to} (${tz})`, reply_id: d.id, reply_text: cls.reply }); continue; }
    if (policy.daily_cap !== null && q.countReplyEvents(c.account_id, c.channel, 'auto_sent', startOfDay(tz, now)) >= policy.daily_cap) { const d = draft(); record('capped', { ...common, escalation: `daily cap of ${policy.daily_cap} reached`, reply_id: d.id, reply_text: cls.reply }); continue; }
    const reply = q.addReply({ conversation_ref: c.id, text: cls.reply, mode: 'auto', created_by: 'auto-reply', in_reply_to: c.last_message_id });
    try {
      await send(q, c, reply.id, cls.reply, client);
      record('auto_sent', { ...common, reply_id: reply.id, reply_text: cls.reply });
    } catch (err) {
      record('error', { ...common, reply_id: reply.id, reply_text: cls.reply, escalation: `send failed: ${(err as Error).message.slice(0, 200)}` });
    }
  }
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  if (total) { log.info(`Replies: ${Object.entries(out).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}`); liveEvents.emitUpdate({ kind: 'inbox' }); }
  return out;
}

/** Errors (no credit, outage) are never retried on their own: a thread is decided once per message. This clears them and runs the pass again. */
/**
 * Every open thread the policy should answer but no pass has settled: never decided (it arrived while the read
 * budget was spent, or in the burst window), or decided "not now". Runs after each sync so a switch flipped on,
 * a cap raised, quiet hours ending or credit topped up turns the waiting drafts into sent replies, oldest first.
 */
export async function sweepDeferred(q: Queries, opts: { accountId?: number; channel?: InboxChannel; source?: 'tts' | 'cruva'; deps?: ProcessDeps } = {}): Promise<{ scanned: number; candidates: number; result: Record<ReplyDecision, number> }> {
  const now = opts.deps?.now ?? Date.now();
  const open = q.listOpenConversations({ accountId: opts.accountId, channel: opts.channel, limit: 3000 }).filter((c) => c.account_id && (!opts.source || c.source === opts.source) && !c.conversation_id.startsWith('sample-'));
  const policies = new Map<string, ReplyPolicy>();
  const policyOf = (c: InboxConversation) => { const k = `${c.account_id}:${c.channel}`; let p = policies.get(k); if (!p) { p = getPolicy(q, c.account_id!, c.channel); policies.set(k, p); } return p; };
  const inScope = open.filter((c) => { const p = policyOf(c); return p.mode !== 'off' && !p.shops_off.includes(c.tts_shop_id) && c.last_message_at && now - Date.parse(c.last_message_at) <= p.max_age_hours * 3600000; });
  const events = q.replyEventsForMessages(inScope.map((c) => ({ conversation_ref: c.id, message_id: c.last_message_id! })));
  const ids = inScope
    .filter((c) => { const ev = events.get(`${c.id}:${c.last_message_id}`); return !ev || isDeferred(ev, now); })
    .sort((a, b) => (a.last_message_at ?? '').localeCompare(b.last_message_at ?? ''))
    .map((c) => c.id);
  const result = await processConversations(q, ids, opts.deps);
  if (Object.values(result).some((n) => n)) log.info(`Reply sweep: ${ids.length} of ${open.length} open thread(s) looked at again${opts.accountId ? ` for account ${opts.accountId}` : ''}`);
  return { scanned: open.length, candidates: ids.length, result };
}

export async function retryErrors(q: Queries, accountId: number, channel: InboxChannel, opts: { conversationRefs?: number[]; deps?: ProcessDeps } = {}): Promise<{ retried: number; result: Record<ReplyDecision, number> }> {
  const ids = q.clearReplyErrors(accountId, channel, opts.conversationRefs);
  const result = await processConversations(q, ids, opts.deps);
  return { retried: ids.length, result };
}

/** Why this conversation will not be answered automatically right now (for the thread view). */
export function replyBlocker(q: Queries, c: InboxConversation, now = Date.now()): string | null {
  if (!c.account_id) return 'shop not linked to an account';
  const policy = getPolicy(q, c.account_id, c.channel);
  if (policy.mode === 'off') return `replies are off for ${c.account_name ?? c.shop_name} (${c.channel === 'cs' ? 'Customer service' : 'Creators'})`;
  if (policy.shops_off.includes(c.tts_shop_id)) return `${c.shop_name} is switched off for ${c.channel === 'cs' ? 'Customer service' : 'Creators'}`;
  if (policy.mode === 'draft') return 'draft mode: replies wait for the team';
  if (!inboxSettings(q).auto_reply_master) return 'master switch off (Settings)';
  if (!inboxSettings(q).llm_configured) return 'ANTHROPIC_API_KEY not set';
  if (q.getSetting(`reply_pause:${c.id}`, '') === '1') return 'paused by the team';
  if (c.status === 'closed') return 'conversation closed';
  if (c.last_sender !== 'them') return 'last message is ours';
  if (!c.can_send) return 'TikTok does not allow the shop to message this buyer right now';
  if (!c.last_message_at || now - Date.parse(c.last_message_at) > policy.max_age_hours * 3600000) return `older than ${policy.max_age_hours}h`;
  const ev = c.last_message_id ? q.replyEventFor(c.id, c.last_message_id) : null;
  if (ev) return ev.decision === 'auto_sent' ? 'answered automatically' : `${ev.decision}${ev.escalation ? `: ${ev.escalation}` : ''}`;
  if (inQuietHours(policy, tzFor(q, c.market), now)) return 'quiet hours';
  return null;
}

// ---- Data for the page ----

const dayAgo = (n: number, now = Date.now()) => new Date(now - n * 86400000).toISOString();

export interface ShopsPrefetch { tts: ReturnType<Queries['listTtsShops']>; cruva: ReturnType<Queries['listShops']> }

export function channelReadiness(q: Queries, accountId: number, channel: InboxChannel, scopeLive: (scope: 'customer_service' | 'affiliate_seller') => boolean, apps: { main: boolean; affiliate: boolean; cruva?: boolean } = { main: tts.configured, affiliate: ttsAffiliate.configured, cruva: cruvaMcp.configured }, pre?: ShopsPrefetch): { ready: boolean; note: string | null; shops: RepliesData['shops'] } {
  const shops = (pre?.tts ?? q.listTtsShops()).filter((s) => s.account_id === accountId);
  const policy = getPolicy(q, accountId, channel);
  const rows: RepliesData['shops'] = shops.map((s) => ({ id: s.id, name: s.name, market: s.market, token_ok: channel === 'affiliate' ? (apps.affiliate ? s.affiliate_token_ok : s.token_ok) : s.token_ok, off: policy.shops_off.includes(s.id), language: policy.languages[s.id] ?? null, source: 'tts' as const }));
  if (channel === 'affiliate') {
    // Creators: every linked Cruva shop reads and answers its creator inbox through Cruva, whether or not the TikTok affiliate app is authorised.
    const cruvaOn = apps.cruva ?? cruvaMcp.configured;
    const cruvaShops = (pre?.cruva ?? q.listShops('cruva')).filter((s) => s.account_id === accountId);
    for (const s of cruvaShops) {
      const market = marketOfShopName(s.shop_name);
      // A market the TikTok affiliate app already covers stays on TikTok; Cruva fills the rest.
      if (rows.some((r) => r.source === 'tts' && r.token_ok && apps.affiliate && (r.market ?? '').toUpperCase() === (market ?? '').toUpperCase())) continue;
      rows.push({ id: s.shop_id, name: s.shop_name, market, token_ok: cruvaOn, off: policy.shops_off.includes(s.shop_id), language: policy.languages[s.shop_id] ?? null, source: 'cruva' });
    }
    if (!rows.length) return { ready: false, note: 'No TikTok shop or Cruva shop linked to this account yet (Cruva › Link shops, or Promotions › Connection).', shops: rows };
    if (rows.some((r) => r.source === 'cruva' && r.token_ok)) return { ready: true, note: rows.some((r) => r.source === 'tts' && r.token_ok) ? null : null, shops: rows };
    if (rows.some((r) => r.source === 'cruva') && !cruvaOn) return { ready: false, note: 'Cruva shops linked but CRUVA_API_KEY is not set (Settings › Connections), so the creator inbox cannot be read.', shops: rows };
    if (!apps.affiliate && !apps.main) return { ready: false, note: 'TikTok app not configured on the server and no Cruva shop linked.', shops: rows };
    if (apps.affiliate && !rows.some((r) => r.token_ok)) return { ready: false, note: 'No shop on this account has authorised the affiliate app yet (Promotions › Connection › Affiliate app), and no Cruva shop is linked.', shops: rows };
    if (!apps.affiliate && !scopeLive('affiliate_seller')) return { ready: false, note: 'The affiliate scope is not live on the main app; add the affiliate app under Promotions › Connection, or link the Cruva shop.', shops: rows };
    return { ready: true, note: null, shops: rows };
  }
  if (!shops.length) return { ready: false, note: 'No TikTok shop linked to this account yet (Promotions › Connection).', shops: rows };
  if (!apps.main) return { ready: false, note: 'TikTok app not configured on the server.', shops: rows };
  if (!scopeLive('customer_service')) return { ready: false, note: 'Customer service scope is still under review with TikTok. Draft mode works on sample threads; live buyer chats arrive once the scope is approved and the shops are re-authorised.', shops: rows };
  if (!rows.some((r) => r.token_ok)) return { ready: false, note: 'No shop on this account is authorised (Promotions › Connection).', shops: rows };
  return { ready: true, note: null, shops: rows };
}

const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Attach the latest decision and the pending draft to open threads: three queries, not two per thread. */
export function withState(q: Queries, convs: InboxConversation[]): (InboxConversation & { event: ReplyEvent | null; draft: InboxReply | null })[] {
  const events = q.replyEventsForMessages(convs.map((c) => ({ conversation_ref: c.id, message_id: c.last_message_id! })));
  const drafts = q.pendingDrafts(convs.map((c) => c.id));
  return convs.map((c) => ({ ...c, event: events.get(`${c.id}:${c.last_message_id}`) ?? null, draft: drafts.get(c.id) ?? null }));
}

/** Conversations that need the team, with their latest decision and pending draft. */
export function waitingFor(q: Queries, accountId: number, channel: InboxChannel, policy: ReplyPolicy, now = Date.now(), open?: InboxConversation[]): RepliesData['waiting'] {
  return withState(q, open ?? q.listOpenConversations({ accountId, channel, limit: 500 }))
    .filter((c) => (c.event ? ['escalated', 'drafted', 'capped', 'quiet', 'error', 'waiting'].includes(c.event.decision) : c.last_message_at ? now - Date.parse(c.last_message_at) <= policy.max_age_hours * 3600000 : false))
    .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''));
}

/** The waiting threads grouped by what is stopping them, so "why did nothing send" is one glance. */
export function blockerGroups(q: Queries, waiting: RepliesData['waiting'], intents: { key: string; label: string }[], now = Date.now()): RepliesData['blockers'] {
  const groups = new Map<string, { reason: string; deferred: boolean; ids: number[]; examples: { id: number; counterpart_name: string | null; last_message_at: string | null }[] }>();
  for (const w of waiting) {
    const ev = w.event;
    const esc = ev?.escalation ?? '';
    let reason: string; let deferred = false;
    if (!ev) { reason = replyBlocker(q, w, now) ?? 'Not read yet: waits for the next sync'; deferred = !replyBlocker(q, w, now); }
    else if (ev.decision === 'waiting') { reason = 'Arrived in the burst window: read again on the next pass'; deferred = true; }
    else if (ev.decision === 'capped') { reason = 'Daily cap reached: goes out when the cap is raised or tomorrow'; deferred = true; }
    else if (ev.decision === 'quiet') { reason = 'Quiet hours: goes out when they end'; deferred = true; }
    else if (ev.decision === 'drafted' && /master switch off/i.test(esc)) { reason = 'Master switch off (Settings › Connections): goes out when it is on'; deferred = true; }
    else if (ev.decision === 'drafted' && /^only:/i.test(esc)) reason = `Blocked by the only-filter (${esc.replace(/^only:\s*/i, '')})`;
    else if (ev.decision === 'drafted') reason = 'Draft mode: waits for the team';
    else if (ev.decision === 'error') { reason = `Error: ${esc.replace(/^send failed: /i, 'send failed: ').slice(0, 80) || 'unknown'}`; deferred = true; }
    else if (ev.decision === 'escalated') reason = `Needs a human: ${ev.intent ? intents.find((i) => i.key === ev.intent)?.label ?? ev.intent : esc || 'the model asked for one'}${ev.intent && esc ? ` (${esc.replace(/\(\d+%\)/, '').trim()})` : ''}`;
    else reason = `${ev.decision}${esc ? `: ${esc}` : ''}`;
    const g = groups.get(reason) ?? { reason, deferred, ids: [], examples: [] };
    g.ids.push(w.id);
    if (g.examples.length < 3) g.examples.push({ id: w.id, counterpart_name: w.counterpart_name, last_message_at: w.last_message_at });
    groups.set(reason, g);
  }
  return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length).map((g) => ({ reason: g.reason, deferred: g.deferred, count: g.ids.length, examples: g.examples }));
}

export function repliesData(q: Queries, account: Account, channel: InboxChannel, scopeLive: (scope: 'customer_service' | 'affiliate_seller') => boolean, now = Date.now(), apps?: { main: boolean; affiliate: boolean }): RepliesData {
  const policy = getPolicy(q, account.id, channel);
  const settings = inboxSettings(q);
  const readiness = channelReadiness(q, account.id, channel, scopeLive, apps);
  const tz = tzFor(q, (account.markets ?? '').split(/[,\s]+/)[0] || null);
  const since = startOfDay(tz, now);
  const sent = q.countRepliesSentSince(account.id, channel, since);
  const waiting = waitingFor(q, account.id, channel, policy, now);
  const log = withCosts(q, q.listReplyEvents({ accountId: account.id, channel, limit: 300 }));
  const week = q.listReplyEvents({ accountId: account.id, channel, since: dayAgo(7, now), limit: 2000 });
  const minutes = log.filter((e) => e.decision === 'auto_sent' && e.created_at >= since && e.context.their_at).map((e) => (Date.parse(e.created_at) - Date.parse(e.context.their_at!)) / 60000).filter((m) => m >= 0 && m < 1440);
  const cruvaShop = cruvaShopFor(q, account.id, null);
  const pullCounts = [...q.latestHealthPullCounts('tts', readiness.shops.map((s) => s.id)).values()];
  const productCount = pullCounts.reduce((n, p) => n + p.products, 0);
  const orderCount = pullCounts.reduce((n, p) => n + p.orders, 0);
  const library = q.listContext().filter((e) => e.enabled && (e.scope === 'both' || e.scope === channel) && (e.account_id === null || e.account_id === account.id));
  const promos = q.listPromotions().filter((p) => Date.parse(p.end_at) > now && p.targets.some((t) => t.account_id === account.id && t.status !== 'error'));
  const history = q.countConversations({ accountId: account.id, channel });
  const knowledge: RepliesData['knowledge'] = [
    { label: 'Context library', state: library.length ? 'ok' : 'warn', detail: library.length ? `${library.length} note(s) for this account or every account` : 'No notes yet. Teach from a wrong reply, or add notes under Inbox › Library.' },
    { label: 'Promotions', state: promos.length ? 'ok' : 'warn', detail: promos.length ? `${promos.length} live or upcoming` : 'None live for this account' },
    { label: 'Products', state: productCount ? 'ok' : 'missing', detail: productCount ? `${productCount} from the TikTok pull (titles, prices, stock)` : 'No TikTok product pull yet (Accounts › Pull now)' },
  ];
  if (channel === 'affiliate') {
    knowledge.push(
      { label: 'Commission', state: account.commission_pct !== null || q.getSetting(`reply_commission:${account.id}`, '') ? 'ok' : 'warn', detail: account.commission_pct !== null ? `${account.commission_pct}% on the account` : 'Not recorded: the model will not quote a rate' },
      { label: 'Cruva CRM', state: cruvaShop && cruvaRest.configured ? 'ok' : cruvaShop ? 'warn' : 'missing', detail: cruvaShop && cruvaRest.configured ? 'Creator profile, samples, outreach logs, campaigns per message' : cruvaShop ? 'Shop linked but CRUVA_API_KEY not set' : 'No Cruva shop linked (Cruva › Link shops)' },
      { label: 'Creator brief', state: q.getSetting(`playbook_learned_${cruvaShop ?? ''}`, '').includes('brief_link":"http') ? 'ok' : 'warn', detail: q.getSetting(`playbook_learned_${cruvaShop ?? ''}`, '').includes('brief_link":"http') ? 'Brief link known from Cruva' : 'No brief link yet (roll out the creator brief under Cruva)' },
      { label: 'Conversation history', state: history ? 'ok' : 'warn', detail: history ? `${history} creator thread(s) on record` : 'No creator threads pulled yet' },
    );
  } else {
    knowledge.push(
      { label: 'Orders and returns', state: orderCount ? 'ok' : 'missing', detail: orderCount ? `${orderCount} recent orders matched by buyer id, order number or name` : 'No order pull yet' },
      { label: 'CS history', state: history ? 'ok' : 'warn', detail: history ? `${history} buyer thread(s) on record` : 'No buyer threads yet (scope pending or no sync)' },
    );
  }
  return {
    account,
    channel,
    policy,
    master_on: settings.auto_reply_master,
    llm_configured: settings.llm_configured,
    channel_ready: readiness.ready,
    channel_note: readiness.note,
    shops: readiness.shops,
    counts: {
      replied_today: sent.auto + sent.manual,
      auto_today: q.countReplyEvents(account.id, channel, 'auto_sent', since),
      manual_today: sent.manual,
      cap: policy.daily_cap,
      waiting: waiting.length,
      escalated: waiting.filter((w) => w.event?.decision === 'escalated' || w.event?.decision === 'error').length,
      drafts: waiting.filter((w) => w.draft).length,
      skipped_today: q.countReplyEvents(account.id, channel, 'skipped', since),
      median_minutes: median(minutes) === null ? null : Math.round(median(minutes)!),
      wrong_7d: week.filter((e) => e.feedback === 'wrong').length,
    },
    waiting,
    blockers: blockerGroups(q, waiting, INTENTS[channel], now),
    log,
    knowledge,
    intents: INTENTS[channel],
    only_filters: ONLY_FILTERS[channel],
    languages: LANGUAGE_NAMES,
  };
}

/** Every thread waiting for a person across accounts, newest first (for Today). */
/** The Claude cost behind each event, from the usage log (manual drafts and automatic passes alike). */
export function withCosts<T extends Pick<ReplyEvent, 'conversation_ref' | 'message_id' | 'cost'>>(q: Queries, events: T[]): T[] {
  const refs = events.map((e) => `reply:${e.conversation_ref}:${e.message_id}`);
  const costs = q.llmCostByRef(refs);
  return events.map((e) => ({ ...e, cost: costs.get(`reply:${e.conversation_ref}:${e.message_id}`) ?? null }));
}

/** Open threads for every enabled account, grouped by account and channel, from one query. */
function openByAccount(q: Queries, accounts: Account[]): Map<string, InboxConversation[]> {
  const enabled = new Set(accounts.map((a) => a.id));
  const by = new Map<string, InboxConversation[]>();
  for (const c of q.listOpenConversations({ limit: 20000 })) {
    if (c.account_id === null || !enabled.has(c.account_id)) continue;
    const key = `${c.account_id}:${c.channel}`;
    const list = by.get(key) ?? [];
    if (list.length < 500) { list.push(c); by.set(key, list); }
  }
  return by;
}

export function waitingAll(q: Queries, limit = 40, now = Date.now()): (InboxConversation & { reason: string | null })[] {
  return overview(q, () => true, now, limit).waiting;
}

/** The replies overview in one pass over the open threads: the per-account rows and the oldest threads waiting across accounts. */
export function overview(q: Queries, scopeLive: (scope: 'customer_service' | 'affiliate_seller') => boolean, now = Date.now(), limit = 40): { rows: RepliesSummaryRow[]; waiting: (InboxConversation & { reason: string | null })[] } {
  const accounts = q.listAccounts().filter((x) => x.enabled);
  const by = openByAccount(q, accounts);
  const pre: ShopsPrefetch = { tts: q.listTtsShops(), cruva: q.listShops('cruva') };
  const rows: RepliesSummaryRow[] = [];
  const all: (InboxConversation & { reason: string | null })[] = [];
  for (const a of accounts) {
    for (const channel of ['affiliate', 'cs'] as InboxChannel[]) {
      const policy = getPolicy(q, a.id, channel);
      const tz = tzFor(q, (a.markets ?? '').split(/[,\s]+/)[0] || null);
      const waiting = waitingFor(q, a.id, channel, policy, now, by.get(`${a.id}:${channel}`) ?? []);
      const readiness = channelReadiness(q, a.id, channel, scopeLive, undefined, pre);
      rows.push({ account_id: a.id, account_name: a.name, am_name: a.am_name, channel, mode: policy.mode, waiting: waiting.length, escalated: waiting.filter((w) => w.event?.decision === 'escalated' || w.event?.decision === 'error').length, auto_today: q.countReplyEvents(a.id, channel, 'auto_sent', startOfDay(tz, now)), cap: policy.daily_cap, ready: readiness.ready, note: readiness.note, shops: readiness.shops });
      for (const w of waiting) all.push({ ...w, reason: w.event?.escalation ?? (w.event ? w.event.decision : null) });
    }
  }
  return { rows, waiting: all.sort((a, b) => (a.last_message_at ?? '').localeCompare(b.last_message_at ?? '')).slice(0, limit) };
}

export function summary(q: Queries, scopeLive: (scope: 'customer_service' | 'affiliate_seller') => boolean, now = Date.now()): RepliesSummaryRow[] {
  return overview(q, scopeLive, now).rows;
}

/** Save a policy from the UI; unknown keys are dropped, numbers clamped. */
export function savePolicy(q: Queries, accountId: number, channel: InboxChannel, body: Record<string, unknown>): ReplyPolicy {
  const cur = getPolicy(q, accountId, channel);
  const mode = body.mode === undefined ? cur.mode : String(body.mode);
  if (!['off', 'draft', 'auto'].includes(mode)) throw new Error('mode must be off, draft or auto');
  const cap = body.daily_cap === undefined ? cur.daily_cap : body.daily_cap === null || body.daily_cap === '' ? null : Math.max(1, Math.min(5000, Math.round(Number(body.daily_cap)) || 1));
  const list = (v: unknown, allowed: string[], fallback: string[]) => (v === undefined ? fallback : Array.isArray(v) ? v.map(String).filter((k) => allowed.includes(k)) : fallback);
  const hhmm = (v: unknown, fallback: string | null) => (v === undefined ? fallback : v === null || v === '' ? null : /^\d{2}:\d{2}$/.test(String(v)) ? String(v) : fallback);
  const next: ReplyPolicy = {
    account_id: accountId,
    channel,
    mode: mode as ReplyPolicy['mode'],
    daily_cap: cap,
    answer_all: body.answer_all === undefined ? cur.answer_all : Boolean(body.answer_all),
    only: list(body.only, ONLY_FILTERS[channel].map((f) => f.key), cur.only),
    never: list(body.never, INTENTS[channel].map((i) => i.key), cur.never),
    auto_intents: list(body.auto_intents, INTENTS[channel].map((i) => i.key), cur.auto_intents),
    quiet_from: hhmm(body.quiet_from, cur.quiet_from),
    quiet_to: hhmm(body.quiet_to, cur.quiet_to),
    max_age_hours: body.max_age_hours === undefined ? cur.max_age_hours : Number.isFinite(Number(body.max_age_hours)) ? Math.max(1, Math.min(720, Math.round(Number(body.max_age_hours)))) : 48,
    shops_off: list(body.shops_off, q.listTtsShops().filter((s) => s.account_id === accountId).map((s) => s.id), cur.shops_off),
    languages: body.languages === undefined ? cur.languages : Object.fromEntries(Object.entries((body.languages ?? {}) as Record<string, unknown>).filter(([k, v]) => q.listTtsShops().some((s) => s.id === k && s.account_id === accountId) && typeof v === 'string' && v !== '*' && v in LANGUAGE_NAMES).map(([k, v]) => [k, String(v)])),
    updated_at: new Date().toISOString(),
  };
  const saved = q.saveReplyPolicy(next);
  liveEvents.emitUpdate({ kind: 'inbox' });
  return saved;
}

/** Mark a logged reply right or wrong; "teach" adds a context note for this account and language so the next reply knows. */
export function feedback(q: Queries, eventId: number, fb: 'right' | 'wrong' | null, note: string | null, teach: { title?: string; body?: string } | null, actor: string | null): ReplyEvent {
  const ev = q.getReplyEvent(eventId);
  if (!ev) throw new Error('Reply event not found');
  const updated = q.setReplyFeedback(eventId, fb, note)!;
  if (teach?.body?.trim()) {
    q.createContext({ language: ev.language && ev.language !== 'en' ? ev.language : '*', scope: ev.channel, account_id: ev.account_id, title: (teach.title?.trim() || `Learned from ${ev.context.counterpart ?? 'a reply'} (${actor ?? 'team'})`).slice(0, 120), body: teach.body.trim(), enabled: true });
  }
  liveEvents.emitUpdate({ kind: 'inbox' });
  return updated;
}

/** A pretend buyer or creator thread on the account's first shop, so draft mode can be tried before the scope is live. */
export async function sampleThread(q: Queries, account: Account, channel: InboxChannel, text: string, language: string | null, deps: ProcessDeps = {}): Promise<{ conversation: InboxConversation; messages: InboxMessage[]; draft: InboxReply | null; event: ReplyEvent | null }> {
  const shop = q.listTtsShops().find((s) => s.account_id === account.id);
  if (!shop) throw new Error('Link a TikTok shop to this account first (Promotions › Connection).');
  const stamp = Date.now();
  const up = q.upsertConversation({ tts_shop_id: shop.id, channel, conversation_id: `sample-${stamp}`, counterpart_name: channel === 'cs' ? 'Sample buyer' : 'sample.creator', counterpart_id: null, unread_count: 1, can_send: false, last_message_at: new Date(stamp).toISOString(), last_message_text: text, last_sender: 'them', last_message_id: `sample-${stamp}-1` });
  q.upsertMessages(up.id, [{ message_id: `sample-${stamp}-1`, sender_role: 'them', sender_name: channel === 'cs' ? 'Sample buyer' : 'sample.creator', type: 'TEXT', text, created_at: new Date(stamp - 120000).toISOString() }]);
  if (language) q.setConversationLanguage(up.id, language);
  const policy = getPolicy(q, account.id, channel);
  if (policy.mode === 'off') q.saveReplyPolicy({ ...policy, mode: 'draft', updated_at: new Date().toISOString() });
  try {
    await processConversations(q, [up.id], deps);
  } finally {
    if (policy.mode === 'off') q.saveReplyPolicy({ ...policy, updated_at: new Date().toISOString() });
  }
  const conversation = q.getConversation(up.id)!;
  return { conversation, messages: q.listMessages(up.id), draft: q.pendingDraft(up.id), event: q.replyEventFor(up.id, `sample-${stamp}-1`) };
}

/** Monday digest: what went out automatically last week, what waited, what was marked wrong. */
export function weeklyDigest(q: Queries, now = Date.now()): string | null {
  const since = dayAgo(7, now);
  const lines: string[] = [];
  for (const a of q.listAccounts().filter((x) => x.enabled)) {
    for (const channel of ['affiliate', 'cs'] as InboxChannel[]) {
      const policy = getPolicy(q, a.id, channel);
      if (policy.mode === 'off') continue;
      const ev = q.listReplyEvents({ accountId: a.id, channel, since, limit: 5000 });
      if (!ev.length) continue;
      const n = (d: ReplyDecision) => ev.filter((e) => e.decision === d).length;
      const wrong = ev.filter((e) => e.feedback === 'wrong').length;
      lines.push(`• *${a.name}* ${channel === 'cs' ? 'buyers' : 'creators'} (${policy.mode}): ${n('auto_sent')} sent automatically, ${n('drafted') + n('capped') + n('quiet')} drafted, ${n('escalated')} to a human, ${n('skipped')} needed no answer${wrong ? `, ${wrong} marked wrong` : ''}${n('error') ? `, ${n('error')} errors` : ''}`);
    }
  }
  if (!lines.length) return null;
  return `*Replies last 7 days*\n${lines.join('\n')}`;
}
