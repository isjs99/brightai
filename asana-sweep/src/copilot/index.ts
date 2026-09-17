import type { Queries } from '../db/queries.js';
import type { Account, CopilotData, CopilotQuestion, CopilotSource } from '../sweep/types.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { tldv, type TldvClient } from '../bd/tldv.js';
import type { GmailClient } from '../bd/gmail.js';
import { slackBot, type SlackBot } from '../notify/slackbot.js';
import { money } from '../bd/outreach.js';
import { projectRows, stockSettings } from '../stock/index.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Client question copilot. Every question a client asks (Slack channel, email, or typed in by the
 * AM) is answered from evidence: tl;dv call transcripts and notes, emails with the client, the
 * client Slack channel, the SOP / context library, reports, incidents and the account numbers.
 * The draft cites its sources so the AM can check before sending.
 */

const STOP = new Set('the a an and or of to in on for with we you our your is are was were be been it this that these those as at by from do does did can could will would should have has had not no yes what when where why how who which please thanks thank hi hello i me my us they them their about into over under again also just so than then there here any some all'.split(' '));
const stem = (w: string) => w.replace(/(ing|ed|es|s|ly|ment|tion|ions)$/g, '');
export function tokens(text: string): string[] {
  return [...new Set(text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9€$£%.]+/g, ' ').split(' ').map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w.length > 2 && !STOP.has(w)).map(stem))];
}

/** Break long texts into overlapping windows so a hit surfaces the relevant passage, not the whole call. */
function windows(text: string, size = 700, step = 500): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) { out.push(text.slice(i, i + size)); if (i + size >= text.length) break; }
  return out;
}

