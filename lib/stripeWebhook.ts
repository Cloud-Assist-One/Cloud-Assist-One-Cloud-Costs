import { tierForPriceId } from './stripePricing';
import type { SubscriptionTier } from './subscriptionTiers';

/** The parts of a Stripe subscription this reads, independent of the SDK's own type. */
export interface SubscriptionEvent {
  id: string;
  status: string;
  /** items.data[0].price.id, or null when the subscription has none or more than one. */
  priceId: string | null;
}

export interface CompanyUpdate {
  stripe_subscription_id: string | null;
  subscription_status: string;
  subscription_tier: SubscriptionTier;
}

export type SubscriptionResolution = { action: 'apply'; update: CompanyUpdate } | { action: 'skip'; reason: string };

// Statuses a subscription passes through that still mean "this company paid
// and should keep its tier". past_due and unpaid are included deliberately:
// Stripe's own retry schedule (Smart Retries) keeps trying to collect for
// days before it gives up, and cutting a company off on the first missed
// charge would be harsher than Stripe's own product is designed to be.
// Everything else -- incomplete (first payment never succeeded), canceled,
// paused, and anything this deployment does not recognise -- fails closed.
const ACCESS_GRANTING_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/**
 * What a customer.subscription.created/updated event means for a company's
 * row, decided without touching the database or the Stripe SDK's own types
 * -- the same shape of split as exportDiscovery/pullPlacement, so the
 * webhook route stays thin and this decision is testable on its own.
 *
 * "skip" rather than guessing whenever the subscription does not resolve to
 * exactly one tier: this is a webhook, and Stripe retries on anything but a
 * 2xx, so an unresolvable event -- an unrecognised price, more than one
 * price on the subscription -- has to be answered 200 and left alone rather
 * than have the route 500 into an endless retry loop that will never
 * resolve itself.
 */
export function resolveSubscriptionEvent(event: SubscriptionEvent): SubscriptionResolution {
  if (event.priceId === null) {
    return { action: 'skip', reason: `Subscription ${event.id} carries no single resolvable price.` };
  }

  const tier = tierForPriceId(event.priceId);
  if (!tier) {
    return {
      action: 'skip',
      reason: `Subscription ${event.id} is on price ${event.priceId}, which no configured tier matches.`,
    };
  }

  const grantsAccess = ACCESS_GRANTING_STATUSES.has(event.status);

  return {
    action: 'apply',
    update: {
      stripe_subscription_id: grantsAccess ? event.id : null,
      subscription_status: event.status,
      subscription_tier: grantsAccess ? tier : 'free',
    },
  };
}

/**
 * What customer.subscription.deleted always means, unconditionally -- never
 * "skip". A created/updated event can safely wait for a clearer one when
 * this deployment cannot make sense of it, because there is still a live
 * subscription behind it either way. A deleted event has no such safety
 * net: the subscription is gone, so leaving the company's tier alone on any
 * excuse would strand it on a paid tier with nothing backing it and no
 * future event to ever correct that.
 */
export const SUBSCRIPTION_DELETED_UPDATE: CompanyUpdate = {
  stripe_subscription_id: null,
  subscription_status: 'canceled',
  subscription_tier: 'free',
};
