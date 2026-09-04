import { isPurchasableTier, tierForPriceId } from '@/lib/stripe';

interface MinimalEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface CompanyUpdate {
  match: { column: 'id' | 'stripe_customer_id'; value: string };
  values: Record<string, unknown>;
}

/** Company id from an object's own metadata, set by the checkout route. */
function companyIdOf(object: Record<string, unknown>): string | null {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const id = metadata?.company_id;
  return typeof id === 'string' && id ? id : null;
}

function customerIdOf(object: Record<string, unknown>): string | null {
  const customer = object.customer;
  return typeof customer === 'string' && customer ? customer : null;
}

/**
 * True only for an invoice that belongs to a subscription. A consulting
 * invoice is billed to the same Stripe customer as any subscription that
 * customer might also have, but says nothing about that subscription's
 * health -- a one-off invoice going unpaid must not flip a healthy
 * subscriber to past_due, and paying one must not flip a genuinely past_due
 * subscriber back to active.
 */
function hasSubscription(object: Record<string, unknown>): boolean {
  const subscription = object.subscription;
  return typeof subscription === 'string' && subscription.length > 0;
}

/**
 * Pure: decides what a Stripe event means for a company row. Keeping this
 * out of the route lets every event be tested without faking signature
 * verification.
 */
export function companyUpdateForEvent(event: MinimalEvent): CompanyUpdate | null {
  const object = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const companyId = companyIdOf(object);
      if (!companyId) return null;
      const metadata = object.metadata as Record<string, unknown> | undefined;

      const values: Record<string, unknown> = {
        stripe_customer_id: object.customer,
        stripe_subscription_id: object.subscription,
        subscription_status: 'active',
      };

      // subscription_tier still carries a CHECK constraint. A Checkout
      // session not created by our own route -- the Stripe dashboard, a
      // payment link, a legacy session -- can carry metadata.tier that is
      // missing or misspelled. Writing it verbatim would fail the whole
      // update, release the claim, and have Stripe retry this event
      // forever while the customer is charged and never unlocked. Omit the
      // field instead and still apply the rest: the customer/subscription
      // ids are real regardless, and an admin can fix the tier by hand.
      if (isPurchasableTier(metadata?.tier)) {
        values.subscription_tier = metadata?.tier;
      } else {
        console.error(
          `webhook: checkout.session.completed (event ${event.id}) for company ${companyId} ` +
            `has a non-purchasable tier in its metadata: ${JSON.stringify(metadata?.tier)}`
        );
      }

      return { match: { column: 'id', value: companyId }, values };
    }

    case 'customer.subscription.updated': {
      const companyId = companyIdOf(object);
      if (!companyId) return null;

      const items = object.items as { data?: { price?: { id?: string } }[] } | undefined;
      const priceId = items?.data?.[0]?.price?.id;
      const tier = priceId ? tierForPriceId(priceId) : null;

      const values: Record<string, unknown> = {
        subscription_status: object.status,
        stripe_subscription_id: object.id,
      };
      // An unrecognised price means the plan was changed in the Stripe
      // dashboard to something we do not sell. Leave the tier alone rather
      // than guessing a limit.
      if (tier) values.subscription_tier = tier;

      return { match: { column: 'id', value: companyId }, values };
    }

    case 'customer.subscription.deleted': {
      const companyId = companyIdOf(object);
      if (!companyId) return null;
      // Back to free with trial_ends_at cleared, which resolveCompanyAccess
      // turns into trial_expired. Cancellation needs no separate path.
      //
      // trial_ends_at MUST be nulled, not merely left as whatever it already
      // was: a company that subscribed inside its 30-day trial still has a
      // future trial_ends_at on this row. Leaving it alone would make
      // resolveCompanyAccess see free + a not-yet-passed trial date and
      // return 'trialing' -- re-granting the remaining trial days (with a
      // countdown banner) to an account that just canceled a paid plan.
      return {
        match: { column: 'id', value: companyId },
        values: {
          subscription_tier: 'free',
          subscription_status: 'canceled',
          stripe_subscription_id: null,
          trial_ends_at: null,
        },
      };
    }

    // Stripe invoices do NOT inherit their subscription's metadata, so these
    // two must find the company by customer id. Matching on metadata here
    // would silently skip the event and leave a failed card invisible.
    case 'invoice.payment_failed': {
      // A consulting invoice has no subscription field and is billed to the
      // same customer as any subscription that customer might also have.
      // Without this check, an unpaid consulting invoice would flip a
      // healthy subscriber to past_due and show a false red banner.
      if (!hasSubscription(object)) return null;
      const customerId = customerIdOf(object);
      if (!customerId) return null;
      return {
        match: { column: 'stripe_customer_id', value: customerId },
        values: { subscription_status: 'past_due' },
      };
    }

    case 'invoice.payment_succeeded': {
      // Same reasoning as invoice.payment_failed: a paid consulting invoice
      // must not flip a genuinely past_due subscriber back to active.
      if (!hasSubscription(object)) return null;
      const customerId = customerIdOf(object);
      if (!customerId) return null;
      return {
        match: { column: 'stripe_customer_id', value: customerId },
        values: { subscription_status: 'active' },
      };
    }

    default:
      return null;
  }
}
