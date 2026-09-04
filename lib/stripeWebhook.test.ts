import { resolveSubscriptionEvent, SUBSCRIPTION_DELETED_UPDATE } from './stripeWebhook';

describe('resolveSubscriptionEvent', () => {
  const originalPrice20 = process.env.STRIPE_PRICE_SUBSCRIPTION_20;

  beforeEach(() => {
    process.env.STRIPE_PRICE_SUBSCRIPTION_20 = 'price_twenty';
  });

  afterEach(() => {
    if (originalPrice20 === undefined) delete process.env.STRIPE_PRICE_SUBSCRIPTION_20;
    else process.env.STRIPE_PRICE_SUBSCRIPTION_20 = originalPrice20;
  });

  it('grants the tier for an active subscription', () => {
    const result = resolveSubscriptionEvent({ id: 'sub_1', status: 'active', priceId: 'price_twenty' });

    expect(result).toEqual({
      action: 'apply',
      update: { stripe_subscription_id: 'sub_1', subscription_status: 'active', subscription_tier: 'subscription_20' },
    });
  });

  it('grants the tier while trialing', () => {
    const result = resolveSubscriptionEvent({ id: 'sub_1', status: 'trialing', priceId: 'price_twenty' });

    expect(result.action).toBe('apply');
    expect((result as { update: { subscription_tier: string } }).update.subscription_tier).toBe('subscription_20');
  });

  // Stripe's own Smart Retries keep trying to collect for days before
  // giving up. Cutting access on the first missed charge would be harsher
  // than Stripe's own product is designed to be.
  it.each(['past_due', 'unpaid'])('keeps the tier through a %s subscription', (status) => {
    const result = resolveSubscriptionEvent({ id: 'sub_1', status, priceId: 'price_twenty' });

    expect(result).toEqual({
      action: 'apply',
      update: { stripe_subscription_id: 'sub_1', subscription_status: status, subscription_tier: 'subscription_20' },
    });
  });

  // The one status this must never grant on: the FIRST payment has not
  // succeeded yet (e.g. still waiting on 3D Secure). Granting here would
  // hand out a paid tier before any money has actually moved.
  it('does not grant the tier for an incomplete subscription', () => {
    const result = resolveSubscriptionEvent({ id: 'sub_1', status: 'incomplete', priceId: 'price_twenty' });

    expect(result).toEqual({
      action: 'apply',
      update: { stripe_subscription_id: null, subscription_status: 'incomplete', subscription_tier: 'free' },
    });
  });

  it.each(['incomplete_expired', 'canceled', 'paused'])('reverts to free for a %s subscription', (status) => {
    const result = resolveSubscriptionEvent({ id: 'sub_1', status, priceId: 'price_twenty' });

    expect(result).toEqual({
      action: 'apply',
      update: { stripe_subscription_id: null, subscription_status: status, subscription_tier: 'free' },
    });
  });

  // Fails closed on anything this deployment does not recognise, including a
  // status a future Stripe API version might add -- rather than defaulting
  // to granting access on a status nobody anticipated.
  it('fails closed on an unrecognised status', () => {
    const result = resolveSubscriptionEvent({ id: 'sub_1', status: 'some_future_status', priceId: 'price_twenty' });

    expect((result as { update: { subscription_tier: string } }).update.subscription_tier).toBe('free');
  });

  it('skips a subscription with no single resolvable price', () => {
    const result = resolveSubscriptionEvent({ id: 'sub_1', status: 'active', priceId: null });

    expect(result).toEqual({ action: 'skip', reason: expect.stringContaining('sub_1') });
  });

  it('skips a price no configured tier matches, rather than guessing', () => {
    const result = resolveSubscriptionEvent({ id: 'sub_1', status: 'active', priceId: 'price_unrecognised' });

    expect(result.action).toBe('skip');
  });
});

describe('SUBSCRIPTION_DELETED_UPDATE', () => {
  // Deletion has no ambiguous case to skip on -- the subscription really is
  // gone -- so this is a fixed constant, not a function with a decision to
  // get wrong.
  it('unconditionally reverts to free and clears the subscription id', () => {
    expect(SUBSCRIPTION_DELETED_UPDATE).toEqual({
      stripe_subscription_id: null,
      subscription_status: 'canceled',
      subscription_tier: 'free',
    });
  });
});
