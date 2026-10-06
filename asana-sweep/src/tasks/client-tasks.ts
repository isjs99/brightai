import type { Queries } from '../db/queries.js';
import type { Account, ClientTask, ClientTaskSources, ClientTasksData } from '../sweep/types.js';
import { config } from '../config.js';
import { draftWithClaude, modelFor } from '../inbox/llm.js';
import { tldv } from '../bd/tldv.js';
import { slackBot } from '../notify/slackbot.js';
import { INTERNAL_CALL_RE } from '../onboarding/targets.js';
import { todayIn } from '../checklist/checker.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Ad hoc client tasks: what the client asked for or what was agreed with them, pulled out of the client
 * Slack channel, the emails with the client and the tl;dv calls (all already indexed as evidence for Ask),
 * as a short bullet with the full context behind it and a due date when one was said. The AM can dismiss,
 * amend the due date, tick it done, or add a task by hand.
 */

export interface ExtractedTask { title: string; detail: string; due_date: string | null }

const DAY_WORDS: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

/** A due date from words like "by Friday", "tomorrow", "next week", "by 12 October", "end of month", relative to the day it was said. */
export function dueDateFrom(text: string, saidOn: string): string | null {
  const t = text.toLowerCase();
  const base = new Date(`${saidOn}T12:00:00Z`);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const add = (n: number) => iso(new Date(base.getTime() + n * 86400000));
  const explicit = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicit) return explicit[1];
  const dm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/) ?? t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (dm) {
    const day = Number(/^\d/.test(dm[1]) ? dm[1] : dm[2]);
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf((/^\d/.test(dm[1]) ? dm[2] : dm[1]).slice(0, 3));
    if (day >= 1 && day <= 31 && mon >= 0) { let d = new Date(Date.UTC(base.getUTCFullYear(), mon, day)); if (d.getTime() < base.getTime() - 30 * 86400000) d = new Date(Date.UTC(base.getUTCFullYear() + 1, mon, day)); return iso(d); }
  }
  if (/\btoday\b|\bby eod\b|\bend of (the )?day\b|\basap\b/.test(t)) return saidOn;
  if (/\btomorrow\b/.test(t)) return add(1);
  if (/\bend of (the )?week\b|\bthis week\b/.test(t)) { const dow = base.getUTCDay() || 7; return add(5 - dow >= 0 ? 5 - dow : 0); }
  if (/\bnext week\b/.test(t)) { const dow = base.getUTCDay() || 7; return add(8 - dow + 4); }
  if (/\bend of (the )?month\b/.test(t)) return iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)));
  const byDay = t.match(/\b(?:by|on|before|until|for)\s+(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/);
  if (byDay) { const target = DAY_WORDS[byDay[1]]; const dow = base.getUTCDay() || 7; let n = target - dow; if (n <= 0) n += 7; if (/next\s+/.test(byDay[0])) n += 7; return add(n); }
  return null;
}

const ASK_RE = /\b(can you|could you|please|would you|we need|need you to|make sure|don't forget|let's|lets|action:|todo|to do|send (me|us|over)|share|follow up|follow-up|by (monday|tuesday|wednesday|thursday|friday|tomorrow|eod|end of)|agreed|we will|we'll|you will|you'll|i'll|i will)\b/i;
const NOISE_RE = /^(thanks|thank you|ok|okay|great|perfect|cheers|hi|hello|hey|good morning|morning)\b/i;

/** Without Claude: sentences that read like an ask or a commitment, one task each. */
export function heuristicTasks(text: string, saidOn: string): ExtractedTask[] {
  const out: ExtractedTask[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const line = raw.replace(/^\s*[-•*]\s*/, '').replace(/^\s*(?:[^:\n]{1,40}:\s*)?/, '').replace(/\s+/g, ' ').trim();
    if (line.length < 18 || line.length > 300 || NOISE_RE.test(line) || !ASK_RE.test(line)) continue;
    const title = line.replace(/^(can you|could you|would you|please)\s+/i, '').replace(/[.?!]+$/, '');
    const key = title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title.charAt(0).toUpperCase() + title.slice(1), detail: raw.trim(), due_date: dueDateFrom(line, saidOn) });
    if (out.length >= 5) break;
  }
  return out;
}

