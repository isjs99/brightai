import type { Queries } from '../db/queries.js';
import type { BdEmailDraft } from '../sweep/types.js';
import { draftWithClaude } from '../inbox/llm.js';
import { bodyToHtml, firstName, outreachInputs, parseDraftJson } from './outreach.js';
import type { GmailClient } from './gmail.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * tl;dv call follow-ups. Every recorded call gets a follow-up email drafted in Isaac's voice from
 * the meeting notes and transcript, addressed to the external attendee, saved as a draft here and
 * (when Gmail is connected) in Gmail. Needs TLDV_API_KEY.
 */

export interface TldvMeeting {
  id: string;
  name: string;
  happenedAt: string;
  url: string | null;
  organizer: { name?: string; email?: string } | null;
  invitees: { name?: string; email?: string }[];
}

export class TldvClient {
  constructor(private apiKey = process.env.TLDV_API_KEY?.trim() ?? '', private baseUrl = 'https://pasta.tldv.io/v1alpha1', private fetchFn: typeof fetch = fetch) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.apiKey) throw new Error('TLDV_API_KEY is not set.');
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { headers: { 'x-api-key': this.apiKey, accept: 'application/json' } });
    const data = (await res.json().catch(() => null)) as T & { message?: string };
    if (!res.ok) throw new Error(`tl;dv ${res.status}: ${(data as { message?: string } | null)?.message ?? res.statusText}`);
    return data;
  }

  async listMeetings(opts: { since?: string; limit?: number } = {}): Promise<TldvMeeting[]> {
    const qs = new URLSearchParams({ limit: String(opts.limit ?? 20), page: '1' });
    if (opts.since) qs.set('from', opts.since);
    const data = await this.get<{ results?: Record<string, unknown>[]; meetings?: Record<string, unknown>[] }>(`/meetings?${qs.toString()}`);
    return (data.results ?? data.meetings ?? []).map((m) => ({
      id: String(m.id),
      name: String(m.name ?? m.title ?? 'Call'),
      happenedAt: String(m.happenedAt ?? m.happened_at ?? m.createdAt ?? ''),
      url: (m.url as string | null) ?? null,
      organizer: (m.organizer as TldvMeeting['organizer']) ?? null,
      invitees: ((m.invitees as TldvMeeting['invitees'] | undefined) ?? []).filter((i) => i && (i.email || i.name)),
    }));
  }

  async transcript(id: string): Promise<string> {
    const data = await this.get<{ data?: { speaker?: string; text?: string }[] }>(`/meetings/${id}/transcript`);
    return (data.data ?? []).map((t) => `${t.speaker ? `${t.speaker}: ` : ''}${t.text ?? ''}`).join('\n');
  }

  async highlights(id: string): Promise<string[]> {
    const data = await this.get<{ data?: { text?: string; topic?: { title?: string; summary?: string } }[] }>(`/meetings/${id}/highlights`);
    return (data.data ?? []).map((h) => [h.topic?.title, h.topic?.summary ?? h.text].filter(Boolean).join(': ')).filter(Boolean);
  }
}

export const tldv = new TldvClient();

const INTERNAL = /@(brightform\.agency|tldv\.io)$/i;

/** The person we write back to: the first attendee outside Brightform. */
export function externalAttendee(m: TldvMeeting): { name: string; email: string } | null {
  const all = [...m.invitees, ...(m.organizer ? [m.organizer] : [])];
  const ext = all.find((a) => a.email && !INTERNAL.test(a.email));
  return ext?.email ? { name: ext.name?.trim() || ext.email.split('@')[0], email: ext.email } : null;
}

export function renderFollowupPrompt(m: TldvMeeting, to: { name: string; email: string }, notes: string[], transcript: string, inputs: ReturnType<typeof outreachInputs>): { system: string; user: string } {
  const system = [
    `You write follow-up emails on behalf of ${inputs.senderName}, ${inputs.senderTitle}, a TikTok Shop Partner agency, after a call he has just had. You write exactly as he writes; the examples are emails he actually sent. Warm, direct, British English, no exclamation marks, no hype. Opens "Hi <first name>," and signs off "Very best,\\n${firstName(inputs.senderName)}".`,
    'Structure: one line of thanks that references something specific from the call, then "What we discussed:" with three to five short bullets of the concrete points and numbers raised, then "Next steps:" with two or three bullets naming who does what by when (only what was actually agreed or offered on the call), then one closing line. Under 180 words. Never invent commitments, prices or dates that were not on the call. Attachments he promised (deck, price card, case studies) can be referenced as "attached" so he can add them.',
    'Formatting: plain text only. No markdown, no asterisks. Bullets start with "- ". Headings are short lines ending with a colon. Blank line between paragraphs.',
    'Output JSON only: {"subject": "...", "body": "..."}. Subject under 60 characters, e.g. "<Company> x Brightform: next steps".',
    '', '## Brightform facts (only source of claims about Brightform)', inputs.pitch,
    ...(inputs.examples.length ? ['', '## Emails he sent before (voice samples)', ...inputs.examples.slice(0, 4).map((e) => `### ${e.subject}\n${e.body}`)] : []),
  ].join('\n');
  const user = [
    `## Call: ${m.name} (${m.happenedAt.slice(0, 10)})`,
    `Write to: ${to.name} <${to.email}>`,
    `Attendees: ${[...m.invitees, ...(m.organizer ? [m.organizer] : [])].map((a) => `${a.name ?? ''} ${a.email ? `<${a.email}>` : ''}`.trim()).filter(Boolean).join(', ')}`,
    ...(notes.length ? ['', '## Notes and highlights', ...notes.map((n) => `- ${n}`)] : []),
    ...(transcript ? ['', '## Transcript (excerpt)', transcript.slice(0, 14000)] : []),
    '', 'Write the follow-up now as JSON.',
  ].join('\n');
  return { system, user };
}

