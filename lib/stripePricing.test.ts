import { isPaidSubscriptionTier, PAID_SUBSCRIPTION_TIERS, priceIdForTier, tierForPriceId } from './stripePricing';

describe('stripePricing', () => {
  const ENV_VARS = ['STRIPE_PRICE_SUBSCRIPTION_4', 'STRIPE_PRICE_SUBSCRIPTION_20', 'STRIPE_PRICE_SUBSCRIPTION_UNLIMITED'];
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_VARS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_VARS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  describe('isPaidSubscriptionTier', () => {
    it('accepts every paid tier', () => {
      for (const tier of PAID_SUBSCRIPTION_TIERS) {
        expect(isPaidSubscriptionTier(tier)).toBe(true);
      }
    });

    // The one tier a checkout must never be started for -- there is no price
    // to charge, and Stripe has no notion of a free subscription.
    it('rejects the free tier', () => {
      expect(isPaidSubscriptionTier('free')).toBe(false);
    });

    it('rejects junk', () => {
      expect(isPaidSubscriptionTier('subscription_4000')).toBe(false);
      expect(isPaidSubscriptionTier(undefined)).toBe(false);
      expect(isPaidSubscriptionTier(null)).toBe(false);
    });
  });

  describe('priceIdForTier', () => {
    it('reads the price configured for a tier', () => {
      process.env.STRIPE_PRICE_SUBSCRIPTION_4 = 'price_abc';

      expect(priceIdForTier('subscription_4')).toBe('price_abc');
    });

    it('returns null when the tier has no price configured yet', () => {
      expect(priceIdForTier('subscription_20')).toBeNull();
    });

    it('trims whitespace and treats a blank value as unset', () => {
      process.env.STRIPE_PRICE_SUBSCRIPTION_4 = '  price_abc  ';
      expect(priceIdForTier('subscription_4')).toBe('price_abc');

      process.env.STRIPE_PRICE_SUBSCRIPTION_20 = '   ';
      expect(priceIdForTier('subscription_20')).toBeNull();
    });

    // Reads process.env live rather than a value captured at import time --
    // otherwise a rotated price id would need a process restart to take
    // effect, silently pointing checkout at whatever price was live at boot.
    it('picks up a value set after the module was first imported', () => {
      expect(priceIdForTier('subscription_unlimited')).toBeNull();
      process.env.STRIPE_PRICE_SUBSCRIPTION_UNLIMITED = 'price_xyz';
      expect(priceIdForTier('subscription_unlimited')).toBe('price_xyz');
    });
  });

  describe('tierForPriceId', () => {
    it('resolves a configured price back to its tier', () => {
      process.env.STRIPE_PRICE_SUBSCRIPTION_20 = 'price_twenty';

      expect(tierForPriceId('price_twenty')).toBe('subscription_20');
    });

    // The two directions are built from the same env vars, so distinct
    // tiers can never resolve to the same price without one silently
    // shadowing the other in this lookup too.
    it('does not confuse two different tiers configured with different prices', () => {
      process.env.STRIPE_PRICE_SUBSCRIPTION_4 = 'price_four';
      process.env.STRIPE_PRICE_SUBSCRIPTION_20 = 'price_twenty';

      expect(tierForPriceId('price_four')).toBe('subscription_4');
      expect(tierForPriceId('price_twenty')).toBe('subscription_20');
    });

    // A price this deployment does not recognise is exactly as unresolved as
    // a tier with no price configured -- the webhook must treat both cases
    // the same way: do nothing rather than guess.
    it('returns null for a price nothing is configured with', () => {
      process.env.STRIPE_PRICE_SUBSCRIPTION_4 = 'price_four';

      expect(tierForPriceId('price_unrelated')).toBeNull();
    });

    it('returns null when no price is configured at all', () => {
      expect(tierForPriceId('price_anything')).toBeNull();
    });
  });
});
