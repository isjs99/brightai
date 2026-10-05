import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from '../logger.js';

/**
 * The portal as an MCP client of Cruva (mcp.cruva.com) with the account's API key, so the playbook
 * can read every shop's setup and roll out the missing pieces through the same tools Claude uses.
 * Tool results are plain text listings; parseListing turns them into rows.
 */
export interface McpCaller {
  configured: boolean;
  call(tool: string, args: Record<string, unknown>): Promise<string>;
}

class ToolError extends Error {}

export class CruvaMcp implements McpCaller {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private apiKey = process.env.CRUVA_API_KEY?.trim() ?? '', private baseUrl = (process.env.CRUVA_MCP_URL?.trim() || 'https://mcp.cruva.com').replace(/\/+$/, '')) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Which transport the live session came up on, for the Connections test. */
  transport: string | null = null;

  /**
   * Cruva documents the API-key route as the SSE URL with ?api_key=. Some deployments only accept the
   * key on the streamable HTTP endpoint, so every way is tried in turn and the error of each attempt is
   * kept, so a failure says exactly what was refused instead of hiding behind the last fallback.
   */
  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const key = this.apiKey;
      const headers = { 'x-api-key': key };
      const withKey = (path: string) => { const u = new URL(`${this.baseUrl}${path}`); u.searchParams.set('api_key', key); return u; };
      const attempts: { name: string; make: () => SSEClientTransport | StreamableHTTPClientTransport }[] = [
        { name: 'SSE ?api_key', make: () => new SSEClientTransport(withKey('/sse'), { requestInit: { headers } }) },
        { name: 'HTTP /mcp x-api-key', make: () => new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp`), { requestInit: { headers } }) },
        { name: 'HTTP /mcp ?api_key', make: () => new StreamableHTTPClientTransport(withKey('/mcp'), { requestInit: { headers } }) },
        { name: 'HTTP / x-api-key', make: () => new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/`), { requestInit: { headers } }) },
      ];
      const errors: string[] = [];
      for (const a of attempts) {
        const client = new Client({ name: 'brightform-am-ops', version: '1.0.0' });
        try {
          await client.connect(a.make());
          client.onclose = () => { this.client = null; this.transport = null; };
          client.onerror = (e) => { log.warn(`Cruva MCP: ${e.message}`); };
          this.client = client;
          this.transport = a.name;
          if (errors.length) log.warn(`Cruva MCP connected over ${a.name} after: ${errors.join(' · ')}`);
          return client;
        } catch (err) {
          errors.push(`${a.name}: ${(err as Error).message.replace(/\s+/g, ' ').slice(0, 220)}`);
          await client.close().catch(() => undefined);
        }
      }
      throw new Error(`Cruva MCP refused every connection. ${errors.join(' · ')}`);
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  /** Connect and list shops: what the Connections page's Test button runs. Never throws. */
  async test(): Promise<{ ok: boolean; transport: string | null; shops: number; error: string | null }> {
    if (!this.configured) return { ok: false, transport: null, shops: 0, error: 'CRUVA_API_KEY is not set.' };
    try {
      await this.close();
      const text = await this.call('list_shops', {});
      return { ok: true, transport: this.transport, shops: parseListing(text).length, error: null };
    } catch (err) {
      return { ok: false, transport: null, shops: 0, error: (err as Error).message };
    }
  }

  /** Call a tool. A dropped SSE session or a transient transport error is retried once on a fresh connection; a tool error is not. */
  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.configured) throw new Error('CRUVA_API_KEY is not set (Cruva › Dashboard › API › Generate API key).');
    for (let attempt = 1; ; attempt++) {
      try {
        const c = await this.connect();
        const r = (await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 120000 })) as { content?: { type: string; text?: string }[]; isError?: boolean };
        const text = unwrap((r.content ?? []).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n'));
        if (r.isError) throw new ToolError(`Cruva ${tool}: ${text.slice(0, 400) || 'failed'}`);
        return text;
      } catch (err) {
        if (err instanceof ToolError || attempt >= 3) throw err;
        log.warn(`Cruva MCP ${tool} failed (${(err as Error).message}); reconnecting (attempt ${attempt + 1})`);
        await this.close();
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  async close(): Promise<void> {
    const c = this.client; this.client = null; this.transport = null;
    if (c) await c.close().catch(() => undefined);
  }
}

