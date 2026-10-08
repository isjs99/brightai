import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { PlaybookEngine } from '../src/playbook/index';
import { SampleEngine } from '../src/samples/index';
import { buildMcpServer, mcpRoleOf } from '../src/web/mcp';
import { config } from '../src/config';
import type { Scheduler } from '../src/scheduler/index';
import type { McpCaller } from '../src/cruva/mcp';

/** The engines the MCP tools reach for, real where they are cheap, stubbed where they need the world. */
function setup() {
  const q = new Queries(openTestDb());
  const a = q.createAccount({ name: 'MCP Test Brand', markets: 'DE', am_name: 'Federica', aa_name: null, enabled: true, notes: null, commission_pct: 15, commission_basis: 'gmv', settlement_pct: 100, slack_channel: '#kijimea', client_slack_channel: null, client_domain: null });
  const mcp: McpCaller = { configured: false, async call() { return ''; } };
  const playbook = new PlaybookEngine(q, mcp, null);
  playbook.seed();
  playbook.linkShop('shop-mcp', 'MCP Test Brand DE', a.id);
  const samples = new SampleEngine(q, playbook, mcp, null, { minGapMs: 0 });
  q.applyScan([{ account_id: a.id, shop_id: 'shop-mcp', code: 'c_dms_silent', severity: 'crit', message: 'MCP Test Brand DE: no DMs sent for 9 days', detail: '0 DMs in the last 28 days' }], { account_ids: [a.id] });
  const scheduler = {
    playbook, samples,
    stock: { data: () => ({ shops: [], alerts: [] }) },
    incidents: { data: () => ({ incidents: [] }) },
    health: { accountOverview: () => null, scopeLive: () => true },
    monitor: { rules: () => [{ code: 'c_dms_silent', title: 'No DMs going out' }] },
    copilot: { ask: async (input: { question: string }) => ({ answer: `Answer to: ${input.question}`, sources: [] }) },
  } as unknown as Scheduler;
  return { q, a, scheduler };
}

async function connect(scheduler: Scheduler, q: Queries, role: 'admin' | 'am') {
  const server = buildMcpServer(q, scheduler, role);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  return client;
}

const textOf = (r: unknown) => String((r as { content: { text: string }[] }).content[0].text);

describe('the dashboard as an MCP server', () => {
  it('maps the bearer tokens to roles', () => {
    const saved = { t: config.mcpToken, am: config.mcpAmToken };
    config.mcpToken = 'admin-secret'; config.mcpAmToken = 'am-secret';
    expect(mcpRoleOf('Bearer admin-secret')).toBe('admin');
    expect(mcpRoleOf('bearer am-secret')).toBe('am');
    expect(mcpRoleOf('Bearer nope')).toBeNull();
    expect(mcpRoleOf(undefined)).toBeNull();
    config.mcpToken = ''; config.mcpAmToken = 'am-secret';
    expect(mcpRoleOf('Bearer admin-secret')).toBeNull(); // an empty token never matches
    config.mcpToken = saved.t; config.mcpAmToken = saved.am;
  });

  it('answers the read tools from the platform and keeps the write tools for the admin token with writes enabled', async () => {
    const { q, a, scheduler } = setup();
    const am = await connect(scheduler, q, 'am');
    const names = (await am.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['account_overview', 'ask', 'checklist', 'cruva_profile', 'cruva_rollouts', 'cruva_shops', 'gmv', 'incidents', 'list_accounts', 'open_flags', 'replies_summary', 'samples', 'stock']);
    const accounts = JSON.parse(textOf(await am.callTool({ name: 'list_accounts', arguments: {} }))) as { name: string; cruva_shops: { shop_id: string }[] }[];
    expect(accounts.find((x) => x.name === 'MCP Test Brand')?.cruva_shops).toEqual([{ shop_id: 'shop-mcp', shop_name: 'MCP Test Brand DE', market: 'DE' }]);
    const flags = JSON.parse(textOf(await am.callTool({ name: 'open_flags', arguments: { account: 'mcp test' } }))) as { rule: string; severity: string }[];
    expect(flags).toHaveLength(1); expect(flags[0]).toMatchObject({ rule: 'No DMs going out', severity: 'crit' });
    const missing = await am.callTool({ name: 'open_flags', arguments: { account: 'Nobody' } });
    expect(missing.isError).toBe(true); expect(textOf(missing)).toMatch(/No account matches/);
    const shops = JSON.parse(textOf(await am.callTool({ name: 'cruva_shops', arguments: { account: String(a.id) } }))) as { shop_name: string; outreach: { live: number } }[];
    expect(shops[0]).toMatchObject({ shop_name: 'MCP Test Brand DE', outreach: { live: 0, always_on: false } });
    const profile = JSON.parse(textOf(await am.callTool({ name: 'cruva_profile', arguments: { shop: 'mcp test brand de' } }))) as { profile: unknown; competitors: unknown[] };
    expect(profile.profile).toBeNull(); expect(profile.competitors).toEqual([]);
    const answer = JSON.parse(textOf(await am.callTool({ name: 'ask', arguments: { question: 'How is it doing?', account: 'MCP Test Brand' } }))) as { answer: string };
    expect(answer.answer).toBe('Answer to: How is it doing?');
    expect(JSON.parse(textOf(await am.callTool({ name: 'samples', arguments: {} }))).some((x: { name: string }) => x.name === 'MCP Test Brand')).toBe(true);
    // Writes: only for the admin token, and only when MCP_WRITES=1.
    const adminNoWrites = await connect(scheduler, q, 'admin');
    expect((await adminNoWrites.listTools()).tools.some((t) => t.name === 'samples_accept')).toBe(false);
    const saved = config.mcpWrites; config.mcpWrites = true;
    try {
      const admin = await connect(scheduler, q, 'admin');
      const all = (await admin.listTools()).tools.map((t) => t.name);
      expect(all).toEqual(expect.arrayContaining(['cruva_learn', 'cruva_prepare_rollout', 'cruva_optimise_copy', 'samples_scan', 'samples_accept']));
      const r = await admin.callTool({ name: 'samples_accept', arguments: { shop: 'MCP Test Brand DE', apply_ids: ['1'], confirm: false } });
      expect(r.isError).toBe(true); expect(textOf(r)).toMatch(/confirm=true/);
    } finally { config.mcpWrites = saved; }
  });
});
