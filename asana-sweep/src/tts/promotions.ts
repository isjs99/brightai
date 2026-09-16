import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { tts, TtsClient, TtsError } from './client.js';
import type { Promotion, PromotionTarget } from '../sweep/types.js';

/** Access token for a shop, refreshed if it expires within the hour. */
export async function shopCredentials(q: Queries, shopId: string, client: TtsClient = tts): Promise<{ accessToken: string; cipher: string }> {
  const shop = q.getTtsShop(shopId);
  if (!shop) throw new TtsError(`TikTok shop ${shopId} is not authorised.`);
  const now = Math.floor(Date.now() / 1000);
  if (shop.access_expires_at - now < 3600) {
    if (shop.refresh_expires_at && shop.refresh_expires_at < now) throw new TtsError(`Authorisation for ${shop.name} has expired. Re-authorise the shop.`);
    const t = await client.refreshToken(shop.refresh_token);
    q.updateTtsTokens(shopId, t);
    return { accessToken: t.access_token, cipher: shop.cipher };
  }
  return { accessToken: shop.access_token, cipher: shop.cipher };
}

const toUnix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Build the CreateActivity body for one target. */
export function activityBody(p: Promotion, target: PromotionTarget): Record<string, unknown> {
  const title = `${p.name} ${target.market}`.slice(0, 50);
  const body: Record<string, unknown> = {
    title,
    activity_type: p.activity_type,
    product_level: p.activity_type === 'SHIPPING_DISCOUNT' ? 'SHOP' : p.product_level,
    begin_time: toUnix(p.begin_at),
    end_time: toUnix(p.end_at),
    participation_limit: [{ type: p.participation }],
  };
  if (p.activity_type === 'SHIPPING_DISCOUNT' && p.discount_value !== null) {
    body.discount = { shipping_discount: { type: p.discount_type === 'AMOUNT_OFF' ? 'AMOUNT_OFF' : 'PERCENTAGE_OFF', value: String(p.discount_value) } };
  }
  return body;
}

/** Product rows for UpdateActivityProduct at PRODUCT level. */
export function productRows(p: Promotion, shopId: string): unknown[] {
  const ids = p.products[shopId] ?? [];
  return ids.map((id) => {
    const row: Record<string, unknown> = { id, quantity_limit: -1, quantity_per_user: -1, skus: [] };
    if (p.activity_type === 'DIRECT_DISCOUNT') row.discount = String(p.discount_value ?? 0);
    else if (p.activity_type === 'FIXED_PRICE' || p.activity_type === 'FLASHSALE') row.activity_price_amount = String(p.discount_value ?? 0);
    return row;
  });
}

/** Push every planned target of a promotion to its TikTok shop. Targets without a linked shop are marked unlinked. */
export async function pushPromotion(q: Queries, promotionId: number, client: TtsClient = tts): Promise<Promotion> {
  const p = q.getPromotion(promotionId);
  if (!p) throw new Error('Promotion not found');
  for (const t of p.targets) {
    if (t.status === 'live' || t.status === 'pushed') continue;
    const shop = q.findTtsShopFor(t.account_id, t.market);
    if (!shop) {
      q.updateTarget(t.id, { status: 'unlinked', tts_shop_id: null, error_message: `No authorised TikTok shop linked to ${t.account_name} ${t.market}.` });
      continue;
    }
    try {
      const creds = await shopCredentials(q, shop.id, client);
      const created = await client.createActivity(creds, activityBody(p, t));
      if (p.product_level !== 'SHOP' && p.activity_type !== 'SHIPPING_DISCOUNT') {
        const rows = productRows(p, shop.id);
        if (rows.length) await client.updateActivityProducts(creds, created.activity_id, rows);
      }
      q.updateTarget(t.id, { status: 'pushed', tts_shop_id: shop.id, tts_activity_id: created.activity_id, tts_status: created.status ?? null, error_message: null, pushed_at: new Date().toISOString() });
      log.info(`Promotion ${p.id} pushed to ${shop.name} (${t.market}): activity ${created.activity_id}`);
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`Promotion ${p.id} push failed for ${t.account_name} ${t.market}: ${msg}`);
      q.updateTarget(t.id, { status: 'error', tts_shop_id: shop.id, error_message: msg });
    }
  }
  return q.getPromotion(promotionId)!;
}

export async function deactivatePromotion(q: Queries, promotionId: number, client: TtsClient = tts): Promise<Promotion> {
  const p = q.getPromotion(promotionId);
  if (!p) throw new Error('Promotion not found');
  for (const t of p.targets) {
    if (!t.tts_activity_id || !t.tts_shop_id) {
      if (t.status === 'planned') q.updateTarget(t.id, { status: 'deactivated' });
      continue;
    }
    try {
      const creds = await shopCredentials(q, t.tts_shop_id, client);
      await client.deactivateActivity(creds, t.tts_activity_id);
      q.updateTarget(t.id, { status: 'deactivated', tts_status: 'DEACTIVATED', error_message: null });
    } catch (err) {
      q.updateTarget(t.id, { status: 'error', error_message: (err as Error).message });
    }
  }
  return q.getPromotion(promotionId)!;
}

const STATUS_MAP: Record<string, PromotionTarget['status']> = {
  DRAFT: 'pushed',
  NOT_START: 'pushed',
  ONGOING: 'live',
  EXPIRED: 'ended',
  DEACTIVATED: 'deactivated',
  NOT_EFFECTIVE: 'error',
};

/** Read the current status of each pushed activity from TikTok. */
export async function syncPromotion(q: Queries, promotionId: number, client: TtsClient = tts): Promise<Promotion> {
  const p = q.getPromotion(promotionId);
  if (!p) throw new Error('Promotion not found');
  for (const t of p.targets) {
    if (!t.tts_activity_id || !t.tts_shop_id) continue;
    try {
      const creds = await shopCredentials(q, t.tts_shop_id, client);
      const a = await client.getActivity(creds, t.tts_activity_id);
      const s = String(a.status ?? '');
      q.updateTarget(t.id, { tts_status: s, status: STATUS_MAP[s] ?? t.status, error_message: s === 'NOT_EFFECTIVE' ? 'Terminated by TikTok' : null });
    } catch (err) {
      q.updateTarget(t.id, { error_message: (err as Error).message });
    }
  }
  return q.getPromotion(promotionId)!;
}
