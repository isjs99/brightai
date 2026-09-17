import type { Queries } from '../db/queries.js';
import type { Account, ClientReport, ReportData, ReportsData } from '../sweep/types.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { tldv, type TldvClient } from '../bd/tldv.js';
import { tts, type TtsClient } from '../tts/client.js';
import { shopCredentials } from '../tts/promotions.js';
import { slackBot, type SlackBot } from '../notify/slackbot.js';
import { riseBand } from '../bd/score.js';
import { money } from '../bd/outreach.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';

/**
 * Client reports: weekly or monthly, per account, built from the Cruva GMV sync, the TikTok Shop
 * analytics API, the FastMoss-fed BD pipeline (market context), tl;dv calls with the client,
 * incidents, promotions and checklist completion. Claude writes the narrative; the report is
 * editable and then posted to the client's Slack channel.
 */

export function periodBounds(period: 'weekly' | 'monthly', endDate?: string | null, now = new Date()): { start: string; end: string; prev_start: string; prev_end: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  const add = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
  if (period === 'weekly') {
    let end: Date;
    if (endDate) end = day(endDate);
    else {
      const today = day(iso(now));
      const dow = today.getUTCDay(); // 0 = Sunday
      end = add(today, dow === 0 ? -7 : -dow); // last Sunday
    }
    const start = add(end, -6);
    return { start: iso(start), end: iso(end), prev_start: iso(add(start, -7)), prev_end: iso(add(end, -7)) };
  }
  let ref: Date;
  if (endDate) ref = day(endDate);
  else ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // last day of previous month
  const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
  const prevStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1));
  const prevEnd = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 0));
  return { start: iso(start), end: iso(end), prev_start: iso(prevStart), prev_end: iso(prevEnd) };
}

const pct = (cur: number, prev: number): string => (prev > 0 ? `${cur >= prev ? '+' : ''}${Math.round(((cur - prev) / prev) * 100)}%` : cur > 0 ? 'new' : '0%');
const num = (v: unknown): number | null => { if (v && typeof v === 'object') return num((v as Record<string, unknown>).amount ?? (v as Record<string, unknown>).value); const n = Number(v); return Number.isFinite(n) ? n : null; };

