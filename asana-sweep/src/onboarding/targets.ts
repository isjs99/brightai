import type { Queries } from '../db/queries.js';
import type { Lead, TargetAnalysis, TargetLight, TargetRow, TargetSource, TargetsData } from '../sweep/types.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { searchEvidence } from '../copilot/index.js';
import { todayIn } from '../checklist/checker.js';
import { leadsSettings } from '../leads/sync.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Onboarding > Targets: every lead on the list, ranked daily by how far along the deal is, with the
 * context behind it (the calls, emails and Slack that mention the lead), the outstanding steps and the
 * blockers. The AM who handles it is set here; "Ready to sign" moves the lead into Onboarding steps.
 *
 * Privacy: only sources that name the lead (or its domain) are used, and internal calls between the
 * founders and the team (no outside attendee, or titled as an internal catch-up) are never read for a
 * target, so private business discussions stay out of the deal context.
 */

const STAGE_RULES: { re: RegExp; pct: number; label: string; next: string[] }[] = [
  { re: /signed|closed[\s-]*won|\bwon\b|onboard/i, pct: 100, label: 'Signed', next: ['Move to Onboarding steps'] },
  { re: /verbal|ready to sign|contract sent|docusign|signature|signing/i, pct: 90, label: 'Contract out', next: ['Chase the signature on DocuSign', 'Line up the onboarding call', 'Prepare the onboarding forms'] },
  { re: /negotiat|redline|legal|terms|mor\b|pricing agreed/i, pct: 80, label: 'Negotiating', next: ['Close the open terms (retainer, commission, term, notice)', 'Send the final SLA or MoR agreement for signature'] },
  { re: /proposal|quote|offer|deck sent|pitched|pitch sent/i, pct: 60, label: 'Proposal sent', next: ['Follow up on the proposal within 3 working days', 'Book the decision call', 'Prepare the P&L forecast for their SKUs'] },
  { re: /call|meeting|demo|pitch|discovery|intro/i, pct: 45, label: 'In conversation', next: ['Send the proposal and forecast after the call', 'Confirm decision makers and timeline'] },
  { re: /replied|interested|warm|engaged|follow/i, pct: 35, label: 'Engaged', next: ['Book the discovery call', 'Share the case studies for their category'] },
  { re: /contacted|outreach|reached|emailed|messaged|sent/i, pct: 25, label: 'Contacted', next: ['Chase on a second channel (LinkedIn, TikTok Shop AM intro)', 'Send the one-pager'] },
  { re: /new|sourced|lead|prospect|research|identified|cold/i, pct: 10, label: 'New', next: ['Find the decision maker and their email', 'Send the first outreach'] },
];
const LOST_RE = /lost|closed[\s-]*lost|dead|declined|no[\s-]*go|not now|churn|rejected/i;

export function stageOf(stage: string | null): { pct: number; label: string; next: string[]; lost: boolean } {
  if (!stage) return { pct: 0, label: 'No stage', next: ['Set the stage on the lead list'], lost: false };
  if (LOST_RE.test(stage)) return { pct: 0, label: 'Lost', next: [], lost: true };
  for (const r of STAGE_RULES) if (r.re.test(stage)) return { pct: r.pct, label: r.label, next: r.next, lost: false };
  return { pct: 30, label: stage, next: ['Confirm the next step with the client'], lost: false };
}

const INTERNAL_CALL_RE = /\b(internal|team (call|meeting|sync)|founders?|1:1|one to one|catch[\s-]?up|weekly|standup|all[\s-]?hands|ai training|interview)\b/i;
const daysSince = (iso: string | null, now = Date.now()): number | null => (iso ? Math.floor((now - Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso)) / 86400000) : null);
const domainOf = (lead: Lead, prospectDomain: string | null): string | null => {
  const m = (lead.notes ?? '').match(/\b([a-z0-9-]+\.(?:com|de|co\.uk|uk|fr|it|es|nl|io|eu|net|org))\b/i);
  return prospectDomain ?? (m ? m[1].toLowerCase() : null);
};

