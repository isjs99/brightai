import { log } from '../logger.js';

/**
 * Slack Web API client for direct messages. Needs a bot token (xoxb-...) with
 * chat:write, users:read and users:read.email scopes. Incoming webhooks cannot DM
 * arbitrary users, which is why this exists alongside notify/slack.ts.
 */
export class SlackBot {
  constructor(private token: string) {}

  get configured(): boolean {
    return Boolean(this.token);
  }

  async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!this.token) throw new Error('SLACK_BOT_TOKEN is not set.');
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error ?? res.status}`);
    return data;
  }

  async lookupUserIdByEmail(email: string): Promise<string> {
    const data = await this.call<{ user: { id: string } }>('users.lookupByEmail', { email });
    return data.user.id;
  }

  /** Send a DM. `to` is a Slack user id (U…) or an email address. */
  async dm(to: string, text: string): Promise<void> {
    const channel = to.includes('@') ? await this.lookupUserIdByEmail(to) : to;
    await this.call('chat.postMessage', { channel, text, unfurl_links: false });
  }

  /** Post to a channel (id or #name); returns the message ts so replies can go in the thread. */
  async post(channel: string, text: string, opts: { thread_ts?: string | null; unfurl?: boolean } = {}): Promise<{ ts: string; channel: string }> {
    const data = await this.call<{ ts: string; channel: string }>('chat.postMessage', { channel, text, unfurl_links: opts.unfurl ?? false, ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}) });
    return { ts: data.ts, channel: data.channel };
  }

  /** Recent channel messages (needs channels:history / groups:history), oldest first. */
  async history(channel: string, opts: { oldest?: string; limit?: number } = {}): Promise<{ ts: string; user?: string; text?: string; bot_id?: string; subtype?: string; thread_ts?: string }[]> {
    const data = await this.call<{ messages?: { ts: string; user?: string; text?: string; bot_id?: string; subtype?: string; thread_ts?: string }[] }>('conversations.history', { channel, limit: opts.limit ?? 50, ...(opts.oldest ? { oldest: opts.oldest } : {}) });
    return [...(data.messages ?? [])].sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  async permalink(channel: string, ts: string): Promise<string | null> {
    try {
      const data = await this.call<{ permalink?: string }>('chat.getPermalink', { channel, message_ts: ts });
      return data.permalink ?? null;
    } catch {
      return null;
    }
  }

  /** Every channel the bot can see, for the channel pickers (cached for ten minutes). */
  private channelsCache: { at: number; rows: { id: string; name: string; is_private: boolean; is_member: boolean; num_members: number | null }[] } | null = null;
  async listChannels(): Promise<{ id: string; name: string; is_private: boolean; is_member: boolean; num_members: number | null }[]> {
    if (this.channelsCache && Date.now() - this.channelsCache.at < 10 * 60000) return this.channelsCache.rows;
    const rows: { id: string; name: string; is_private: boolean; is_member: boolean; num_members: number | null }[] = [];
    let cursor = '';
    for (let i = 0; i < 10; i += 1) {
      const data = await this.call<{ channels?: { id: string; name: string; is_private?: boolean; is_member?: boolean; num_members?: number }[]; response_metadata?: { next_cursor?: string } }>('conversations.list', { limit: 500, types: 'public_channel,private_channel', exclude_archived: true, ...(cursor ? { cursor } : {}) });
      for (const c of data.channels ?? []) { rows.push({ id: c.id, name: c.name, is_private: Boolean(c.is_private), is_member: Boolean(c.is_member), num_members: typeof c.num_members === 'number' ? c.num_members : null }); this.channelCache.set(c.name.toLowerCase(), c.id); }
      cursor = data.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    rows.sort((a, b) => Number(b.is_member) - Number(a.is_member) || a.name.localeCompare(b.name));
    this.channelsCache = { at: Date.now(), rows };
    return rows;
  }

  /** Resolve "#name" to a channel id via conversations.list (cached per process). */
  private channelCache = new Map<string, string>();
  async channelId(nameOrId: string): Promise<string> {
    const raw = nameOrId.trim();
    if (!raw.startsWith('#')) return raw;
    const name = raw.slice(1).toLowerCase();
    const hit = this.channelCache.get(name);
    if (hit) return hit;
    let cursor = '';
    for (let i = 0; i < 10; i += 1) {
      const data = await this.call<{ channels?: { id: string; name: string }[]; response_metadata?: { next_cursor?: string } }>('conversations.list', { limit: 500, types: 'public_channel,private_channel', exclude_archived: true, ...(cursor ? { cursor } : {}) });
      for (const c of data.channels ?? []) this.channelCache.set(c.name.toLowerCase(), c.id);
      cursor = data.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    const id = this.channelCache.get(name);
    if (!id) throw new Error(`Slack channel ${raw} not found (is the bot a member?)`);
    return id;
  }

  /** Like dm() but never throws. */
  async tryDm(to: string, text: string): Promise<string | null> {
    try {
      await this.dm(to, text);
      return null;
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`Slack DM to ${to} failed: ${msg}`);
      return msg;
    }
  }
}

export const slackBot = new SlackBot(process.env.SLACK_BOT_TOKEN?.trim() ?? '');
