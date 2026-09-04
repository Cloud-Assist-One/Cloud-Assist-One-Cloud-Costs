import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe, isPurchasableTier, priceIdForTier } from '@/lib/stripe';

// Stripe's SDK needs Node crypto and fails on the Edge runtime. Node is the
// default runtime in this Next.js version, but pinning it explicitly guards
// this route if that default ever changes.
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const companyId = typeof body?.companyId === 'string' ? body.companyId : null;
  const tier = body?.tier;

  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  // The price id is derived from the tier server-side and never read from the
  // request. Trusting a client-supplied price would let a caller pass a $0
  // price from another Stripe account and take a paid tier for nothing.
  if (!isPurchasableTier(tier)) {
    return NextResponse.json({ error: 'That plan is not available to buy.' }, { status: 400 });
  }

  const adminClient = createAdminClient();
  const { data: company, error } = await adminClient
    .from('companies')
    .select('id, name, stripe_customer_id, stripe_subscription_id, subscription_status')
    .eq('id', companyId)
    .maybeSingle();

  if (error || !company) {
    return NextResponse.json({ error: 'Company not found.' }, { status: 404 });
  }

  // A second Checkout Session for a company that already has a live
  // subscription would create a second, concurrent Stripe subscription --
  // the webhook only overwrites subscription_tier, so nothing in the app
  // would reveal the duplicate, and the customer would be billed twice.
  // Stripe's Billing Portal already prorates plan changes correctly, so an
  // existing active/trialing/past_due subscription is refused here rather
  // than rebuilding that logic ourselves.
  const existingStatus = company.subscription_status as string | null;
  if (
    company.stripe_subscription_id &&
    (existingStatus === 'active' || existingStatus === 'trialing' || existingStatus === 'past_due')
  ) {
    return NextResponse.json(
      { error: 'You already have a subscription. Use Manage Billing to change plans.' },
      { status: 400 }
    );
  }

  const stripe = getStripe();
  let customerId = company.stripe_customer_id as string | null;

  if (!customerId) {
    const customer = await stripe.customers.create({
      name: company.name as string,
      metadata: { company_id: companyId },
    });
    customerId = customer.id;
    await adminClient
      .from('companies')
      .update({ stripe_customer_id: customerId })
      .eq('id', companyId);
  }

  // NEXT_PUBLIC_SITE_URL is preferred: request.nextUrl.origin is derived from
  // the incoming Host/X-Forwarded-Host header, which a caller can forge. The
  // request origin is kept only as a local-development fallback -- a forged
  // Host must never be able to steer where a paying customer lands right
  // after checkout.
  const origin = (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim() || request.nextUrl?.origin || '';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceIdForTier(tier), quantity: 1 }],
    success_url: `${origin}/billing?checkout=success`,
    cancel_url: `${origin}/billing?checkout=cancelled`,
    metadata: { company_id: companyId, tier },
    subscription_data: { metadata: { company_id: companyId, tier } },
  });

  return NextResponse.json({ url: session.url });
}
