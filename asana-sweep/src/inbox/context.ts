import { Queries } from '../db/queries.js';
import type { InboxConversation, InboxMessage, ReplyContext, PlaybookLearned } from '../sweep/types.js';
import type { TtsRows } from '../health/tts-rules.js';
import { guessLanguage, LANGUAGE_NAMES } from './language.js';
import { cruvaRest, type CruvaRest } from '../cruva/rest.js';

/** The Cruva shop behind a conversation: same account, name ends with the market (or the only shop on the account). */
export function cruvaShopFor(q: Queries, accountId: number | null, market: string | null): string | null {
  if (!accountId) return null;
  const shops = q.listShops('cruva').filter((s) => s.account_id === accountId);
  if (!shops.length) return null;
  if (shops.length === 1 || !market) return shops[0].shop_id;
  const m = market.toUpperCase();
  const hit = shops.find((s) => new RegExp(`[\\s(\\-_]${m === 'GB' ? '(UK|GB)' : m}\\)?$`, 'i').test(s.shop_name.trim())) ?? shops.find((s) => s.shop_name.toUpperCase().includes(m));
  return (hit ?? shops[0]).shop_id;
}

const learnedFor = (q: Queries, shopId: string | null): PlaybookLearned | null => {
  if (!shopId) return null;
  try { const raw = q.getSetting(`playbook_learned_${shopId}`, ''); return raw ? (JSON.parse(raw) as PlaybookLearned) : null; } catch { return null; }
};

const day = (sec: number | null | undefined): string | null => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : null);
const ORDER_ID = /\b\d{15,20}\b/g;

/** Every fact the reply model may lean on for one conversation, by channel. Never throws: thin context comes with notes. */
export async function buildContext(q: Queries, c: InboxConversation, messages: InboxMessage[], overrideLanguage?: string | null, rest: CruvaRest = cruvaRest): Promise<ReplyContext> {
  const base = buildContextSync(q, c, messages, overrideLanguage);
  if (c.channel !== 'affiliate') return base;
  const shopId = c.source === 'cruva' ? c.tts_shop_id : cruvaShopFor(q, c.account_id, c.market);
  if (!shopId) { base.notes.push('No Cruva shop linked to this account yet (Cruva › Link shops), so creator history comes from TikTok only.'); return base; }
  if (!rest.configured) { base.notes.push('CRUVA_API_KEY not set, so the creator CRM, samples and campaigns are missing.'); return base; }
  const cx = await rest.creatorContext(shopId, c.counterpart_name);
  base.notes.push(...cx.notes);
  if (cx.creator) base.creator = { handle: cx.creator.handle, followers: cx.creator.followers, gmv_for_us: cx.creator.gmv_for_us, videos: cx.creator.videos, showcasing: cx.creator.showcasing, tags: cx.creator.tags, last_post: cx.creator.last_post };
  if (cx.samples.length) base.samples = cx.samples.map((s) => ({ product: s.product, status: s.status, requested: s.requested, approved: s.approved, received: s.received, source: s.source }));
  base.outreach_logs = cx.logs.map((l) => ({ when: l.when, campaign: l.campaign, channel: l.channel, status: l.status }));
  base.campaigns = cx.campaigns.map((k) => ({ title: k.title, type: k.type, status: k.status, link: k.link, ends: k.ends }));
  if (cx.products.length) {
    const seen = new Set(base.products.map((p) => p.id));
    for (const p of cx.products.slice(0, 40)) if (!seen.has(p.id)) base.products.push({ id: p.id, title: p.title, price: p.price, currency: null, stock: p.stock, status: p.open_plan === false ? 'not in open plan' : p.status });
  }
  return base;
}

