import type { Queries } from '../db/queries.js';
import type { InboxChannel, InboxConversation, InboxMessage, ReplyAudit, ReplyAuditItem, ReplyAuditSummary, ReplyContext, ReplyEvent } from '../sweep/types.js';
import { buildContext } from './context.js';
import { draftWithClaude } from './llm.js';
import { getPolicy, INTENTS } from './replies.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * The reply audit. Every few days a sample of the replies that went out on their own is scored against a fixed
 * rubric by a stronger model, accounts, intents and languages are ranked worst first, and the run fixes what it can:
 * a library note when two replies would have been helped by it, a standing rule for a generic fault, an intent
 * switched to a human on an account where it keeps failing (and restored when it scores well again), and a note
 * that did not help after two runs switched off. It never sends anything and never touches a note a person wrote.
 */

export const RUBRIC = [
  { key: 'answers', label: 'Answers the question that was asked' },
  { key: 'facts', label: 'Facts right: nothing stated that is not in the context' },
  { key: 'language', label: 'Right language and register, no mixing' },
  { key: 'tone', label: 'Warm, short, no filler, no sign-off block, no placeholders left' },
  { key: 'policy', label: 'No retainer, fee, extra free product, off-account commission, refund or compensation promise' },
  { key: 'next_step', label: 'The next step is clear' },
] as const;
export type RubricKey = (typeof RUBRIC)[number]['key'];
export const FAULTS: Record<string, string> = {
  mixed_language: 'Never mix languages inside one reply; write the whole reply in the reply language.',
  signoff_block: 'No sign-off block: no "Best regards", no team name on its own line, no signature.',
  placeholder_left: 'Never leave a placeholder such as [brand], [name] or {{...}} in the text; use the real value or drop the sentence.',
  too_long: 'Keep replies to five sentences at most.',
  promise_without_fact: 'Never promise a date, an amount or an outcome that is not in the facts; say the team will confirm it.',
};

export interface AuditVerdict { scores: Record<RubricKey, number>; total: number; fail: boolean; why: string; unverified_claim: string | null; note_key: string | null; note: string | null; fault: string | null }

