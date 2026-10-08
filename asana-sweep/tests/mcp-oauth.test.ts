import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { config } from '../src/config';
import { DashboardOAuthProvider, mountMcpOAuth } from '../src/web/mcp-oauth';
import { SharedPasswordAuth } from '../src/web/auth';

/** The whole dance an app does against the dashboard: register, authorize, sign in, exchange, use, refresh, revoke. */
describe('OAuth for the MCP endpoint', () => {
  const q = new Queries(openTestDb());
  const provider = new DashboardOAuthProvider(q).withDashboardAuth(new SharedPasswordAuth());
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const saved = { url: config.publicUrl, pw: config.dashboardPassword, am: config.amPassword };
  let base = '';
  const server = createServer(app);
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    config.publicUrl = base; config.dashboardPassword = 'admin-pw'; config.amPassword = 'am-pw';
    mountMcpOAuth(app, provider);
  });
  afterAll(async () => { config.publicUrl = saved.url; config.dashboardPassword = saved.pw; config.amPassword = saved.am; await new Promise<void>((r) => server.close(() => r())); });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  it('advertises itself, registers the app, signs in with the dashboard password and hands out tokens that carry the role', async () => {
    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string; authorization_servers: string[] };
    expect(meta.resource).toBe(`${base}/mcp`);
    expect(meta.authorization_servers).toEqual([`${base}/`]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(as.registration_endpoint).toBe(`${base}/register`);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    // Dynamic registration, as the Claude apps do it.
    const reg = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    expect(reg.status).toBe(201);
    const client = await reg.json() as { client_id: string; client_secret?: string };
    expect(client.client_id).toMatch(/^[0-9a-f]{64}$/); expect(client.client_secret).toBeUndefined();
    // The authorize page is the sign-in form with the request carried in hidden fields.
    const authz = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'read write', resource: `${base}/mcp` })) authz.searchParams.set(k, v);
    const page = await fetch(authz);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toMatch(/Allow Claude to use Brightform ops/); expect(html).toMatch(/name="code_challenge" value="/); expect(html).toMatch(/name="state" value="xyz"/);
    // Wrong password: back to the app with an error, no code.
    const form = (extra: Record<string, string>) => new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, state: 'xyz', scope: 'read write', resource: `${base}/mcp`, ...extra });
    const bad = await fetch(`${base}/mcp/oauth/login`, { method: 'POST', body: form({ password: 'nope' }), redirect: 'manual' });
    expect(bad.status).toBe(302); expect(new URL(bad.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    // The AM password: a code that only carries read.
    const amLogin = await fetch(`${base}/mcp/oauth/login`, { method: 'POST', body: form({ password: 'am-pw' }), redirect: 'manual' });
    const amUrl = new URL(amLogin.headers.get('location')!);
    expect(amUrl.origin + amUrl.pathname).toBe('https://claude.ai/api/mcp/auth_callback'); expect(amUrl.searchParams.get('state')).toBe('xyz');
    const amTok = await (await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: amUrl.searchParams.get('code')!, code_verifier: verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', resource: `${base}/mcp` }) })).json() as { access_token: string; scope: string };
    expect(amTok.scope).toBe('read');
    expect(await provider.roleOfToken(amTok.access_token)).toBe('am');
    // The admin password: read and write; the code is single use and PKCE is checked.
    const login = await fetch(`${base}/mcp/oauth/login`, { method: 'POST', body: form({ password: 'admin-pw' }), redirect: 'manual' });
    const code = new URL(login.headers.get('location')!).searchParams.get('code')!;
    const wrongVerifier = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: 'not-it', redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }) });
    expect(wrongVerifier.status).toBe(400);
    const tok = await (await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }) })).json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    expect(tok.scope).toBe('read write'); expect(tok.expires_in).toBe(86400);
    expect(await provider.roleOfToken(tok.access_token)).toBe('admin');
    const again = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }) });
    expect(again.status).toBe(400); // the code was used
    // Refresh rotates both tokens; revoke ends the access token; a made-up token is nobody.
    const refreshed = await (await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tok.refresh_token }) })).json() as { access_token: string; refresh_token: string };
    expect(refreshed.access_token).not.toBe(tok.access_token);
    expect(await provider.roleOfToken(refreshed.access_token)).toBe('admin');
    expect((await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tok.refresh_token }) })).status).toBe(400);
    expect((await fetch(`${base}/revoke`, { method: 'POST', body: new URLSearchParams({ client_id: client.client_id, token: refreshed.access_token }) })).status).toBe(200);
    expect(await provider.roleOfToken(refreshed.access_token)).toBeNull();
    expect(await provider.roleOfToken('deadbeef')).toBeNull();
    expect(q.oauthPrune(Date.now() + 100 * 86400000)).toBeGreaterThan(0);
  });
});
