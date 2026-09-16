import type { Queries } from '../db/queries.js';
import type { BdContact, BdEmailDraft, BdProspect, OutreachExample } from '../sweep/types.js';
import { riseBand } from './score.js';

/**
 * Cold-email drafting for BD prospects. The model writes as Isaac, from his real sent emails
 * (voice) and the pitch block (facts), tailored to what FastMoss shows for the shop. Without an
 * Anthropic key the template path fills Isaac's intro structure with the same tailoring.
 */

export const MARKET_NAMES: Record<string, string> = { DE: 'Germany', UK: 'UK', FR: 'France', IT: 'Italy', ES: 'Spain', IE: 'Ireland', NL: 'Netherlands', BE: 'Belgium', PL: 'Poland', AT: 'Austria', SE: 'Sweden' };
export const LANGUAGES: Record<string, string> = { en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' };

export interface DraftRequest {
  prospect: BdProspect;
  contact: Pick<BdContact, 'name' | 'title' | 'email'>;
  language: string;
  style: 'short' | 'intro';
  instructions?: string | null;
  examples: OutreachExample[];
  pitch: string;
  senderName: string;
  senderTitle: string;
  bookingUrl: string;
  previousDrafts?: Pick<BdEmailDraft, 'subject' | 'status' | 'created_at'>[];
}

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

export function money(n: number | null | undefined, currency: string): string {
  if (n === null || n === undefined) return 'n/a';
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : `${currency} `;
  return `${sym}${Math.round(n).toLocaleString('en-GB')}`;
}

/** The facts the writer may use about the shop, in prose bullets. */
export function prospectFacts(p: BdProspect): string[] {
  const facts: string[] = [];
  facts.push(`Shop: ${p.shop_name}${p.brand && p.brand.toLowerCase() !== p.shop_name.toLowerCase() ? ` (brand: ${p.brand})` : ''} on TikTok Shop ${MARKET_NAMES[p.market] ?? p.market}${p.shop_type === 'cross_border' ? ', selling cross-border' : ''}`);
  if (p.category) facts.push(`Category: ${p.category}`);
  if (p.gmv_7d !== null) facts.push(`GMV last 7 days: ${money(p.gmv_7d, p.currency)}${p.units_7d ? ` (${p.units_7d.toLocaleString('en-GB')} units)` : ''}`);
  if (p.gmv_total !== null) facts.push(`GMV lifetime: ${money(p.gmv_total, p.currency)}`);
  const band = riseBand(p.rise_score);
  if (p.rise_score !== null) facts.push(`Momentum: ${band} (${Math.round(p.rise_score * 100)}% of lifetime GMV came in the last 7 days)`);
  if (p.new_shop_30d && p.launched_at) facts.push(`Shop created ${p.launched_at} (launched in the last 30 days)`);
  else if (p.launched_at) facts.push(`Shop created ${p.launched_at}`);
  if (p.gmv_started_30d) facts.push(p.gmv_started_at ? `First sales ${p.gmv_started_at}, so they only just started selling` : `Sales only started in roughly the last ${p.age_estimate_days ?? 30} days (estimated from the run-rate)`);
  if (p.products) facts.push(`${p.products} active products${p.rating ? `, shop rating ${p.rating}` : ''}`);
  if (p.tiktok_handle) facts.push(`TikTok handle @${p.tiktok_handle}`);
  if (p.website || p.domain) facts.push(`Website: ${p.website ?? p.domain}`);
  if (p.notes && !p.notes.startsWith('Existing client')) facts.push(`Notes from the team: ${p.notes}`);
  return facts;
}

export function outreachHistory(p: BdProspect): string[] {
  const lines: string[] = [];
  if (p.outreach_linkedin) lines.push(`LinkedIn: contacted${p.outreach_linkedin_at ? ` on ${p.outreach_linkedin_at.slice(0, 10)}` : ''}`);
  if (p.outreach_tts_am) lines.push(`TikTok Shop AM intro: done${p.outreach_tts_am_at ? ` on ${p.outreach_tts_am_at.slice(0, 10)}` : ''}`);
  if (p.outreach_gmail) lines.push(`Email: already sent once${p.outreach_gmail_at ? ` on ${p.outreach_gmail_at.slice(0, 10)}` : ''} (this is a follow-up)`);
  for (const e of p.outreach_log.slice(0, 8)) if (e.note) lines.push(`${e.created_at.slice(0, 10)} ${e.channel ?? e.action}: ${e.note}${e.contact_name ? ` (${e.contact_name})` : ''}`);
  return lines;
}

export function renderOutreachPrompt(r: DraftRequest): { system: string; user: string } {
  const lang = LANGUAGES[r.language] ?? r.language;
  const sys: string[] = [];
  sys.push(`You draft outreach emails on behalf of ${r.senderName}, ${r.senderTitle}, a TikTok Shop Partner agency. You write exactly as he writes; the examples below are emails he actually sent.`);
  sys.push('Voice: warm but direct, short sentences, British English, no hype words, no exclamation marks, no "I hope this finds you well" fluff beyond his usual one-line opener. Opens "Hi <first name>," and signs off "Very best,\\n' + firstName(r.senderName) + '". He uses *Who we are* / *Credentials* / *What we do* headers with "- " bullets when giving a full introduction, and a plain three-to-five sentence note when the ask is small.');
  sys.push('Tailor the first lines to the prospect: name the shop, the market and what the numbers show (momentum, a recent launch, category). Numbers about the prospect must come from the facts given; never invent them. Claims about Brightform must come from the pitch block; never invent awards, clients or numbers.');
  sys.push('Do not reuse dated specifics from the examples (travel dates, city visits, names). Do not mention FastMoss or that the data was pulled from a tool; phrase it as "we track" or "we noticed".');
  sys.push(`Write the email in ${lang}. Keep the subject under 60 characters; his subjects are plain, e.g. "<Brand> x TikTok Shop <Market>" or a concrete hook.`);
  sys.push(r.style === 'intro' ? 'Style requested: full introduction. After the tailored opener, include the *Who we are* / *Credentials* / *What we do* blocks from the pitch (you may trim bullets that do not fit the prospect), then one clear call to action offering a call.' : 'Style requested: short note. 90 to 160 words, no bullet blocks; pick the two or three pitch facts that matter most for this shop and end with one clear call to action offering a quick call.');
  if (r.bookingUrl) sys.push(`When offering a call you may include his booking link once: ${r.bookingUrl}`);
  sys.push('Output JSON only, no prose around it: {"subject": "...", "body": "..."}. The body is plain text: blank lines between paragraphs, bullets as "- ", headers wrapped in single asterisks like *Credentials*.');
  sys.push('', '## Pitch block (the only source of Brightform claims)', r.pitch);
  if (r.examples.length) {
    sys.push('', '## Emails he sent before (voice samples)');
    for (const e of r.examples.slice(0, 8)) sys.push(`### ${e.subject} (${e.kind}${e.to_domain ? `, to ${e.to_domain}` : ''})\n${e.body}`);
  }

  const u: string[] = [];
  u.push(`## Recipient\n${r.contact.name}${r.contact.title ? `, ${r.contact.title}` : ''}${r.contact.email ? ` <${r.contact.email}>` : ''}`);
  u.push('', '## The prospect (facts you may use)');
  for (const f of prospectFacts(r.prospect)) u.push(`- ${f}`);
  const hist = outreachHistory(r.prospect);
  if (hist.length) {
    u.push('', '## What we have already done with this prospect');
    for (const h of hist) u.push(`- ${h}`);
  }
  if (r.previousDrafts?.length) {
    u.push('', '## Earlier emails drafted to this company');
    for (const d of r.previousDrafts.slice(0, 5)) u.push(`- ${d.created_at.slice(0, 10)} "${d.subject}" (${d.status})`);
  }
  if (r.instructions?.trim()) u.push('', '## Extra instructions from Isaac', r.instructions.trim());
  u.push('', `Write the ${r.style === 'intro' ? 'full introduction' : 'short note'} now as JSON.`);
  return { system: sys.join('\n'), user: u.join('\n') };
}

/** Pull {subject, body} out of the model output, tolerating text around the JSON. */
export function parseDraftJson(text: string): { subject: string; body: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(text.slice(start, end + 1)) as { subject?: unknown; body?: unknown };
      const subject = String(j.subject ?? '').trim();
      const body = String(j.body ?? '').replace(/\r\n/g, '\n').trim();
      if (subject && body) return { subject, body };
    } catch {
      /* fall through */
    }
  }
  // Model wrote "Subject: ...\n\n<body>" instead.
  const m = text.match(/^\s*Subject:\s*(.+)\n+([\s\S]+)$/i);
  if (m) return { subject: m[1].trim(), body: m[2].trim() };
  throw new Error('The draft came back in an unexpected shape. Try again.');
}

