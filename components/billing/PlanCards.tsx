'use client';

import { useState } from 'react';
import type { CompanyAccess } from '@/lib/companyAccess';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// subscription_unlimited is intentionally absent: it is admin-granted, not
// something a customer can self-serve buy (see lib/stripe.ts PURCHASABLE_TIERS).
const PLANS = [
  {
    tier: 'subscription_4' as const,
    name: 'Subscription 4',
    price: '$150',
    blurb: 'Up to 4 cloud connections.',
  },
  {
    tier: 'subscription_20' as const,
    name: 'Subscription 20',
    price: '$250',
    blurb: 'Up to 20 cloud connections.',
  },
];

export default function PlanCards({
  companyId,
  access,
  hasCustomer,
}: {
  companyId: string;
  access: CompanyAccess;
  hasCustomer: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(path: string, body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Something went wrong.');
      // Stripe types session.url as `string | null`; a falsy url here would
      // otherwise leave busy set forever with the button stuck on "Opening
      // Stripe..." and no explanation, since nothing would throw to reach
      // the catch below.
      if (!data.url) throw new Error('Something went wrong. Please try again.');
      window.location.href = data.url;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
      setBusy(null);
    }
  }

  // active, past_due, and exempt all mean the company already has a tier --
  // exempt covers subscription_unlimited plus any other admin-granted paid
  // plan (see resolveCompanyAccess) -- so all three must be checked to grey
  // out the matching card instead of only the two the brief called out.
  const currentTier =
    access.state === 'active' || access.state === 'past_due' || access.state === 'exempt'
      ? access.tier
      : null;

  // Only 'active'/'past_due' carry a live Stripe subscription (exempt, by
  // definition in resolveCompanyAccess, never has a stripe_subscription_id),
  // so only those two states hit the checkout route's existing-subscription
  // guard. Routing the *other* plan's button through the portal instead of
  // checkout means the customer is never left clicking something that now
  // 400s -- Stripe's portal already handles switching plans with proration.
  const mustUsePortalToSwitch = access.state === 'active' || access.state === 'past_due';

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        {PLANS.map((plan) => (
          <Card key={plan.tier}>
            <CardHeader>
              <CardTitle className="text-xl">{plan.name}</CardTitle>
              <p className="text-3xl font-bold">
                {plan.price}
                <span className="text-base font-normal text-muted-foreground">/mo</span>
              </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">{plan.blurb}</p>
              {currentTier !== plan.tier && mustUsePortalToSwitch ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null}
                  aria-busy={busy === 'portal'}
                  onClick={() => go('/api/billing/portal', { companyId }, 'portal')}
                  className="w-full"
                >
                  {busy === 'portal' ? 'Opening Stripe...' : 'Manage billing to switch'}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={busy !== null || currentTier === plan.tier}
                  aria-busy={busy === plan.tier}
                  onClick={() => go('/api/billing/checkout', { companyId, tier: plan.tier }, plan.tier)}
                  className="w-full"
                >
                  {currentTier === plan.tier
                    ? 'Current plan'
                    : busy === plan.tier
                      ? 'Opening Stripe...'
                      : `Choose ${plan.name}`}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        Need more than 20 connections? Contact us and we will set you up.
      </p>

      {hasCustomer ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null}
          aria-busy={busy === 'portal'}
          onClick={() => go('/api/billing/portal', { companyId }, 'portal')}
          className="self-start"
        >
          {busy === 'portal' ? 'Opening Stripe...' : 'Manage billing'}
        </Button>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
