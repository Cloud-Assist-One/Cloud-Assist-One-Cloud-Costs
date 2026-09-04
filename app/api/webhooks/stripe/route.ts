import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { createStripeClient } from '@/lib/stripe';
import { resolveSubscriptionEvent, SUBSCRIPTION_DELETED_UPDATE } from '@/lib/stripeWebhook';
import type { CompanyUpdate } from '@/lib/stripeWebhook';

// This is where Stripe tells this app a subscription changed -- no session,
// no cookie, so it is intentionally public with no admin/staff guard in
// front of it, the same as the signup route. The Stripe-Signature header,
// verified below against STRIPE_WEBHOOK_SECRET, is what stands in for auth.
//
// The Stripe dashboard's endpoint for this route needs at minimum
// customer.subscription.created, customer.subscription.updated, and
// customer.subscription.deleted -- nothing else is read.
export async function POST(request: NextRequest) {
  // Raw text, not request.json(): signature verification hashes the exact
  // bytes Stripe sent, and re-serializing a parsed object would not
  // reproduce them byte for byte.
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();

  if (!webhookSecret) {
    console.error('webhooks/stripe: STRIPE_WEBHOOK_SECRET is not set.');
    return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 500 });
  }
  if (!signature) {
    return NextResponse.json({ error: 'Missing Stripe-Signature header.' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const stripe = createStripeClient();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // Never 500 here: a bad signature is not this deployment's fault to
    // retry its way out of, and a 500 would tell Stripe to keep trying the
    // exact same request forever.
    console.error('webhooks/stripe: signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
  }

  // customerId and update travel together, resolved once per branch, so
  // there is no later point where one could be set without the other --
  // unlike two separate variables coordinated by hand across branches.
  let outcome: { customerId: string; update: CompanyUpdate } | null = null;

  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const items = subscription.items.data;
    // Our own checkout only ever attaches one price. More than one (e.g. a
    // metered add-on attached by hand in the dashboard) is not a shape this
    // reads a tier from -- resolveSubscriptionEvent treats it the same as
    // no price at all and skips rather than guessing which one counts.
    const priceId = items.length === 1 ? items[0].price.id : null;
    const resolution = resolveSubscriptionEvent({ id: subscription.id, status: subscription.status, priceId });
    if (resolution.action === 'skip') {
      console.error(`webhooks/stripe: ${resolution.reason}`);
    } else {
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
      outcome = { customerId, update: resolution.update };
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    outcome = { customerId, update: SUBSCRIPTION_DELETED_UPDATE };
  } else {
    // Anything else is a type this endpoint is not subscribed to reading --
    // still a success, since there is nothing here for it to do.
    return NextResponse.json({ received: true });
  }

  if (!outcome) {
    return NextResponse.json({ received: true });
  }

  const { customerId, update } = outcome;
  const adminClient = createAdminClient();
  const { data: updated, error } = await adminClient
    .from('companies')
    .update(update)
    .eq('stripe_customer_id', customerId)
    .select('id');

  if (error) {
    // A real, possibly transient failure -- worth Stripe retrying.
    console.error('webhooks/stripe: failed to update the company row:', error);
    return NextResponse.json({ error: 'Could not record this subscription change.' }, { status: 500 });
  }

  if ((updated ?? []).length === 0) {
    // No company has this Stripe customer id. Not this deployment's doing --
    // a checkout started elsewhere, a test event from the Stripe dashboard,
    // or a customer created directly in Stripe -- and a retry will not
    // produce a company that does not exist, so this still succeeds.
    console.error(`webhooks/stripe: no company found for Stripe customer ${customerId}.`);
  }

  return NextResponse.json({ received: true });
}