export function auditPrompt(input: { channel: InboxChannel; language: string | null; account: string | null; their_text: string | null; reply_text: string; thread: { who: string; text: string }[]; followup: string | null; intent: string | null; confidence: number | null; ctx: ReplyContext | null; commission_pct: number | null }): { system: string; user: string } {
  const system = [
    `You audit replies a TikTok Shop brand's assistant sent on its own to ${input.channel === 'cs' ? 'buyers' : 'affiliate creators'}. Judge like a careful senior account manager who reads the language natively.`,
    'Score six points, each 0 (fails), 1 (partly) or 2 (fully):',
    ...RUBRIC.map((r, i) => `${i + 1}. ${r.key}: ${r.label}`),
    'A reply with 0 on facts or 0 on policy is a fail whatever the total. Only facts in the context count as facts; anything else the reply states is an unverified claim and must be named.',
    'If a short library note for this account and language would have fixed this reply and others like it, suggest it: note_key is a short snake_case name of the issue (for example shipping_time_unknown, commission_rate), note is one or two sentences the next reply should know. Otherwise null.',
    `If the reply shows a generic fault, name it with one of: ${Object.keys(FAULTS).join(', ')}; otherwise null.`,
    'British English in your reasoning, never invent facts, one sentence for why.',
    'Answer with one JSON object and nothing else: {"scores": {"answers": 0-2, "facts": 0-2, "language": 0-2, "tone": 0-2, "policy": 0-2, "next_step": 0-2}, "why": "...", "unverified_claim": "..." | null, "note_key": "..." | null, "note": "..." | null, "fault": "..." | null}',
  ].join('\n');
  const lines: string[] = [];
  lines.push(`Brand: ${input.account ?? 'unknown'}. Reply language expected: ${input.language ?? 'unknown'}. Intent the assistant chose: ${input.intent ?? 'unknown'}${input.confidence !== null ? ` (confidence ${Math.round(input.confidence * 100)}%)` : ''}.`);
  if (input.commission_pct !== null) lines.push(`Commission on this account: ${input.commission_pct}%.`);
  if (input.ctx) {
    const c = input.ctx;
    if (c.library.length) lines.push('', 'Library notes the assistant had:', ...c.library.map((l) => `- ${l.title}: ${l.body}`));
    if (c.promotions.length) lines.push('', 'Promotions:', ...c.promotions.map((p) => `- ${p.name}: ${p.discount}, ${p.period} (${p.status})`));
    if (c.products.length) lines.push('', 'Products:', ...c.products.slice(0, 20).map((p) => `- ${p.title}${p.price != null ? ` ${p.price} ${p.currency ?? ''}` : ''}${p.stock != null ? `, stock ${p.stock}` : ''}`));
    if (c.samples.length) lines.push('', 'Samples:', ...c.samples.map((s) => `- ${s.product}: ${s.status}${s.requested ? ` (requested ${s.requested.slice(0, 10)})` : ''}`));
    if (c.orders.length) lines.push('', 'Orders:', ...c.orders.slice(0, 5).map((o) => `- ${o.id}: ${o.status}, placed ${o.created}${o.shipped ? `, shipped ${o.shipped}` : ''}${o.delivered ? `, delivered ${o.delivered}` : ''}`));
    if (c.returns.length) lines.push('', 'Returns:', ...c.returns.map((r) => `- ${r.id}: ${r.status}`));
    if (c.creator) lines.push('', `Creator: @${c.creator.handle}, ${c.creator.followers ?? '?'} followers, ${c.creator.videos ?? 0} videos for us, GMV ${c.creator.gmv_for_us ?? 0}, tags ${c.creator.tags.join(', ') || 'none'}.`);
    if (c.brief_link) lines.push(`Brief link: ${c.brief_link}`);
    if (c.notes.length) lines.push('', 'Gaps in the context: ' + c.notes.join('; '));
  } else lines.push('', 'Context: not available for this reply (judge facts against the thread only).');
  if (input.thread.length) lines.push('', 'Thread before the reply (oldest first):', ...input.thread.map((m) => `[${m.who}] ${m.text}`));
  lines.push('', `Their message: ${input.their_text ?? '(empty)'}`);
  lines.push('', `The reply that went out: ${input.reply_text}`);
  if (input.followup) lines.push('', `What they wrote back afterwards: ${input.followup}`);
  return { system, user: lines.join('\n') };
}

export function parseAudit(raw: string): AuditVerdict {
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('the auditor did not answer with JSON');
  const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const sc = (j.scores ?? {}) as Record<string, unknown>;
  const scores = Object.fromEntries(RUBRIC.map((r) => [r.key, Math.max(0, Math.min(2, Math.round(Number(sc[r.key] ?? 0)) || 0))])) as Record<RubricKey, number>;
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);
  const fault = str(j.fault); const noteKey = str(j.note_key)?.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '') ?? null;
  return { scores, total, fail: scores.facts === 0 || scores.policy === 0, why: (str(j.why) ?? '').slice(0, 400), unverified_claim: str(j.unverified_claim)?.slice(0, 300) ?? null, note_key: noteKey, note: noteKey ? str(j.note)?.slice(0, 500) ?? null : null, fault: fault && fault in FAULTS ? fault : null };
}

/** Up to `perAccount` replies per account and channel from the window, covering every intent that occurred, newest first within an intent. */
export function sampleEvents(q: Queries, opts: { since: string; perAccount?: number; nudged?: Map<string, string[]> }): ReplyEvent[] {
  const per = opts.perAccount ?? 25;
  const window = q.listReplyEvents({ since: opts.since, limit: 20000 });
  // A reply is scored once: what an earlier run already audited is left out (it would cost a second call and skew the trend).
  const audited = q.auditForEvents(window.map((e) => e.id));
  const all = window.filter((e) => e.account_id && e.context.reply_text && !audited.has(e.id) && (e.decision === 'auto_sent' || e.feedback === 'wrong' || (opts.nudged?.get(`${e.account_id}:${e.channel}`)?.includes(e.intent ?? '') && (e.decision === 'escalated' || e.decision === 'drafted'))));
  const by = new Map<string, ReplyEvent[]>();
  for (const e of all) { const k = `${e.account_id}:${e.channel}`; by.set(k, [...(by.get(k) ?? []), e]); }
  const out: ReplyEvent[] = [];
  for (const list of by.values()) {
    const wrong = list.filter((e) => e.feedback === 'wrong');
    const rest = list.filter((e) => e.feedback !== 'wrong');
    const byIntent = new Map<string, ReplyEvent[]>();
    for (const e of rest) { const k = e.intent ?? 'other'; byIntent.set(k, [...(byIntent.get(k) ?? []), e]); }
    const picked: ReplyEvent[] = [...wrong.slice(0, per)];
    // Round-robin over intents so a rare one is always represented.
    const queues = [...byIntent.values()].map((l) => [...l].sort((a, b) => b.created_at.localeCompare(a.created_at)));
    while (picked.length < per && queues.some((qq) => qq.length)) for (const qq of queues) { if (picked.length >= per) break; const e = qq.shift(); if (e) picked.push(e); }
    out.push(...picked);
  }
  return out;
}

