import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Queries } from '../db/queries.js';
import { config } from '../config.js';
import type { Role, SharedPasswordAuth } from './auth.js';

/**
 * OAuth 2.1 for the MCP endpoint, so the Claude apps (web, mobile, desktop custom connectors) can sign in:
 * dynamic client registration, authorization code with PKCE, refresh and revocation, all kept in SQLite.
 * The sign-in page is the dashboard's own: the admin password gives read and write scopes, the AM password
 * read only, and someone already signed in to the dashboard just presses Allow. Access tokens last a day,
 * refresh tokens ninety; both are random and stored hashed-free (they are the secret), per client.
 */

const ACCESS_SECONDS = 86400;
const REFRESH_SECONDS = 90 * 86400;
const CODE_SECONDS = 600;
export const SCOPES: Record<Role, string[]> = { admin: ['read', 'write'], am: ['read'] };

interface StoredCode { client_id: string; code_challenge: string; redirect_uri: string; role: Role; scopes: string[]; resource: string | null; created_at: number }
interface StoredToken { client_id: string; role: Role; scopes: string[]; resource: string | null; kind: 'access' | 'refresh'; pair: string; issued_at: number }

const token = () => randomBytes(32).toString('hex');
const safeEqual = (a: string, b: string): boolean => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export class DashboardOAuthProvider implements OAuthServerProvider {
  constructor(private q: Queries) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const q = this.q;
    return {
      getClient: (clientId) => q.oauthGet<OAuthClientInformationFull>('client', clientId) ?? undefined,
      registerClient: (client) => { const full = { ...client, client_id: token(), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull; q.oauthPut('client', full.client_id, full, null); return full; },
    };
  }

  /** The sign-in page: the dashboard password (admin or AM), or Allow when the browser already carries a dashboard session. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const role = this.auth?.roleOf(res.req as Request) ?? null;
    const hidden = { client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge, state: params.state ?? '', scope: (params.scopes ?? []).join(' '), resource: params.resource?.href ?? '' };
    const fields = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
    res.status(200).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brightform ops: allow access</title>
<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f6f4;color:#111;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}form{background:#fff;border:1px solid #e3e3df;border-radius:14px;padding:28px 30px;width:min(92vw,400px)}h1{font-size:19px;margin:0 0 6px}p{color:#555;font-size:14px;margin:0 0 16px}label{display:block;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#666;margin-bottom:6px}input[type=password]{width:100%;box-sizing:border-box;font-size:16px;padding:10px 12px;border:1px solid #cfcfca;border-radius:8px;margin-bottom:14px}button{width:100%;font-size:15px;padding:11px;border:0;border-radius:999px;background:#111;color:#fff;cursor:pointer}.sub{font-size:12px;color:#777;margin-top:12px}</style></head><body>
<form method="post" action="/mcp/oauth/login">${fields}
<h1>Allow ${esc(client.client_name ?? 'this app')} to use Brightform ops</h1>
<p>${role ? `You are signed in to the dashboard as <b>${role === 'admin' ? 'admin' : 'account manager'}</b>. Allow this app the same access?` : 'Sign in with the dashboard password. The admin password gives read and write access, the AM password read only.'}</p>
${role ? `<input type="hidden" name="use_session" value="1"><button type="submit">Allow as ${role === 'admin' ? 'admin' : 'account manager'}</button><p class="sub">Not you? <a href="/login">Sign out of the dashboard first.</a></p>` : `<label>Dashboard password</label><input type="password" name="password" autofocus autocomplete="current-password"><button type="submit">Allow access</button>`}
<p class="sub">Redirects to ${esc(new URL(params.redirectUri).host)}.</p>
</form></body></html>`);
  }

  private auth: SharedPasswordAuth | null = null;
  withDashboardAuth(auth: SharedPasswordAuth): this { this.auth = auth; return this; }

  /** The form's POST: check the password (or the dashboard session), mint the code, redirect back to the app. */
  login = (req: Request, res: Response): void => {
    const b = (req.body ?? {}) as Record<string, string>;
    const client = this.q.oauthGet<OAuthClientInformationFull>('client', String(b.client_id ?? ''));
    const redirect = String(b.redirect_uri ?? '');
    if (!client || !redirect || !client.redirect_uris.includes(redirect) || !b.code_challenge) { res.status(400).type('text').send('This sign-in link is not valid any more. Start again from the app.'); return; }
    let role: Role | null = null;
    if (b.use_session === '1') role = this.auth?.roleOf(req) ?? null;
    else { const pw = String(b.password ?? ''); if (pw && safeEqual(pw, config.dashboardPassword)) role = 'admin'; else if (pw && config.amPassword && safeEqual(pw, config.amPassword)) role = 'am'; }
    const url = new URL(redirect);
    if (!role) { url.searchParams.set('error', 'access_denied'); url.searchParams.set('error_description', 'Wrong password'); if (b.state) url.searchParams.set('state', b.state); res.redirect(302, url.href); return; }
    const requested = String(b.scope ?? '').split(/\s+/).filter(Boolean);
    const scopes = (requested.length ? requested : SCOPES[role]).filter((s) => SCOPES[role!].includes(s));
    const code = token();
    this.q.oauthPut('code', code, { client_id: client.client_id, code_challenge: String(b.code_challenge), redirect_uri: redirect, role, scopes: scopes.length ? scopes : ['read'], resource: b.resource || null, created_at: Date.now() } satisfies StoredCode, Date.now() + CODE_SECONDS * 1000);
    url.searchParams.set('code', code);
    if (b.state) url.searchParams.set('state', b.state);
    res.redirect(302, url.href);
  };

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const c = this.q.oauthGet<StoredCode>('code', authorizationCode);
    if (!c || c.client_id !== client.client_id) throw new InvalidGrantError('Unknown or expired authorization code');
    return c.code_challenge;
  }

  private issue(client_id: string, role: Role, scopes: string[], resource: string | null): OAuthTokens {
    const pair = token(); const access = token(); const refresh = token(); const now = Date.now();
    this.q.oauthPut('token', access, { client_id, role, scopes, resource, kind: 'access', pair, issued_at: now } satisfies StoredToken, now + ACCESS_SECONDS * 1000);
    this.q.oauthPut('token', refresh, { client_id, role, scopes, resource, kind: 'refresh', pair, issued_at: now } satisfies StoredToken, now + REFRESH_SECONDS * 1000);
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: scopes.join(' ') };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.q.oauthGet<StoredCode>('code', authorizationCode);
    if (!c || c.client_id !== client.client_id) throw new InvalidGrantError('Unknown or expired authorization code');
    if (redirectUri && redirectUri !== c.redirect_uri) throw new InvalidGrantError('redirect_uri does not match');
    this.q.oauthDelete('code', authorizationCode); // one use
    return this.issue(client.client_id, c.role, c.scopes, c.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const t = this.q.oauthGet<StoredToken>('token', refreshToken);
    if (!t || t.kind !== 'refresh' || t.client_id !== client.client_id) throw new InvalidGrantError('Unknown or expired refresh token');
    this.q.oauthDelete('token', refreshToken); // rotated
    const next = (scopes?.length ? scopes.filter((s) => t.scopes.includes(s)) : t.scopes);
    return this.issue(client.client_id, t.role, next.length ? next : t.scopes, t.resource);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const t = this.q.oauthGet<StoredToken>('token', accessToken);
    if (!t || t.kind !== 'access') throw new InvalidTokenError('Unknown or expired token');
    return { token: accessToken, clientId: t.client_id, scopes: t.scopes, extra: { role: t.role }, ...(t.resource ? { resource: new URL(t.resource) } : {}) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const t = this.q.oauthGet<StoredToken>('token', request.token);
    if (!t || t.client_id !== client.client_id) return;
    this.q.oauthDelete('token', request.token);
  }

  /** The role an OAuth bearer token carries, or null when it is not one of ours. */
  async roleOfToken(bearer: string): Promise<Role | null> {
    try { const info = await this.verifyAccessToken(bearer); return (info.extra?.role as Role | undefined) ?? null; } catch { return null; }
  }
}

export const resourceMetadataUrl = (): string => `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

/** Mount the OAuth endpoints at the root: /authorize, /token, /register, /revoke, the two well-known documents, and the sign-in form's POST. */
export function mountMcpOAuth(app: Express, provider: DashboardOAuthProvider): void {
  const issuer = new URL(config.publicUrl);
  app.use(mcpAuthRouter({ provider, issuerUrl: issuer, resourceServerUrl: new URL('/mcp', issuer), resourceName: 'Brightform ops', scopesSupported: ['read', 'write'], clientRegistrationOptions: { clientSecretExpirySeconds: 0 } }));
  app.post('/mcp/oauth/login', express.urlencoded({ extended: false }), provider.login);
}
