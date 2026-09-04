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
    .select('id, name, stripe_customer_id')
    .eq('id', companyId)
    .maybeSingle();

  if (error || !company) {
    return NextResponse.json({ error: 'Company not found.' }, { status: 404 });
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

  const origin = request.nextUrl?.origin ?? process.env.NEXT_PUBLIC_SITE_URL ?? '';

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
