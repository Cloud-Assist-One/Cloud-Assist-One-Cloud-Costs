import { tierForPriceId } from '@/lib/stripe';

interface MinimalEvent {
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
      const metadata = object.metadata as Record<string, unknown>;
      return {
        match: { column: 'id', value: companyId },
        values: {
          stripe_customer_id: object.customer,
          stripe_subscription_id: object.subscription,
          subscription_tier: metadata.tier,
          subscription_status: 'active',
        },
      };
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
      // Back to free with a long-past trial_ends_at, which resolveCompanyAccess
      // turns into trial_expired. Cancellation needs no separate path.
      return {
        match: { column: 'id', value: companyId },
        values: {
          subscription_tier: 'free',
          subscription_status: 'canceled',
          stripe_subscription_id: null,
        },
      };
    }

    // Stripe invoices do NOT inherit their subscription's metadata, so these
    // two must find the company by customer id. Matching on metadata here
    // would silently skip the event and leave a failed card invisible.
    case 'invoice.payment_failed': {
      const customerId = customerIdOf(object);
      if (!customerId) return null;
      return {
        match: { column: 'stripe_customer_id', value: customerId },
        values: { subscription_status: 'past_due' },
      };
    }

    case 'invoice.payment_succeeded': {
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
