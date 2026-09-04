import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';

// Stripe's SDK needs Node crypto and fails on the Edge runtime. Node is the
// default runtime in this Next.js version, but pinning it explicitly guards
// this route if that default ever changes.
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const companyId = typeof body?.companyId === 'string' ? body.companyId : null;

  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const { data: company } = await createAdminClient()
    .from('companies')
    .select('stripe_customer_id')
    .eq('id', companyId)
    .maybeSingle();

  const customerId = company?.stripe_customer_id as string | null | undefined;
  if (!customerId) {
    return NextResponse.json({ error: 'No billing account yet.' }, { status: 400 });
  }

  // NEXT_PUBLIC_SITE_URL is preferred: request.nextUrl.origin is derived from
  // the incoming Host/X-Forwarded-Host header, which a caller can forge. The
  // request origin is kept only as a local-development fallback -- a forged
  // Host must never be able to steer where the customer lands after they
  // finish managing billing (invoices, saved card details are one click away).
  const origin = (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim() || request.nextUrl?.origin || '';

  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/billing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    // Same reasoning as the checkout route: an unhandled throw returns an
    // empty body, and the browser's response.json() then fails with
    // "Unexpected end of JSON input" instead of anything actionable. A stored
    // customer id that Stripe no longer recognises lands here too -- unlike
    // checkout there is nothing to re-mint, since the portal exists to show a
    // history this company would not have under a new customer.
    console.error(`billing/portal: could not open the billing portal for ${companyId}`, error);
    return NextResponse.json(
      { error: 'Could not open billing. Please try again, or contact support if it persists.' },
      { status: 500 }
    );
  }
}