/** Everything on record that names the lead: calls, emails, Slack, BD notes. Internal calls are skipped. */
export function gatherTargetContext(q: Queries, lead: Lead): { sources: TargetSource[]; prospect: { status: string; owner: string | null; notes: string | null; contacts: number; domain: string | null } | null } {
  const name = lead.name.trim();
  const nameLc = name.toLowerCase();
  const prospect = q.listProspects(true).find((p) => (p.brand ?? '').toLowerCase() === nameLc || p.shop_name.toLowerCase() === nameLc || p.shop_name.toLowerCase().includes(nameLc) && nameLc.length > 4) ?? null;
  const domain = domainOf(lead, prospect?.domain ?? null);
  const mention = (t: string) => { const l = t.toLowerCase(); return l.includes(nameLc) || (domain ? l.includes(domain) : false); };
  const rows = q.listEvidence({ kinds: ['call', 'email', 'slack', 'sop', 'report'] }).filter((r) => {
    if (r.kind === 'call' && INTERNAL_CALL_RE.test(r.title) && !mention(r.title)) return false;
    if (!mention(r.title) && !mention(r.text.slice(0, 4000))) return false;
    return true;
  });
  const query = `${name} ${domain ?? ''} proposal contract pricing retainer commission call next steps`;
  const hits = searchEvidence(rows.map((r) => ({ kind: r.kind, title: r.title, text: r.text, url: r.url, occurred_at: r.occurred_at })), query, 8);
  const sources: TargetSource[] = hits.map((h) => ({ kind: h.kind, title: h.title, occurred_at: h.occurred_at, url: h.url, snippet: h.snippet }));
  // Rows that name the lead but did not score (short notes): keep the newest few as context too.
  for (const r of rows.filter((x) => !sources.some((s) => s.title === x.title)).slice(0, 4)) sources.push({ kind: r.kind, title: r.title, occurred_at: r.occurred_at, url: r.url, snippet: r.text.replace(/\s+/g, ' ').slice(0, 300) });
  return { sources: sources.slice(0, 10), prospect: prospect ? { status: prospect.status, owner: prospect.owner_name, notes: prospect.notes, contacts: (prospect as unknown as { contacts?: unknown[] }).contacts?.length ?? 0, domain: prospect.domain } : null };
}