/** Draft follow-ups for calls that ended since the last check. Returns how many drafts were created. */
export async function draftCallFollowups(q: Queries, opts: { gmail?: GmailClient | null; client?: TldvClient; llm?: (system: string, user: string) => Promise<string>; since?: string } = {}): Promise<{ checked: number; drafted: number; errors: string[] }> {
  const client = opts.client ?? tldv;
  const errors: string[] = [];
  if (!client.configured) return { checked: 0, drafted: 0, errors: ['TLDV_API_KEY is not set'] };
  const since = opts.since ?? q.getSetting('tldv_since', '') ?? '';
  let meetings: TldvMeeting[] = [];
  try {
    meetings = await client.listMeetings({ since: since || new Date(Date.now() - 3 * 86400000).toISOString(), limit: 20 });
  } catch (err) {
    q.setSetting('tldv_last_error', (err as Error).message);
    return { checked: 0, drafted: 0, errors: [(err as Error).message] };
  }
  let drafted = 0;
  const llm = opts.llm ?? ((s: string, u: string) => draftWithClaude(s, u, { maxTokens: 1200 }));
  for (const m of meetings.sort((a, b) => a.happenedAt.localeCompare(b.happenedAt))) {
    if (q.draftForMeeting(m.id)) continue;
    const to = externalAttendee(m);
    if (!to) continue;
    try {
      const [notes, transcript] = await Promise.all([client.highlights(m.id).catch(() => [] as string[]), client.transcript(m.id).catch(() => '')]);
      if (!notes.length && !transcript) continue; // recording not processed yet; try again next run
      const inputs = outreachInputs(q);
      const { system, user } = renderFollowupPrompt(m, to, notes, transcript, inputs);
      const { subject, body } = parseDraftJson(await llm(system, user));
      // Attach to a prospect when the attendee's domain matches one, else park it on a synthetic "Calls" prospect row.
      const domain = to.email.split('@')[1]?.toLowerCase() ?? '';
      const prospect = q.listProspects(true).find((p) => p.domain && domain && p.domain.toLowerCase() === domain) ?? q.listProspects(true).find((p) => p.contacts.some((c) => c.email?.toLowerCase() === to.email.toLowerCase()));
      const prospectId = prospect?.id ?? q.createProspect({ shop_name: m.name.slice(0, 80), market: 'UK', source: 'tldv', notes: `Created from the tl;dv call "${m.name}" on ${m.happenedAt.slice(0, 10)}`, domain }).id;
      const contact = prospect?.contacts.find((c) => c.email?.toLowerCase() === to.email.toLowerCase()) ?? null;
      let draft: BdEmailDraft = q.createDraft({ prospect_id: prospectId, contact_id: contact?.id ?? null, to_name: to.name, to_email: to.email, subject, body, language: 'en', style: 'short', generator: 'claude', created_by: 'tldv', kind: 'followup', meeting_id: m.id, meeting_title: m.name });
      q.logOutreach(prospectId, { channel: 'gmail', action: 'note', note: `Follow-up drafted after the call "${m.name}"`, contact_name: to.name, actor: 'tldv' });
      if (opts.gmail?.connected) {
        try {
          const g = await opts.gmail.createDraft({ to: to.email, toName: to.name, subject, body, html: bodyToHtml(body) });
          draft = q.updateDraft(draft.id, { status: 'gmail', gmail_draft_id: g.draft_id, gmail_message_id: g.message_id, gmail_url: g.url }) ?? draft;
        } catch (err) {
          errors.push(`Gmail: ${(err as Error).message}`);
        }
      }
      drafted += 1;
      if (m.happenedAt > (q.getSetting('tldv_since', '') || '')) q.setSetting('tldv_since', m.happenedAt);
    } catch (err) {
      errors.push(`${m.name}: ${(err as Error).message}`);
    }
  }
  q.setSetting('tldv_last_check_at', new Date().toISOString());
  q.setSetting('tldv_last_error', errors.join(' · '));
  if (drafted) { log.info(`tl;dv: ${drafted} follow-up draft(s) prepared`); liveEvents.emitUpdate({ kind: 'bd' }); }
  return { checked: meetings.length, drafted, errors };
}