export function searchEvidence(rows: { kind: string; title: string; text: string; url: string | null; occurred_at: string | null }[], question: string, limit = 8): CopilotSource[] {
  const qt = tokens(question);
  if (!qt.length) return [];
  const scored: CopilotSource[] = [];
  const recencyBoost = (iso: string | null) => { if (!iso) return 1; const days = (Date.now() - Date.parse(iso)) / 86400000; return days < 30 ? 1.3 : days < 90 ? 1.15 : days < 365 ? 1 : 0.85; };
  for (const r of rows) {
    const titleT = new Set(tokens(r.title));
    let best: { score: number; snippet: string } | null = null;
    for (const w of windows(r.text)) {
      const wt = tokens(w);
      const set = new Set(wt);
      let hits = 0;
      for (const t of qt) { if (set.has(t)) hits += 1; if (titleT.has(t)) hits += 0.5; }
      if (!hits) continue;
      const score = (hits / qt.length) * recencyBoost(r.occurred_at) * (r.kind === 'call' || r.kind === 'email' || r.kind === 'slack' ? 1.1 : 1);
      if (!best || score > best.score) {
        const idx = Math.max(0, wt.findIndex((t) => qt.includes(t)));
        const pos = Math.max(0, w.toLowerCase().indexOf((wt[idx] ?? '').slice(0, 4)));
        best = { score, snippet: (pos > 120 ? '…' : '') + w.slice(Math.max(0, pos - 120), Math.max(0, pos - 120) + 360).replace(/\s+/g, ' ').trim() + (w.length > pos + 240 ? '…' : '') };
      }
    }
    if (best) scored.push({ kind: r.kind, title: r.title, snippet: best.snippet, url: r.url, occurred_at: r.occurred_at, score: Math.min(1, Math.round(best.score * 100) / 100) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function renderAnswerPrompt(question: CopilotQuestion, account: Account | null, sources: CopilotSource[]): { system: string; user: string } {
  const system = [
    `You are the account team's copilot at Brightform, a TikTok Shop Partner agency. A client${account ? ` (${account.name})` : ''} asked a question. Draft the reply the account manager will send, using only the evidence below.`,
    'British English, warm but direct, no exclamation marks, no hype. Two to six sentences. If the evidence answers it, say so plainly and cite the source in square brackets after the sentence, like [1] or [2][4]. If the evidence only partly answers it, answer the part you can and say what you will confirm and by when. If nothing in the evidence is relevant, say you will check and come back, and do not invent facts.',
    'Do not mention "evidence" or "sources" to the client; the bracketed numbers are for the AM and get stripped or kept as they choose. Output the reply text only.',
  ].join('\n');
  const u = [`## Question${question.asked_by ? ` (from ${question.asked_by})` : ''}\n${question.question}`, '', '## Evidence', ...(sources.length ? sources.map((s, i) => `[${i + 1}] ${s.kind.toUpperCase()} · ${s.title}${s.occurred_at ? ` · ${s.occurred_at.slice(0, 10)}` : ''}\n${s.snippet}`) : ['(none found)']), '', 'Write the reply now.'];
  return { system, user: u.join('\n') };
}

export function templateAnswer(question: CopilotQuestion, sources: CopilotSource[]): string {
  if (!sources.length) return `Thanks for the question. I do not have this to hand, so let me check with the team and come back to you today.`;
  // Only the sources that match nearly as well as the best one; weaker hits stay in the evidence list for the AM.
  const floor = sources[0].score * 0.6;
  const top = sources.filter((s, i) => i === 0 || s.score >= floor).slice(0, 3).map((s) => `${s.snippet.replace(/^…|…$/g, '')} [${sources.indexOf(s) + 1}]`).join(' ');
  return `Thanks for the question. From what we have on record: ${top} Let me know if you need more detail on any of it.`;
}

export interface CopilotDeps { gmail?: GmailClient | null; slack?: SlackBot; tldv?: TldvClient; llm?: ((system: string, user: string) => Promise<string>) | null }

const QUESTION_RE = /\?\s*$|^\s*(what|when|where|why|how|who|which|can|could|would|will|is|are|do|does|did|should|any update|update on|status of|wann|wie|was|warum|wo|können|könnt|gibt es|quand|comment|pourquoi|est-ce|pouvez|cuándo|cómo|qué|por qué|pueden|quando|come|perché|potete|c'è)\b/i;
export const looksLikeQuestion = (text: string): boolean => text.trim().length > 8 && QUESTION_RE.test(text.trim());

export class Copilot {
  private indexing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private q: Queries, private deps: CopilotDeps = {}) {}

  private get llm(): ((system: string, user: string) => Promise<string>) | null {
    if (this.deps.llm !== undefined) return this.deps.llm;
    return config.anthropicApiKey ? (s, u) => draftWithClaude(s, u, { maxTokens: 700 }) : null;
  }

  settings(): CopilotData['settings'] {
    return { watch_slack: this.q.getSetting('copilot_watch_slack', '1') === '1', watch_email: this.q.getSetting('copilot_watch_email', '1') === '1', notify_am: this.q.getSetting('copilot_notify_am', '1') === '1' };
  }

  data(): CopilotData {
    const counts = this.evidenceCountsByAccount();
    return {
      questions: this.q.listQuestions(),
      accounts: this.q.listAccounts().filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, client_slack_channel: a.client_slack_channel, client_domain: a.client_domain, evidence: counts.get(a.id) ?? 0 })),
      settings: this.settings(), evidence_counts: this.q.evidenceCounts(), last_index_at: this.q.getSetting('copilot_last_index_at', '') || null, last_index_error: this.q.getSetting('copilot_last_index_error', '') || null,
      slack_configured: (this.deps.slack ?? slackBot).configured, gmail_connected: Boolean(this.deps.gmail?.connected), tldv_configured: (this.deps.tldv ?? tldv).configured, llm_configured: Boolean(this.llm),
    };
  }

  private evidenceCountsByAccount(): Map<number, number> {
    const m = new Map<number, number>();
    for (const e of this.q.listEvidence()) if (e.account_id) m.set(e.account_id, (m.get(e.account_id) ?? 0) + 1);
    return m;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.poll(), 5 * 60000);
    setTimeout(() => void this.index().then(() => this.poll()), 90000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private accountFor(opts: { domain?: string | null; channel?: string | null; text?: string | null }): Account | null {
    const accounts = this.q.listAccounts().filter((a) => a.enabled);
    if (opts.domain) { const d = opts.domain.toLowerCase(); const hit = accounts.find((a) => a.client_domain && d.endsWith(a.client_domain)); if (hit) return hit; }
    if (opts.channel) { const c = opts.channel.toLowerCase(); const hit = accounts.find((a) => a.client_slack_channel && (a.client_slack_channel.toLowerCase() === c || a.client_slack_channel.toLowerCase() === `#${c}`)); if (hit) return hit; }
    if (opts.text) { const t = opts.text.toLowerCase(); const hit = accounts.find((a) => t.includes(a.name.toLowerCase())); if (hit) return hit; }
    return null;
  }

  /** Build or refresh the evidence store from every source that is configured. */
  async index(): Promise<{ added: number; errors: string[] }> {
    if (this.indexing) return { added: 0, errors: ['Already indexing'] };
    this.indexing = true;
    const errors: string[] = [];
    let added = 0;
    try {
      const accounts = this.q.listAccounts().filter((a) => a.enabled);
      // SOPs / context library.
      added += this.q.upsertEvidence(this.q.listContext().filter((c) => c.enabled).map((c) => ({ account_id: c.account_id, kind: 'sop', ref: `context:${c.id}`, title: c.title, text: c.body, occurred_at: c.updated_at })));
      // Reports, incidents, account numbers, stock, promotions.
      added += this.q.upsertEvidence(this.q.listReports().map((r) => ({ account_id: r.account_id, kind: 'report', ref: `report:${r.id}`, title: r.title, text: r.body, occurred_at: r.updated_at })));
      added += this.q.upsertEvidence(this.q.listIncidents({ limit: 500 }).map((i) => ({ account_id: i.account_id, kind: 'incident', ref: `incident:${i.id}`, title: `${i.title}${i.resolved_at ? ' (resolved)' : ' (open)'}`, text: `${i.message}\nRecommended action: ${i.recommended_action}\nOwner: ${i.owner ?? 'unassigned'}`, occurred_at: i.created_at })));
      const shops = this.q.listShops();
      const today = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 56 * 86400000).toISOString().slice(0, 10);
      const gmv = this.q.listGmvBetween(from, today);
      const stock = projectRows(this.q.listStock(), { coverDays: stockSettings(this.q).default_cover_days });
      const promos = this.q.listPromotions();
      for (const a of accounts) {
        const ids = new Set(shops.filter((s) => s.account_id === a.id).map((s) => s.shop_id));
        const cur = shops.find((s) => s.account_id === a.id)?.currency ?? '€';
        const weeks: string[] = [];
        for (let w = 0; w < 8; w += 1) {
          const end = new Date(Date.now() - w * 7 * 86400000).toISOString().slice(0, 10);
          const start = new Date(Date.now() - (w * 7 + 6) * 86400000).toISOString().slice(0, 10);
          const rows = gmv.filter((r) => ids.has(r.shop_id) && r.date >= start && r.date <= end);
          if (rows.length) weeks.push(`Week ${start} to ${end}: total GMV ${money(rows.reduce((n, r) => n + r.total_gmv, 0), cur)}, affiliate GMV ${money(rows.reduce((n, r) => n + r.affiliate_gmv, 0), cur)}, ${rows.reduce((n, r) => n + r.units, 0)} units.`);
        }
        const rows: Parameters<Queries['upsertEvidence']>[0] = [];
        if (weeks.length) rows.push({ account_id: a.id, kind: 'data', ref: `gmv:${a.id}`, title: `${a.name}: GMV by week (Cruva sync)`, text: weeks.join('\n'), occurred_at: new Date().toISOString() });
        const st = stock.filter((r) => r.account_id === a.id && r.velocity > 0);
        if (st.length) rows.push({ account_id: a.id, kind: 'data', ref: `stock:${a.id}`, title: `${a.name}: stock countdown`, text: st.slice(0, 60).map((r) => `${r.product_title}${r.sku_name ? ` (${r.sku_name})` : ''}: ${r.on_hand} on hand, ${r.velocity} a day, ${r.days_left ?? '?'} days left${r.stockout_at ? `, runs out ${r.stockout_at}` : ''}.`).join('\n'), occurred_at: new Date().toISOString() });
        const pr = promos.filter((p) => p.targets.some((t) => t.account_id === a.id));
        if (pr.length) rows.push({ account_id: a.id, kind: 'data', ref: `promotions:${a.id}`, title: `${a.name}: promotions`, text: pr.map((p) => `${p.name}: ${p.begin_at.slice(0, 10)} to ${p.end_at.slice(0, 10)} (${p.activity_type}, ${p.discount_type} ${p.discount_value ?? ''})${p.notes ? `. ${p.notes}` : ''}`).join('\n'), occurred_at: new Date().toISOString() });
        const convs = this.q.listConversations({ accountId: a.id, limit: 100 });
        for (const c of convs.slice(0, 40)) {
          const msgs = this.q.listMessages(c.id, 40).filter((m) => m.text);
          if (msgs.length) rows.push({ account_id: a.id, kind: 'inbox', ref: `conv:${c.id}`, title: `${c.channel === 'cs' ? 'Buyer' : 'Creator'} conversation with ${c.counterpart_name ?? 'unknown'}`, text: msgs.map((m) => `${m.sender_role === 'us' ? 'Us' : m.sender_name ?? 'Them'}: ${m.text}`).join('\n'), occurred_at: c.last_message_at });
        }
        added += this.q.upsertEvidence(rows);
      }
      // tl;dv calls (last 180 days), transcript fetched once per meeting.
      const td = this.deps.tldv ?? tldv;
      if (td.configured) {
        try {
          const since = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
          const meetings = await td.listMeetings({ since, limit: 100 });
          for (const m of meetings) {
            if (this.q.hasEvidence('call', m.id)) continue;
            const domain = m.invitees.map((i) => (i.email ?? '').split('@')[1]).find((d) => d && !/gmail|brightform|outlook|hotmail|yahoo/i.test(d)) ?? null;
            const account = this.accountFor({ domain, text: m.name });
            let notes: string[] = [];
            let transcript = '';
            try { notes = await td.highlights(m.id); } catch { /* optional */ }
            try { transcript = await td.transcript(m.id); } catch (err) { errors.push(`tl;dv transcript ${m.name}: ${(err as Error).message}`); }
            const text = [notes.length ? `Notes:\n${notes.map((n) => `- ${n}`).join('\n')}` : '', transcript ? `Transcript:\n${transcript}` : ''].filter(Boolean).join('\n\n');
            if (text) added += this.q.upsertEvidence([{ account_id: account?.id ?? null, kind: 'call', ref: m.id, title: `Call: ${m.name}`, text, url: m.url, occurred_at: m.happenedAt || null }]);
          }
        } catch (err) { errors.push(`tl;dv: ${(err as Error).message}`); }
      }
      // Emails with the client (Gmail read scope), per client domain.
      const gmail = this.deps.gmail;
      if (gmail?.connected) {
        for (const a of accounts.filter((x) => x.client_domain)) {
          try {
            const msgs = await gmail.listSent(`(from:@${a.client_domain} OR to:@${a.client_domain}) newer_than:180d`, 30);
            added += this.q.upsertEvidence(msgs.map((m) => ({ account_id: a.id, kind: 'email', ref: `gmail:${m.id}`, title: `Email: ${m.subject}${m.to ? ` (${m.to})` : ''}`, text: m.body, url: `https://mail.google.com/mail/u/0/#all/${m.id}`, occurred_at: m.sent_at })));
          } catch (err) { errors.push(`Gmail ${a.name}: ${(err as Error).message}`); }
        }
      }
      // Client Slack channels (last 30 days, one evidence row per day).
      const slack = this.deps.slack ?? slackBot;
      if (slack.configured) {
        for (const a of accounts.filter((x) => x.client_slack_channel)) {
          try {
            const chan = await slack.channelId(a.client_slack_channel!);
            const msgs = await slack.history(chan, { oldest: String(Math.floor(Date.now() / 1000) - 30 * 86400), limit: 200 });
            const byDay = new Map<string, string[]>();
            for (const m of msgs) { if (!m.text || m.subtype) continue; const day = new Date(Number(m.ts) * 1000).toISOString().slice(0, 10); byDay.set(day, [...(byDay.get(day) ?? []), `${m.user ?? 'someone'}: ${m.text}`]); }
            added += this.q.upsertEvidence([...byDay.entries()].map(([day, lines]) => ({ account_id: a.id, kind: 'slack', ref: `slack:${chan}:${day}`, title: `Slack ${a.client_slack_channel} on ${day}`, text: lines.join('\n'), occurred_at: `${day}T12:00:00.000Z` })));
          } catch (err) { errors.push(`Slack ${a.name}: ${(err as Error).message}`); }
        }
      }
      this.q.setSetting('copilot_last_index_at', new Date().toISOString());
      this.q.setSetting('copilot_last_index_error', errors.join(' · ').slice(0, 500));
    } catch (err) {
      errors.push((err as Error).message);
      this.q.setSetting('copilot_last_index_error', (err as Error).message);
    } finally {
      this.indexing = false;
      liveEvents.emitUpdate({ kind: 'copilot' });
    }
    return { added, errors };
  }

  /** Find evidence and draft the answer for one question. */
  async answer(id: number): Promise<CopilotQuestion> {
    const qn = this.q.getQuestion(id);
    if (!qn) throw new Error('Question not found');
    const account = qn.account_id ? this.q.getAccount(qn.account_id) : null;
    const rows = this.q.listEvidence({ accountId: qn.account_id ?? undefined });
    const sources = searchEvidence(rows, qn.question);
    let answer: string;
    let generator: CopilotQuestion['generator'] = 'template';
    const llm = this.llm;
    if (llm) {
      try {
        const { system, user } = renderAnswerPrompt(qn, account, sources);
        answer = (await llm(system, user)).trim().replace(/!+/g, '.');
        generator = 'claude';
      } catch (err) {
        log.warn(`Copilot draft failed: ${(err as Error).message}`);
        answer = templateAnswer(qn, sources);
      }
    } else answer = templateAnswer(qn, sources);
    const out = this.q.updateQuestion(id, { answer, sources, generator, status: 'drafted', answered_at: new Date().toISOString() })!;
    liveEvents.emitUpdate({ kind: 'copilot' });
    return out;
  }

  async ask(input: { account_id: number | null; question: string; source?: CopilotQuestion['source']; asked_by?: string | null; channel?: string | null; thread_ts?: string | null; external_id?: string | null; created_by?: string | null }): Promise<CopilotQuestion | null> {
    const created = this.q.createQuestion({ account_id: input.account_id, source: input.source ?? 'manual', question: input.question.trim(), asked_by: input.asked_by ?? null, channel: input.channel ?? null, thread_ts: input.thread_ts ?? null, external_id: input.external_id ?? null, created_by: input.created_by ?? null });
    if (!created) return null;
    return this.answer(created.id);
  }

  /** Send the (edited) answer back where the question came from: Slack thread, or a Gmail draft for email. */
  async send(id: number, text?: string | null): Promise<{ question: CopilotQuestion; mode: 'slack' | 'gmail_draft' | 'none'; url?: string | null }> {
    const qn = this.q.getQuestion(id);
    if (!qn) throw new Error('Question not found');
    const body = (text ?? qn.answer ?? '').trim();
    if (!body) throw new Error('Nothing to send: draft an answer first.');
    const clean = body.replace(/\s?\[\d+\](\[\d+\])*/g, '');
    if (qn.source === 'slack' && qn.channel) {
      const slack = this.deps.slack ?? slackBot;
      await slack.post(await slack.channelId(qn.channel), clean, { thread_ts: qn.thread_ts ?? qn.external_id ?? null });
      const out = this.q.updateQuestion(id, { answer: body, status: 'answered', sent_at: new Date().toISOString() })!;
      liveEvents.emitUpdate({ kind: 'copilot' });
      return { question: out, mode: 'slack' };
    }
    if (qn.source === 'email' && qn.asked_by && this.deps.gmail?.connected) {
      const r = await this.deps.gmail.createDraft({ to: qn.asked_by, subject: `Re: ${qn.question.slice(0, 60)}`, body: clean });
      const out = this.q.updateQuestion(id, { answer: body, status: 'answered', sent_at: new Date().toISOString() })!;
      liveEvents.emitUpdate({ kind: 'copilot' });
      return { question: out, mode: 'gmail_draft', url: r.url };
    }
    const out = this.q.updateQuestion(id, { answer: body, status: 'answered', sent_at: new Date().toISOString() })!;
    liveEvents.emitUpdate({ kind: 'copilot' });
    return { question: out, mode: 'none' };
  }

  /** Watch client Slack channels and client emails for new questions; draft and DM the AM. */
  async poll(): Promise<{ found: number; errors: string[] }> {
    const s = this.settings();
    const errors: string[] = [];
    let found = 0;
    const accounts = this.q.listAccounts().filter((a) => a.enabled);
    const slack = this.deps.slack ?? slackBot;
    if (s.watch_slack && slack.configured) {
      for (const a of accounts.filter((x) => x.client_slack_channel)) {
        try {
          const chan = await slack.channelId(a.client_slack_channel!);
          const key = `copilot_slack_since_${chan}`;
          const oldest = this.q.getSetting(key, '') || String(Math.floor(Date.now() / 1000) - 86400);
          const msgs = await slack.history(chan, { oldest, limit: 100 });
          let last = oldest;
          for (const m of msgs) {
            last = m.ts;
            if (!m.text || m.bot_id || m.subtype || m.thread_ts && m.thread_ts !== m.ts) continue;
            if (!looksLikeQuestion(m.text)) continue;
            const created = await this.ask({ account_id: a.id, question: m.text, source: 'slack', asked_by: m.user ?? null, channel: a.client_slack_channel, thread_ts: m.ts, external_id: m.ts });
            if (created) { found += 1; await this.notify(a, created); }
          }
          this.q.setSetting(key, last);
        } catch (err) { errors.push(`Slack ${a.name}: ${(err as Error).message}`); }
      }
    }
    const gmail = this.deps.gmail;
    if (s.watch_email && gmail?.connected) {
      for (const a of accounts.filter((x) => x.client_domain)) {
        try {
          const msgs = await gmail.listSent(`from:@${a.client_domain} newer_than:2d`, 10);
          for (const m of msgs) {
            const first = m.body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12).join('\n');
            if (!looksLikeQuestion(first) && !first.includes('?')) continue;
            const q = first.split('\n').find((l) => l.includes('?')) ?? first;
            const created = await this.ask({ account_id: a.id, question: `${m.subject}: ${q}`, source: 'email', asked_by: m.to, external_id: m.id });
            if (created) { found += 1; await this.notify(a, created); }
          }
        } catch (err) { errors.push(`Gmail ${a.name}: ${(err as Error).message}`); }
      }
    }
    if (errors.length) log.warn(`Copilot poll: ${errors.join(' · ')}`);
    return { found, errors };
  }

  private async notify(account: Account, qn: CopilotQuestion): Promise<void> {
    if (!this.settings().notify_am || !account.am_name) return;
    const person = this.q.listPeople().find((p) => p.name.toLowerCase() === account.am_name!.toLowerCase());
    if (!person?.slack_user_id) return;
    const slack = this.deps.slack ?? slackBot;
    await slack.tryDm(person.slack_user_id, `Client question from ${account.name} (${qn.source}):\n> ${qn.question.slice(0, 300)}\n\nDraft answer:\n${(qn.answer ?? '').slice(0, 1200)}\n\nSources: ${qn.sources.slice(0, 4).map((s, i) => `[${i + 1}] ${s.title}`).join(' · ') || 'none found'}\nReview and send: ${config.publicUrl}/copilot?q=${qn.id}`);
  }
}