export function rulesAnalysis(lead: Lead, ctx: ReturnType<typeof gatherTargetContext>, now = Date.now()): TargetAnalysis {
  const st = stageOf(lead.stage);
  const since = daysSince(lead.last_contact, now);
  const lastSource = ctx.sources.map((s) => s.occurred_at).filter((x): x is string => Boolean(x)).sort().pop() ?? null;
  const sinceSource = daysSince(lastSource, now);
  const quiet = Math.min(since ?? 999, sinceSource ?? 999);
  const blockers: string[] = [];
  if (!lead.poc) blockers.push('No point of contact on the lead');
  if (lead.est_value === null) blockers.push('No estimated value');
  if (!lead.onboarding_id) blockers.push('No AM assigned to handle the deal');
  if (quiet > 30) blockers.push(`No contact for ${quiet === 999 ? 'as long as we have records' : `${quiet} days`}`);
  else if (quiet > 14) blockers.push(`Quiet for ${quiet} days`);
  if (st.pct >= 60 && st.pct < 100 && !ctx.sources.some((s) => /proposal|contract|sla|agreement|forecast/i.test(`${s.title} ${s.snippet}`))) blockers.push('No proposal or contract found in the calls, emails or Slack');
  const signals: string[] = [];
  if (lead.priority) signals.push(`Priority ${lead.priority}`);
  if (lead.est_value !== null) signals.push(`Estimated ${Math.round(lead.est_value).toLocaleString('en-GB')} a month`);
  if (ctx.prospect) signals.push(`BD pipeline: ${ctx.prospect.status}${ctx.prospect.owner ? ` (${ctx.prospect.owner})` : ''}${ctx.prospect.contacts ? `, ${ctx.prospect.contacts} contact(s)` : ''}`);
  if (ctx.sources.length) signals.push(`${ctx.sources.length} source(s) on record, last ${lastSource ? lastSource.slice(0, 10) : 'unknown'}`);
  let light: TargetLight = 'grey';
  if (lead.signed || st.pct >= 100) light = 'green';
  else if (st.lost) light = 'grey';
  else if (!lead.stage) light = 'grey';
  else if (quiet > 30 || (st.pct >= 60 && quiet > 14)) light = 'red';
  else if (st.pct >= 60 && quiet <= 14) light = 'green';
  else light = 'amber';
  const summary = lead.signed ? `Signed${lead.signed_at ? ` on ${lead.signed_at.slice(0, 10)}` : ''}; move to onboarding.` : st.lost ? 'Marked lost on the lead list.' : `${st.label} (${st.pct}%)${since !== null ? `, last contact ${since === 0 ? 'today' : `${since} day${since === 1 ? '' : 's'} ago`}` : ', no contact date'}${lead.poc ? ` with ${lead.poc}` : ''}.${lead.notes ? ` ${lead.notes.slice(0, 160)}` : ''}`;
  return { light, progress_pct: lead.signed ? 100 : st.pct, stage_label: lead.signed ? 'Signed' : st.label, summary, next_steps: lead.signed ? ['Move to Onboarding steps'] : st.next, blockers, signals, sources: ctx.sources, generator: 'rules', analysed_at: new Date(now).toISOString() };
}

export function renderTargetPrompt(lead: Lead, ctx: ReturnType<typeof gatherTargetContext>, base: TargetAnalysis): { system: string; user: string } {
  const system = [
    'You are the BD analyst at Brightform, a TikTok Shop Partner agency (retainer plus commission on GMV; a Merchant of Record model for brands without an EU entity). Rate one deal from the lead list and the evidence. British English, plain, no hype.',
    'Return JSON only: {"progress_pct": 0-100, "light": "red"|"amber"|"green", "summary": "<two sentences: where the deal is and what it hinges on>", "next_steps": ["<concrete action, who, by when>", ...up to 4], "blockers": ["<what stops it closing>", ...up to 4], "signals": ["<fact with date or number>", ...up to 5]}.',
    'green = likely to close in the next few weeks and moving; amber = alive but needs a push; red = stalled, blocked or going quiet. Use only the facts given; never invent people, numbers or dates.',
  ].join('\n');
  const user = [
    `## Lead\n${lead.name} · stage: ${lead.stage ?? 'none'} · country: ${lead.country ?? '?'} · POC: ${lead.poc ?? 'none'} · last contact: ${lead.last_contact ?? 'unknown'} · est. value: ${lead.est_value ?? 'unknown'} · priority: ${lead.priority ?? 'none'} · added: ${lead.added_on ?? lead.first_seen_at.slice(0, 10)}${lead.notes ? `\nNotes: ${lead.notes}` : ''}`,
    ctx.prospect ? `## BD pipeline\nstatus ${ctx.prospect.status}${ctx.prospect.owner ? `, owner ${ctx.prospect.owner}` : ''}${ctx.prospect.notes ? `\n${ctx.prospect.notes}` : ''}` : '',
    '## Rules-based read', `${base.stage_label} ${base.progress_pct}% · ${base.light}`, ...base.blockers.map((b) => `- blocker: ${b}`),
    '## Evidence', ...(ctx.sources.length ? ctx.sources.map((s, i) => `[${i + 1}] ${s.kind.toUpperCase()} · ${s.title}${s.occurred_at ? ` · ${s.occurred_at.slice(0, 10)}` : ''}\n${s.snippet}`) : ['(nothing on record names this lead)']),
    '', 'Return the JSON now.',
  ].filter(Boolean).join('\n');
  return { system, user };
}