export interface AuditDeps { llm?: (system: string, user: string) => Promise<string>; now?: number; perAccount?: number; windowHours?: number; context?: (c: InboxConversation, messages: InboxMessage[]) => Promise<ReplyContext | null> }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

export async function runAudit(q: Queries, deps: AuditDeps = {}): Promise<ReplyAudit> {
  const now = deps.now ?? Date.now();
  const since = new Date(now - (deps.windowHours ?? 72) * 3600000).toISOString();
  const nudged = new Map<string, string[]>();
  for (const p of q.listReplyPolicies()) { const n = nudgedIntents(q, p.account_id, p.channel); if (n.length) nudged.set(`${p.account_id}:${p.channel}`, n); }
  const events = sampleEvents(q, { since, perAccount: deps.perAccount, nudged });
  const audit = q.createReplyAudit(since, new Date(now).toISOString());
  const llm = deps.llm ?? ((s: string, u: string) => draftWithClaude(s, u, { feature: 'audit', maxTokens: 700 }));
  const accounts = new Map(q.listAccounts().map((a) => [a.id, a]));
  const items: ReplyAuditItem[] = [];
  let errors = 0;
  for (const e of events) {
    const c = q.getConversation(e.conversation_ref);
    if (!c) continue;
    const messages = q.listMessages(c.id, 80);
    const idx = messages.findIndex((m) => m.message_id === e.message_id);
    const before = (idx >= 0 ? messages.slice(Math.max(0, idx - 6), idx) : messages.slice(-6)).map((m) => ({ who: m.sender_role === 'us' ? 'us' : 'them', text: (m.text ?? '').slice(0, 400) }));
    const after = messages.filter((m) => m.sender_role === 'them' && m.created_at > e.created_at).slice(0, 2).map((m) => m.text ?? '').filter(Boolean).join(' / ') || null;
    let ctx: ReplyContext | null = null;
    try { ctx = deps.context ? await deps.context(c, messages) : await buildContext(q, c, messages, e.language); } catch { ctx = null; }
    const account = e.account_id ? accounts.get(e.account_id) : undefined;
    try {
      const { system, user } = auditPrompt({ channel: e.channel, language: e.language, account: account?.name ?? c.account_name ?? null, their_text: e.context.their_text, reply_text: e.context.reply_text!, thread: before, followup: after, intent: e.intent, confidence: e.confidence, ctx, commission_pct: account?.commission_pct ?? null });
      const v = parseAudit(await llm(system, user));
      items.push(q.addReplyAuditItem({ audit_id: audit.id, event_id: e.id, conversation_ref: c.id, account_id: e.account_id, channel: e.channel, intent: e.intent, language: e.language, decision: e.decision, scores: v.scores, total: v.total, fail: v.fail, why: v.why, unverified_claim: v.unverified_claim, note_key: v.note_key, note: v.note, fault: v.fault, their_text: e.context.their_text, reply_text: e.context.reply_text, followup_text: after, counterpart: e.context.counterpart ?? c.counterpart_name }));
    } catch (err) {
      errors += 1;
      log.warn(`Reply audit: event ${e.id} not scored: ${(err as Error).message}`);
    }
  }
  const previous = q.listReplyAudits(2).find((a) => a.id !== audit.id) ?? null;
  const prevItems = previous ? q.listReplyAuditItems(previous.id) : [];
  const summary = summarise(q, items, prevItems);
  const actions = selfAudit(q, audit.id, items, q.listReplyAudits(8).filter((a) => a.id !== audit.id && a.finished_at));
  const finished = q.finishReplyAudit(audit.id, { sampled: items.length, mean: r2(mean(items.map((i) => i.total))), fail_rate: items.length ? r2(items.filter((i) => i.fail).length / items.length) : null, summary, actions, error: errors ? `${errors} repl${errors === 1 ? 'y' : 'ies'} could not be scored` : null });
  log.info(`Reply audit #${audit.id}: ${items.length} replies scored, mean ${finished.mean ?? '–'}, fail rate ${finished.fail_rate ?? '–'}, ${actions.length} action(s)`);
  liveEvents.emitUpdate({ kind: 'inbox' });
  return finished;
}

