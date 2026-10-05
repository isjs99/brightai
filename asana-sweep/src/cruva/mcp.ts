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

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: 'brightform-am-ops', version: '1.0.0' });
      const sse = new URL(`${this.baseUrl}/sse`);
      sse.searchParams.set('api_key', this.apiKey);
      try {
        await client.connect(new SSEClientTransport(sse));
      } catch (err) {
        log.warn(`Cruva MCP over SSE failed (${(err as Error).message}); trying streamable HTTP`);
        const http = new URL(`${this.baseUrl}/mcp`);
        http.searchParams.set('api_key', this.apiKey);
        await client.connect(new StreamableHTTPClientTransport(http));
      }
      client.onclose = () => { this.client = null; };
      client.onerror = (e) => { log.warn(`Cruva MCP: ${e.message}`); };
      this.client = client;
      return client;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
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
    const c = this.client; this.client = null;
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