export function parseTargetJson(text: string, base: TargetAnalysis): TargetAnalysis {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < 0) return base;
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const pct = Number(j.progress_pct);
    const light = ['red', 'amber', 'green'].includes(String(j.light)) ? (String(j.light) as TargetLight) : base.light;
    const arr = (v: unknown, n: number) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, n) : []);
    return { ...base, progress_pct: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : base.progress_pct, light, summary: String(j.summary ?? base.summary).trim() || base.summary, next_steps: arr(j.next_steps, 4).length ? arr(j.next_steps, 4) : base.next_steps, blockers: arr(j.blockers, 4).length ? arr(j.blockers, 4) : base.blockers, signals: arr(j.signals, 5).length ? arr(j.signals, 5) : base.signals, generator: 'claude' };
  } catch {
    return base;
  }
}

export class Targets {
  private refreshing = false;
  constructor(private q: Queries, private deps: { llm?: ((system: string, user: string) => Promise<string>) | null } = {}) {}

  private get llm(): ((system: string, user: string) => Promise<string>) | null {
    if (this.deps.llm !== undefined) return this.deps.llm;
    return config.anthropicApiKey ? (s, u) => draftWithClaude(s, u, { maxTokens: 900 }) : null;
  }

  async analyse(lead: Lead, opts: { useLlm?: boolean } = {}): Promise<TargetAnalysis> {
    const ctx = gatherTargetContext(this.q, lead);
    let out = rulesAnalysis(lead, ctx);
    const llm = this.llm;
    if (llm && opts.useLlm !== false && !lead.signed && !stageOf(lead.stage).lost) {
      try { const { system, user } = renderTargetPrompt(lead, ctx, out); out = parseTargetJson(await llm(system, user), out); } catch (err) { log.warn(`Target analysis (${lead.name}): ${(err as Error).message}`); }
    }
    this.q.saveTargetState(lead.id, { analysis: out, analysis_at: out.analysed_at });
    return out;
  }

  /** Daily: every open lead gets a fresh read (Claude for the ones that moved or are new, rules for the rest). */
  async refresh(opts: { leadId?: number; useLlm?: boolean } = {}): Promise<{ analysed: number; errors: string[] }> {
    if (this.refreshing) return { analysed: 0, errors: ['Already refreshing'] };
    this.refreshing = true;
    const errors: string[] = [];
    let analysed = 0;
    try {
      const states = this.q.listTargetStates();
      const leads = this.q.listLeads(false).filter((l) => (!opts.leadId || l.id === opts.leadId) && (opts.leadId || (!l.signed && states.get(l.id)?.status !== 'lost')));
      let llmBudget = 80;
      for (const lead of leads) {
        try {
          const st = states.get(lead.id);
          const moved = !st?.analysis || (lead.updated_at > (st.analysis_at ?? '')) || (Date.now() - Date.parse(st.analysis_at ?? '0') > 3 * 86400000);
          const useLlm = opts.useLlm ?? (moved && llmBudget > 0);
          if (useLlm) llmBudget -= 1;
          await this.analyse(lead, { useLlm });
          analysed += 1;
        } catch (err) { errors.push(`${lead.name}: ${(err as Error).message}`); }
      }
      this.q.setSetting('targets_last_refresh_at', new Date().toISOString());
      this.q.setSetting('targets_last_refresh_error', errors.join(' · ').slice(0, 500));
    } finally {
      this.refreshing = false;
      liveEvents.emitUpdate({ kind: 'leads' });
    }
    return { analysed, errors };
  }

