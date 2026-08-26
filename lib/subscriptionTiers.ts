export const SUBSCRIPTION_TIERS = [
  'free',
  'subscription_4',
  'subscription_20',
  'subscription_unlimited',
] as const;

export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const SUBSCRIPTION_TIER_LABELS: Record<SubscriptionTier, string> = {
  free: 'Free',
  subscription_4: 'Subscription 4',
  subscription_20: 'Subscription 20',
  subscription_unlimited: 'Subscription Unlimited',
};

// How many cloud connections a tier allows in total, counted across every
// provider rather than per provider: a Free account's single connection can
// be AWS or Azure, not one of each. null means no cap.
export const CONNECTION_LIMITS: Record<SubscriptionTier, number | null> = {
  free: 1,
  subscription_4: 4,
  subscription_20: 20,
  subscription_unlimited: null,
};

export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return typeof value === 'string' && (SUBSCRIPTION_TIERS as readonly string[]).includes(value);
}

// Anything unrecognised is treated as the most restrictive tier, so a bad or
// missing value can never hand out more connections than intended.
export function connectionLimitFor(tier: unknown): number | null {
  return isSubscriptionTier(tier) ? CONNECTION_LIMITS[tier] : CONNECTION_LIMITS.free;
}

export function canAddConnection(tier: unknown, currentCount: number): boolean {
  const limit = connectionLimitFor(tier);
  if (limit === null) return true;
  return currentCount < limit;
}

/** Message shown when the Add Connection control is disabled. */
export function connectionLimitMessage(tier: unknown, currentCount: number): string | null {
  const limit = connectionLimitFor(tier);
  if (limit === null || currentCount < limit) return null;
  const tierLabel = isSubscriptionTier(tier) ? SUBSCRIPTION_TIER_LABELS[tier] : SUBSCRIPTION_TIER_LABELS.free;
  const plural = limit === 1 ? 'connection' : 'connections';
  return `Your ${tierLabel} plan includes ${limit} cloud ${plural}. Contact us to add more.`;
}
