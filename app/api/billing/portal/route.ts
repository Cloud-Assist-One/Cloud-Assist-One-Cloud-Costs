import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { createStripeClient } from '@/lib/stripe';

/**
 * Everything past "start a subscription" -- upgrade, downgrade, cancel,
 * update the card on file, view past invoices -- goes through Stripe's own
 * hosted Billing Portal rather than being rebuilt here. Switching a company
 * between tiers by calling Checkout a second time would attach a SECOND
 * subscription to the same customer instead of changing the first one, so
 * once a company has an active subscription, every further plan change
 * comes through this route instead.
 *
 * Which prices a customer is allowed to switch between in the portal is
 * configured in the Stripe dashboard (Settings -> Billing -> Customer
 * portal), not in code here.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const companyId = body?.companyId;

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data: company } = await adminClient
    .from('companies')
    .select('stripe_customer_id')
    .eq('id', companyId)
    .maybeSingle();

  const customerId = company?.stripe_customer_id as string | null | undefined;
  if (!customerId) {
    return NextResponse.json(
      { error: 'This company has no billing account yet. Subscribe to a paid plan first.' },
      { status: 400 }
    );
  }

  let stripe: Stripe;
  try {
    stripe = createStripeClient();
  } catch (err) {
    console.error('billing/portal: Stripe is not configured:', err);
    return NextResponse.json({ error: 'Billing is not set up yet. Contact support.' }, { status: 500 });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${request.nextUrl.origin}/?billing=portal`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('billing/portal: failed to create a billing portal session:', err);
    return NextResponse.json({ error: 'Could not open billing management. Please try again.' }, { status: 502 });
  }
}
