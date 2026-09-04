import Stripe from 'stripe';
import type { SubscriptionTier } from '@/lib/subscriptionTiers';

/** The tiers a customer can buy. subscription_unlimited is admin-granted. */
export const PURCHASABLE_TIERS = ['subscription_4', 'subscription_20'] as const;

export type PurchasableTier = (typeof PURCHASABLE_TIERS)[number];

const PRICE_ENV_VAR: Record<PurchasableTier, string> = {
  subscription_4: 'STRIPE_PRICE_SUB4',
  subscription_20: 'STRIPE_PRICE_SUB20',
};

export function isPurchasableTier(value: unknown): value is PurchasableTier {
  return typeof value === 'string' && (PURCHASABLE_TIERS as readonly string[]).includes(value);
}

/**
 * Throws rather than returning a fallback: a missing price id is a
 * deployment mistake, and quietly charging the wrong plan is far worse than
 * a failed checkout.
 */
export function priceIdForTier(tier: PurchasableTier): string {
  const envVar = PRICE_ENV_VAR[tier];
  const priceId = (process.env[envVar] ?? '').trim();
  if (!priceId) throw new Error(`${envVar} is not set, so ${tier} cannot be sold.`);
  return priceId;
}

/** Reverse lookup for customer.subscription.updated. */
export function tierForPriceId(priceId: string): SubscriptionTier | null {
  // Guard against falsy or blank price ids: an empty string from unset env
  // should not match and return a tier.
  if (!priceId || !priceId.trim()) return null;

  const matches: PurchasableTier[] = [];
  for (const tier of PURCHASABLE_TIERS) {
    if ((process.env[PRICE_ENV_VAR[tier]] ?? '').trim() === priceId) {
      matches.push(tier);
    }
  }

  if (matches.length > 1) {
    const envVars = matches.map((tier) => PRICE_ENV_VAR[tier]).join(' and ');
    throw new Error(
      `Multiple tiers map to price id ${priceId}: ${envVars} must not share a price id.`
    );
  }

  return matches.length === 1 ? matches[0] : null;
}

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const key = (process.env.STRIPE_SECRET_KEY ?? '').trim();
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set.');
  cached = new Stripe(key);
  return cached;
}
