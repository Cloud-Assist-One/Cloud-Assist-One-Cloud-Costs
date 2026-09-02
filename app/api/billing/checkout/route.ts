import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { createStripeClient } from '@/lib/stripe';
import { isPaidSubscriptionTier, priceIdForTier } from '@/lib/stripePricing';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const companyId = body?.companyId;
  const tier = body?.tier;

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  if (!isPaidSubscriptionTier(tier)) {
    return NextResponse.json({ error: 'tier must be one of the paid subscription tiers.' }, { status: 400 });
  }

  const priceId = priceIdForTier(tier);
  if (!priceId) {
    console.error(`billing/checkout: no Stripe price configured for ${tier}.`);
    return NextResponse.json({ error: 'This plan is not available for checkout yet. Contact support.' }, { status: 500 });
  }

  let stripe: Stripe;
  try {
    stripe = createStripeClient();
  } catch (err) {
    console.error('billing/checkout: Stripe is not configured:', err);
    return NextResponse.json({ error: 'Billing is not set up yet. Contact support.' }, { status: 500 });
  }

  const adminClient = createAdminClient();
  const { data: company } = await adminClient
    .from('companies')
    .select('id, name, stripe_customer_id, stripe_subscription_id')
    .eq('id', companyId)
    .maybeSingle();

  if (!company) {
    return NextResponse.json({ error: 'Company not found.' }, { status: 404 });
  }

  // Starting a second Checkout session while one is already active would
  // attach a SECOND subscription to the same customer rather than changing
  // the first -- double billing, not an upgrade. The UI already hides the
  // Subscribe buttons once a company is on a paid tier; this is the same
  // rule enforced server-side, since that UI guard is only a courtesy a
  // direct POST could skip.
  if (company.stripe_subscription_id) {
    return NextResponse.json(
      { error: 'This company already has an active subscription. Use Manage billing to change plans.' },
      { status: 409 }
    );
  }

  // Reused across every checkout attempt for this company, never re-minted:
  // a fresh customer per attempt would split payment history across
  // duplicates in the Stripe dashboard, and the webhook resolves companies
  // by this id.
  let customerId = company.stripe_customer_id as string | null;
  if (!customerId) {
    try {
      const customer = await stripe.customers.create({ name: company.name, metadata: { companyId } });
      customerId = customer.id;
    } catch (err) {
      console.error('billing/checkout: failed to create a Stripe customer:', err);
      return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 502 });
    }

    const { error: saveError } = await adminClient
      .from('companies')
      .update({ stripe_customer_id: customerId })
      .eq('id', companyId);
    if (saveError) {
      // Not fatal to this request -- checkout can still proceed on the
      // customer id just created. But left unsaved, the NEXT checkout
      // attempt will not find it and will mint a second Stripe customer for
      // the same company, so this is worth knowing about.
      console.error('billing/checkout: created a Stripe customer but could not save its id:', saveError);
    }
  }

  const origin = request.nextUrl.origin;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancelled`,
      // Metadata is not how the webhook resolves the company -- it looks the
      // subscription's customer id up against stripe_customer_id instead, one
      // path for every event type. This is only a debugging aid for reading
      // a session in the Stripe dashboard.
      metadata: { companyId },
    });

    if (!session.url) {
      console.error('billing/checkout: Stripe created a session with no url.');
      return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 502 });
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('billing/checkout: failed to create a checkout session:', err);
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 502 });
  }
}