function group<T>(xs: T[], key: (x: T) => string): Map<string, T[]> { const m = new Map<string, T[]>(); for (const x of xs) { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]); } return m; }

export function summarise(q: Queries, items: ReplyAuditItem[], prev: ReplyAuditItem[]): ReplyAuditSummary {
  const accounts = new Map(q.listAccounts().map((a) => [a.id, a.name]));
  const intentLabel = (ch: InboxChannel, k: string | null) => INTENTS[ch].find((i) => i.key === k)?.label ?? k ?? 'other';
  const row = (list: ReplyAuditItem[], prevList: ReplyAuditItem[]) => ({ n: list.length, mean: r2(mean(list.map((i) => i.total))), fail_rate: list.length ? r2(list.filter((i) => i.fail).length / list.length) : null, prev_mean: r2(mean(prevList.map((i) => i.total))), worst: [...list].sort((a, b) => a.total - b.total).slice(0, 3).map((i) => ({ item_id: i.id, counterpart: i.counterpart, total: i.total, fail: i.fail, why: i.why })) });
  const byAccount = [...group(items, (i) => `${i.account_id}:${i.channel}`).entries()].map(([k, list]) => { const [aid, ch] = k.split(':'); return { account_id: Number(aid), account_name: accounts.get(Number(aid)) ?? `#${aid}`, channel: ch as InboxChannel, ...row(list, prev.filter((p) => `${p.account_id}:${p.channel}` === k)) }; });
  const byIntent = [...group(items, (i) => `${i.channel}:${i.intent ?? 'other'}`).entries()].map(([k, list]) => { const [ch, intent] = k.split(':'); return { channel: ch as InboxChannel, intent, label: intentLabel(ch as InboxChannel, intent), ...row(list, prev.filter((p) => `${p.channel}:${p.intent ?? 'other'}` === k)) }; });
  const byLanguage = [...group(items, (i) => i.language ?? 'unknown').entries()].map(([language, list]) => ({ language, ...row(list, prev.filter((p) => (p.language ?? 'unknown') === language)) }));
  const byRubric = RUBRIC.map((r) => ({ key: r.key, label: r.label, mean: r2(mean(items.map((i) => i.scores[r.key]))), zeros: items.filter((i) => i.scores[r.key] === 0).length }));
  const worst = (a: { mean: number | null; fail_rate: number | null }, b: { mean: number | null; fail_rate: number | null }) => (b.fail_rate ?? 0) - (a.fail_rate ?? 0) || (a.mean ?? 99) - (b.mean ?? 99);
  return { by_account: byAccount.sort(worst), by_intent: byIntent.sort(worst), by_language: byLanguage.sort(worst), by_rubric: byRubric, red: byAccount.filter((a) => (a.fail_rate ?? 0) > 0.1 || (a.mean ?? 12) < 7).map((a) => `${a.account_name} (${a.channel === 'cs' ? 'buyers' : 'creators'})`) };
}

const nudgeKey = (accountId: number, channel: InboxChannel) => `audit_nudged:${accountId}:${channel}`;
export function nudgedIntents(q: Queries, accountId: number, channel: InboxChannel): string[] { try { return JSON.parse(q.getSetting(nudgeKey(accountId, channel), '') || '[]') as string[]; } catch { return []; } }

