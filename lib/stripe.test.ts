import { isPurchasableTier, priceIdForTier, tierForPriceId, getStripe } from './stripe';

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

  it('throws when multiple tiers share the same price id', () => {
    process.env.STRIPE_PRICE_SUB4 = 'price_shared';
    process.env.STRIPE_PRICE_SUB20 = 'price_shared';
    expect(() => tierForPriceId('price_shared')).toThrow(
      /STRIPE_PRICE_SUB4 and STRIPE_PRICE_SUB20 must not share a price id/
    );
  });

  it('returns null for an empty price id', () => {
    expect(tierForPriceId('')).toBeNull();
  });

  it('returns null for a whitespace-only price id', () => {
    expect(tierForPriceId('   ')).toBeNull();
  });
});

describe('getStripe', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  it('throws when STRIPE_SECRET_KEY is unset', async () => {
    process.env = { ...originalEnv };
    delete process.env.STRIPE_SECRET_KEY;

    jest.resetModules();
    const { getStripe: getStripeUnset } = await import('./stripe');
    expect(() => getStripeUnset()).toThrow('STRIPE_SECRET_KEY is not set');
  });

  it('throws when STRIPE_SECRET_KEY is blank', async () => {
    process.env = {
      ...originalEnv,
      STRIPE_SECRET_KEY: '   ',
    };

    jest.resetModules();
    const { getStripe: getStripeBlank } = await import('./stripe');
    expect(() => getStripeBlank()).toThrow('STRIPE_SECRET_KEY is not set');
  });

  it('returns a Stripe instance when STRIPE_SECRET_KEY is set', async () => {
    process.env = {
      ...originalEnv,
      STRIPE_SECRET_KEY: 'sk_test_valid_test_key_not_real',
    };

    jest.resetModules();
    const mockStripeInstance = { test: 'mock' };
    jest.doMock('stripe', () => {
      return jest.fn(() => mockStripeInstance);
    });

    const { getStripe: getStripeValid } = await import('./stripe');
    const stripe = getStripeValid();
    expect(stripe).toBe(mockStripeInstance);
  });

  it('returns the same cached instance on subsequent calls', async () => {
    process.env = {
      ...originalEnv,
      STRIPE_SECRET_KEY: 'sk_test_valid_test_key_not_real',
    };

    jest.resetModules();
    let constructorCallCount = 0;
    const mockStripeInstance = { test: 'mock' };
    jest.doMock('stripe', () => {
      return jest.fn(() => {
        constructorCallCount++;
        return mockStripeInstance;
      });
    });

    const { getStripe: getStripeCached } = await import('./stripe');
    const instance1 = getStripeCached();
    const instance2 = getStripeCached();
    expect(instance1).toBe(instance2);
    expect(constructorCallCount).toBe(1);
  });
});