/** The part of the context that needs no network: promotions, products, orders, library, history. */
export function buildContextSync(q: Queries, c: InboxConversation, messages: InboxMessage[], overrideLanguage?: string | null): ReplyContext {
  const theirs = messages.filter((m) => m.sender_role === 'them' && m.text);
  const lastFromThem = theirs[theirs.length - 1]?.text ?? c.last_message_text;
  const account = c.account_id ? q.getAccount(c.account_id) : null;
  const language = guessLanguage(lastFromThem, c.market, overrideLanguage ?? c.language ?? (account as { reply_language?: string | null } | null)?.reply_language);
  const now = Date.now();
  const notes: string[] = [];
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
  // Products: the latest TikTok pull for this shop first (title, price, stock), then anything in promotions.
  const pull = q.latestHealthPulls('tts').find((p) => p.shop_id === c.tts_shop_id);
  const rows = (pull?.rows ?? {}) as Partial<TtsRows>;
  const products: ReplyContext['products'] = [];
  const seen = new Set<string>();
  for (const p of (rows.products ?? []).filter((p) => p.status === 'ACTIVATE' || p.status === 'ACTIVE' || !p.status).slice(0, 60)) {
    const sku = p.skus.find((s) => s.price !== null) ?? p.skus[0];
    products.push({ id: p.id, title: p.title, price: sku?.price ?? null, currency: sku?.currency ?? null, stock: p.skus.reduce((n, s) => n + s.qty, 0), status: null });
    seen.add(p.id);
  }
  for (const p of q.listPromotions()) for (const [shop, ids] of Object.entries(p.products)) if (shop === c.tts_shop_id) for (const id of ids) if (!seen.has(id)) { seen.add(id); products.push({ id, title: q.getSetting(`product_title:${c.tts_shop_id}:${id}`, '') || `product ${id}` }); }
  if (!pull) notes.push('No TikTok pull for this shop yet, so products and orders are missing (Accounts › Pull now).');
  // Orders and returns for the buyer: by TikTok user id, by an order number they typed, or by the recipient name.
  let orders: ReplyContext['orders'] = [];
  let returns: ReplyContext['returns'] = [];
  if (c.channel === 'cs') {
    const typed = new Set<string>();
    for (const m of theirs) for (const id of m.text!.match(ORDER_ID) ?? []) typed.add(id);
    const mine = (rows.orders ?? []).filter((o) => (c.counterpart_id && o.user_id && o.user_id === c.counterpart_id) || typed.has(o.id) || (c.counterpart_name && o.recipient_name && o.recipient_name.trim().toLowerCase() === c.counterpart_name.trim().toLowerCase()));
    const titles = new Map((rows.products ?? []).map((p) => [p.id, p.title]));
    orders = mine
      .sort((a, b) => b.create_time - a.create_time)
      .slice(0, 8)
      .map((o) => ({ id: o.id, status: o.status, created: day(o.create_time) ?? '', shipped: day(o.collection_time ?? o.rts_time), delivered: day(o.delivery_time), ship_by: day(o.tts_sla_time ?? o.rts_sla_time), carrier: o.shipping_provider, total: o.total_amount, currency: o.currency, items: o.line_items.map((li) => (li.product_id && titles.get(li.product_id)) || li.product_id || 'item').slice(0, 6) }));
    const ids = new Set(orders.map((o) => o.id));
    returns = (rows.returns ?? []).filter((r) => r.order_id && ids.has(r.order_id)).map((r) => ({ id: r.return_id, order_id: r.order_id, status: r.status, type: r.type, refund: r.refund_total, next_action: r.next_action }));
    if (!orders.length && pull) notes.push('No order on this shop matches the buyer, so do not state order facts; ask for the order number.');
  }
  const learned = learnedFor(q, cruvaShopFor(q, c.account_id, c.market));
  const commission = { pct: account?.commission_pct ?? null, ads_pct: null as number | null, note: null as string | null };
  const invite = q.getSetting(`reply_commission:${c.account_id ?? 0}`, '');
  if (invite) { const j = (() => { try { return JSON.parse(invite) as { pct?: number; ads_pct?: number; note?: string }; } catch { return {}; } })(); if (typeof j.pct === 'number') commission.pct = j.pct; if (typeof j.ads_pct === 'number') commission.ads_pct = j.ads_pct; if (j.note) commission.note = j.note; }
  return {
    language,
    account: c.account_name ?? c.shop_name,
    market: c.market,
    promotions,
    products,
    history: q.historyForCounterpart(c),
    cruva_outreach: c.channel === 'affiliate' ? q.cruvaOutreachFor(c.counterpart_name, c.account_id).map((o) => ({ when: o.occurred_at, summary: o.summary })) : [],
    library: q.contextFor(language, c.channel, c.account_id).map((e) => ({ title: e.title, body: e.body, language: e.language, scope: e.scope })),
    commission,
    brief_link: learned?.brief_link ?? null,
    creator: null,
    samples: [],
    outreach_logs: [],
    campaigns: [],
    orders,
    returns,
    notes,
  };
}

