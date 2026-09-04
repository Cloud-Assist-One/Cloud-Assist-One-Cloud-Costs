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

  const origin = request.nextUrl?.origin ?? process.env.NEXT_PUBLIC_SITE_URL ?? '';

  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/billing`,
  });

  return NextResponse.json({ url: session.url });
}
