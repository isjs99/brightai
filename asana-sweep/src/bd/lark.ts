import type { Queries } from '../db/queries.js';
import type { BdProspect, LarkMessage, LarkDraftStatus, TtsContact } from '../sweep/types.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { brandDisplayName, firstName, MARKET_NAMES, outreachInputs } from './outreach.js';
import { suggestTtsContact } from './sequence.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Lark messages to TikTok Shop: for each prospect, a short DM to the TikTok AM we know is on that account, or,
 * when we do not know for sure, to the TSP (agency partnerships) manager for the market. Every draft carries
 * the facts it was written from so the sender can check it is true before it goes. Lark has no API we can send
 * through, so the dashboard copies the message, opens the person's Lark link, and the sender pastes and sends.
 * Drafts are scheduled across days ("5 a day from Monday") and the due ones are listed each morning.
 */

export interface LarkRecipient { contact: TtsContact | null; confidence: LarkMessage['confidence']; reason: string }

/** Who gets the message: the AM recorded on the prospect ("known for sure"), else the market's TSP manager. */
export function pickLarkRecipient(q: Queries, prospect: BdProspect): LarkRecipient {
  const contacts = q.listTtsContacts();
  if (prospect.tts_am_contact_id) {
    const c = contacts.find((x) => x.id === prospect.tts_am_contact_id) ?? null;
    if (c) return { contact: c, confidence: 'known', reason: `Recorded as the TikTok AM on ${brandDisplayName(prospect)}` };
  }
  const s = suggestTtsContact(contacts, prospect);
  const market = MARKET_NAMES[prospect.market] ?? prospect.market;
  if (s.fallback) return { contact: s.fallback, confidence: 'tsp', reason: `No AM confirmed on this account${s.contact ? ` (${s.contact.name} owns ${s.contact.category ?? 'the category'} in ${market}, but that is a guess)` : ''}: goes to the TSP manager for ${market}` };
  if (s.contact) return { contact: s.contact, confidence: 'tsp', reason: `No TSP manager on file for ${market}; ${s.contact.name} is the ${s.contact.category ?? 'category'} owner there` };
  return { contact: null, confidence: 'tsp', reason: `No TikTok Shop contacts on file for ${market}` };
}

const money = (n: number | null, currency: string): string => (n === null ? '' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: /^[A-Z]{3}$/.test(currency) ? currency : 'EUR', maximumFractionDigits: 0 }).format(n));

/** The verifiable facts a message may use, in the order a reader would check them. Nothing else goes in the prompt. */
export function larkFacts(p: BdProspect): string[] {
  const facts: string[] = [];
  const brand = brandDisplayName(p);
  facts.push(`Brand: ${brand}${p.brand && p.brand !== p.shop_name ? ` (shop "${p.shop_name}")` : ''}`);
  facts.push(`Market: ${MARKET_NAMES[p.market] ?? p.market}`);
  if (p.category) facts.push(`Category: ${p.category}`);
  if (p.gmv_7d !== null) facts.push(`Last 7 days GMV: ${money(p.gmv_7d, p.currency)} (FastMoss)`);
  if (p.gmv_total !== null) facts.push(`Lifetime GMV: ${money(p.gmv_total, p.currency)}`);
  if (p.rise_score !== null && p.rise_score >= 0.5) facts.push(`Momentum: ${Math.round(p.rise_score * 100)}% of lifetime GMV came in the last 7 days (took off recently)`);
  else if (p.rise_score !== null && p.rise_score >= 0.2) facts.push(`Momentum: ${Math.round(p.rise_score * 100)}% of lifetime GMV in the last 7 days (rising)`);
  if (p.launched_at) facts.push(`Shop created: ${p.launched_at}`);
  if (p.gmv_started_at) facts.push(`First sales: ${p.gmv_started_at}`);
  if (p.products !== null) facts.push(`Products listed: ${p.products}`);
  if (p.rating !== null) facts.push(`Shop rating: ${p.rating}`);
  if (p.company_employees !== null) facts.push(`Company size: about ${p.company_employees} people`);
  if (p.company_location) facts.push(`Company location: ${p.company_location}`);
  const emailed = p.outreach_log.filter((e) => e.channel === 'gmail' && e.action === 'contacted').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (emailed) facts.push(`We emailed ${emailed.contact_name ?? 'a decision maker'} on ${emailed.created_at.slice(0, 10)}`);
  else facts.push('We have not contacted the brand yet');
  if (p.status === 'replied' || p.status === 'meeting') facts.push(`Brand status: ${p.status}`);
  return facts;
}

function templateLark(p: BdProspect, r: LarkRecipient, senderName: string): string {
  const to = r.contact ? firstName(r.contact.name) : 'there';
  const brand = brandDisplayName(p);
  const market = MARKET_NAMES[p.market] ?? p.market;
  const gmv = p.gmv_7d !== null ? ` doing ${money(p.gmv_7d, p.currency)} in the last 7 days` : '';
  const momentum = p.rise_score !== null && p.rise_score >= 0.5 ? ' and only just taken off' : '';
  const ask = r.confidence === 'known' ? `Are they working with a TSP yet? If not, happy for you to intro us or for me to reach out directly, whichever you prefer.` : `Do you know who the AM is on this one, and whether they are with a TSP yet? If not, happy to reach out, or for an intro if that is easier.`;
  return `Hi ${to}, quick one on ${brand} (${market}${p.category ? `, ${p.category}` : ''})${gmv}${momentum}. ${ask}\n\n${firstName(senderName)}`;
}