export function renderExtractPrompt(account: Account, source: { kind: string; title: string; text: string; occurred_at: string | null }, existing: string[]): { system: string; user: string } {
  const system = [
    `You read what a client (${account.name}) and Brightform's account team said to each other and pull out the ad hoc tasks: things the client asked for, things we agreed to do, things they owe us that we must chase. Brightform is a TikTok Shop Partner agency; the routine daily checks are not tasks (ignore "we will keep monitoring"). Only concrete, one-off actions.`,
    'Return JSON only: an array of objects {"title": "<short bullet, max 12 words, starts with a verb>", "detail": "<2-4 sentences: what exactly, who asked, what was agreed, quoting the key line>", "due_date": "<YYYY-MM-DD when a date or day was said or clearly implied, else null>"}. No duplicates of the existing tasks listed. Empty array [] when there is nothing actionable.',
  ].join('\n');
  const user = [`## Source\n${source.kind.toUpperCase()} · ${source.title}${source.occurred_at ? ` · ${source.occurred_at.slice(0, 10)}` : ''}`, '', '## Text', source.text.slice(0, 9000), '', existing.length ? `## Existing tasks (do not repeat)\n${existing.map((t) => `- ${t}`).join('\n')}` : '', '', 'Return the JSON array now.'].join('\n');
  return { system, user };
}

export function parseExtracted(text: string, saidOn: string): ExtractedTask[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < 0) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown[];
    return arr.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object').map((x) => {
      const title = String(x.title ?? '').trim().slice(0, 160);
      const detail = String(x.detail ?? '').trim();
      const due = typeof x.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.due_date) ? x.due_date : dueDateFrom(`${title} ${detail}`, saidOn);
      return { title, detail, due_date: due };
    }).filter((t) => t.title.length > 3).slice(0, 8);
  } catch {
    return [];
  }
}

const similar = (a: string, b: string): boolean => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const A = new Set(norm(a)), B = new Set(norm(b));
  if (!A.size || !B.size) return false;
  let hits = 0;
  for (const w of A) if (B.has(w)) hits += 1;
  return hits / Math.min(A.size, B.size) >= 0.6;
};

