import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';
import { hourlyRateCentsFor } from '@/lib/consultingRate';
import { buildInvoiceLines, type TimeEntryRow } from '@/lib/consultingInvoice';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const body = await request.json().catch(() => null);
  const companyId = typeof body?.companyId === 'string' ? body.companyId : null;
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const adminClient = createAdminClient();

  const { data: company } = await adminClient
    .from('companies')
    .select('id, name, stripe_customer_id, hourly_rate_cents')
    .eq('id', companyId)
    .maybeSingle();

  if (!company) {
    return NextResponse.json({ error: 'Company not found.' }, { status: 404 });
  }

  // Re-select rather than trusting ids from the browser: the source of truth
  // for "not yet billed" is the database, not the request.
  const { data: entries } = await adminClient
    .from('time_entries')
    .select('id, entry_date, minutes_spent, description')
    .eq('company_id', companyId)
    .eq('billable', true)
    .is('stripe_invoice_id', null)
    .order('entry_date', { ascending: true });

  const unbilled = (entries ?? []) as TimeEntryRow[];
  if (unbilled.length === 0) {
    return NextResponse.json({ error: 'No unbilled hours for this company.' }, { status: 400 });
  }

  const stripe = getStripe();
  let customerId = company.stripe_customer_id as string | null;

  // A consulting-only client may never have subscribed.
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

  const rateCents = hourlyRateCentsFor(company.hourly_rate_cents as number | null);
  const lines = buildInvoiceLines(unbilled, rateCents);

  for (const line of lines) {
    await stripe.invoiceItems.create(
      {
        customer: customerId,
        amount: line.amountCents,
        currency: 'usd',
        description: line.description,
      },
      { idempotencyKey: line.idempotencyKey }
    );
  }

  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: 14,
    metadata: { company_id: companyId },
  });

  await stripe.invoices.finalizeInvoice(invoice.id as string);
  await stripe.invoices.sendInvoice(invoice.id as string);

  const { error: stampError } = await adminClient
    .from('time_entries')
    .update({
      stripe_invoice_id: invoice.id,
      invoiced_at: new Date().toISOString(),
      rate_cents_at_invoice: rateCents,
    })
    .in(
      'id',
      lines.map((line) => line.entryId)
    );

  if (stampError) {
    // The invoice exists and was sent. The entries are unstamped, so a retry
    // would re-run the loop above -- but each item carries an idempotency key
    // derived from its entry id, so Stripe returns the existing item rather
    // than billing the work twice. Surface the failure for a manual re-run.
    return NextResponse.json(
      { error: 'Invoice sent, but the time entries could not be marked billed.', invoiceId: invoice.id },
      { status: 500 }
    );
  }

  return NextResponse.json({
    invoiceId: invoice.id,
    entryCount: lines.length,
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
  });
}
