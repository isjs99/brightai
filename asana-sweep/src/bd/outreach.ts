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

const NAME_SUFFIXES = /\b(uk|de|fr|it|es|eu|shop|store|official|oficial|deutschland|germany|france|italia|italy|españa|espana|spain|europe|ltd|srl|s\.r\.l|gmbh|sas|sl|onlineshop|online|tts|direct)\b/gi;

/** The name we use for the company in copy: the brand when set, else the shop name cleaned of handle-style dots and market suffixes ("ulefone.fr" -> "Ulefone"). */
export function brandDisplayName(p: Pick<BdProspect, 'shop_name' | 'brand'>): string {
  const raw = (p.brand?.trim() || p.shop_name).trim();
  let s = raw.replace(/[._]+/g, ' ').replace(NAME_SUFFIXES, '').replace(/[-–]+$/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 3) s = raw;
  // Handle-style shop names (all lower case, e.g. "ulefone.fr") read badly in an email; title-case them. A brand set explicitly keeps its casing ("medicube", "VEVOR").
  if (!p.brand?.trim() && s === s.toLowerCase()) s = s.replace(/\b\w/g, (c) => c.toUpperCase());
  return s;
}

export function money(n: number | null | undefined, currency: string): string {
  if (n === null || n === undefined) return 'n/a';
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : `${currency} `;
  return `${sym}${Math.round(n).toLocaleString('en-GB')}`;
}

