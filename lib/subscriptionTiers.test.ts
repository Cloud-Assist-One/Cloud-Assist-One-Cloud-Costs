import {
  canAddConnection,
  connectionLimitFor,
  connectionLimitMessage,
  isSubscriptionTier,
  SUBSCRIPTION_TIERS,
} from './subscriptionTiers';

describe('subscriptionTiers', () => {
  it('caps each tier at its documented number of connections', () => {
    expect(connectionLimitFor('free')).toBe(1);
    expect(connectionLimitFor('subscription_4')).toBe(4);
    expect(connectionLimitFor('subscription_20')).toBe(20);
    expect(connectionLimitFor('subscription_unlimited')).toBeNull();
  });

  it('treats an unknown or missing tier as Free rather than unlimited', () => {
    // A bad value must never hand out more than the smallest plan.
    expect(connectionLimitFor('enterprise')).toBe(1);
    expect(connectionLimitFor(null)).toBe(1);
    expect(connectionLimitFor(undefined)).toBe(1);
  });

  it('allows a Free account its first connection and refuses the second', () => {
    expect(canAddConnection('free', 0)).toBe(true);
    expect(canAddConnection('free', 1)).toBe(false);
  });

  it('counts connections across every provider, not per provider', () => {
    // Four already added, whatever mix of clouds they are.
    expect(canAddConnection('subscription_4', 3)).toBe(true);
    expect(canAddConnection('subscription_4', 4)).toBe(false);
  });

  it('never blocks the unlimited tier', () => {
    expect(canAddConnection('subscription_unlimited', 0)).toBe(true);
    expect(canAddConnection('subscription_unlimited', 500)).toBe(true);
  });

  it('explains the limit only once it has been reached', () => {
    expect(connectionLimitMessage('free', 0)).toBeNull();
    expect(connectionLimitMessage('free', 1)).toMatch(/Free plan includes 1 cloud connection/);
    expect(connectionLimitMessage('subscription_20', 20)).toMatch(/includes 20 cloud connections/);
    expect(connectionLimitMessage('subscription_unlimited', 999)).toBeNull();
  });

  it('recognises only the four known tiers', () => {
    for (const tier of SUBSCRIPTION_TIERS) {
      expect(isSubscriptionTier(tier)).toBe(true);
    }
    expect(isSubscriptionTier('subscription_5')).toBe(false);
    expect(isSubscriptionTier('')).toBe(false);
  });
});
