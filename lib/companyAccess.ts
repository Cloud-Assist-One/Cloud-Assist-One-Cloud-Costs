import { isSubscriptionTier, type SubscriptionTier } from '@/lib/subscriptionTiers';

/** The billing-relevant columns of a company row. */
export interface CompanyBillingRow {
  subscription_tier: string | null;
  trial_ends_at: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
}

export type CompanyAccess =
  | { state: 'trialing'; daysLeft: number; trialEndsAt: string }
  | { state: 'trial_expired'; trialEndsAt: string | null }
  | { state: 'active'; tier: SubscriptionTier }
  | { state: 'past_due'; tier: SubscriptionTier }
  | { state: 'exempt'; tier: SubscriptionTier };

const MS_PER_DAY = 86_400_000;

/** Whole days remaining, rounded up, floored at 0. */
export function trialDaysLeft(trialEndsAt: string | null, now: Date = new Date()): number {
  if (!trialEndsAt) return 0;
  const ends = new Date(trialEndsAt).getTime();
  if (Number.isNaN(ends)) return 0;
  return Math.max(0, Math.ceil((ends - now.getTime()) / MS_PER_DAY));
}

/**
 * Order matters. Rule 5 is the catch-all that locks anything we cannot
 * positively identify as paid or in-trial, which is also how cancellation
 * works: the webhook returns a canceled company to 'free', and its long-past
 * trial_ends_at drops it straight to trial_expired with no separate path.
 */
export function resolveCompanyAccess(
  row: CompanyBillingRow | null,
  now: Date = new Date()
): CompanyAccess {
  if (!row) return { state: 'trial_expired', trialEndsAt: null };

  const tier = row.subscription_tier;

  if (isSubscriptionTier(tier) && tier !== 'free') {
    // A paid tier with no Stripe subscription was granted by an admin --
    // every subscription_unlimited customer, plus anyone predating billing.
    // These must never be gated.
    if (!row.stripe_subscription_id) return { state: 'exempt', tier };

    if (row.subscription_status === 'past_due') return { state: 'past_due', tier };

    if (row.subscription_status === 'active' || row.subscription_status === 'trialing') {
      return { state: 'active', tier };
    }
  }

  if (tier === 'free' && row.trial_ends_at) {
    const ends = new Date(row.trial_ends_at).getTime();
    if (!Number.isNaN(ends) && ends > now.getTime()) {
      return {
        state: 'trialing',
        daysLeft: trialDaysLeft(row.trial_ends_at, now),
        trialEndsAt: row.trial_ends_at,
      };
    }
  }

  return { state: 'trial_expired', trialEndsAt: row.trial_ends_at };
}