export class ClientTasks {
  private scanning = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private q: Queries, private deps: { llm?: ((system: string, user: string) => Promise<string>) | null; copilot?: { index(): Promise<{ added: number; errors: string[] }>; indexStatus(): { last_at: string | null; last_error: string | null; indexing: boolean } } | null; gmailConnected?: () => boolean; slackConfigured?: () => boolean; tldvConfigured?: () => boolean } = {}) {}

  private get llm(): ((system: string, user: string) => Promise<string>) | null {
    if (this.deps.llm !== undefined) return this.deps.llm;
    return config.anthropicApiKey ? (s, u) => draftWithClaude(s, u, { maxTokens: 1200, feature: 'tasks' }) : null;
  }

  /** Where the tasks would come from and why nothing arrives, with the fix per source. */
  sources(): ClientTaskSources {
    const accounts = this.q.listAccounts().filter((a) => a.enabled);
    const slackOn = this.deps.slackConfigured ? this.deps.slackConfigured() : slackBot.configured;
    const gmailOn = this.deps.gmailConnected ? this.deps.gmailConnected() : false;
    const tldvOn = this.deps.tldvConfigured ? this.deps.tldvConfigured() : tldv.configured;
    const withChannel = accounts.filter((a) => a.client_slack_channel);
    const withDomain = accounts.filter((a) => a.client_domain);
    const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const rows = this.q.listEvidence({ kinds: ['slack', 'email', 'call'], from: since });
    const count = (id: number, kind: string) => rows.filter((r) => r.account_id === id && r.kind === kind).length;
    const idx = this.deps.copilot?.indexStatus() ?? { last_at: this.q.getSetting('copilot_last_index_at', '') || null, last_error: this.q.getSetting('copilot_last_index_error', '') || null, indexing: false };
    const ie = idx.last_error ?? '';
    const slackErr = /Slack/i.test(ie) ? ie.split(' · ').find((x) => /^Slack/i.test(x)) ?? null : null;
    return {
      slack: { ok: slackOn && withChannel.length > 0 && !slackErr, label: 'Client Slack channels', detail: !slackOn ? 'SLACK_BOT_TOKEN not set' : !withChannel.length ? 'No account has a client Slack channel set' : slackErr ? slackErr : `${withChannel.length} of ${accounts.length} accounts have a channel`, fix: !slackOn ? 'Set SLACK_BOT_TOKEN (bot scopes: channels:read, groups:read, channels:history, groups:history, chat:write) and restart.' : !withChannel.length ? 'Settings › Accounts: set the client Slack channel on each account, then invite the bot to that channel (/invite @bot).' : slackErr ? 'Invite the bot to the channel (/invite @bot) and check the bot has channels:history and groups:history.' : accounts.length > withChannel.length ? `Set the channel on: ${accounts.filter((a) => !a.client_slack_channel).map((a) => a.name).join(', ')}` : null },
      gmail: { ok: gmailOn && withDomain.length > 0, label: 'Emails with the client (Gmail)', detail: !gmailOn ? 'Gmail not connected' : !withDomain.length ? 'No account has a client email domain set' : `${withDomain.length} of ${accounts.length} accounts have a domain`, fix: !gmailOn ? 'Growth › Outreach › Voice, Gmail & contacts: connect Gmail (needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, scopes gmail.compose and gmail.readonly).' : !withDomain.length ? 'Settings › Accounts: set the client domain (e.g. neurogum.com) on each account.' : accounts.length > withDomain.length ? `Set the domain on: ${accounts.filter((a) => !a.client_domain).map((a) => a.name).join(', ')}` : null },
      tldv: { ok: tldvOn && !/tl;dv/i.test(ie), label: 'tl;dv calls', detail: !tldvOn ? 'TLDV_API_KEY not set' : /tl;dv/i.test(ie) ? ie.split(' · ').find((x) => /tl;dv/i.test(x)) ?? ie : 'Calls from the last 180 days are indexed; a call lands on an account when an attendee has the client domain or the title names the account', fix: !tldvOn ? 'Set TLDV_API_KEY (tl;dv › Settings › API) and restart.' : null },
      llm: { ok: Boolean(this.llm), label: 'Claude (reads the text into tasks)', detail: this.llm ? `${modelFor('tasks')}` : 'ANTHROPIC_API_KEY not set: pattern matching only', fix: this.llm ? null : 'Set ANTHROPIC_API_KEY and keep credit on the Anthropic account; without it only sentences that read like an ask become tasks.' },
      index: idx,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, slack: count(a.id, 'slack'), email: count(a.id, 'email'), call: count(a.id, 'call'), missing: [!a.client_slack_channel ? 'Slack channel' : '', !a.client_domain ? 'client domain' : ''].filter(Boolean) })),
      unmatched_calls: rows.filter((r) => r.kind === 'call' && r.account_id === null && !INTERNAL_CALL_RE.test(r.title)).slice(0, 10).map((r) => ({ title: r.title, occurred_at: r.occurred_at })),
    };
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.scan(), 30 * 60000);
    setTimeout(() => void this.scan(), 150000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  status(): { last_scan_at: string | null; last_scan_error: string | null; scanning: boolean } {
    return { last_scan_at: this.q.getSetting('client_tasks_last_scan_at', '') || null, last_scan_error: this.q.getSetting('client_tasks_last_scan_error', '') || null, scanning: this.scanning };
  }

  data(opts: { from?: string; to?: string; accountId?: number | null } = {}): ClientTasksData {
    const today = todayIn(this.q.getSetting('check_timezone', 'Europe/Madrid'));
    const from = opts.from ?? today, to = opts.to ?? today;
    return {
      from, to, today,
      tasks: this.q.listClientTasks({ accountId: opts.accountId ?? undefined, from, to }),
      accounts: this.q.listAccounts().filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, am_name: a.am_name, markets: a.markets, client_slack_channel: a.client_slack_channel, client_domain: a.client_domain })),
      ...this.status(), llm_configured: Boolean(this.llm), sources: this.sources(),
    };
  }

  /** New evidence since the last scan (client Slack, emails, calls) → tasks, deduplicated per account. */
  async scan(opts: { sinceDays?: number; accountId?: number; index?: boolean } = {}): Promise<{ scanned: number; added: number; errors: string[] }> {
    if (this.scanning) return { scanned: 0, added: 0, errors: ['Already scanning'] };
    this.scanning = true;
    const errors: string[] = [];
    let scanned = 0, added = 0;
    try {
      // Fresh evidence first: the client Slack channels, the emails and the calls are re-read on every scan.
      if (opts.index !== false && this.deps.copilot) { try { const r = await this.deps.copilot.index(); errors.push(...r.errors.filter((e) => e !== 'Already indexing')); } catch (err) { errors.push(`Index: ${(err as Error).message}`); } }
      const last = this.q.getSetting('client_tasks_last_scan_at', '');
      const since = opts.sinceDays ? new Date(Date.now() - opts.sinceDays * 86400000).toISOString() : last || new Date(Date.now() - 14 * 86400000).toISOString();
      const accounts = this.q.listAccounts().filter((a) => a.enabled && (!opts.accountId || a.id === opts.accountId));
      const llm = this.llm;
      for (const a of accounts) {
        const rows = this.q.listEvidence({ accountId: a.id, ownOnly: true, kinds: ['slack', 'email', 'call'] }).filter((r) => r.indexed_at >= since || (opts.sinceDays !== undefined && (r.occurred_at ?? '') >= since.slice(0, 10)));
        for (const r of rows) {
          const ref = `${r.kind}:${r.ref}`;
          if (this.q.hasClientTask(a.id, ref) || this.q.hasClientTask(a.id, `${ref}#0`)) continue;
          scanned += 1;
          const saidOn = (r.occurred_at ?? r.indexed_at).slice(0, 10);
          const existing = this.q.recentClientTaskTitles(a.id);
          let found: ExtractedTask[] = [];
          if (llm) {
            try { const { system, user } = renderExtractPrompt(a, r, existing); found = parseExtracted(await llm(system, user), saidOn); } catch (err) { errors.push(`${a.name} ${r.kind}: ${(err as Error).message}`); found = heuristicTasks(r.text, saidOn); }
          } else found = heuristicTasks(r.text, saidOn);
          found = found.filter((t) => !existing.some((e) => similar(e, t.title)));
          // One marker row per source even when nothing was found, so it is not re-read on the next scan.
          if (!found.length) { this.q.createClientTask({ account_id: a.id, title: `(nothing actionable in ${r.title.slice(0, 80)})`, source: r.kind as ClientTask['source'], source_ref: `${ref}#0`, source_url: r.url, created_by: 'scan' }); this.q.updateClientTask(this.q.listClientTasks({ accountId: a.id }).find((t) => t.source_ref === `${ref}#0`)!.id, { status: 'dismissed', dismissed_at: new Date().toISOString() }); continue; }
          found.forEach((t, i) => {
            const detail = `${t.detail}\n\nFrom: ${r.title}${r.occurred_at ? ` (${r.occurred_at.slice(0, 10)})` : ''}`;
            this.q.createClientTask({ account_id: a.id, title: t.title, detail, source: r.kind as ClientTask['source'], source_ref: i === 0 ? ref : `${ref}#${i}`, source_url: r.url, due_date: t.due_date, due_source: t.due_date ? 'context' : 'am', created_by: 'scan' });
            added += 1;
          });
        }
      }
      this.q.setSetting('client_tasks_last_scan_at', new Date().toISOString());
      this.q.setSetting('client_tasks_last_scan_error', errors.join(' · ').slice(0, 500));
    } catch (err) {
      errors.push((err as Error).message);
      this.q.setSetting('client_tasks_last_scan_error', (err as Error).message);
    } finally {
      this.scanning = false;
      if (added) liveEvents.emitUpdate({ kind: 'check' });
    }
    if (added || errors.length) log.info(`Client tasks: ${added} added from ${scanned} source(s)${errors.length ? `, ${errors.length} error(s)` : ''}`);
    return { scanned, added, errors };
  }
}
