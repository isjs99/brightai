import type { Queries } from '../db/queries.js';
import type { BdContact, BdProspect, BulkDraftStatus } from '../sweep/types.js';
import { titleScore } from './apollo.js';
import { bodyToHtml } from './outreach.js';
import { generateDraft, type DraftOpts } from './draft.js';
import type { GmailClient } from './gmail.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Bulk cold outreach: one email per prospect to its most senior, most relevant decision maker,
 * saved straight into Gmail drafts so Isaac can send a batch from his inbox.
 */

/** The contact most likely to own the TikTok Shop decision: highest title score, ties to verified Apollo contacts and people who have not been emailed yet. */
export function pickBestContact(p: Pick<BdProspect, 'market' | 'contacts'>, opts: { emailedIds?: Set<number> } = {}): BdContact | null {
  const withEmail = p.contacts.filter((c) => c.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email));
  if (!withEmail.length) return null;
  const score = (c: BdContact) => titleScore(c.title, p.market) + (c.source === 'apollo' && c.enriched ? 3 : 0) + (opts.emailedIds?.has(c.id) ? -100 : 0) + (/noreply|no-reply|info@|hello@|contact@|support@/i.test(c.email ?? '') ? -20 : 0);
  return [...withEmail].sort((a, b) => score(b) - score(a) || a.id - b.id)[0] ?? null;
}

/** The contact to connect with on LinkedIn: highest title score among those with a profile URL, people already in the sequence last. */
export function pickBestLinkedin(p: Pick<BdProspect, 'market' | 'contacts'>): BdContact | null {
  const withUrl = p.contacts.filter((c) => c.linkedin_url && /linkedin\.com\//i.test(c.linkedin_url));
  if (!withUrl.length) return null;
  const score = (c: BdContact) => titleScore(c.title, p.market) + (c.linkedin_status !== 'none' ? -100 : 0) + (c.email ? 2 : 0);
  return [...withUrl].sort((a, b) => score(b) - score(a) || a.id - b.id)[0] ?? null;
}

export interface BulkDraftSelection {
  ids?: number[];
  market?: string | null;
  limit?: number;
  /** Include prospects that already have an open cold draft or a sent email (default false). */
  include_drafted?: boolean;
}

/** Prospects that are worth a cold email now: not clients, not won or lost, an emailable contact, and no email drafted or sent yet. */
export function bulkCandidates(q: Queries, sel: BulkDraftSelection = {}): { prospect: BdProspect; contact: BdContact }[] {
  const drafts = q.listDrafts({ includeDiscarded: false });
  const drafted = new Set(drafts.filter((d) => d.kind === 'cold').map((d) => d.prospect_id));
  const emailed = new Set(drafts.filter((d) => d.status === 'sent' && d.contact_id).map((d) => d.contact_id as number));
  const wanted = sel.ids ? new Set(sel.ids) : null;
  const out: { prospect: BdProspect; contact: BdContact }[] = [];
  for (const p of q.listProspects(false)) {
    if (wanted && !wanted.has(p.id)) continue;
    if (p.is_client || p.status === 'won' || p.status === 'lost' || p.archived) continue;
    if (sel.market && p.market !== sel.market) continue;
    if (!sel.include_drafted && (drafted.has(p.id) || p.outreach_gmail)) continue;
    const contact = pickBestContact(p, { emailedIds: emailed });
    if (!contact) continue;
    out.push({ prospect: p, contact });
  }
  out.sort((a, b) => (b.prospect.rise_score ?? 0) - (a.prospect.rise_score ?? 0) || (b.prospect.gmv_7d ?? 0) - (a.prospect.gmv_7d ?? 0));
  return sel.limit ? out.slice(0, sel.limit) : out;
}

export class BulkDraftJob {
  private status: BulkDraftStatus = { running: false, total: 0, done: 0, drafted: 0, gmail: 0, skipped: 0, current: null, errors: [], started_at: null, finished_at: null, to_gmail: false };
  private stopRequested = false;

  constructor(private q: Queries, private gmail: GmailClient, private generate: typeof generateDraft = generateDraft) {}

  get state(): BulkDraftStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  start(sel: BulkDraftSelection, opts: DraftOpts & { to_gmail: boolean; actor: string | null }): BulkDraftStatus {
    if (this.status.running) return this.state;
    const items = bulkCandidates(this.q, sel);
    this.status = { running: items.length > 0, total: items.length, done: 0, drafted: 0, gmail: 0, skipped: 0, current: null, errors: [], started_at: new Date().toISOString(), finished_at: items.length ? null : new Date().toISOString(), to_gmail: opts.to_gmail && this.gmail.connected };
    this.stopRequested = false;
    if (items.length) void this.run(items, opts);
    return this.state;
  }

  stop(): void {
    this.stopRequested = true;
  }

  private async run(items: { prospect: BdProspect; contact: BdContact }[], opts: DraftOpts & { to_gmail: boolean; actor: string | null }): Promise<void> {
    for (const { prospect, contact } of items) {
      if (this.stopRequested) break;
      this.status.current = prospect.brand ?? prospect.shop_name;
      liveEvents.emitUpdate({ kind: 'bd' });
      try {
        const g = await this.generate(this.q, prospect.id, contact, opts);
        const draft = this.q.createDraft({ prospect_id: prospect.id, contact_id: contact.id, to_name: contact.name, to_email: contact.email!, subject: g.subject, body: g.body, language: opts.language, style: opts.style, generator: g.generator, created_by: opts.actor });
        this.status.drafted += 1;
        if (this.status.to_gmail) {
          try {
            const r = await this.gmail.createDraft({ to: draft.to_email, toName: draft.to_name, subject: draft.subject, body: draft.body, html: bodyToHtml(draft.body) });
            this.q.updateDraft(draft.id, { status: 'gmail', gmail_draft_id: r.draft_id, gmail_message_id: r.message_id, gmail_url: r.url });
            this.status.gmail += 1;
            this.q.logOutreach(prospect.id, { channel: 'gmail', action: 'note', note: `Bulk draft "${g.subject}" to ${contact.name} saved to Gmail`, contact_name: contact.name, actor: opts.actor });
          } catch (err) {
            this.status.errors.push(`${this.status.current}: Gmail: ${(err as Error).message}`);
            this.q.logOutreach(prospect.id, { channel: 'gmail', action: 'note', note: `Bulk draft "${g.subject}" to ${contact.name} (Gmail save failed)`, contact_name: contact.name, actor: opts.actor });
          }
        } else {
          this.q.logOutreach(prospect.id, { channel: 'gmail', action: 'note', note: `Bulk draft "${g.subject}" to ${contact.name}`, contact_name: contact.name, actor: opts.actor });
        }
      } catch (err) {
        this.status.skipped += 1;
        this.status.errors.push(`${this.status.current}: ${(err as Error).message}`);
      }
      this.status.done += 1;
    }
    this.status.running = false;
    this.status.current = null;
    this.status.finished_at = new Date().toISOString();
    log.info(`Bulk drafts: ${this.status.drafted} drafted, ${this.status.gmail} in Gmail, ${this.status.errors.length} error(s)`);
    liveEvents.emitUpdate({ kind: 'bd' });
  }
}
