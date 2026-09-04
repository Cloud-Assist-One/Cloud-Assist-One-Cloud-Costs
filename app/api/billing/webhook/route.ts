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
  // once; a primary-key conflict means we already handled it, so acknowledge
  // and do nothing rather than upgrading a company twice.
  const { error: claimError } = await adminClient
    .from('stripe_events')
    .insert({ id: event.id });

  if (claimError) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  const update = companyUpdateForEvent(event as never);

  if (update) {
    const { error } = await adminClient
      .from('companies')
      .update(update.values)
      .eq(update.match.column, update.match.value);

    if (error) {
      // Release the claim so Stripe's retry can try again, then fail loudly.
      // If the release itself fails, the claim row survives and Stripe's retry
      // of this same event id will hit the primary-key conflict above and be
      // dismissed as a duplicate -- so the update would be lost silently and
      // permanently. That is worse than the original failure, so it is logged
      // explicitly rather than swallowed.
      const { error: releaseError } = await adminClient
        .from('stripe_events')
        .delete()
        .eq('id', event.id);

      if (releaseError) {
        console.error(
          `webhook: applied-update failed AND claim release failed for event ${event.id}. ` +
            `This event will be treated as a duplicate on retry and must be replayed by hand.`,
          releaseError
        );
      }

      return NextResponse.json({ error: 'Could not apply update.' }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