/** One tailored opener sentence from the FastMoss facts, in Isaac's register. */
export function tailoredOpener(p: BdProspect): string {
  const market = MARKET_NAMES[p.market] ?? p.market;
  const band = riseBand(p.rise_score);
  if (p.new_shop_30d) return `We track every TikTok Shop launch in ${market}, and ${p.shop_name} caught my eye: live for less than a month and already at ${money(p.gmv_7d, p.currency)} a week${p.category ? ` in ${p.category}` : ''}.`;
  if (p.gmv_started_30d) return `${p.shop_name} has only just started selling on TikTok Shop ${market} and is already doing ${money(p.gmv_7d, p.currency)} a week${p.category ? ` in ${p.category}` : ''}, which is a strong start.`;
  if (band === 'surging') return `${p.shop_name} is one of the fastest-rising shops on TikTok Shop ${market} right now: ${money(p.gmv_7d, p.currency)} in the last seven days, about ${Math.round((p.rise_score ?? 0) * 100)}% of everything the shop has sold to date.`;
  if (band === 'rising') return `${p.shop_name} is climbing on TikTok Shop ${market}, with ${money(p.gmv_7d, p.currency)} in the last seven days${p.category ? ` in ${p.category}` : ''}.`;
  return `We work with a number of ${p.category ? `${p.category.toLowerCase()} ` : ''}brands on TikTok Shop ${market}, and ${p.shop_name}${p.gmv_7d ? ` (around ${money(p.gmv_7d, p.currency)} a week)` : ''} looks like a shop we could grow.`;
}

