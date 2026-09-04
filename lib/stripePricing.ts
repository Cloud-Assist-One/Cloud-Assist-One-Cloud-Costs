import { SUBSCRIPTION_TIERS } from './subscriptionTiers';
import type { SubscriptionTier } from './subscriptionTiers';

export type PaidSubscriptionTier = Exclude<SubscriptionTier, 'free'>;

export const PAID_SUBSCRIPTION_TIERS: readonly PaidSubscriptionTier[] = SUBSCRIPTION_TIERS.filter(
  (tier): tier is PaidSubscriptionTier => tier !== 'free'
);

export function isPaidSubscriptionTier(value: unknown): value is PaidSubscriptionTier {
  return (PAID_SUBSCRIPTION_TIERS as readonly string[]).includes(value as string);
}

// One Stripe Price per paid tier, named by env var rather than hard-coded --
// a Price id is created per Stripe account (and differs between test and
// live mode), so it can never be a source constant the way the tier names
// themselves are.
const PRICE_ENV_VAR: Record<PaidSubscriptionTier, string> = {
  subscription_4: 'STRIPE_PRICE_SUBSCRIPTION_4',
  subscription_20: 'STRIPE_PRICE_SUBSCRIPTION_20',
  subscription_unlimited: 'STRIPE_PRICE_SUBSCRIPTION_UNLIMITED',
};

/**
 * Read live, not cached at module load: a test sets and unsets
 * process.env per case, and a route reading a stale value baked in at cold
 * start would silently keep pointing at a price that was since rotated.
 */
export function priceIdForTier(tier: PaidSubscriptionTier): string | null {
  return process.env[PRICE_ENV_VAR[tier]]?.trim() || null;
}

/**
 * The inverse of priceIdForTier, for the webhook: which tier does a Stripe
 * Price belong to. Built by searching the SAME env vars priceIdForTier
 * reads, rather than a second hard-coded table, so the two directions can
 * never disagree about which price maps to which tier.
 *
 * Null covers two cases the webhook has to treat the same way -- do
 * nothing rather than guess: a price this deployment has no tier configured
 * for, and a tier that itself has no price configured (an env var left
 * unset, which priceIdForTier already reports as its own null).
 */
export function tierForPriceId(priceId: string): PaidSubscriptionTier | null {
  return PAID_SUBSCRIPTION_TIERS.find((tier) => priceIdForTier(tier) === priceId) ?? null;
}
