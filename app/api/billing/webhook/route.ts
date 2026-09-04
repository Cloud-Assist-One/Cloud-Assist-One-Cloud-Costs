import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';
import { companyUpdateForEvent } from '@/lib/stripeWebhook';

// The Stripe SDK needs Node crypto for signature verification and fails on
// the Edge runtime.
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const signature = request.headers.get('stripe-signature');
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();

  if (!signature || !secret) {
    return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 400 });
  }

  // Must be the raw body. Parsing JSON first silently breaks verification.
  const rawBody = await request.text();

  let event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
  }

  const adminClient = createAdminClient();

  // Claim the event id first. Stripe can deliver the same event more than
  // once; a primary-key conflict means we already handled it.
  const { error: claimError } = await adminClient
    .from('stripe_events')
    .insert({ id: event.id });

  if (claimError) {
    // 23505 is unique_violation -- genuine proof this event was already
    // processed. ANY OTHER error is not proof of anything: a network blip or
    // a permission problem would otherwise be reported to Stripe as success,
    // stopping its retries and dropping a real payment event permanently.
    if (claimError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }

    console.error(`webhook: could not claim event ${event.id}`, claimError);
    return NextResponse.json({ error: 'Could not claim event.' }, { status: 500 });
  }

  try {
    const update = companyUpdateForEvent(event as never);

    if (update) {
      const { error } = await adminClient
        .from('companies')
        .update(update.values)
        .eq(update.match.column, update.match.value);

      if (error) throw new Error(`companies update failed: ${error.message}`);
    }
  } catch (processingError) {
    // Everything after the claim runs inside this try, because a throw is as
    // damaging as a returned error: companyUpdateForEvent calls
    // tierForPriceId, which throws on a duplicate-price misconfiguration. An
    // escaping throw would leave the claim row in place, so Stripe's retry of
    // this same event id would hit the conflict above and be dismissed as a
    // duplicate -- the update lost permanently, with a 500 in the logs that
    // looks transient.
    const { error: releaseError } = await adminClient
      .from('stripe_events')
      .delete()
      .eq('id', event.id);

    if (releaseError) {
      console.error(
        `webhook: processing failed AND claim release failed for event ${event.id}. ` +
          `This event will be treated as a duplicate on retry and must be replayed by hand.`,
        releaseError
      );
    }

    console.error(`webhook: failed to process event ${event.id}`, processingError);
    return NextResponse.json({ error: 'Could not apply update.' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
