import type { Queries } from '../db/queries.js';
import type { BdEmailDraft, SendQueueState } from '../sweep/types.js';
import type { GmailClient } from './gmail.js';
import { bodyToHtml } from './outreach.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Sends reviewed outreach drafts through Gmail on a drip, instead of opening each one by hand. A draft is queued
 * by a person (its `send_account` is that person's own Gmail when connected, else the shared account), and the
 * scheduler calls `tick()` every minute: inside the sending hours on allowed days, under the daily cap, and at
 * least `gap` seconds after the previous send, the oldest queued draft goes out. Each send is logged on the
 * prospect exactly as "Mark as sent" would have, so the pipeline, the Gmail tick and the history stay right.
 */

export const SEND_DEFAULTS = { daily_cap: 30, gap_seconds: 120, hours: '08:30-18:00', weekdays_only: true, paused: false };

const SETTINGS = { cap: 'outreach_send_daily_cap', gap: 'outreach_send_gap_seconds', hours: 'outreach_send_hours', weekdays: 'outreach_send_weekdays_only', paused: 'outreach_send_paused', tz: 'check_timezone' } as const;

export function sendSettings(q: Queries): { daily_cap: number; gap_seconds: number; hours: string; weekdays_only: boolean; paused: boolean; timezone: string } {
  const num = (k: string, d: number, min: number, max: number) => { const n = Number(q.getSetting(k, '')); return Number.isFinite(n) && n >= min && n <= max && q.getSetting(k, '') !== '' ? Math.round(n) : d; };
  return {
    daily_cap: num(SETTINGS.cap, SEND_DEFAULTS.daily_cap, 1, 500),
    gap_seconds: num(SETTINGS.gap, SEND_DEFAULTS.gap_seconds, 10, 3600),
    hours: /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(q.getSetting(SETTINGS.hours, '')) ? q.getSetting(SETTINGS.hours, '') : SEND_DEFAULTS.hours,
    weekdays_only: (q.getSetting(SETTINGS.weekdays, '') || (SEND_DEFAULTS.weekdays_only ? '1' : '0')) === '1',
    paused: q.getSetting(SETTINGS.paused, '') === '1',
    timezone: q.getSetting(SETTINGS.tz, 'Europe/Madrid'),
  };
}

export function saveSendSettings(q: Queries, b: Record<string, unknown>): void {
  if (b.send_daily_cap !== undefined) q.setSetting(SETTINGS.cap, String(Math.max(1, Math.min(500, Math.round(Number(b.send_daily_cap) || SEND_DEFAULTS.daily_cap)))));
  if (b.send_gap_seconds !== undefined) q.setSetting(SETTINGS.gap, String(Math.max(10, Math.min(3600, Math.round(Number(b.send_gap_seconds) || SEND_DEFAULTS.gap_seconds)))));
  if (b.send_hours !== undefined && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(String(b.send_hours))) q.setSetting(SETTINGS.hours, String(b.send_hours));
  if (b.send_weekdays_only !== undefined) q.setSetting(SETTINGS.weekdays, b.send_weekdays_only ? '1' : '0');
  if (b.send_paused !== undefined) q.setSetting(SETTINGS.paused, b.send_paused ? '1' : '0');
}

/** Local wall-clock parts in the account time zone. */
function localParts(now: Date, timezone: string): { minutes: number; weekday: number; day: string } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { minutes: Number(parts.hour) % 24 * 60 + Number(parts.minute), weekday, day: `${parts.year}-${parts.month}-${parts.day}` };
}

/** Whether sends are allowed right now under the hours and weekday rules. */
export function inSendWindow(now: Date, s: { hours: string; weekdays_only: boolean; timezone: string }): boolean {
  const { minutes, weekday } = localParts(now, s.timezone);
  if (s.weekdays_only && (weekday === 0 || weekday === 6)) return false;
  const [from, to] = s.hours.split('-').map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  return minutes >= from && minutes < to;
}

/** Why a draft must not be queued, or null when it can be. */
export function queueBlocker(q: Queries, d: BdEmailDraft, opts: { force?: boolean } = {}): string | null {
  if (d.status === 'sent') return 'already sent';
  if (d.status === 'queued') return 'already queued';
  if (d.status === 'discarded') return 'discarded';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.to_email)) return 'no valid email address';
  if (!d.subject.trim() || !d.body.trim()) return 'empty subject or body';
  if (/\[[^\]]{2,}\]/.test(d.body) || /\[[^\]]{2,}\]/.test(d.subject)) return 'still has a [placeholder] to fill in';
  if (opts.force) return null;
  const recent = q.listDrafts({ prospectId: d.prospect_id }).find((o) => o.id !== d.id && o.to_email.toLowerCase() === d.to_email.toLowerCase() && (o.status === 'sent' || o.status === 'queued') && Date.now() - Date.parse(o.updated_at) < 30 * 86400000);
  if (recent) return `${d.to_email} was ${recent.status === 'sent' ? 'emailed' : 'queued'} in the last 30 days`;
  const p = q.getProspect(d.prospect_id);
  if (p?.outreach_gmail && d.kind === 'cold') return 'prospect already emailed (Gmail is ticked); queue with "force" to send anyway';
  return null;
}

/** The prospect-side bookkeeping for a send, shared with "Mark as sent". */
export function recordSent(q: Queries, d: BdEmailDraft, actor: string | null, via: string): void {
  const before = q.getProspect(d.prospect_id);
  const note = `Sent "${d.subject}" to ${d.to_email}${via ? ` (${via})` : ''}`;
  if (before && !before.outreach_gmail) q.patchProspect(d.prospect_id, { outreach_gmail: true, outreach_note: note, outreach_contact: d.to_name }, actor);
  else q.logOutreach(d.prospect_id, { channel: 'gmail', action: 'contacted', note, contact_name: d.to_name, actor });
  if (before && before.status === 'new') q.patchProspect(d.prospect_id, { status: 'contacted' }, actor);
}

