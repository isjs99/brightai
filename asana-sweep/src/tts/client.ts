import { createHmac } from 'node:crypto';
import { log } from '../logger.js';

/**
 * TikTok Shop OpenAPI client (Partner Center app). Handles request signing, per-shop access
 * tokens and refresh. Base URL and signing follow the Partner Center spec:
 *   sign = HMAC-SHA256(app_secret, app_secret + path + sorted(query without sign/access_token) + body + app_secret)
 * Every request carries app_key, timestamp, sign (+ shop_cipher) as query params and the shop's
 * access token in the x-tts-access-token header.
 */
export interface TtsConfig {
  appKey: string;
  appSecret: string;
  baseUrl: string;
  authUrl: string;
}

export const ttsConfig: TtsConfig = {
  appKey: process.env.TTS_APP_KEY?.trim() ?? '',
  appSecret: process.env.TTS_APP_SECRET?.trim() ?? '',
  baseUrl: (process.env.TTS_BASE_URL?.trim() || 'https://open-api.tiktokglobalshop.com').replace(/\/+$/, ''),
  authUrl: (process.env.TTS_AUTH_URL?.trim() || 'https://auth.tiktok-shops.com').replace(/\/+$/, ''),
};

export const ttsConfigured = (): boolean => Boolean(ttsConfig.appKey && ttsConfig.appSecret);

export class TtsError extends Error {
  constructor(message: string, public code: number | null = null, public status: number | null = null) {
    super(message);
    this.name = 'TtsError';
  }
}

export interface TtsShop {
  id: string;
  name: string;
  region: string;
  seller_type: string;
  cipher: string;
  code?: string;
}

export interface TtsTokens {
  access_token: string;
  access_token_expire_in: number; // unix seconds
  refresh_token: string;
  refresh_token_expire_in: number;
  open_id?: string;
  seller_name?: string;
  seller_base_region?: string;
}

export function signRequest(secret: string, path: string, query: Record<string, string>, body: string): string {
  const keys = Object.keys(query)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();
  let s = path;
  for (const k of keys) s += k + query[k];
  if (body) s += body;
  s = secret + s + secret;
  return createHmac('sha256', secret).update(s).digest('hex');
}

/** Authorisation URL the seller opens to grant the app access to their shop (service ID from Partner Center). */
export function authorizationUrl(serviceId: string, state: string): string {
  return `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(serviceId)}&state=${encodeURIComponent(state)}`;
}

export class TtsClient {
  constructor(private cfg: TtsConfig = ttsConfig) {}

  get configured(): boolean {
    return Boolean(this.cfg.appKey && this.cfg.appSecret);
  }

  private ensure() {
    if (!this.configured) throw new TtsError('TikTok Shop app is not configured. Set TTS_APP_KEY and TTS_APP_SECRET.');
  }

  /** Exchange the auth code from the authorisation callback for tokens. */
  async exchangeCode(authCode: string): Promise<TtsTokens> {
    this.ensure();
    const url = new URL(`${this.cfg.authUrl}/api/v2/token/get`);
    url.searchParams.set('app_key', this.cfg.appKey);
    url.searchParams.set('app_secret', this.cfg.appSecret);
    url.searchParams.set('auth_code', authCode);
    url.searchParams.set('grant_type', 'authorized_code');
    return this.authCall(url);
  }

  async refreshToken(refreshToken: string): Promise<TtsTokens> {
    this.ensure();
    const url = new URL(`${this.cfg.authUrl}/api/v2/token/refresh`);
    url.searchParams.set('app_key', this.cfg.appKey);
    url.searchParams.set('app_secret', this.cfg.appSecret);
    url.searchParams.set('refresh_token', refreshToken);
    url.searchParams.set('grant_type', 'refresh_token');
    return this.authCall(url);
  }

  private async authCall(url: URL): Promise<TtsTokens> {
    const res = await fetch(url);
    const data = (await res.json()) as { code: number; message: string; data: TtsTokens };
    if (!res.ok || data.code !== 0) throw new TtsError(`TikTok auth failed: ${data.message ?? res.status}`, data.code ?? null, res.status);
    return data.data;
  }

