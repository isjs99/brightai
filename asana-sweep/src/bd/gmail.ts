import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import type { Queries } from '../db/queries.js';
import { log } from '../logger.js';

/**
 * Gmail link for BD outreach. One Google account (Isaac's) is connected once via OAuth; the
 * refresh token lives in settings. Used to create drafts in his Drafts folder (so they are sent
 * from his own account, in his own Gmail) and to read his sent cold outreach as voice samples.
 *
 * Setup: a Google Cloud OAuth client (Web application) with redirect URI
 * `${PUBLIC_URL}/api/gmail/callback`, then GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.
 */

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.readonly'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const SETTING_REFRESH = 'gmail_refresh_token';
const SETTING_EMAIL = 'gmail_email';
const SETTING_CONNECTED_AT = 'gmail_connected_at';

export const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s: string): string => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** RFC 2822 message for the Gmail API: plain text, or multipart/alternative with an HTML part when `html` is given. */
export function buildRawMessage(m: { to: string; toName?: string | null; from?: string | null; fromName?: string | null; subject: string; body: string; html?: string | null }): string {
  const enc = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
  const addr = (email: string, name?: string | null) => (name ? `${enc(name.replace(/[<>"]/g, ''))} <${email}>` : email);
  const b64 = (s: string) => Buffer.from(s.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/(.{76})/g, '$1\r\n');
  const head = [`To: ${addr(m.to, m.toName)}`, ...(m.from ? [`From: ${addr(m.from, m.fromName)}`] : []), `Subject: ${enc(m.subject)}`, 'MIME-Version: 1.0'];
  const lines = m.html
    ? (() => {
        const boundary = `bf_${Date.now().toString(36)}`;
        return [
          ...head,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset="UTF-8"',
          'Content-Transfer-Encoding: base64',
          '',
          b64(m.body),
          `--${boundary}`,
          'Content-Type: text/html; charset="UTF-8"',
          'Content-Transfer-Encoding: base64',
          '',
          b64(m.html),
          `--${boundary}--`,
        ];
      })()
    : [...head, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(m.body)];
  return b64url(lines.join('\r\n'));
}

/** Where to open a draft in the Gmail web app for the connected account. */
export function gmailDraftUrl(messageId: string, account?: string | null): string {
  return `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : 'u/0/'}#drafts/${messageId}`;
}

/** Gmail compose window prefilled from the URL: the no-OAuth fallback. */
export function gmailComposeUrl(m: { to: string; subject: string; body: string; account?: string | null }): string {
  const params = new URLSearchParams({ view: 'cm', fs: '1', to: m.to, su: m.subject, body: m.body });
  if (m.account) params.set('authuser', m.account);
  return `https://mail.google.com/mail/?${params.toString()}`;
}

/** Extract the text/plain part of a Gmail API message payload (falls back to stripped HTML). */
export function extractPlainText(payload: { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined): string {
  if (!payload) return '';
  const walk = (p: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }, want: string): string | null => {
    if (p.mimeType === want && p.body?.data) return fromB64url(p.body.data);
    for (const child of (p.parts ?? []) as typeof p[]) {
      const hit = walk(child, want);
      if (hit) return hit;
    }
    return null;
  };
  const plain = walk(payload, 'text/plain');
  if (plain) return plain;
  const html = walk(payload, 'text/html');
  return html ? html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
}

