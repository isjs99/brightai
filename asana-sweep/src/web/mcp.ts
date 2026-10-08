import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Queries } from '../db/queries.js';
import type { Scheduler } from '../scheduler/index.js';
import { config } from '../config.js';
import { overview as repliesOverview } from '../inbox/replies.js';
import { buildGmv } from '../reports/index.js';
import { log } from '../logger.js';

/**
 * The dashboard as an MCP server, so Claude Code, Cowork and the Claude apps can ask the platform directly:
 * accounts and their lights, open flags, Cruva shops with what sells, voice and competitors, rollouts,
 * samples, replies, checklists, GMV, stock, incidents, and the client copilot. Streamable HTTP, stateless
 * (one server per request), bearer tokens from the environment: MCP_TOKEN reads and, with MCP_WRITES=1,
 * acts (learn, prepare, optimise, scan, accept samples); MCP_AM_TOKEN reads only.
 */

export type McpRole = 'admin' | 'am';

const safeEqual = (a: string, b: string): boolean => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function mcpRoleOf(authorization: string | undefined): McpRole | null {
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  if (config.mcpToken && safeEqual(token, config.mcpToken)) return 'admin';
  if (config.mcpAmToken && safeEqual(token, config.mcpAmToken)) return 'am';
  return null;
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** An account by id or by (part of) its name. */
function findAccount(q: Queries, ref: string | number | undefined | null) {
  if (ref === undefined || ref === null || ref === '') return null;
  const accounts = q.listAccounts();
  const n = Number(ref);
  if (Number.isInteger(n) && n > 0) return accounts.find((a) => a.id === n) ?? null;
  const k = String(ref).toLowerCase();
  return accounts.find((a) => a.name.toLowerCase() === k) ?? accounts.find((a) => a.name.toLowerCase().includes(k)) ?? null;
}

export function buildMcpServer(q: Queries, scheduler: Scheduler, role: McpRole): McpServer {
  const server = new McpServer({ name: 'brightform-ops', version: '1.0' });
  const { playbook, samples, stock, incidents, health, monitor, copilot } = scheduler;
  const shopOf = (ref: string) => { const shops = playbook.shops(); const k = ref.toLowerCase(); return shops.find((s) => s.shop_id === ref) ?? shops.find((s) => s.shop_name.toLowerCase() === k) ?? shops.find((s) => s.shop_name.toLowerCase().includes(k)) ?? null; };
  const accountRef = z.string().optional().describe('Account id or (part of) its name; omit for every account');
  const shopRef = z.string().describe('Cruva shop id or (part of) its name, e.g. "Kijimea DE"');

  server.registerTool('list_accounts', { title: 'Accounts', description: 'Every client account: id, name, markets, AM, enabled, Slack channel, with its Cruva shops.', inputSchema: {} }, async () => {
    const shops = playbook.shops();
    return text(q.listAccounts().map((a) => ({ id: a.id, name: a.name, markets: a.markets, am: a.am_name, enabled: a.enabled, slack_channel: a.slack_channel, cruva_shops: shops.filter((s) => s.account_id === a.id).map((s) => ({ shop_id: s.shop_id, shop_name: s.shop_name, market: s.market })) })));
  });

  server.registerTool('account_overview', { title: 'Account overview', description: 'One account against the TikTok Shop API, Cruva and its targets: traffic lights per area, KPIs, open flags, targets, campaigns and the latest AI assessment (the Accounts › Overview page). Series are left out.', inputSchema: { account: z.string().describe('Account id or name') } }, async ({ account }) => {
    const a = findAccount(q, account);
    if (!a) return fail(`No account matches "${account}".`);
    const o = health.accountOverview(a.id, monitor.rules());
    if (!o) return fail('No overview for this account yet.');
    const { series: _series, ...rest } = o as unknown as Record<string, unknown>;
    return text(rest);
  });

  server.registerTool('open_flags', { title: 'Open alerts', description: 'The open monitor flags (alerts), worst first, optionally for one account.', inputSchema: { account: accountRef } }, async ({ account }) => {
    const a = findAccount(q, account);
    if (account && !a) return fail(`No account matches "${account}".`);
    const rules = new Map(monitor.rules().map((r) => [r.code, r.title]));
    const order = { crit: 0, warn: 1, info: 2 };
    return text(q.listFlags(false).filter((f) => !a || f.account_id === a.id).sort((x, y) => order[x.severity] - order[y.severity]).map((f) => ({ id: f.id, account: f.account_name, severity: f.severity, rule: rules.get(f.code) ?? f.code, message: f.message, detail: f.detail, since: f.first_seen_at, acknowledged: Boolean(f.acknowledged_at) })));
  });

  server.registerTool('cruva_shops', { title: 'Cruva shops', description: 'Every linked Cruva shop with its setup state: what was learnt (top videos, voice, competitors), outreach health (DMs out, days silent, live bots, Always-on), switches and errors.', inputSchema: { account: accountRef } }, async ({ account }) => {
    const a = findAccount(q, account);
    if (account && !a) return fail(`No account matches "${account}".`);
    return text(playbook.shops().filter((s) => !a || s.account_id === a.id).map((s) => ({ shop_id: s.shop_id, shop_name: s.shop_name, account: s.account_name, market: s.market, language: s.language, learnt: { profile: s.profile ? { learned_at: s.profile.learned_at, summary: s.profile.summary, best_hook: s.profile.hooks[0] ?? null, offer: s.profile.offer, top_creators: s.profile.top_creators.slice(0, 3) } : null, voice: s.voice ? s.voice.summary : null, competitors: s.competitors, market_read: s.market_read ? { learned_at: s.market_read.learned_at, summary: s.market_read.summary, trends: s.market_read.trends.map((t) => t.name) } : null, learning: s.learning }, outreach: s.outreach, top_pct: s.top_pct, auto_update: s.auto_update, error: s.error })));
  });

  server.registerTool('cruva_profile', { title: 'Cruva shop profile', description: 'Everything learnt about one shop: the content profile (hooks, formats, products that carry, timing, offer, example scripts, ideas, top creators), the voice, the direct competitors and the market read (trends, hooks, products, gaps, creators to approach, top competitor videos).', inputSchema: { shop: shopRef } }, async ({ shop }) => {
    const s = shopOf(shop);
    if (!s) return fail(`No Cruva shop matches "${shop}".`);
    const c = playbook.competitors(s.shop_id);
    return text({ shop: { shop_id: s.shop_id, shop_name: s.shop_name, market: s.market, language: s.language }, profile: s.profile, voice: s.voice, competitors: c.competitors, market_read: c.market, learned: s.learned });
  });

  server.registerTool('cruva_rollouts', { title: 'Cruva rollouts', description: 'Recent best-practice rollouts (status, shops, draft counts); pass rollout_id for its drafts with the copy.', inputSchema: { rollout_id: z.number().int().optional(), limit: z.number().int().min(1).max(100).optional() } }, async ({ rollout_id, limit }) => {
    if (rollout_id) { const r = q.getRollout(rollout_id); if (!r) return fail('No such rollout.'); return text({ rollout: r, drafts: q.listRolloutDrafts(rollout_id).map((d) => ({ id: d.id, shop: d.shop_name, kind: d.kind, key: d.key, name: d.name, action: d.action, status: d.status, language: d.language, copy: d.copy, blockers: d.blockers, tailored_at: d.tailored_at })) }); }
    return text(q.listRollouts(limit ?? 20));
  });

  server.registerTool('samples', { title: 'Samples', description: 'The sample traffic light per account: rules, cap from targets, pending requests, the shortlist to accept, needs-a-look and skipped with reasons, accepted this week.', inputSchema: { account: accountRef } }, async ({ account }) => {
    const a = findAccount(q, account);
    if (account && !a) return fail(`No account matches "${account}".`);
    const d = samples.data();
    return text(d.accounts.filter((x) => !a || x.account_id === a.id).map((x) => ({ ...x, shops: x.shops.map((sh) => ({ ...sh, shortlist: sh.shortlist.map((r) => ({ apply_id: r.apply_id, handle: r.handle, followers: r.followers, gmv_30d: r.gmv_30d, engagement: r.engagement, post_rate: r.post_rate, product: r.product, score: r.score, reasons: r.reasons })), review: sh.review.map((r) => ({ apply_id: r.apply_id, handle: r.handle, reasons: r.reasons })), skipped: sh.skipped.length, accepted: sh.accepted.slice(0, 10).map((r) => ({ handle: r.handle, decided_at: r.decided_at, by: r.decided_by })) })) })));
  });

  server.registerTool('replies_summary', { title: 'Replies', description: 'Creator and customer-service auto-replies per account: replied, waiting for a human, switches, and the conversations waiting with the reason.', inputSchema: {} }, async () => {
    const o = repliesOverview(q, (scope) => health.scopeLive(scope));
    return text({ rows: o.rows, waiting: o.waiting.map((w) => ({ id: w.id, account: w.account_name, shop: w.shop_name, channel: w.channel, from: w.counterpart_name, last_message_at: w.last_message_at, last_message: w.last_message_text, reason: w.reason })) });
  });

  server.registerTool('checklist', { title: 'Daily checklist', description: "One account's checklist items (what the AM checks daily and weekly) and where they come from.", inputSchema: { account: z.string().describe('Account id or name') } }, async ({ account }) => {
    const a = findAccount(q, account);
    if (!a) return fail(`No account matches "${account}".`);
    return text({ account: a.name, source: q.checklistSource(a.id), items: q.checklistItemsFor(a.id) });
  });

  server.registerTool('gmv', { title: 'GMV', description: 'GMV per shop for a month (YYYY-MM, default this month) from TikTok, Windsor or Cruva: totals, affiliate share, pace against target.', inputSchema: { month: z.string().regex(/^\d{4}-\d{2}$/).optional() } }, async ({ month }) => text(buildGmv(q, month ?? new Date().toISOString().slice(0, 7))));

  server.registerTool('stock', { title: 'Stock', description: 'Days of stock left per shop and the SKUs that are out, critical or low.', inputSchema: {} }, async () => text(stock.data()));

  server.registerTool('incidents', { title: 'Incidents', description: 'Open incidents and their state.', inputSchema: {} }, async () => text(incidents.data()));

  server.registerTool('ask', { title: 'Ask the client copilot', description: 'Ask a question about an account in plain words; the copilot answers from calls, Slack, email, Drive and the numbers, with sources. Slow (a Claude call).', inputSchema: { question: z.string().min(3), account: accountRef, as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() } }, async ({ question, account, as_of }) => {
    const a = findAccount(q, account);
    if (account && !a) return fail(`No account matches "${account}".`);
    const created = await copilot.ask({ account_id: a?.id ?? null, question, source: 'manual', created_by: `mcp:${role}`, audience: 'internal', as_of: as_of ?? null });
    if (!created) return fail('The copilot could not take the question.');
    return text({ answer: created.answer, sources: created.sources });
  });

  if (role === 'admin' && config.mcpWrites) {
    server.registerTool('cruva_learn', { title: 'Learn a shop now', description: 'Read the shop again: top videos, voice, competitors and the market read.', inputSchema: { shop: shopRef } }, async ({ shop }) => { const s = shopOf(shop); if (!s) return fail(`No Cruva shop matches "${shop}".`); const r = await playbook.learnShop(s.shop_id); return text({ errors: r.errors, profile: r.profile?.summary ?? null, voice: r.voice?.summary ?? null, market: r.market?.summary ?? null }); });
    server.registerTool('cruva_prepare_rollout', { title: 'Prepare a rollout', description: 'Draft the missing best-practice pieces for the shops (learnt first where needed, tailored in the background). Nothing is applied until approved in the dashboard.', inputSchema: { shops: z.array(shopRef).min(1) } }, async ({ shops }) => { const ids = shops.map((x) => shopOf(x)?.shop_id).filter((x): x is string => Boolean(x)); if (!ids.length) return fail('No shop matched.'); const r = await playbook.prepareTailored({ shop_ids: ids, created_by: `mcp:${role}` }); return text({ rollout_id: r.rollout.id, drafts: r.drafts.length, url: `${config.publicUrl}/cruva?rollout=${r.rollout.id}` }); });
    server.registerTool('cruva_optimise_copy', { title: 'Optimise bot copy', description: 'Redo the copy of every live bot on the shops from the top videos, competitors, campaigns and season. apply=true applies it straight away; otherwise it waits in the dashboard.', inputSchema: { shops: z.array(shopRef).min(1), apply: z.boolean().optional() } }, async ({ shops, apply }) => { const ids = shops.map((x) => shopOf(x)?.shop_id).filter((x): x is string => Boolean(x)); if (!ids.length) return fail('No shop matched.'); return text(await playbook.optimiseCopy({ shopIds: ids, apply: Boolean(apply), actor: `mcp:${role}` })); });
    server.registerTool('samples_scan', { title: 'Scan sample requests', description: 'Read the shop\'s pending sample requests now, research the creators and refresh the shortlist (auto-accept runs where the account allows it).', inputSchema: { shop: shopRef } }, async ({ shop }) => { const s = shopOf(shop); if (!s) return fail(`No Cruva shop matches "${shop}".`); const r = await samples.scanShop(s.shop_id); return text({ pending: r.pending, shortlist: r.shortlist.length, review: r.review.length, skipped: r.skipped.length, accepted_week: r.accepted_week, cap: r.cap }); });
    server.registerTool('samples_accept', { title: 'Accept sample requests', description: 'Approve sample requests in Cruva by apply_id (from the samples tool). This ships product and cannot be undone: pass confirm=true.', inputSchema: { shop: shopRef, apply_ids: z.array(z.string().regex(/^\d+$/)).min(1), confirm: z.boolean() } }, async ({ shop, apply_ids, confirm }) => { if (!confirm) return fail('Pass confirm=true to approve: Cruva ships the product.'); const s = shopOf(shop); if (!s) return fail(`No Cruva shop matches "${shop}".`); const r = await samples.accept(s.shop_id, apply_ids, `mcp:${role}`); return text({ accepted: r.accepted.map((x) => x.handle), skipped: r.skipped }); });
  }
  return server;
}

/** One request, one server: stateless Streamable HTTP, so nothing is kept between calls and any instance can answer. */
export async function handleMcp(q: Queries, scheduler: Scheduler, req: Request, res: Response): Promise<void> {
  if (!config.mcpToken && !config.mcpAmToken) { res.status(404).json({ error: 'MCP is not enabled: set MCP_TOKEN.' }); return; }
  const role = mcpRoleOf(req.headers.authorization);
  if (!role) { res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'A valid bearer token is required.' }); return; }
  if (req.method !== 'POST') { res.status(405).set('Allow', 'POST').json({ error: 'This MCP server is stateless: POST only.' }); return; }
  const server = buildMcpServer(q, scheduler, role);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); } catch (err) { log.warn(`MCP: ${(err as Error).message}`); if (!res.headersSent) res.status(500).json({ error: (err as Error).message }); }
}
