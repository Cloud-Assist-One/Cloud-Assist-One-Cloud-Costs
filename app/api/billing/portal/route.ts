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

  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/billing`,
  });

  return NextResponse.json({ url: session.url });
}