  /** Signed call to the OpenAPI. `shopCipher` is required for shop-scoped endpoints. */
  async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { accessToken: string; shopCipher?: string; query?: Record<string, string>; body?: unknown }): Promise<T> {
    this.ensure();
    const query: Record<string, string> = { ...(opts.query ?? {}), app_key: this.cfg.appKey, timestamp: String(Math.floor(Date.now() / 1000)) };
    if (opts.shopCipher) query.shop_cipher = opts.shopCipher;
    const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
    query.sign = signRequest(this.cfg.appSecret, path, query, body);
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-tts-access-token': opts.accessToken },
      body: body || undefined,
    });
    const text = await res.text();
    let data: { code?: number; message?: string; data?: T };
    try {
      data = JSON.parse(text);
    } catch {
      throw new TtsError(`TikTok returned non-JSON (${res.status}) for ${method} ${path}`, null, res.status);
    }
    if (!res.ok || (data.code !== undefined && data.code !== 0)) {
      log.warn(`TTS ${method} ${path} -> ${res.status} code ${data.code}: ${data.message}`);
      throw new TtsError(`TikTok Shop error ${data.code ?? res.status}: ${data.message ?? 'unknown'}`, data.code ?? null, res.status);
    }
    return data.data as T;
  }

  // ---- Shops ----
  async authorizedShops(accessToken: string): Promise<TtsShop[]> {
    const data = await this.call<{ shops: TtsShop[] }>('GET', '/authorization/202309/shops', { accessToken });
    return data.shops ?? [];
  }

  // ---- Analytics ----
  /** Shop performance (GMV, orders, traffic) for [start, end) in the shop's local currency. Dates are YYYY-MM-DD in the shop's timezone. */
  async shopPerformance(shop: { accessToken: string; cipher: string }, start: string, end: string, granularity: 'ALL' | '1D' = 'ALL'): Promise<{ latest_available_date?: string; performance?: { intervals?: Record<string, unknown>[] } }> {
    return this.call('GET', '/analytics/202509/shop/performance', { accessToken: shop.accessToken, shopCipher: shop.cipher, query: { start_date_ge: start, end_date_lt: end, granularity, currency: 'LOCAL' } });
  }

  // ---- Promotions (activities) ----
  async createActivity(shop: { accessToken: string; cipher: string }, body: Record<string, unknown>): Promise<{ activity_id: string; status?: string }> {
    return this.call('POST', '/promotion/202309/activities', { accessToken: shop.accessToken, shopCipher: shop.cipher, body });
  }

  async updateActivity(shop: { accessToken: string; cipher: string }, activityId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.call('PUT', `/promotion/202309/activities/${activityId}`, { accessToken: shop.accessToken, shopCipher: shop.cipher, body });
  }

  async updateActivityProducts(shop: { accessToken: string; cipher: string }, activityId: string, products: unknown[]): Promise<unknown> {
    return this.call('PUT', `/promotion/202309/activities/${activityId}/products`, { accessToken: shop.accessToken, shopCipher: shop.cipher, body: { activity_id: activityId, products } });
  }

  async deactivateActivity(shop: { accessToken: string; cipher: string }, activityId: string): Promise<unknown> {
    return this.call('POST', `/promotion/202309/activities/${activityId}/deactivate`, { accessToken: shop.accessToken, shopCipher: shop.cipher, body: {} });
  }

  async getActivity(shop: { accessToken: string; cipher: string }, activityId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/promotion/202309/activities/${activityId}`, { accessToken: shop.accessToken, shopCipher: shop.cipher });
  }

  async searchActivities(shop: { accessToken: string; cipher: string }, filter: Record<string, unknown> = {}): Promise<{ activities: Record<string, unknown>[]; next_page_token?: string }> {
    return this.call('POST', '/promotion/202309/activities/search', { accessToken: shop.accessToken, shopCipher: shop.cipher, body: { page_size: 50, page_token: '', ...filter } });
  }

  // ---- Products (for picking what a promotion applies to) ----
  async searchProducts(shop: { accessToken: string; cipher: string }, pageToken = ''): Promise<{ products: { id: string; title: string; status: string; skus?: { id: string; seller_sku?: string; price?: { sale_price?: string; currency?: string } }[] }[]; next_page_token?: string }> {
    return this.call('POST', '/product/202502/products/search', {
      accessToken: shop.accessToken,
      shopCipher: shop.cipher,
      query: { page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) },
      body: { status: 'ACTIVATED' },
    });
  }
  // ---- Customer service (buyer) conversations, customer_service 202309 ----

  async csConversations(shop: { accessToken: string; cipher: string }, pageToken = ''): Promise<{ conversations: Record<string, unknown>[]; next_page_token?: string }> {
    const query: Record<string, string> = { page_size: '20' };
    if (pageToken) query.page_token = pageToken;
    const d = await this.call<{ conversations?: Record<string, unknown>[]; next_page_token?: string }>('GET', '/customer_service/202309/conversations', { accessToken: shop.accessToken, shopCipher: shop.cipher, query });
    return { conversations: d.conversations ?? [], next_page_token: d.next_page_token };
  }

  async csMessages(shop: { accessToken: string; cipher: string }, conversationId: string, pageToken = ''): Promise<{ messages: Record<string, unknown>[]; next_page_token?: string }> {
    const query: Record<string, string> = { page_size: '10', sort_order: 'DESC', sort_field: 'create_time' };
    if (pageToken) query.page_token = pageToken;
    const d = await this.call<{ messages?: Record<string, unknown>[]; next_page_token?: string }>('GET', `/customer_service/202309/conversations/${encodeURIComponent(conversationId)}/messages`, { accessToken: shop.accessToken, shopCipher: shop.cipher, query });
    return { messages: d.messages ?? [], next_page_token: d.next_page_token };
  }

  async csSendText(shop: { accessToken: string; cipher: string }, conversationId: string, text: string): Promise<{ message_id: string }> {
    return this.call<{ message_id: string }>('POST', `/customer_service/202309/conversations/${encodeURIComponent(conversationId)}/messages`, { accessToken: shop.accessToken, shopCipher: shop.cipher, body: { type: 'TEXT', content: JSON.stringify({ content: text.slice(0, 2000) }) } });
  }

  async csMarkRead(shop: { accessToken: string; cipher: string }, conversationId: string): Promise<void> {
    await this.call('POST', `/customer_service/202309/conversations/${encodeURIComponent(conversationId)}/messages/read`, { accessToken: shop.accessToken, shopCipher: shop.cipher, body: {} });
  }

  // ---- Affiliate (creator) conversations, affiliate_seller 202412 / 202505 ----

  async affConversations(shop: { accessToken: string; cipher: string }, pageToken = ''): Promise<{ conversations: Record<string, unknown>[]; next_page_token?: string }> {
    const query: Record<string, string> = { page_size: '50', only_need_conversation_id: 'false' };
    if (pageToken) query.page_token = pageToken;
    const d = await this.call<{ conversations?: Record<string, unknown>[]; next_page_token?: string }>('GET', '/affiliate_seller/202505/conversations', { accessToken: shop.accessToken, shopCipher: shop.cipher, query });
    return { conversations: d.conversations ?? [], next_page_token: d.next_page_token };
  }

  async affMessages(shop: { accessToken: string; cipher: string }, conversationId: string, pageToken = ''): Promise<{ messages: Record<string, unknown>[]; has_more?: boolean; next_page_token?: string }> {
    const query: Record<string, string> = { page_size: '20' };
    if (pageToken) query.page_token = pageToken;
    const d = await this.call<{ messages?: Record<string, unknown>[]; has_more?: boolean; next_page_token?: string }>('GET', `/affiliate_seller/202412/conversation/${encodeURIComponent(conversationId)}/messages`, { accessToken: shop.accessToken, shopCipher: shop.cipher, query });
    return { messages: d.messages ?? [], has_more: d.has_more, next_page_token: d.next_page_token };
  }

  async affSendText(shop: { accessToken: string; cipher: string }, conversationId: string, text: string): Promise<{ message_id: string }> {
    return this.call<{ message_id: string }>('POST', `/affiliate_seller/202412/conversations/${encodeURIComponent(conversationId)}/messages`, { accessToken: shop.accessToken, shopCipher: shop.cipher, body: { msg_type: 'TEXT', content: JSON.stringify({ content: text.slice(0, 2000) }) } });
  }

}

export const tts = new TtsClient();