export class SendQueue {
  private sending = false;
  lastError: string | null = null;

  constructor(private q: Queries, private gmail: GmailClient) {}

  /** Drafts queued by a person: their own Gmail when connected, else the shared account. */
  queue(ids: number[], actor: string | null, opts: { force?: boolean } = {}): { queued: BdEmailDraft[]; skipped: { id: number; reason: string }[] } {
    const queued: BdEmailDraft[] = [];
    const skipped: { id: number; reason: string }[] = [];
    const account = this.gmail.forActor(actor);
    if (!account.connected) throw new Error('Connect Gmail first (Growth › Outreach emails › Settings): your own, or the shared account.');
    for (const id of ids) {
      const d = this.q.getDraft(id);
      if (!d) { skipped.push({ id, reason: 'not found' }); continue; }
      const why = queueBlocker(this.q, d, opts);
      if (why) { skipped.push({ id, reason: why }); continue; }
      queued.push(this.q.updateDraft(id, { status: 'queued', queued_at: new Date().toISOString(), queued_by: actor, send_account: account.account, send_error: null })!);
    }
    if (queued.length) liveEvents.emitUpdate({ kind: 'bd' });
    return { queued, skipped };
  }

  unqueue(id: number): BdEmailDraft | null {
    const d = this.q.getDraft(id);
    if (!d || d.status !== 'queued') return d;
    const out = this.q.updateDraft(id, { status: 'draft', queued_at: null, queued_by: null, send_account: null });
    liveEvents.emitUpdate({ kind: 'bd' });
    return out;
  }

  sentToday(now = new Date()): number {
    const s = sendSettings(this.q);
    const { day } = localParts(now, s.timezone);
    return this.q.listDrafts({}).filter((d) => d.status === 'sent' && d.sent_at && localParts(new Date(d.sent_at), s.timezone).day === day).length;
  }

  state(now = new Date()): SendQueueState {
    const s = sendSettings(this.q);
    const drafts = this.q.listDrafts({});
    const queued = drafts.filter((d) => d.status === 'queued');
    const lastSent = drafts.filter((d) => d.sent_at).map((d) => d.sent_at!).sort().at(-1) ?? null;
    const sent_today = this.sentToday(now);
    const inWindow = inSendWindow(now, s);
    let next_at: string | null = null;
    if (queued.length && !s.paused && inWindow && sent_today < s.daily_cap) {
      const earliest = lastSent ? Date.parse(lastSent) + s.gap_seconds * 1000 : now.getTime();
      next_at = new Date(Math.max(earliest, now.getTime())).toISOString();
    }
    return { queued: queued.length, sent_today, last_sent_at: lastSent, next_at, in_window: inWindow, sending: this.sending, last_error: this.lastError, settings: { daily_cap: s.daily_cap, gap_seconds: s.gap_seconds, hours: s.hours, weekdays_only: s.weekdays_only, paused: s.paused, timezone: s.timezone } };
  }

  /** Called every minute. Sends at most one draft per call so the gap and cap hold even if a send is slow. */
  async tick(now = new Date()): Promise<BdEmailDraft | null> {
    if (this.sending) return null;
    const s = sendSettings(this.q);
    if (s.paused || !inSendWindow(now, s)) return null;
    const drafts = this.q.listDrafts({});
    const queued = drafts.filter((d) => d.status === 'queued').sort((a, b) => (a.queued_at ?? '').localeCompare(b.queued_at ?? ''));
    if (!queued.length) return null;
    if (this.sentToday(now) >= s.daily_cap) return null;
    const lastSent = drafts.filter((d) => d.sent_at).map((d) => d.sent_at!).sort().at(-1);
    if (lastSent && now.getTime() - Date.parse(lastSent) < s.gap_seconds * 1000) return null;
    const d = queued[0];
    this.sending = true;
    try {
      const client = this.gmail.forAccount(d.send_account ?? '');
      if (!client.connected) throw new Error(`Gmail is no longer connected for ${d.send_account || 'the shared account'}`);
      const sent = await client.sendMessage({ to: d.to_email, toName: d.to_name, subject: d.subject, body: d.body, html: bodyToHtml(d.body) });
      const url = `https://mail.google.com/mail/${client.email ? `?authuser=${encodeURIComponent(client.email)}` : 'u/0/'}#sent/${sent.message_id}`;
      const out = this.q.updateDraft(d.id, { status: 'sent', sent_at: now.toISOString(), gmail_message_id: sent.message_id, gmail_thread_id: sent.thread_id, gmail_url: url, send_error: null })!;
      recordSent(this.q, out, d.queued_by, `auto-sent from ${client.email}`);
      this.lastError = null;
      log.info(`Outreach sent to ${d.to_email} from ${client.email} (draft ${d.id}, queued by ${d.queued_by ?? 'unknown'})`);
      liveEvents.emitUpdate({ kind: 'bd' });
      return out;
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `${d.to_email}: ${msg}`;
      this.q.updateDraft(d.id, { status: 'draft', send_error: msg, queued_at: null, send_account: null });
      this.q.logOutreach(d.prospect_id, { channel: 'gmail', action: 'note', note: `Auto-send failed: ${msg}`, contact_name: d.to_name, actor: d.queued_by });
      log.warn(`Outreach auto-send to ${d.to_email} failed: ${msg}`);
      liveEvents.emitUpdate({ kind: 'bd' });
      return null;
    } finally {
      this.sending = false;
    }
  }
}
