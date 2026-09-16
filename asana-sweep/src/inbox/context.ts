import { Queries } from '../db/queries.js';
import type { InboxConversation, InboxMessage, ReplyContext } from '../sweep/types.js';
import { guessLanguage } from './language.js';

/**
 * Everything the reply model may lean on for one conversation: the brand and market, live
 * promotions for that account/market, products in those promotions, the thread and earlier
 * threads with the same person, Cruva outreach notes for creators, and the context library.
 */
export function buildContext(q: Queries, c: InboxConversation, messages: InboxMessage[], overrideLanguage?: string | null): ReplyContext {
  const lastFromThem = [...messages].reverse().find((m) => m.sender_role === 'them' && m.text)?.text ?? c.last_message_text;
  const account = c.account_id ? q.getAccount(c.account_id) : null;
  const language = guessLanguage(lastFromThem, c.market, overrideLanguage ?? c.language ?? (account as { reply_language?: string | null } | null)?.reply_language);
  const now = Date.now();
  const promotions = q
    .listPromotions()
    .filter((p) => Date.parse(p.end_at) > now - 7 * 86400000)
    .filter((p) => p.targets.some((t) => (!c.account_id || t.account_id === c.account_id) && (!c.market || t.market === c.market) && t.status !== 'error'))
    .map((p) => ({
      name: p.name,
      discount: p.activity_type === 'SHIPPING_DISCOUNT' ? 'free / discounted shipping' : p.discount_type === 'FIXED_PRICE' ? `fixed price ${p.discount_value ?? ''}` : p.discount_type === 'AMOUNT_OFF' ? `${p.discount_value ?? ''} off` : `${p.discount_value ?? ''}% off`,
      period: `${p.begin_at.slice(0, 10)} to ${p.end_at.slice(0, 10)}`,
      status: Date.parse(p.begin_at) > now ? 'upcoming' : Date.parse(p.end_at) < now ? 'ended' : 'live',
    }));
  const productIds = new Set<string>();
  for (const p of q.listPromotions()) for (const [shop, ids] of Object.entries(p.products)) if (shop === c.tts_shop_id) ids.forEach((id) => productIds.add(id));
  const products = [...productIds].slice(0, 30).map((id) => ({ id, title: q.getSetting(`product_title:${c.tts_shop_id}:${id}`, '') || `product ${id}` }));
  return {
    language,
    account: c.account_name ?? c.shop_name,
    market: c.market,
    promotions,
    products,
    history: q.historyForCounterpart(c),
    cruva_outreach: c.channel === 'affiliate' ? q.cruvaOutreachFor(c.counterpart_name, c.account_id).map((o) => ({ when: o.occurred_at, summary: o.summary })) : [],
    library: q.contextFor(language, c.channel, c.account_id).map((e) => ({ title: e.title, body: e.body, language: e.language, scope: e.scope })),
  };
}

/** Render the context and thread as the prompt for the reply model. */
export function renderPrompt(c: InboxConversation, messages: InboxMessage[], ctx: ReplyContext): { system: string; user: string } {
  const brand = ctx.account ?? c.shop_name;
  const lines: string[] = [];
  lines.push(`You write replies for the TikTok Shop "${c.shop_name}" (brand: ${brand}${ctx.market ? `, market ${ctx.market}` : ''}).`);
  lines.push(`Channel: ${c.channel === 'cs' ? 'customer service chat with a buyer' : 'chat with an affiliate creator'}.`);
  lines.push(`Reply language: ${ctx.language}. Reply in that language unless the last message clearly uses another one; then match it.`);
  lines.push('Replace [brand] in any guidance with the brand name. Output only the reply text, nothing else.');
  lines.push('');
  lines.push('## Guidance from the context library');
  for (const e of ctx.library) lines.push(`### ${e.title}\n${e.body.replace(/\[brand\]/g, brand)}`);
  if (ctx.promotions.length) {
    lines.push('', '## Promotions for this shop');
    for (const p of ctx.promotions) lines.push(`- ${p.name}: ${p.discount}, ${p.period} (${p.status})`);
  }
  if (ctx.products.length) {
    lines.push('', '## Products in those promotions');
    for (const p of ctx.products) lines.push(`- ${p.title}`);
  }
  if (ctx.cruva_outreach.length) {
    lines.push('', '## Earlier outreach to this creator (Cruva)');
    for (const o of ctx.cruva_outreach) lines.push(`- ${o.when ? o.when.slice(0, 10) + ': ' : ''}${o.summary}`);
  }
  if (ctx.history.length) {
    lines.push('', '## Earlier conversations with this person');
    for (const h of ctx.history.slice(-15)) lines.push(`- [${h.when.slice(0, 10)}] ${h.who}: ${h.text}`);
  }
  const thread = messages
    .filter((m) => m.text || m.type !== 'TEXT')
    .slice(-25)
    .map((m) => `[${m.created_at.slice(0, 16).replace('T', ' ')}] ${m.sender_role === 'us' ? 'SHOP' : m.sender_role === 'them' ? (c.channel === 'cs' ? 'BUYER' : 'CREATOR') : 'SYSTEM'}${m.sender_name ? ` (${m.sender_name})` : ''}: ${m.text ?? `<${m.type.toLowerCase()}>`}`)
    .join('\n');
  return { system: lines.join('\n'), user: `Conversation so far:\n${thread || '(no messages)'}\n\nWrite the shop's next reply.` };
}