const money = (n: number | null | undefined, cur: string | null | undefined) => (n === null || n === undefined ? '' : `${cur ?? ''} ${n}`.trim());

/** Render the context and thread as the prompt for the reply model (classification and reply in one call). */
export function renderPrompt(c: InboxConversation, messages: InboxMessage[], ctx: ReplyContext, opts: { intents?: { key: string; label: string; escalates: boolean }[]; json?: boolean } = {}): { system: string; user: string } {
  const brand = ctx.account ?? c.shop_name;
  const cs = c.channel === 'cs';
  const lang = LANGUAGE_NAMES[ctx.language] ?? ctx.language;
  const lines: string[] = [];
  lines.push(`You write replies for the TikTok Shop "${c.shop_name}" (brand: ${brand}${ctx.market ? `, market ${ctx.market}` : ''}) on behalf of the brand's account team.`);
  lines.push(`Channel: ${cs ? 'customer service chat with a buyer' : 'chat with an affiliate creator who promotes the brand'}.`);
  lines.push(`Reply language: ${lang} (${ctx.language}). Reply in that language unless the last message clearly uses another one; then match it. Use the natural register of that language (du/Sie, tu/vous etc. as a friendly brand would).`);
  lines.push('Be short, warm and concrete: two to five sentences, no bullet lists, no sign-off block, no placeholders. Only state facts that appear below; if something is unknown, say you will check and come back.');
  if (cs) {
    lines.push('Never promise a refund amount, compensation, a return outcome or a delivery date that is not in the order facts below. Never ask for card details or passwords. Returns are handled through the TikTok order page: point the buyer there.');
  } else {
    lines.push('Never promise retainers, fixed fees, paid posts, free products beyond the sample programme, or commission rates other than the ones below. Do not share internal numbers (GMV, margins). Link only to the brief or campaign links below.');
  }
  lines.push('Replace [brand] in any guidance with the brand name.');
  if (opts.json) {
    const intents = (opts.intents ?? []).map((i) => `${i.key}${i.escalates ? ' (human)' : ''}`).join(', ');
    lines.push('', 'Answer with one JSON object and nothing else:', '{"needs_reply": true|false, "intent": "<one of: ' + intents + '>", "escalate": true|false, "escalation": "<why a human must take over, or null>", "confidence": 0..1, "reply": "<the reply text, or null when needs_reply is false>"}',
      'needs_reply is false for thanks, emojis, reactions, "ok", automatic cards or anything that does not ask or expect something. escalate is true for intents marked (human), for anger or legal threats, for anything about money or terms you cannot confirm from the facts below, and when confidence is under 0.6.');
  } else {
    lines.push('Output only the reply text, nothing else.');
  }
  lines.push('', '## Guidance from the context library');
  if (!ctx.library.length) lines.push('(none yet)');
  for (const e of ctx.library) lines.push(`### ${e.title}\n${e.body.replace(/\[brand\]/g, brand)}`);
  if (!cs) {
    lines.push('', '## Commission and programme');
    lines.push(`- Commission: ${ctx.commission.pct !== null ? `${ctx.commission.pct}%` : 'not recorded, do not quote a number'}${ctx.commission.ads_pct !== null ? `; with ads / boosted ${ctx.commission.ads_pct}%` : ''}${ctx.commission.note ? `. ${ctx.commission.note}` : ''}`);
    lines.push(`- Creator brief: ${ctx.brief_link ?? 'no brief link recorded'}`);
    if (ctx.creator) lines.push(`- This creator in our CRM: @${ctx.creator.handle}, ${ctx.creator.followers ?? '?'} followers, ${ctx.creator.videos ?? 0} videos for us, GMV for us ${ctx.creator.gmv_for_us ?? 0}${ctx.creator.showcasing ? ', has our product in their showcase' : ''}${ctx.creator.last_post ? `, last post ${ctx.creator.last_post.slice(0, 10)}` : ''}${ctx.creator.tags.length ? `, tags: ${ctx.creator.tags.join(', ')}` : ''}`);
    if (ctx.samples.length) { lines.push('', '## Their sample requests'); for (const s of ctx.samples) lines.push(`- ${s.product}: ${s.status}${s.requested ? `, requested ${s.requested.slice(0, 10)}` : ''}${s.approved ? `, approved ${s.approved.slice(0, 10)}` : ''}${s.received ? `, received ${s.received.slice(0, 10)}` : ''}`); }
    if (ctx.campaigns.length) { lines.push('', '## Live campaigns they can join'); for (const k of ctx.campaigns) lines.push(`- ${k.title} (${k.type}${k.ends ? `, until ${k.ends.slice(0, 10)}` : ''})${k.link ? `: ${k.link}` : ''}`); }
    if (ctx.outreach_logs.length) { lines.push('', '## Automated messages we already sent them (Cruva)'); for (const l of ctx.outreach_logs.slice(0, 8)) lines.push(`- ${l.when.slice(0, 10)} ${l.campaign} via ${l.channel}: ${l.status}`); }
  }
  if (ctx.promotions.length) { lines.push('', '## Promotions for this shop'); for (const p of ctx.promotions) lines.push(`- ${p.name}: ${p.discount}, ${p.period} (${p.status})`); }
  if (ctx.products.length) { lines.push('', `## Products${cs ? '' : ' (what they can promote)'}`); for (const p of ctx.products.slice(0, 40)) lines.push(`- ${p.title}${p.price !== null && p.price !== undefined ? ` at ${money(p.price, p.currency)}` : ''}${p.stock !== null && p.stock !== undefined ? ` (${p.stock} in stock)` : ''}${p.status ? ` [${p.status}]` : ''}`); }
  if (cs) {
    lines.push('', '## This buyer\'s orders on the shop');
    if (!ctx.orders.length) lines.push('(no order matched this buyer; ask for the order number before stating anything)');
    for (const o of ctx.orders) lines.push(`- Order ${o.id}: ${o.status}, placed ${o.created}${o.shipped ? `, shipped ${o.shipped}` : ''}${o.delivered ? `, delivered ${o.delivered}` : ''}${!o.shipped && o.ship_by ? `, ships by ${o.ship_by}` : ''}${o.carrier ? `, carrier ${o.carrier}` : ''}${o.total !== null ? `, ${money(o.total, o.currency)}` : ''}; items: ${o.items.join(', ')}`);
    if (ctx.returns.length) { lines.push('', '## Returns and refunds on those orders'); for (const r of ctx.returns) lines.push(`- Return ${r.id} on order ${r.order_id ?? '?'}: ${r.status}${r.type ? ` (${r.type})` : ''}${r.refund !== null ? `, refund ${r.refund}` : ''}${r.next_action ? `, our next step: ${r.next_action}` : ''}`); }
  }
  if (ctx.cruva_outreach.length) { lines.push('', '## Earlier outreach notes for this creator'); for (const o of ctx.cruva_outreach) lines.push(`- ${o.when ? o.when.slice(0, 10) + ': ' : ''}${o.summary}`); }
  if (ctx.history.length) { lines.push('', '## Earlier conversations with this person'); for (const h of ctx.history.slice(-15)) lines.push(`- [${h.when.slice(0, 10)}] ${h.who}: ${h.text}`); }
  if (ctx.notes.length) { lines.push('', '## Gaps in what you know'); for (const n of ctx.notes) lines.push(`- ${n}`); }
  const thread = messages
    .filter((m) => m.text || m.type !== 'TEXT')
    .slice(-25)
    .map((m) => `[${m.created_at.slice(0, 16).replace('T', ' ')}] ${m.sender_role === 'us' ? 'SHOP' : m.sender_role === 'them' ? (cs ? 'BUYER' : 'CREATOR') : 'SYSTEM'}${m.sender_name ? ` (${m.sender_name})` : ''}: ${m.text ?? `<${m.type.toLowerCase()}>`}`)
    .join('\n');
  return { system: lines.join('\n'), user: `Conversation so far:\n${thread || '(no messages)'}\n\n${opts.json ? 'Classify the last message from them and write the shop\'s next reply as the JSON object.' : "Write the shop's next reply."}` };
}
