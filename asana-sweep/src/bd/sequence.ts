import type { Queries } from '../db/queries.js';
import type { BdContact, BdFollowup, BdProspect, TtsContact } from '../sweep/types.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { brandDisplayName, firstName, MARKET_NAMES, outreachInputs, tailoredOpener } from './outreach.js';
import { riseBand } from './score.js';

/**
 * The BD LinkedIn sequence and its reminders. LinkedIn has no public API for connection requests,
 * so the dashboard drives the human: open the profile, log the request, remind to check back,
 * hand over a short message once they accept, and log the send.
 */

export const LINKEDIN_STEPS = ['requested', 'connected', 'messaged'] as const;

export function addDays(days: number, from = Date.now()): string {
  return new Date(from + days * 86400000).toISOString();
}

/** Short LinkedIn message (under 300 characters) in Isaac's voice; Claude when configured, else a template. */
export async function linkedinMessage(q: Queries, prospect: BdProspect, contact: Pick<BdContact, 'name' | 'title'>): Promise<{ text: string; generator: 'claude' | 'template' }> {
  const inputs = outreachInputs(q);
  const brand = brandDisplayName(prospect);
  const market = MARKET_NAMES[prospect.market] ?? prospect.market;
  const opener = tailoredOpener(prospect).replace(/\s+That is a strong start\.$/, '');
  const base = `Thanks for connecting, ${firstName(contact.name)}. ${opener} I run Brightform, the #1 TikTok Shop Partner in the EU by GMV. Worth 20 minutes on a call?`;
  const short = `Thanks for connecting, ${firstName(contact.name)}. ${brand} caught our eye on TikTok Shop ${market}. I run Brightform, the #1 TikTok Shop Partner in the EU by GMV. Worth 20 minutes on a call?`;
  // Keep the whole message under LinkedIn's 300 characters; drop the link, then the long opener, before ever cutting a word.
  const fit = (t: string) => (t.length <= 300 ? t : null);
  const fallback = fit(inputs.bookingUrl ? `${base} ${inputs.bookingUrl}` : base) ?? fit(base) ?? fit(inputs.bookingUrl ? `${short} ${inputs.bookingUrl}` : short) ?? short.slice(0, 300);
  if (!config.anthropicApiKey) return { text: fallback, generator: 'template' };
  const system = [
    `You write LinkedIn messages on behalf of ${inputs.senderName}, ${inputs.senderTitle}, a TikTok Shop Partner agency. Warm, direct, British English, no exclamation marks, no hype.`,
    'This is the first message after the person accepted a connection request. Under 300 characters total. One line thanking them for connecting, one line on why their shop caught our eye (use the fact given), one line on what Brightform is, one clear ask for a short call. No greeting line like "Hi X," needed beyond the first name once. No links unless the booking link is provided, then it may close the message.',
    `Call the company "${brand}". Output the message text only.`,
    '', '## Brightform facts (only source of claims)', inputs.pitch,
  ].join('\n');
  const user = [`Person: ${contact.name}${contact.title ? `, ${contact.title}` : ''}`, `Company: ${brand} on TikTok Shop ${market}`, `Why they caught our eye: ${tailoredOpener(prospect)}`, `Momentum band: ${riseBand(prospect.rise_score)}`, inputs.bookingUrl ? `Booking link: ${inputs.bookingUrl}` : ''].filter(Boolean).join('\n');
  try {
    const text = (await draftWithClaude(system, user, { maxTokens: 300 })).trim();
    return { text: text.length > 320 ? fallback : text, generator: 'claude' };
  } catch {
    return { text: fallback, generator: 'template' };
  }
}

/**
 * Advance a contact through the LinkedIn sequence, logging history, ticking the LinkedIn channel,
 * and creating / closing the reminders that go with each step.
 */
