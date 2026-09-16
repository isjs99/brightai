import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signRequest } from '../src/tts/client';
import { activityBody, productRows } from '../src/tts/promotions';
import { marketsOf, marketFromRegion } from '../src/tts/markets';
import type { Promotion, PromotionTarget } from '../src/sweep/types';

describe('TikTok Shop signing', () => {
  it('signs path + sorted query + body wrapped in the secret, ignoring sign and access_token', () => {
    const secret = 'abc';
    const path = '/promotion/202309/activities';
    const query = { timestamp: '1700000000', app_key: 'k1', shop_cipher: 'c1', sign: 'ignored', access_token: 'ignored' };
    const body = '{"title":"x"}';
    const expected = createHmac('sha256', secret).update(`${secret}${path}app_keyk1shop_cipherc1timestamp1700000000${body}${secret}`).digest('hex');
    expect(signRequest(secret, path, query, body)).toBe(expected);
  });
});

describe('promotion payloads', () => {
  const promo: Promotion = {
    id: 1,
    name: 'Black Friday 15% off',
    activity_type: 'DIRECT_DISCOUNT',
    product_level: 'PRODUCT',
    discount_type: 'PERCENTAGE_OFF',
    discount_value: 15,
    begin_at: '2026-11-27T00:00:00.000Z',
    end_at: '2026-11-30T23:59:00.000Z',
    participation: 'BUYER_NO_LIMIT',
    products: { shopA: ['p1', 'p2'] },
    notes: null,
    created_by: null,
    created_at: '',
    updated_at: '',
    targets: [],
  };
  const target: PromotionTarget = { id: 1, promotion_id: 1, account_id: 1, account_name: 'Kijimea', market: 'DE', tts_shop_id: 'shopA', tts_shop_name: 'Kijimea DE', status: 'planned', tts_activity_id: null, tts_status: null, error_message: null, pushed_at: null };

  it('builds CreateActivity with unix times and a per-market title', () => {
    const b = activityBody(promo, target);
    expect(b.title).toBe('Black Friday 15% off DE');
    expect(b.begin_time).toBe(Math.floor(Date.parse(promo.begin_at) / 1000));
    expect(b.product_level).toBe('PRODUCT');
    expect(b.participation_limit).toEqual([{ type: 'BUYER_NO_LIMIT' }]);
  });

  it('builds product rows with the discount for DIRECT_DISCOUNT and a deal price for FIXED_PRICE', () => {
    expect(productRows(promo, 'shopA')).toEqual([
      { id: 'p1', quantity_limit: -1, quantity_per_user: -1, skus: [], discount: '15' },
      { id: 'p2', quantity_limit: -1, quantity_per_user: -1, skus: [], discount: '15' },
    ]);
    expect(productRows({ ...promo, activity_type: 'FIXED_PRICE', discount_value: 9.99 }, 'shopA')[0].activity_price_amount).toBe('9.99');
    expect(productRows(promo, 'other')).toEqual([]);
  });

  it('shipping discounts always apply at shop level', () => {
    const b = activityBody({ ...promo, activity_type: 'SHIPPING_DISCOUNT', discount_value: 100 }, target);
    expect(b.product_level).toBe('SHOP');
    expect(b.discount).toEqual({ shipping_discount: { type: 'PERCENTAGE_OFF', value: '100' } });
  });
});

describe('markets', () => {
  it('parses roster markets and maps regions', () => {
    expect(marketsOf('DE/IT/FR/ES')).toEqual(['DE', 'IT', 'FR', 'ES']);
    expect(marketsOf('DE / UK / N')).toEqual(['DE', 'UK']);
    expect(marketsOf(null)).toEqual([]);
    expect(marketFromRegion('GB')).toBe('UK');
    expect(marketFromRegion('DE')).toBe('DE');
  });
});