/** No-model fallback: Isaac's intro structure with a tailored opener. */
export function templateDraft(r: DraftRequest): { subject: string; body: string } {
  const p = r.prospect;
  const market = MARKET_NAMES[p.market] ?? p.market;
  const brand = p.brand && p.brand.toLowerCase() !== p.shop_name.toLowerCase() ? p.brand : p.shop_name;
  const subject = `${brand} x TikTok Shop ${market}`;
  const cta = r.bookingUrl ? `Would you be open to a quick call to see whether there's a fit? Grab a slot here: ${r.bookingUrl}` : `Let me know if you'd like to hop on a quick call to see whether there's a fit.`;
  const parts = [`Hi ${firstName(r.contact.name)},`, '', tailoredOpener(p), ''];
  if (r.style === 'intro') {
    parts.push('To give you an introduction to Brightform:', '', r.pitch.trim(), '');
  } else {
    parts.push(`I run Brightform, the #1 TikTok Shop Partner in Germany and the EU by GMV, with 42 shops under management across DE, FR, IT, ES and the UK. We run affiliate and creator programmes at scale, live commerce from our own studio and GMV Max, and act as Merchant of Record for brands without a local entity.`, '');
  }
  parts.push(cta, '', 'Very best,', firstName(r.senderName));
  return { subject, body: parts.join('\n') };
}

/** Settings and examples needed for a draft, read from the database. */
export function outreachInputs(q: Queries): { examples: OutreachExample[]; pitch: string; senderName: string; senderTitle: string; bookingUrl: string } {
  return {
    examples: q.listExamples(true),
    pitch: q.getSetting('outreach_pitch', ''),
    senderName: q.getSetting('outreach_sender_name', 'Isaac Sinclair'),
    senderTitle: q.getSetting('outreach_sender_title', 'Co-Founder/CEO, Brightform'),
    bookingUrl: q.getSetting('outreach_booking_url', ''),
  };
}