export async function gatherReportData(q: Queries, account: Account, bounds: ReturnType<typeof periodBounds>, deps: { tldv?: TldvClient; tts?: TtsClient } = {}): Promise<ReportData> {
  const shops = q.listShops().filter((s) => s.account_id === account.id);
  const shopIds = new Set(shops.map((s) => s.shop_id));
  const currency = shops[0]?.currency ?? '€';
  const cur = q.listGmvBetween(bounds.start, bounds.end).filter((r) => shopIds.has(r.shop_id));
  const prev = q.listGmvBetween(bounds.prev_start, bounds.prev_end).filter((r) => shopIds.has(r.shop_id));
  const sum = (rows: typeof cur, k: 'total_gmv' | 'affiliate_gmv' | 'units') => rows.reduce((n, r) => n + r[k], 0);
  const gmv: ReportData['gmv'] = {
    total: sum(cur, 'total_gmv'), affiliate: sum(cur, 'affiliate_gmv'), units: sum(cur, 'units'), prev_total: sum(prev, 'total_gmv'), prev_affiliate: sum(prev, 'affiliate_gmv'), prev_units: sum(prev, 'units'), currency, days_with_data: new Set(cur.map((r) => r.date)).size,
    by_shop: shops.map((s) => ({ shop_id: s.shop_id, shop_name: s.shop_name, total: sum(cur.filter((r) => r.shop_id === s.shop_id), 'total_gmv'), affiliate: sum(cur.filter((r) => r.shop_id === s.shop_id), 'affiliate_gmv'), units: sum(cur.filter((r) => r.shop_id === s.shop_id), 'units'), prev_total: sum(prev.filter((r) => r.shop_id === s.shop_id), 'total_gmv') })),
  };

  // TikTok Shop analytics per authorised shop (best effort).
  const ttsRows: ReportData['tts'] = [];
  const client = deps.tts ?? tts;
  if (client.configured) {
    for (const shop of q.listTtsShops().filter((s) => s.account_id === account.id && s.token_ok)) {
      try {
        const creds = await shopCredentials(q, shop.id, client);
        const endExclusive = new Date(new Date(`${bounds.end}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
        const r = await client.call<{ performance?: { intervals?: Record<string, unknown>[] } & Record<string, unknown> }>('GET', '/analytics/202509/shop/performance', { accessToken: creds.accessToken, shopCipher: creds.cipher, query: { start_date_ge: bounds.start, end_date_lt: endExclusive, granularity: 'ALL' } });
        const p = (r.performance?.intervals?.[0] ?? r.performance ?? {}) as Record<string, unknown>;
        ttsRows.push({ shop_id: shop.id, shop_name: shop.name, gmv: num(p.gmv), orders: num(p.orders_count ?? p.orders), refunds: num(p.refunds ?? p.refund_amount), conversion: num(p.avg_conversation_rate ?? p.avg_conversion_rate ?? p.conversion_rate), visitors: num(p.unique_visitors ?? p.visitors ?? (p.traffic as Record<string, unknown> | undefined)?.unique_visitors), error: null });
      } catch (err) {
        ttsRows.push({ shop_id: shop.id, shop_name: shop.name, gmv: null, orders: null, refunds: null, conversion: null, visitors: null, error: (err as Error).message });
      }
    }
  }

  // Market context from the BD pipeline (FastMoss pulls): momentum in the account's markets.
  const markets = (account.markets ?? '').split(/[,\s/]+/).map((m) => m.trim().toUpperCase()).filter(Boolean);
  const prospects = q.listProspects(false);
  const market: ReportData['market'] = markets.map((m) => {
    const inMarket = prospects.filter((p) => p.market === m);
    return { market: m, prospects: inMarket.length, surging: inMarket.filter((p) => riseBand(p.rise_score) === 'surging').length, category_leaders: [...inMarket].sort((a, b) => (b.gmv_7d ?? 0) - (a.gmv_7d ?? 0)).slice(0, 5).map((p) => ({ name: p.brand ?? p.shop_name, gmv_7d: p.gmv_7d, currency: p.currency, category: p.category })) };
  });

  // tl;dv calls with the client during the period.
  const calls: ReportData['calls'] = [];
  const td = deps.tldv ?? tldv;
  if (td.configured) {
    try {
      const meetings = await td.listMeetings({ since: bounds.start, limit: 50 });
      const nameLc = account.name.toLowerCase();
      const domain = account.client_domain?.toLowerCase() ?? null;
      const mine = meetings.filter((m) => m.happenedAt.slice(0, 10) >= bounds.start && m.happenedAt.slice(0, 10) <= bounds.end && ((domain && m.invitees.some((i) => (i.email ?? '').toLowerCase().endsWith(`@${domain}`))) || m.name.toLowerCase().includes(nameLc)));
      for (const m of mine.slice(0, 6)) {
        let notes: string[] = [];
        try { notes = (await td.highlights(m.id)).slice(0, 8); } catch { /* notes optional */ }
        calls.push({ id: m.id, title: m.name, happened_at: m.happenedAt, notes, url: m.url });
      }
    } catch (err) {
      log.warn(`Report: tl;dv lookup failed: ${(err as Error).message}`);
    }
  }

  const incidents = q.listIncidents({ limit: 500 }).filter((i) => i.account_id === account.id && i.created_at.slice(0, 10) >= bounds.start && i.created_at.slice(0, 10) <= bounds.end).map((i) => ({ kind: i.kind, severity: i.severity, title: i.title, created_at: i.created_at, resolved_at: i.resolved_at }));
  const promotions = q.listPromotions().filter((p) => p.targets.some((t) => t.account_id === account.id) && p.begin_at.slice(0, 10) <= bounds.end && p.end_at.slice(0, 10) >= bounds.start).map((p) => ({ name: p.name, begin_at: p.begin_at.slice(0, 10), end_at: p.end_at.slice(0, 10) }));
  const checks = q.listChecksBetween(bounds.start, bounds.end).filter((c) => c.account_id === account.id);
  const byDay = new Map<string, boolean>();
  for (const c of checks) byDay.set(c.check_date, (byDay.get(c.check_date) ?? false) || c.combined_complete);
  const checklist = { days: byDay.size, complete: [...byDay.values()].filter(Boolean).length };
  return { gmv, tts: ttsRows, market, calls, incidents, promotions, checklist, notes: [] };
}

function numbersTable(d: ReportData): string {
  const c = d.gmv.currency;
  const rows = [
    ['Total GMV', money(d.gmv.total, c), money(d.gmv.prev_total, c), pct(d.gmv.total, d.gmv.prev_total)],
    ['Affiliate GMV', money(d.gmv.affiliate, c), money(d.gmv.prev_affiliate, c), pct(d.gmv.affiliate, d.gmv.prev_affiliate)],
    ['Units sold', String(d.gmv.units), String(d.gmv.prev_units), pct(d.gmv.units, d.gmv.prev_units)],
  ];
  if (d.gmv.total > 0) rows.push(['Affiliate share', `${Math.round((d.gmv.affiliate / d.gmv.total) * 100)}%`, d.gmv.prev_total > 0 ? `${Math.round((d.gmv.prev_affiliate / d.gmv.prev_total) * 100)}%` : '–', '']);
  return ['| Metric | This period | Previous | Change |', '|---|---|---|---|', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function renderReportPrompt(account: Account, period: 'weekly' | 'monthly', bounds: ReturnType<typeof periodBounds>, d: ReportData, instructions?: string | null): { system: string; user: string } {
  const system = [
    `You write the ${period} performance report that Brightform (a TikTok Shop Partner agency) sends to its client ${account.name}. British English, plain, confident, no hype, no exclamation marks. Write as "we" (Brightform) to "you" (the client).`,
    'Markdown only. Structure: a 2-sentence headline paragraph; "## The numbers" with the table given (copy it exactly, then one or two lines of interpretation); "## What we did" (bullets, from the calls, promotions, incidents and notes; say what was done and why); "## What we are doing next" (bullets, concrete, dated where possible); "## Market context" (two or three lines from the market data: momentum in the market, who is rising, what it means for the client); "## What we need from you" (bullets; only real asks such as stock, EPR documents, creative, approvals; omit the section if there are none).',
    'Use only the facts given. Never invent numbers, names or events. If a data source is missing (no calls, no TikTok analytics), do not mention the gap to the client; just leave it out. Keep it under 450 words.',
    'Output JSON only: {"subject": "<report title, e.g. Kijimea DE: weekly report 8 to 14 September>", "body": "<markdown>"}.',
  ].join('\n');
  const u: string[] = [`## Account\n${account.name} (${account.markets ?? 'markets not set'}), account manager ${account.am_name ?? 'n/a'}`, `## Period\n${bounds.start} to ${bounds.end} (previous: ${bounds.prev_start} to ${bounds.prev_end})`, '## Numbers table (copy exactly)', numbersTable(d)];
  if (d.gmv.by_shop.length > 1) u.push('## By shop', ...d.gmv.by_shop.map((s) => `- ${s.shop_name}: ${money(s.total, d.gmv.currency)} (previous ${money(s.prev_total, d.gmv.currency)})`));
  if (d.gmv.days_with_data === 0) u.push('(No GMV rows synced for this period; say the numbers will follow rather than inventing them.)');
  const tt = d.tts.filter((t) => !t.error);
  if (tt.length) u.push('## TikTok Shop analytics', ...tt.map((t) => `- ${t.shop_name}: GMV ${t.gmv ?? 'n/a'}, orders ${t.orders ?? 'n/a'}, refunds ${t.refunds ?? 'n/a'}, conversion ${t.conversion ?? 'n/a'}, visitors ${t.visitors ?? 'n/a'}`));
  if (d.calls.length) u.push('## Calls with the client in the period', ...d.calls.map((c) => `- ${c.happened_at.slice(0, 10)} "${c.title}"${c.notes.length ? `\n${c.notes.map((n) => `  - ${n}`).join('\n')}` : ''}`));
  if (d.promotions.length) u.push('## Promotions live in the period', ...d.promotions.map((p) => `- ${p.name} (${p.begin_at} to ${p.end_at})`));
  if (d.incidents.length) u.push('## Issues handled in the period', ...d.incidents.map((i) => `- ${i.created_at.slice(0, 10)} ${i.title}${i.resolved_at ? ' (resolved)' : ' (open)'}`));
  if (d.checklist.days) u.push(`## Daily operations\nChecklist complete on ${d.checklist.complete} of ${d.checklist.days} working days.`);
  if (d.market.length) u.push('## Market context (our FastMoss tracking)', ...d.market.map((m) => `- ${m.market}: ${m.prospects} shops tracked, ${m.surging} surging this week. Leaders by weekly GMV: ${m.category_leaders.map((l) => `${l.name} (${money(l.gmv_7d, l.currency)}${l.category ? `, ${l.category}` : ''})`).join(', ')}`));
  if (d.notes.length) u.push('## Notes from the account manager', ...d.notes.map((n) => `- ${n}`));
  if (instructions?.trim()) u.push('## Extra instructions', instructions.trim());
  u.push('', 'Write the report now as JSON.');
  return { system, user: u.join('\n') };
}

export function templateReport(account: Account, period: 'weekly' | 'monthly', bounds: ReturnType<typeof periodBounds>, d: ReportData): { title: string; body: string } {
  const title = `${account.name}: ${period} report ${bounds.start} to ${bounds.end}`;
  const lines = [
    `${period === 'weekly' ? 'Weekly' : 'Monthly'} update for ${account.name} covering ${bounds.start} to ${bounds.end}. Total GMV came in at ${money(d.gmv.total, d.gmv.currency)} (${pct(d.gmv.total, d.gmv.prev_total)} against the previous period), with affiliate at ${money(d.gmv.affiliate, d.gmv.currency)}.`,
    '', '## The numbers', numbersTable(d), '',
    '## What we did',
    ...(d.calls.length ? d.calls.map((c) => `- ${c.happened_at.slice(0, 10)}: ${c.title}${c.notes[0] ? ` – ${c.notes[0]}` : ''}`) : []),
    ...d.promotions.map((p) => `- Ran "${p.name}" (${p.begin_at} to ${p.end_at})`),
    ...d.incidents.map((i) => `- Handled: ${i.title}${i.resolved_at ? ' (resolved)' : ' (in progress)'}`),
    ...d.notes.map((n) => `- ${n}`),
    ...(d.calls.length + d.promotions.length + d.incidents.length + d.notes.length ? [] : ['- Ongoing affiliate outreach, sample management and daily shop operations']),
    '', '## What we are doing next', '- Keep scaling creator and affiliate volume', '- Review promotions and GMV Max against the numbers above', '',
  ];
  if (d.market.length) lines.push('## Market context', ...d.market.map((m) => `- ${m.market}: ${m.surging} of ${m.prospects} tracked shops are surging this week; leaders include ${m.category_leaders.slice(0, 3).map((l) => l.name).join(', ')}.`), '');
  return { title, body: lines.join('\n').trim() };
}

/** Markdown to Slack mrkdwn, good enough for a report: headings bold, bullets, bold, tables as code. */
export function markdownToSlack(md: string): string {
  const out: string[] = [];
  let table: string[] = [];
  const flush = () => { if (table.length) { out.push('```\n' + table.map((r) => r.replace(/^\|\s*|\s*\|$/g, '').split(/\s*\|\s*/).join('   ')).filter((r) => !/^-+(\s+-+)*$/.test(r.replace(/\s+/g, ' ').trim())).join('\n') + '\n```'); table = []; } };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*\|.*\|\s*$/.test(line)) { table.push(line); continue; }
    flush();
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { out.push(`*${h[1].trim()}*`); continue; }
    out.push(line.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^\s*[-*]\s+/, '• ').replace(/\[(.+?)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>'));
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export class ClientReports {
  constructor(private q: Queries, private deps: { slack?: SlackBot; tldv?: TldvClient; tts?: TtsClient; llm?: ((system: string, user: string) => Promise<string>) | null } = {}) {}

  private get llm(): ((system: string, user: string) => Promise<string>) | null {
    if (this.deps.llm !== undefined) return this.deps.llm;
    return config.anthropicApiKey ? (s, u) => draftWithClaude(s, u, { maxTokens: 2500 }) : null;
  }

  data(): ReportsData {
    const shops = this.q.listShops();
    return {
      reports: this.q.listReports(),
      accounts: this.q.listAccounts().filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, client_slack_channel: a.client_slack_channel, client_domain: a.client_domain, markets: a.markets, shops: shops.filter((s) => s.account_id === a.id).length })),
      slack_configured: (this.deps.slack ?? slackBot).configured, llm_configured: Boolean(this.llm), tldv_configured: (this.deps.tldv ?? tldv).configured, tts_configured: (this.deps.tts ?? tts).configured,
    };
  }

  async write(account: Account, period: 'weekly' | 'monthly', bounds: ReturnType<typeof periodBounds>, data: ReportData, instructions?: string | null): Promise<{ title: string; body: string; generator: 'claude' | 'template' }> {
    const llm = this.llm;
    if (!llm) return { ...templateReport(account, period, bounds, data), generator: 'template' };
    const { system, user } = renderReportPrompt(account, period, bounds, data, instructions);
    const text = await llm(system, user);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    try {
      const j = JSON.parse(text.slice(start, end + 1)) as { subject?: string; body?: string };
      const body = String(j.body ?? '').replace(/\r\n/g, '\n').trim();
      if (!body) throw new Error('empty');
      return { title: String(j.subject ?? '').trim() || templateReport(account, period, bounds, data).title, body: body.replace(/!+/g, '.'), generator: 'claude' };
    } catch {
      return { ...templateReport(account, period, bounds, data), generator: 'template' };
    }
  }

  async generate(accountId: number, period: 'weekly' | 'monthly', opts: { endDate?: string | null; instructions?: string | null; notes?: string[]; actor?: string | null } = {}): Promise<ClientReport> {
    const account = this.q.getAccount(accountId);
    if (!account) throw new Error('Account not found');
    const bounds = periodBounds(period, opts.endDate ?? null);
    const data = await gatherReportData(this.q, account, bounds, { tldv: this.deps.tldv, tts: this.deps.tts });
    data.notes = opts.notes ?? [];
    const w = await this.write(account, period, bounds, data, opts.instructions);
    const report = this.q.createReport({ account_id: account.id, period, period_start: bounds.start, period_end: bounds.end, title: w.title, body: w.body, data, generator: w.generator, slack_channel: account.client_slack_channel, created_by: opts.actor ?? null });
    liveEvents.emitUpdate({ kind: 'reports' });
    return report;
  }

  async regenerate(id: number, opts: { instructions?: string | null; notes?: string[]; refresh?: boolean } = {}): Promise<ClientReport> {
    const r = this.q.getReport(id);
    if (!r) throw new Error('Report not found');
    const account = this.q.getAccount(r.account_id)!;
    const bounds = { start: r.period_start, end: r.period_end, ...(() => { const b = periodBounds(r.period, r.period_end); return { prev_start: b.prev_start, prev_end: b.prev_end }; })() };
    const data = opts.refresh === false ? r.data : await gatherReportData(this.q, account, bounds, { tldv: this.deps.tldv, tts: this.deps.tts });
    data.notes = opts.notes ?? r.data.notes ?? [];
    const w = await this.write(account, r.period, bounds, data, opts.instructions);
    const out = this.q.updateReport(id, { title: w.title, body: w.body, data, generator: w.generator })!;
    liveEvents.emitUpdate({ kind: 'reports' });
    return out;
  }

  /** Post the report to the client channel (long reports continue in the thread). */
  async send(id: number, channel?: string | null): Promise<ClientReport> {
    const r = this.q.getReport(id);
    if (!r) throw new Error('Report not found');
    const slack = this.deps.slack ?? slackBot;
    if (!slack.configured) throw new Error('SLACK_BOT_TOKEN is not set.');
    const target = (channel ?? r.slack_channel ?? '').trim();
    if (!target) throw new Error('Set the client Slack channel on the account (or pick one here) first.');
    const text = markdownToSlack(`# ${r.title}\n\n${r.body}`);
    const chunks: string[] = [];
    let buf = '';
    for (const para of text.split('\n\n')) {
      if ((buf + '\n\n' + para).length > 3500 && buf) { chunks.push(buf); buf = para; } else buf = buf ? `${buf}\n\n${para}` : para;
    }
    if (buf) chunks.push(buf);
    const chanId = await slack.channelId(target);
    const first = await slack.post(chanId, chunks[0]);
    for (const c of chunks.slice(1)) await slack.post(chanId, c, { thread_ts: first.ts });
    const out = this.q.updateReport(id, { status: 'sent', sent_at: new Date().toISOString(), slack_channel: target })!;
    liveEvents.emitUpdate({ kind: 'reports' });
    return out;
  }
}