/** What the run changes on its own. Every action is recorded on the audit and reversible from the page. */
export function selfAudit(q: Queries, auditId: number, items: ReplyAuditItem[], past: ReplyAudit[]): ReplyAudit['actions'] {
  const actions: ReplyAudit['actions'] = [];
  const existing = q.listContext();
  // 1. Library notes: the same note_key on two or more replies of an account, channel and language.
  for (const [k, list] of group(items.filter((i) => i.note_key && i.note && i.account_id), (i) => `${i.account_id}:${i.channel}:${i.language ?? 'en'}:${i.note_key}`)) {
    if (list.length < 2) continue;
    const [aid, ch, lang, noteKey] = k.split(':');
    const title = `Audit: ${noteKey.replace(/_/g, ' ')}`;
    if (existing.some((e) => e.account_id === Number(aid) && e.title === title && e.enabled)) continue;
    const entry = q.createContext({ language: lang && lang !== 'en' ? lang : '*', scope: ch as InboxChannel, account_id: Number(aid), title, body: list[0].note!, enabled: true });
    actions.push({ kind: 'note', note_id: entry.id, account_id: Number(aid), channel: ch as InboxChannel, language: lang, note_key: noteKey, title, body: list[0].note!, replies: list.length, undone: false });
  }
  // 2. Standing rules for a generic fault seen three times or more.
  const rules = replyRules(q);
  for (const [fault, list] of group(items.filter((i) => i.fault), (i) => i.fault!)) {
    if (list.length < 3 || rules.includes(FAULTS[fault])) continue;
    rules.push(FAULTS[fault]);
    actions.push({ kind: 'rule', fault, rule: FAULTS[fault], replies: list.length, undone: false });
  }
  if (actions.some((a) => a.kind === 'rule')) q.setSetting('reply_rules', JSON.stringify(rules));
  // 3. Policy nudges: an intent failing on an account goes to a human there; restored when it scores well again.
  for (const [k, list] of group(items.filter((i) => i.account_id && i.intent), (i) => `${i.account_id}:${i.channel}:${i.intent}`)) {
    const [aid, ch, intent] = k.split(':'); const accountId = Number(aid); const channel = ch as InboxChannel;
    if (list.length < 3) continue;
    const failRate = list.filter((i) => i.fail).length / list.length; const m = mean(list.map((i) => i.total)) ?? 0;
    const policy = getPolicy(q, accountId, channel);
    const nudged = nudgedIntents(q, accountId, channel);
    if (failRate > 0.2 && !policy.never.includes(intent)) {
      q.saveReplyPolicy({ ...policy, never: [...policy.never, intent], updated_at: new Date().toISOString() });
      q.setSetting(nudgeKey(accountId, channel), JSON.stringify([...new Set([...nudged, intent])]));
      actions.push({ kind: 'nudge', account_id: accountId, channel, intent, direction: 'to_human', fail_rate: r2(failRate)!, undone: false });
    } else if (nudged.includes(intent) && failRate === 0 && m >= 8) {
      q.saveReplyPolicy({ ...policy, never: policy.never.filter((x) => x !== intent), updated_at: new Date().toISOString() });
      q.setSetting(nudgeKey(accountId, channel), JSON.stringify(nudged.filter((x) => x !== intent)));
      actions.push({ kind: 'nudge', account_id: accountId, channel, intent, direction: 'restored', fail_rate: 0, undone: false });
    }
  }
  // 4. Re-audit of the notes earlier runs added: one that did not reduce its issue after two runs is switched off.
  const seen = new Set<number>();
  for (const prevAudit of past) {
    const prevItems = q.listReplyAuditItems(prevAudit.id);
    for (const a of prevAudit.actions) {
      if (a.kind !== 'note' || a.undone || seen.has(a.note_id)) continue;
      seen.add(a.note_id);
      if (!q.listContext().some((e) => e.id === a.note_id && e.enabled)) continue;
      const then = prevItems.filter((i) => i.account_id === a.account_id && i.note_key === a.note_key).length;
      const nowCount = items.filter((i) => i.account_id === a.account_id && i.note_key === a.note_key).length;
      const key = `audit_note_misses:${a.note_id}`;
      const misses = Number(q.getSetting(key, '0')) + (nowCount >= then && nowCount > 0 ? 1 : 0);
      q.setSetting(key, String(misses));
      if (misses >= 2) {
        q.updateContext(a.note_id, { enabled: false });
        actions.push({ kind: 'note_disabled', note_id: a.note_id, account_id: a.account_id, channel: a.channel, note_key: a.note_key, why: `still ${nowCount} repl${nowCount === 1 ? 'y' : 'ies'} with this issue after two runs`, undone: false });
      } else if (nowCount < then) actions.push({ kind: 'note_checked', note_id: a.note_id, account_id: a.account_id, channel: a.channel, note_key: a.note_key, why: `${then} → ${nowCount} repl${nowCount === 1 ? 'y' : 'ies'} with this issue`, undone: false });
    }
  }
  void auditId;
  return actions;
}