export async function advanceLinkedin(q: Queries, contactId: number, step: (typeof LINKEDIN_STEPS)[number], opts: { actor?: string | null; note?: string | null; checkDays?: number } = {}): Promise<{ contact: BdContact; prospect: BdProspect; followup: BdFollowup | null; message: { text: string; generator: 'claude' | 'template' } | null }> {
  const contact = q.getContact(contactId);
  if (!contact) throw new Error('Contact not found');
  const prospect = q.getProspect(contact.prospect_id)!;
  const actor = opts.actor ?? null;
  const checkDays = opts.checkDays ?? Number(q.getSetting('linkedin_check_days', '3')) ?? 3;
  let followup: BdFollowup | null = null;
  let message: { text: string; generator: 'claude' | 'template' } | null = null;

  if (step === 'requested') {
    const already = contact.linkedin_status !== 'none';
    q.setContactLinkedin(contact.id, 'requested');
    // Log the request once; a repeat click only refreshes the reminder.
    if (!already && !prospect.outreach_linkedin) q.patchProspect(prospect.id, { outreach_linkedin: true, outreach_note: `LinkedIn connection request sent to ${contact.name}${opts.note ? ` (${opts.note})` : ''}`, outreach_contact: contact.name }, actor);
    else if (!already) q.logOutreach(prospect.id, { channel: 'linkedin', action: 'contacted', note: `LinkedIn connection request sent to ${contact.name}${opts.note ? ` (${opts.note})` : ''}`, contact_name: contact.name, actor });
    followup = q.addFollowup({ prospect_id: prospect.id, contact_id: contact.id, kind: 'linkedin_check', title: `Check whether ${contact.name} (${brandDisplayName(prospect)}) accepted the LinkedIn request`, due_at: addDays(checkDays), created_by: actor });
    if (prospect.status === 'new') q.patchProspect(prospect.id, { status: 'contacted' }, actor);
  } else if (step === 'connected') {
    q.setContactLinkedin(contact.id, 'connected');
    q.closeFollowups(contact.id, ['linkedin_check']);
    q.logOutreach(prospect.id, { channel: 'linkedin', action: 'note', note: `${contact.name} accepted the LinkedIn request`, contact_name: contact.name, actor });
    message = await linkedinMessage(q, prospect, contact);
    followup = q.addFollowup({ prospect_id: prospect.id, contact_id: contact.id, kind: 'linkedin_message', title: `Send ${contact.name} (${brandDisplayName(prospect)}) the LinkedIn follow-up message`, due_at: new Date().toISOString(), note: message.text, created_by: actor });
  } else if (step === 'messaged') {
    q.setContactLinkedin(contact.id, 'messaged');
    q.closeFollowups(contact.id, ['linkedin_check', 'linkedin_message']);
    q.logOutreach(prospect.id, { channel: 'linkedin', action: 'contacted', note: `LinkedIn message sent to ${contact.name}${opts.note ? `: ${opts.note.slice(0, 160)}` : ''}`, contact_name: contact.name, actor });
    followup = q.addFollowup({ prospect_id: prospect.id, contact_id: contact.id, kind: 'email_chase', title: `Chase ${contact.name} (${brandDisplayName(prospect)}) if no reply to the LinkedIn message`, due_at: addDays(5), created_by: actor });
  }
  return { contact: q.getContact(contact.id)!, prospect: q.getProspect(prospect.id)!, followup, message };
}

/**
 * Who at TikTok Shop to loop in for a prospect, from the org chart under Outreach emails: the category
 * owner for the market when it is obvious, else the market's multi-category / key account lead, else the
 * TSP manager for the market (the partnerships person who runs the Brightform relationship), else any
 * TSP manager. `tier` says which rule fired so the UI can say why.
 */
/** How likely a counterpart is the right person to loop in: the map's closeness score, seniority, who gives us leads, and a penalty for people Apollo no longer finds. */
export function ttsContactScore(c: TtsContact): number {
  const role = c.role ?? '';
  const n = c.notes ?? '';
  let s = Number(/closeness (\d+)/i.exec(n)?.[1] ?? 0) * 2;
  if (/primary (tsp )?contact/i.test(n)) s += 20;
  if (/gives us (active )?leads/i.test(n)) s += 4;
  if (/\b(head|leiter|director|lead|leader)\b/i.test(role)) s += 9;
  else if (/senior|key account|category manager|owns/i.test(role)) s += 6;
  else if (/junior|graduate|intern|bench/i.test(role)) s += 0;
  else s += 3;
  if (/no apollo record|left tiktok|leaver/i.test(n)) s -= 15;
  return s;
}

const best = (list: TtsContact[]): TtsContact | null => list.reduce<TtsContact | null>((a, b) => (a === null || ttsContactScore(b) > ttsContactScore(a) ? b : a), null);

/**
 * The TikTok Shop AM to loop in for a prospect: the category owner in that market when there is an obvious one,
 * otherwise the TSP (agency partnerships) manager for the market. Never a guess at a random AM.
 */
export function suggestTtsContact(contacts: TtsContact[], prospect: Pick<BdProspect, 'market' | 'category'>): { contact: TtsContact | null; fallback: TtsContact | null; reason: string; tier: 'category' | 'tsp_manager' | 'none' } {
  const market = MARKET_NAMES[prospect.market] ?? prospect.market;
  const inMarket = contacts.filter((c) => c.market === prospect.market);
  const cat = (prospect.category ?? '').toLowerCase();
  const catWords = cat.split(/[^a-z]+/).filter((w) => w.length > 3);
  const catMatch = (c: TtsContact) => { const cc = (c.category ?? '').toLowerCase(); return Boolean(cc && cat && (cat.includes(cc) || cc.includes(cat) || catWords.some((w) => cc.includes(w)) || (/\b(food|beverage|grocer|fmcg|drink|snack|health|supplement)/.test(cat) && /fmcg|food|beverage/.test(cc)))); };
  const owner = best(inMarket.filter((c) => catMatch(c) && !c.is_agency_manager)) ?? best(inMarket.filter(catMatch));
  const manager = best(inMarket.filter((c) => c.is_agency_manager)) ?? best(contacts.filter((c) => c.is_agency_manager && /partnership|TSP|matchmaking/i.test(c.role ?? ''))) ?? best(contacts.filter((c) => c.is_agency_manager));
  if (owner) return { contact: owner, fallback: manager, reason: `${owner.category} owner for ${market}`, tier: 'category' };
  if (manager) return { contact: null, fallback: manager, reason: `No obvious ${prospect.category ?? 'category'} owner in ${market}: go through the TSP manager in Lark`, tier: 'tsp_manager' };
  return { contact: null, fallback: null, reason: `No TikTok Shop contacts on file for ${market} yet`, tier: 'none' };
}
