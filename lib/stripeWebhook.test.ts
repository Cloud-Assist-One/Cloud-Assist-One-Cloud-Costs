import { companyUpdateForEvent } from './stripeWebhook';

beforeEach(() => {
  process.env.STRIPE_PRICE_SUB4 = 'price_sub4';
  process.env.STRIPE_PRICE_SUB20 = 'price_sub20';
});

describe('companyUpdateForEvent', () => {
  it('activates the bought tier on checkout.session.completed', () => {
    const update = companyUpdateForEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { company_id: 'company-1', tier: 'subscription_4' },
        },
      },
    });

    expect(update).toEqual({
      match: { column: 'id', value: 'company-1' },
      values: {
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        subscription_tier: 'subscription_4',
        subscription_status: 'active',
      },
    });
  });

  it('re-derives the tier from the price on subscription.updated', () => {
    const update = companyUpdateForEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          metadata: { company_id: 'company-1' },
          items: { data: [{ price: { id: 'price_sub20' } }] },
        },
      },
    });

    expect(update?.values).toEqual({
      subscription_tier: 'subscription_20',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
    });
  });

  it('returns a company to free when the subscription is deleted', () => {
    const update = companyUpdateForEvent({
      type: 'customer.subscription.deleted',
      data: {
        object: { id: 'sub_1', metadata: { company_id: 'company-1' }, items: { data: [] } },
      },
    });

    expect(update?.values).toEqual({
      subscription_tier: 'free',
      subscription_status: 'canceled',
      stripe_subscription_id: null,
    });
  });

  // Invoices do not inherit subscription metadata, so these two match on the
  // customer id instead. Matching on metadata here would skip the event and
  // leave a failed card invisible.
  it('marks past_due on a failed payment, matching by customer', () => {
    const update = companyUpdateForEvent({
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });

    expect(update).toEqual({
      match: { column: 'stripe_customer_id', value: 'cus_1' },
      values: { subscription_status: 'past_due' },
    });
  });

  it('restores active on a successful payment, matching by customer', () => {
    const update = companyUpdateForEvent({
      type: 'invoice.payment_succeeded',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });

    expect(update).toEqual({
      match: { column: 'stripe_customer_id', value: 'cus_1' },
      values: { subscription_status: 'active' },
    });
  });

  it('ignores events it does not handle', () => {
    expect(
      companyUpdateForEvent({ type: 'customer.created', data: { object: {} } })
    ).toBeNull();
  });

  it('ignores an invoice event carrying no customer', () => {
    expect(
      companyUpdateForEvent({
        type: 'invoice.payment_failed',
        data: { object: { subscription: 'sub_1' } },
      })
    ).toBeNull();
  });

  it('ignores a subscription event carrying no company id', () => {
    expect(
      companyUpdateForEvent({
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', status: 'active', items: { data: [] } } },
      })
    ).toBeNull();
  });

  it('keeps the tier unchanged when the price is from another account', () => {
    const update = companyUpdateForEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          metadata: { company_id: 'company-1' },
          items: { data: [{ price: { id: 'price_unknown' } }] },
        },
      },
    });

    expect(update?.values).toEqual({
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
    });
  });
});
