import { describe, expect, it } from 'vitest';
import { Queries } from '../src/db/queries';
import { openTestDb } from '../src/db/index';
import { parseDms, parseInbox, sendCruvaDm, syncCruvaInbox } from '../src/inbox/cruva-inbox';
import { channelReadiness } from '../src/inbox/replies';
import type { CruvaMcp } from '../src/cruva/mcp';

const LIST = 'Inbox (UNREPLIED) — 2 conversation(s):\n\n@tamanna..chowdhury - unread: 1 - conversation_id: 7672541979863433494\n@jiggles220 - unread: 4 - conversation_id: 7685835102636343574\n\nMore results available. To fetch the next page, call list_inbox again with page_token="1791239060454" (keep the same conversation_status and page_size).';
const DMS = 'Messages with @jiggles220:\n\n[Oct 05, 2026 09:12 PM UTC] brand (message_id: 111): Hey, your sample shipped today.\nTracking follows.\n[Oct 06, 2026 12:03 AM UTC] creator (message_id: 222): Thanks. Which product should I film first?';

describe('creator inbox through Cruva', () => {
  it('parses the inbox listing and the thread text', () => {
    const l = parseInbox(LIST);
    expect(l.rows).toEqual([{ handle: 'tamanna..chowdhury', unread: 1, conversation_id: '7672541979863433494' }, { handle: 'jiggles220', unread: 4, conversation_id: '7685835102636343574' }]);
    expect(l.next).toBe('1791239060454');
    expect(parseInbox('Inbox (ALL) — 0 conversation(s).').rows).toEqual([]);
    const d = parseDms(DMS);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ message_id: '111', sender: 'brand', created_at: '2026-10-05T21:12:00.000Z', text: 'Hey, your sample shipped today.\nTracking follows.' });
    expect(d[1]).toMatchObject({ message_id: '222', sender: 'creator', created_at: '2026-10-06T00:03:00.000Z' });
    expect(parseDms('[Oct 06, 2026 12:03 AM UTC] sender_id 3071 (message_id: 333): hi')[0]).toMatchObject({ sender: 'unknown', sender_id: '3071' });
  });

  it('stores Cruva threads next to the TikTok ones and answers through send_dm', async () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Kijimea', markets: 'DE', am_name: 'Ana', aa_name: null, enabled: true, notes: null, commission_pct: 15, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    q.addShop(a.id, 'cr-1', 'Kijimea DE', 'EUR', 'cruva');
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const mcp = { configured: true, call: async (tool: string, args: Record<string, unknown>) => { calls.push({ tool, args }); if (tool === 'list_inbox') return args.conversation_status === 'ALL' ? 'Inbox (ALL) — 0 conversation(s).' : LIST.replace(/More results.*$/s, ''); if (tool === 'read_dms') return DMS; if (tool === 'send_dm') return 'Sent to @jiggles220 (message_id: 999)'; return ''; } } as unknown as CruvaMcp;
    const r = await syncCruvaInbox(q, { accountId: a.id }, { mcp });
    expect(r).toMatchObject({ ok: true, shops: 1, conversations: 2, new_messages: 4 });
    const convs = q.listConversations({ accountId: a.id, channel: 'affiliate' });
    expect(convs).toHaveLength(2);
    const j = convs.find((c) => c.counterpart_name === 'jiggles220')!;
    expect(j).toMatchObject({ source: 'cruva', shop_name: 'Kijimea DE', market: 'DE', account_name: 'Kijimea', last_sender: 'them', can_send: true });
    expect(q.listMessages(j.id, 10).map((m) => m.sender_role)).toEqual(['us', 'them']);
    // Readiness: the account is live for creators through Cruva, with the Cruva shop in the country rows.
    const ready = channelReadiness(q, a.id, 'affiliate', () => false, { main: false, affiliate: false, cruva: true });
    expect(ready.ready).toBe(true);
    expect(ready.shops).toEqual([{ id: 'cr-1', name: 'Kijimea DE', market: 'DE', token_ok: true, off: false, language: null, source: 'cruva' }]);
    expect(channelReadiness(q, a.id, 'affiliate', () => false, { main: false, affiliate: false, cruva: false }).note).toMatch(/CRUVA_API_KEY/);
    const sent = await sendCruvaDm('cr-1', j.conversation_id, 'jiggles220', 'Start with the 60-cap.', mcp);
    expect(sent.message_id).toBe('999');
    expect(calls.at(-1)).toMatchObject({ tool: 'send_dm', args: { shop_id: 'cr-1', conversation_id: j.conversation_id, handle: 'jiggles220', message: 'Start with the 60-cap.' } });
    // A second sync with nothing new reads no threads again (unread stays as reported, so unread > 0 re-reads).
    const r2 = await syncCruvaInbox(q, { accountId: a.id }, { mcp });
    expect(r2.new_messages).toBe(0);
  });
});