/** Some gateways wrap a tool's text as {"result": "..."}; unwrap that so parsers see the listing itself. */
export function unwrap(text: string): string {
  const t = text.trim();
  if (t.startsWith('{') && t.includes('"result"')) {
    try { const j = JSON.parse(t) as { result?: unknown }; if (typeof j.result === 'string') return j.result; } catch { /* not JSON */ }
  }
  return text;
}

export interface ListingRow {
  remote_id: string;
  name: string;
  /** false when the row carries a status that reads stopped, paused, archived or completed. */
  enabled: boolean;
  status: string | null;
  fields: Record<string, string>;
  /** Indented continuation lines under the row (status notes, detail blocks). */
  detail: string;
}

/**
 * Parse the plain-text listings the Cruva MCP returns:
 *   - Name (ID: 6ab6…) | Status: active | Message: dm | Audience: groups | Sent: 1,980
 *   - [172309] Memo | affiliates: 2 | emails: 2
 *   - Kijimea DE (ID: 6973…, plan: scale)
 * Continuation lines (indented) attach to the row above.
 */
export function parseListing(text: string): ListingRow[] {
  const out: ListingRow[] = [];
  for (const raw of unwrap(text).split('\n')) {
    if (!raw.trim()) continue;
    const isRow = /^- /.test(raw);
    if (!isRow) {
      if (out.length && /^\s+/.test(raw)) out[out.length - 1].detail += (out[out.length - 1].detail ? '\n' : '') + raw.trim();
      continue;
    }
    const line = raw.slice(2).trim();
    const parts = line.split('|').map((p) => p.trim());
    // A name may itself contain " | " (lists often do): anything before the first "key: value" part belongs to the name.
    let nameEnd = 1;
    while (nameEnd < parts.length && !/^[A-Za-z_ ]{1,30}:\s/.test(parts[nameEnd]) && !/^[A-Za-z_ ]{1,30}:$/.test(parts[nameEnd])) nameEnd += 1;
    let head = parts.slice(0, nameEnd).join(' | ');
    let id = '';
    const idParen = head.match(/\(ID:\s*([A-Za-z0-9_-]+)(?:,\s*([^)]*))?\)/);
    const bracket = head.match(/^\[([A-Za-z0-9_-]+)\]\s*(.*)$/);
    const fields: Record<string, string> = {};
    if (idParen) {
      id = idParen[1];
      if (idParen[2]) for (const kv of idParen[2].split(',')) { const [k, ...v] = kv.split(':'); if (v.length) fields[k.trim().toLowerCase()] = v.join(':').trim(); }
      head = head.replace(idParen[0], '').trim();
    } else if (bracket) { id = bracket[1]; head = bracket[2].trim(); }
    for (const p of parts.slice(nameEnd)) { const i = p.indexOf(':'); if (i > 0) fields[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim(); }
    const status = fields.status ?? null;
    out.push({ remote_id: id || head, name: head, enabled: status ? !/stopped|paused|archived|completed/i.test(status) : true, status, fields, detail: '' });
  }
  return out;
}

/** The "(ID: …)" or "id: …" a create tool prints back, so the new object's id can be stored. */
export function idFromResult(text: string): string | null {
  const t = unwrap(text);
  const m = t.match(/\(ID:\s*([A-Za-z0-9_-]+)/) ?? t.match(/\b(?:id|campaign_id|group_id|workflow_id|list_id|brief_id)\s*[:=]\s*"?([A-Za-z0-9_-]{4,})/i) ?? t.match(/\[(\d{3,})\]/);
  return m ? m[1] : null;
}

/** The pasted-back dm_messages JSON that list_automations prints with include_details, when present. */
export function dmMessagesFromDetail(detail: string): { type?: string; content?: string; title?: string }[] | null {
  const m = detail.match(/dm_messages \(ready for [^)]*\):\s*\n?\s*(\[[\s\S]*?\])\s*(?:\n|$)/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as { type?: string; content?: string }[]; } catch { return null; }
}

export function inviteDetailsFromDetail(detail: string): Record<string, unknown> | null {
  const m = detail.match(/invite_details \(ready for [^)]*\):\s*\n?\s*(\{[\s\S]*?\})\s*(?:\n|$)/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return null; }
}

export function outreachFiltersFromDetail(detail: string): Record<string, unknown> | null {
  const m = detail.match(/Outreach filters:\s*(\{.*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return null; }
}

export const cruvaMcp = new CruvaMcp();
