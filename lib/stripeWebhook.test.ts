import { companyUpdateForEvent } from './stripeWebhook';

beforeEach(() => {
  process.env.STRIPE_PRICE_SUB4 = 'price_sub4';
  process.env.STRIPE_PRICE_SUB20 = 'price_sub20';
});

describe('companyUpdateForEvent', () => {
  it('activates the bought tier on checkout.session.completed', () => {
    const update = companyUpdateForEvent({
      id: 'evt_1',
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

  // Regression test for Important 3: a Checkout session not created by our
  // own route (dashboard, payment link, legacy session) can carry metadata
  // that never got a tier at all. subscription_tier is CHECK-constrained, so
  // writing an unvalidated value verbatim would fail the whole update and
  // have Stripe retry the event forever while the customer stays locked
  // despite having paid.
  it('omits subscription_tier and logs when metadata has no tier, but still applies the rest', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const update = companyUpdateForEvent({
      id: 'evt_missing_tier',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { company_id: 'company-1' },
        },
      },
    });

    expect(update).toEqual({
      match: { column: 'id', value: 'company-1' },
      values: {
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        subscription_status: 'active',
      },
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('evt_missing_tier'));

    errorSpy.mockRestore();
  });

  it('omits subscription_tier and logs when metadata carries a garbage tier', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const update = companyUpdateForEvent({
      id: 'evt_garbage_tier',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { company_id: 'company-1', tier: 'enterprise_gold' },
        },
      },
    });

    expect(update).toEqual({
      match: { column: 'id', value: 'company-1' },
      values: {
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        subscription_status: 'active',
      },
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('evt_garbage_tier'));

    errorSpy.mockRestore();
  });

  it('re-derives the tier from the price on subscription.updated', () => {
    const update = companyUpdateForEvent({
      id: 'evt_2',
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

  it('returns a company to free and clears trial_ends_at when the subscription is deleted', () => {
    const update = companyUpdateForEvent({
      id: 'evt_3',
      type: 'customer.subscription.deleted',
      data: {
        object: { id: 'sub_1', metadata: { company_id: 'company-1' }, items: { data: [] } },
      },
    });

    expect(update?.values).toEqual({
      subscription_tier: 'free',
      subscription_status: 'canceled',
      stripe_subscription_id: null,
      trial_ends_at: null,
    });
  });

  // Regression test for Critical 2: cancelling a subscription that was
  // bought during the original 30-day trial must not re-grant the remaining
  // trial days. Nulling trial_ends_at is what makes resolveCompanyAccess
  // land on trial_expired instead of trialing -- see the corresponding
  // resolveCompanyAccess assertion in companyAccess.test.ts.
  it('nulls trial_ends_at even though the deleted subscription event never mentions it', () => {
    const update = companyUpdateForEvent({
      id: 'evt_cancel_during_trial',
      type: 'customer.subscription.deleted',
      data: {
        object: { id: 'sub_1', metadata: { company_id: 'company-1' } },
      },
    });

    expect(update?.values.trial_ends_at).toBeNull();
  });

  // Invoices do not inherit subscription metadata, so these two match on the
  // customer id instead. Matching on metadata here would skip the event and
  // leave a failed card invisible.
  it('marks past_due on a failed payment, matching by customer', () => {
    const update = companyUpdateForEvent({
      id: 'evt_4',
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
      id: 'evt_5',
      type: 'invoice.payment_succeeded',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });

    expect(update).toEqual({
      match: { column: 'stripe_customer_id', value: 'cus_1' },
      values: { subscription_status: 'active' },
    });
  });

  // Regression test for Important 4: a consulting invoice is billed to the
  // same Stripe customer as any subscription that customer might also have,
  // but has no `subscription` field. Without this check, paying it would
  // wrongly flip a genuinely past_due subscriber back to active, and letting
  // it go unpaid would wrongly flip a healthy subscriber to past_due.
  it('ignores a failed-payment event for an invoice with no subscription (a consulting invoice)', () => {
    expect(
      companyUpdateForEvent({
        id: 'evt_consulting_failed',
        type: 'invoice.payment_failed',
        data: { object: { customer: 'cus_1' } },
      })
    ).toBeNull();
  });

  it('ignores a succeeded-payment event for an invoice with no subscription (a consulting invoice)', () => {
    expect(
      companyUpdateForEvent({
        id: 'evt_consulting_succeeded',
        type: 'invoice.payment_succeeded',
        data: { object: { customer: 'cus_1' } },
      })
    ).toBeNull();
  });

  it('ignores events it does not handle', () => {
    expect(
      companyUpdateForEvent({ id: 'evt_6', type: 'customer.created', data: { object: {} } })
    ).toBeNull();
  });

  it('ignores an invoice event carrying no customer', () => {
    expect(
      companyUpdateForEvent({
        id: 'evt_7',
        type: 'invoice.payment_failed',
        data: { object: { subscription: 'sub_1' } },
      })
    ).toBeNull();
  });

  it('ignores a subscription event carrying no company id', () => {
    expect(
      companyUpdateForEvent({
        id: 'evt_8',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', status: 'active', items: { data: [] } } },
      })
    ).toBeNull();
  });

  it('keeps the tier unchanged when the price is from another account', () => {
    const update = companyUpdateForEvent({
      id: 'evt_9',
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