  data(month?: string | null, viewer?: string | null): TargetsData {
    const tz = this.q.getSetting('check_timezone', 'Europe/Madrid');
    const today = todayIn(tz);
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
    const states = this.q.listTargetStates();
    const people = this.q.listPeople();
    const seenKey = `targets_seen_at:${viewer ?? '*'}`;
    const seenAt = this.q.getSetting(seenKey, '') || null;
    const currency = leadsSettings(this.q).currency;
    const inMonth = (iso: string | null) => Boolean(iso && iso.slice(0, 7) === m);
    const current = m === today.slice(0, 7);
    const rows: TargetRow[] = [];
    for (const lead of this.q.listLeads(true)) {
      const st = states.get(lead.id) ?? null;
      const status: TargetRow['status'] = lead.signed ? 'ready' : st?.status ?? 'open';
      const wonInMonth = lead.signed && inMonth(lead.signed_at ?? st?.ready_at ?? null);
      const lostInMonth = Boolean(lead.removed_at && inMonth(lead.removed_at)) || Boolean(st?.lost_at && inMonth(st.lost_at)) || (Boolean(lead.stage) && stageOf(lead.stage).lost && inMonth(lead.updated_at));
      const openNow = !lead.removed_at && !lead.signed && st?.status !== 'lost' && !stageOf(lead.stage).lost;
      const addedInMonth = inMonth(lead.added_on ?? lead.first_seen_at);
      const activeInMonth = inMonth(lead.last_contact) || inMonth(lead.updated_at) || inMonth(st?.ready_at ?? null);
      // Current month: everything open plus what closed this month. Past months: what was added, active, won or lost then.
      if (current ? !(openNow || wonInMonth || lostInMonth || (status === 'ready' && inMonth(st?.ready_at ?? null))) : !(addedInMonth || activeInMonth || wonInMonth || lostInMonth)) continue;
      const amId = st?.am_person_id ?? lead.onboarding_id ?? null;
      const am = amId ? people.find((p) => p.id === amId) ?? null : null;
      const onboarding = this.q.onboardingForLead(lead.id);
      const isNew = openNow && (Date.now() - Date.parse(lead.first_seen_at) < 2 * 86400000 || (seenAt !== null && lead.updated_at > seenAt && Date.now() - Date.parse(lead.updated_at) < 7 * 86400000));
      rows.push({ lead, status, am_person_id: amId, am_name: am?.name ?? lead.onboarding_name ?? null, analysis: st?.analysis ?? null, is_new: isNew, ready_at: st?.ready_at ?? null, ready_by: st?.ready_by ?? null, lost_at: st?.lost_at ?? null, onboarding_id: onboarding?.id ?? null, closed_in_month: wonInMonth ? 'won' : lostInMonth ? 'lost' : null });
    }
    const order: Record<TargetLight, number> = { green: 0, amber: 1, red: 2, grey: 3 };
    rows.sort((a, b) => (a.status === 'ready' ? 1 : 0) - (b.status === 'ready' ? 1 : 0) || order[a.analysis?.light ?? 'grey'] - order[b.analysis?.light ?? 'grey'] || (b.analysis?.progress_pct ?? 0) - (a.analysis?.progress_pct ?? 0) || a.lead.name.localeCompare(b.lead.name));
    const open = rows.filter((r) => r.status === 'open' && !r.closed_in_month);
    return {
      month: m, today, rows, people,
      totals: { open: open.length, ready: rows.filter((r) => r.status === 'ready' && !r.lead.signed).length, won: rows.filter((r) => r.closed_in_month === 'won').length, lost: rows.filter((r) => r.closed_in_month === 'lost').length, pipeline_value: open.reduce((n, r) => n + (r.lead.est_value ?? 0), 0), won_value: rows.filter((r) => r.closed_in_month === 'won').reduce((n, r) => n + (r.lead.est_value ?? 0), 0), new: rows.filter((r) => r.is_new).length },
      last_refresh_at: this.q.getSetting('targets_last_refresh_at', '') || null, last_refresh_error: this.q.getSetting('targets_last_refresh_error', '') || null, refreshing: this.refreshing, llm_configured: Boolean(this.llm), currency,
    };
  }

  markSeen(viewer: string | null): void { this.q.setSetting(`targets_seen_at:${viewer ?? '*'}`, new Date().toISOString()); }
}