/** The facts the writer may use about the shop, in prose bullets. */
export function prospectFacts(p: BdProspect): string[] {
  const facts: string[] = [];
  const brand = brandDisplayName(p);
  facts.push(`Company / brand: ${brand} (TikTok Shop name "${p.shop_name}"; refer to them as ${brand}, never by the shop handle) on TikTok Shop ${MARKET_NAMES[p.market] ?? p.market}${p.shop_type === 'cross_border' ? ', selling cross-border' : ''}`);
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
  const brand = brandDisplayName(r.prospect);
  const sys: string[] = [];
  sys.push(`You draft outreach emails on behalf of ${r.senderName}, ${r.senderTitle}, a TikTok Shop Partner agency. You write exactly as he writes; the examples below are emails he actually sent.`);
  sys.push('Voice: warm but direct, short sentences, British English, no hype words, no exclamation marks. Opens "Hi <first name>," and signs off "Very best,\\n' + firstName(r.senderName) + '".');
  sys.push('Impact first. The first sentence is about them, with the one number or signal that matters most (momentum, a fresh launch, a category they lead). Then the two or three Brightform facts most relevant to that shop, nothing else. Then one clear ask for a call. Cut everything that does not earn its place: no throat-clearing, no "I hope you are well", no restating what they already know.');
  sys.push(`Call the company "${brand}". Never use the TikTok Shop handle or shop name in the subject or body. Numbers about the prospect must come from the facts given; never invent them. Claims about Brightform must come from the pitch block; never invent awards, clients or numbers.`);
  sys.push('Do not reuse dated specifics from the examples (travel dates, city visits, names). Do not mention FastMoss or that the data was pulled from a tool; phrase it as "we track" or "we noticed".');
  sys.push(`Write the email in ${lang}. Subject under 50 characters, plain, e.g. "${brand} x TikTok Shop <Market>" or a concrete hook.`);
  sys.push(r.style === 'intro' ? 'Shape requested: introduction. Under 140 words. After the opener, at most three short bullet points with the strongest proof (each bullet one line), then the ask. A bullet block may have a heading line that ends with a colon, e.g. "Why Brightform:".' : 'Shape requested: short note. 60 to 100 words, no bullets, three or four sentences plus the ask.');
  if (r.bookingUrl) sys.push(`When offering a call you may include his booking link once, on its own line: ${r.bookingUrl}`);
  sys.push('Formatting: plain text only. No markdown, no asterisks, no underscores, no hashes. Bullets start with "- ". A heading is a short line ending with a colon. Blank line between paragraphs. The email is rendered with real bold for headings when it reaches Gmail.');
  sys.push('Output JSON only, no prose around it: {"subject": "...", "body": "..."}.');
  sys.push('', '## Pitch block (the only source of Brightform claims; pick the few that fit this shop)', r.pitch);
  if (r.examples.length) {
    sys.push('', '## Emails he sent before (voice samples; match the tone, not the length)');
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
  u.push('', `Write the ${r.style === 'intro' ? 'introduction' : 'short note'} to ${brand} now as JSON.`);
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
  const brand = brandDisplayName(p);
  const band = riseBand(p.rise_score);
  if (p.new_shop_30d) return `${brand} has been live on TikTok Shop ${market} for under a month and is already at ${money(p.gmv_7d, p.currency)} a week${p.category ? ` in ${p.category}` : ''}. That is a strong start.`;
  if (p.gmv_started_30d) return `${brand} only just started selling on TikTok Shop ${market} and is already doing ${money(p.gmv_7d, p.currency)} a week${p.category ? ` in ${p.category}` : ''}.`;
  if (band === 'surging') return `${brand} is one of the fastest-rising shops on TikTok Shop ${market} right now: ${money(p.gmv_7d, p.currency)} in the last seven days, about ${Math.round((p.rise_score ?? 0) * 100)}% of everything the shop has sold to date.`;
  if (band === 'rising') return `${brand} is climbing on TikTok Shop ${market}: ${money(p.gmv_7d, p.currency)} in the last seven days${p.category ? ` in ${p.category}` : ''}.`;
  return `We run a number of ${p.category ? `${p.category.toLowerCase()} ` : ''}brands on TikTok Shop ${market} and ${brand}${p.gmv_7d ? ` (around ${money(p.gmv_7d, p.currency)} a week)` : ''} looks like a shop we could grow.`;
}

/** The three proof points that matter most for a shop, from the pitch block's known facts. */
export function proofPoints(p: BdProspect): string[] {
  const out = ['#1 TikTok Shop Partner in Germany and the EU by GMV for 6 consecutive months, 42 shops under management'];
  out.push(p.shop_type === 'cross_border' ? 'Merchant of Record for brands without a local entity: logistics, invoicing and VAT handled by us' : 'Affiliate and creator programmes at scale, plus live commerce from our own studio');
  out.push(/beauty|personal care|health|food|beverage|fmcg/i.test(p.category ?? '') ? '2 of 3 FMCG ACE Awards and 1 of 3 Beauty ACE Awards, Q2 Germany' : "TikTok's Best GMV Max Campaign award and FastMoss Agency of the Year 2025");
  return out;
}

/** No-model fallback: a condensed note in Isaac's structure with a tailored opener. */
export function templateDraft(r: DraftRequest): { subject: string; body: string } {
  const p = r.prospect;
  const market = MARKET_NAMES[p.market] ?? p.market;
  const brand = brandDisplayName(p);
  const subject = `${brand} x TikTok Shop ${market}`;
  const cta = r.bookingUrl ? `Worth 20 minutes on a call? Grab a slot here:\n${r.bookingUrl}` : `Worth 20 minutes on a call to see whether there is a fit?`;
  const parts = [`Hi ${firstName(r.contact.name)},`, '', tailoredOpener(p), ''];
  if (r.style === 'intro') {
    parts.push(`I run Brightform, a TikTok Shop Partner agency across DE, UK, FR, IT and ES. Why us:`, ...proofPoints(p).map((x) => `- ${x}`), '');
  } else {
    parts.push(`I run Brightform, the #1 TikTok Shop Partner in Germany and the EU by GMV, with 42 shops under management. We take shops like ${brand} from a good start to a scaled affiliate, live and GMV Max engine.`, '');
  }
  parts.push(cta, '', 'Very best,', firstName(r.senderName));
  return { subject, body: parts.join('\n') };
}

/** Plain-text email body -> HTML for Gmail: paragraphs, "- " bullets, short "Heading:" lines in bold, links clickable. */
export function bodyToHtml(body: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linkify = (t: string) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  const isHeading = (line: string) => /^[^.!?]{2,48}:$/.test(line.trim());
  const blocks = body.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  const html: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let i = 0;
    while (i < lines.length) {
      if (/^\s*[-•]\s+/.test(lines[i])) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-•]\s+/.test(lines[i])) items.push(`<li>${linkify(lines[i].replace(/^\s*[-•]\s+/, ''))}</li>`), i += 1;
        html.push(`<ul style="margin:0 0 12px 20px;padding:0">${items.join('')}</ul>`);
        continue;
      }
      const para: string[] = [];
      while (i < lines.length && !/^\s*[-•]\s+/.test(lines[i])) para.push(isHeading(lines[i]) ? `<b>${esc(lines[i].trim())}</b>` : linkify(lines[i])), i += 1;
      html.push(`<p style="margin:0 0 12px">${para.join('<br>')}</p>`);
    }
  }
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#111">${html.join('')}</div>`;
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