/** The message, Claude in the sender's voice when configured (template otherwise), always from `larkFacts`. */
export async function generateLarkMessage(q: Queries, prospect: BdProspect, r: LarkRecipient, opts: { instructions?: string | null } = {}): Promise<{ body: string; generator: 'claude' | 'template'; facts: string[] }> {
  const facts = larkFacts(prospect);
  const { senderName, senderTitle } = outreachInputs(q);
  if (!config.anthropicApiKey) return { body: templateLark(prospect, r, senderName), generator: 'template', facts };
  const to = r.contact ? `${r.contact.name}${r.contact.role ? `, ${r.contact.role}` : ''} at TikTok Shop` : 'the TikTok Shop contact';
  const relationship = r.confidence === 'known' ? 'is the TikTok account manager on this brand' : 'is the TSP (agency partnerships) manager for the market and may not personally handle this brand';
  const system = `You write short Lark (chat) messages from ${senderName}, ${senderTitle} at Brightform, a TikTok Shop Partner agency, to people at TikTok Shop. Voice: friendly, direct, British English, no hype, no exclamation marks, no bullet points, no subject line, no sign-off block (just the first name on its own last line). 40 to 80 words. One message, plain text.
Rules: use ONLY the facts given; never invent numbers, dates, names or history. Mention at most two facts. If a fact is not in the list, do not imply it. The ask: if the recipient is the account's AM, ask whether the brand is already working with a TSP and offer to be introduced or to reach out directly; if the recipient is the TSP manager, ask who the AM on the brand is and whether the brand is with a TSP yet, and offer to reach out or take an intro. Output JSON only: {"message": "..."}.`;
  const user = `Recipient: ${to}. The recipient ${relationship}.\nFacts about the brand:\n${facts.map((f) => `- ${f}`).join('\n')}${opts.instructions ? `\nExtra instruction from the sender: ${opts.instructions}` : ''}`;
  try {
    const text = await draftWithClaude(system, user, { maxTokens: 400 });
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : text) as { message?: string };
    const body = String(parsed.message ?? '').trim();
    if (!body) throw new Error('empty message');
    return { body, generator: 'claude', facts };
  } catch (err) {
    log.warn(`Lark draft via Claude failed for ${prospect.shop_name}: ${(err as Error).message}`);
    return { body: templateLark(prospect, r, senderName), generator: 'template', facts };
  }
}

/** Dates for `n` messages at `perDay` a day from `start` (YYYY-MM-DD), skipping weekends when asked. */
export function spreadDates(n: number, perDay: number, start: string, weekdaysOnly: boolean): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const per = Math.max(1, perDay);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (!(weekdaysOnly && (dow === 0 || dow === 6))) for (let i = 0; i < per && out.length < n; i += 1) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** The Lark link to open, when the contact's Lark field is a URL. */
export const larkLink = (c: TtsContact | null): string | null => (c?.lark && /^https?:\/\//i.test(c.lark) ? c.lark : null);

/** Drafts Lark messages for many prospects in the background, one Claude call each. */
export class LarkDraftJob {
  private status: LarkDraftStatus = { running: false, total: 0, done: 0, drafted: 0, skipped: 0, current: null, errors: [], started_at: null, finished_at: null };
  private stopRequested = false;

  constructor(private q: Queries, private generate: typeof generateLarkMessage = generateLarkMessage) {}

  get state(): LarkDraftStatus { return { ...this.status, errors: [...this.status.errors] }; }

  start(ids: number[], opts: { actor: string | null; instructions?: string | null; redo?: boolean }): LarkDraftStatus {
    if (this.status.running) return this.state;
    const existing = new Set(this.q.listLarkMessages().filter((m) => m.status !== 'discarded').map((m) => m.prospect_id));
    const prospects = ids.map((id) => this.q.getProspect(id)).filter((p): p is BdProspect => Boolean(p) && !p!.is_client && (opts.redo || !existing.has(p!.id)));
    this.status = { running: prospects.length > 0, total: prospects.length, done: 0, drafted: 0, skipped: 0, current: null, errors: [], started_at: new Date().toISOString(), finished_at: prospects.length ? null : new Date().toISOString() };
    this.stopRequested = false;
    if (prospects.length) void this.run(prospects, opts);
    return this.state;
  }

  stop(): void { this.stopRequested = true; }

  private async run(prospects: BdProspect[], opts: { actor: string | null; instructions?: string | null }): Promise<void> {
    for (const p of prospects) {
      if (this.stopRequested) break;
      this.status.current = brandDisplayName(p);
      liveEvents.emitUpdate({ kind: 'bd' });
      try {
        const r = pickLarkRecipient(this.q, p);
        if (!r.contact) { this.status.skipped += 1; this.status.errors.push(`${this.status.current}: ${r.reason}`); this.status.done += 1; continue; }
        const g = await this.generate(this.q, p, r, { instructions: opts.instructions });
        this.q.createLarkMessage({ prospect_id: p.id, contact_id: r.contact.id, confidence: r.confidence, reason: r.reason, body: g.body, facts: g.facts, generator: g.generator, created_by: opts.actor });
        this.status.drafted += 1;
      } catch (err) {
        this.status.skipped += 1;
        this.status.errors.push(`${this.status.current}: ${(err as Error).message}`);
      }
      this.status.done += 1;
    }
    this.status.running = false;
    this.status.current = null;
    this.status.finished_at = new Date().toISOString();
    log.info(`Lark drafts: ${this.status.drafted} drafted, ${this.status.skipped} skipped`);
    liveEvents.emitUpdate({ kind: 'bd' });
  }
}
