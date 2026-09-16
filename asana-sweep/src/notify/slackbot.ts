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

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
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