export function replyRules(q: Queries): string[] { try { const r = JSON.parse(q.getSetting('reply_rules', '') || '[]'); return Array.isArray(r) ? r.map(String) : []; } catch { return []; } }

/** Undo one action of a run: a note is disabled, a rule removed, a nudge reversed. */
export function undoAuditAction(q: Queries, auditId: number, index: number): ReplyAudit {
  const audit = q.getReplyAudit(auditId);
  if (!audit) throw new Error('Audit not found');
  const a = audit.actions[index];
  if (!a) throw new Error('No such action');
  if (a.undone) return audit;
  if (a.kind === 'note') q.updateContext(a.note_id, { enabled: false });
  else if (a.kind === 'note_disabled') q.updateContext(a.note_id, { enabled: true });
  else if (a.kind === 'rule') q.setSetting('reply_rules', JSON.stringify(replyRules(q).filter((r) => r !== a.rule)));
  else if (a.kind === 'nudge') {
    const policy = getPolicy(q, a.account_id, a.channel);
    const nudged = nudgedIntents(q, a.account_id, a.channel);
    if (a.direction === 'to_human') { q.saveReplyPolicy({ ...policy, never: policy.never.filter((x) => x !== a.intent), updated_at: new Date().toISOString() }); q.setSetting(nudgeKey(a.account_id, a.channel), JSON.stringify(nudged.filter((x) => x !== a.intent))); }
    else { q.saveReplyPolicy({ ...policy, never: [...new Set([...policy.never, a.intent])], updated_at: new Date().toISOString() }); q.setSetting(nudgeKey(a.account_id, a.channel), JSON.stringify([...new Set([...nudged, a.intent])])); }
  }
  const actions = audit.actions.map((x, i) => (i === index ? { ...x, undone: true } : x));
  q.setReplyAuditActions(auditId, actions);
  liveEvents.emitUpdate({ kind: 'inbox' });
  return q.getReplyAudit(auditId)!;
}

/** Five lines for Slack. */
export function auditSlackText(audit: ReplyAudit, publicUrl: string): string {
  const s = audit.summary;
  const trend = audit.prev_mean !== null && audit.mean !== null ? (audit.mean > audit.prev_mean + 0.2 ? ' ↑' : audit.mean < audit.prev_mean - 0.2 ? ' ↓' : ' →') : '';
  const worstAccount = s.by_account[0]; const worstIntent = s.by_intent[0];
  const notes = audit.actions.filter((a) => a.kind === 'note').length; const nudges = audit.actions.filter((a): a is Extract<ReplyAudit['actions'][number], { kind: 'nudge' }> => a.kind === 'nudge' && a.direction === 'to_human');
  return [
    `*Reply audit*: ${audit.sampled} replies scored, mean ${audit.mean ?? '–'}/12${trend}, fail rate ${audit.fail_rate === null ? '–' : `${Math.round(audit.fail_rate * 100)}%`}.`,
    worstAccount ? `Worst account: ${worstAccount.account_name} (${worstAccount.channel === 'cs' ? 'buyers' : 'creators'}) ${worstAccount.mean ?? '–'}/12, ${Math.round((worstAccount.fail_rate ?? 0) * 100)}% fails.` : 'No account had enough replies.',
    worstIntent ? `Worst topic: ${worstIntent.label} ${worstIntent.mean ?? '–'}/12 over ${worstIntent.n}.` : '',
    `${notes} library note${notes === 1 ? '' : 's'} added${nudges.length ? `, ${nudges.map((n) => n.intent).join(', ')} switched to a human on ${nudges.length} account${nudges.length === 1 ? '' : 's'}` : ''}${s.red.length ? `. Red: ${s.red.join(', ')}` : ''}.`,
    `${publicUrl}/replies/audit`,
  ].filter(Boolean).join('\n');
}
