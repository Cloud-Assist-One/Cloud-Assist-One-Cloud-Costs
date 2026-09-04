import { isPurchasableTier, priceIdForTier, tierForPriceId } from './stripe';

describe('purchasable tiers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      STRIPE_PRICE_SUB4: 'price_sub4',
      STRIPE_PRICE_SUB20: 'price_sub20',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('accepts only the two tiers a customer can buy', () => {
    expect(isPurchasableTier('subscription_4')).toBe(true);
    expect(isPurchasableTier('subscription_20')).toBe(true);
  });

  it('rejects the sales-only and free tiers', () => {
    // subscription_unlimited has no Stripe price by design: it is granted by
    // an admin, never bought.
    expect(isPurchasableTier('subscription_unlimited')).toBe(false);
    expect(isPurchasableTier('free')).toBe(false);
  });

  it('rejects anything that is not a known tier', () => {
    expect(isPurchasableTier('price_1234')).toBe(false);
    expect(isPurchasableTier(null)).toBe(false);
  });

  it('maps a tier to its configured price id', () => {
    expect(priceIdForTier('subscription_4')).toBe('price_sub4');
    expect(priceIdForTier('subscription_20')).toBe('price_sub20');
  });

  it('throws rather than guessing when a price id is not configured', () => {
    delete process.env.STRIPE_PRICE_SUB4;
    expect(() => priceIdForTier('subscription_4')).toThrow(/STRIPE_PRICE_SUB4/);
  });

  it('maps a price id back to its tier for subscription.updated', () => {
    expect(tierForPriceId('price_sub20')).toBe('subscription_20');
  });

  it('returns null for an unknown price id', () => {
    expect(tierForPriceId('price_from_another_account')).toBeNull();
  });
});