/** Drop quoted replies, the signature block and tracking links from a sent email so only Isaac's own words remain. */
export function cleanSentBody(text: string): string {
  let t = text.replace(/\r/g, '');
  // Quoted reply or forward.
  t = t.split(/\n(?:On .{0,120}wrote:|---------- Forwarded message ---------|-{2,}\s*Original Message\s*-{2,}|From: .+\nSent: )/)[0];
  // Signature: "--" line, or the name/title block.
  t = t.split(/\n--\s*\n|\n<https?:\/\/[^>]*>\s*\n(?=[A-Z][a-z]+ [A-Z][a-z]+\n)/)[0];
  t = t.split(/\nIsaac Sinclair\nCo-Founder/)[0];
  t = t.split(/\nThe content of this email is confidential/)[0];
  // Gmail's redirect-wrapped links -> the real link.
  t = t.replace(/https:\/\/www\.google\.com\/url\?q=([^&\s]+)[^\s]*/g, (_m, u: string) => decodeURIComponent(u));
  t = t.replace(/\s*<https?:\/\/bitli\.pro\/[^>]+>/g, '');
  // Unwrap hard-wrapped lines inside paragraphs (Gmail wraps plain text at ~72 chars); short
  // lines such as "Very best," are line breaks he typed himself.
  t = t.replace(/^(.{45,})\n(?![\n\-*•\d])/gm, '$1 ');
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export class GmailClient {
  private accessToken: { token: string; expires: number } | null = null;

  constructor(private q: Queries, private fetchFn: typeof fetch = fetch) {}

  get configured(): boolean {
    return Boolean(config.googleClientId && config.googleClientSecret);
  }

  get connected(): boolean {
    return this.configured && Boolean(this.q.getSetting(SETTING_REFRESH, ''));
  }

  get email(): string | null {
    return this.q.getSetting(SETTING_EMAIL, '') || null;
  }

  get redirectUri(): string {
    return `${config.publicUrl}/api/gmail/callback`;
  }

  // ---- OAuth ----

  private sign(nonce: string): string {
    return createHmac('sha256', config.sessionSecret).update(`gmail:${nonce}`).digest('hex').slice(0, 32);
  }

  authUrl(): string {
    const nonce = randomBytes(12).toString('hex');
    const state = `${nonce}.${this.sign(nonce)}`;
    const p = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: this.redirectUri, response_type: 'code', scope: GMAIL_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return `${AUTH_URL}?${p.toString()}`;
  }

  validState(state: string | undefined): boolean {
    const [nonce, sig] = String(state ?? '').split('.');
    if (!nonce || !sig) return false;
    const expect = this.sign(nonce);
    return sig.length === expect.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  }

  async exchangeCode(code: string): Promise<{ email: string }> {
    const body = new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: this.redirectUri, grant_type: 'authorization_code' });
    const res = await this.fetchFn(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) throw new Error(`Google token exchange failed: ${data.error_description ?? data.error ?? res.statusText}`);
    if (!data.refresh_token) throw new Error('Google did not return a refresh token. Remove Brightform from your Google account permissions (myaccount.google.com/permissions) and connect again.');
    this.accessToken = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 - 60000 };
    this.q.setSetting(SETTING_REFRESH, data.refresh_token);
    const profile = (await this.api('GET', '/profile')) as { emailAddress?: string };
    const email = profile.emailAddress ?? '';
    this.q.setSetting(SETTING_EMAIL, email);
    this.q.setSetting(SETTING_CONNECTED_AT, new Date().toISOString());
    log.info(`Gmail connected as ${email}`);
    return { email };
  }

  disconnect(): void {
    this.q.setSetting(SETTING_REFRESH, '');
    this.q.setSetting(SETTING_EMAIL, '');
    this.accessToken = null;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > Date.now()) return this.accessToken.token;
    const refresh = this.q.getSetting(SETTING_REFRESH, '');
    if (!this.configured) throw new Error('Gmail is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.');
    if (!refresh) throw new Error('Gmail is not connected. Connect it from Growth > Outreach emails.');
    const body = new URLSearchParams({ refresh_token: refresh, client_id: config.googleClientId, client_secret: config.googleClientSecret, grant_type: 'refresh_token' });
    const res = await this.fetchFn(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      if (data.error === 'invalid_grant') this.disconnect();
      throw new Error(`Gmail token refresh failed: ${data.error_description ?? data.error ?? res.statusText}${data.error === 'invalid_grant' ? ' (connect Gmail again)' : ''}`);
    }
    this.accessToken = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 - 60000 };
    return data.access_token;
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${API}${path}`, { method, headers: { authorization: `Bearer ${await this.token()}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new Error(`Gmail API ${res.status}: ${data?.error?.message ?? res.statusText}`);
    return data;
  }

  // ---- Drafts ----

  async createDraft(m: { to: string; toName?: string | null; subject: string; body: string; html?: string | null }): Promise<{ draft_id: string; message_id: string; url: string }> {
    const raw = buildRawMessage({ ...m, from: this.email, fromName: this.q.getSetting('outreach_sender_name', '') || null });
    const d = (await this.api('POST', '/drafts', { message: { raw } })) as { id: string; message: { id: string } };
    return { draft_id: d.id, message_id: d.message.id, url: gmailDraftUrl(d.message.id, this.email) };
  }

  // ---- Sent history as voice samples ----

  async listSent(query: string, max = 25): Promise<{ id: string; subject: string; body: string; to: string | null; sent_at: string | null }[]> {
    const list = (await this.api('GET', `/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(max, 50)}`)) as { messages?: { id: string }[] };
    const out: { id: string; subject: string; body: string; to: string | null; sent_at: string | null }[] = [];
    for (const m of list.messages ?? []) {
      const full = (await this.api('GET', `/messages/${m.id}?format=full`)) as { id: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[]; mimeType?: string; body?: { data?: string }; parts?: unknown[] } };
      const header = (n: string) => full.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;
      const body = cleanSentBody(extractPlainText(full.payload));
      if (!body) continue;
      out.push({ id: full.id, subject: header('Subject') ?? '(no subject)', body, to: header('To'), sent_at: full.internalDate ? new Date(Number(full.internalDate)).toISOString().slice(0, 10) : null });
    }
    return out;
  }
}
