import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { resolvePullDateRange } from '@/lib/billingPullDateRange';
import { fetchAzureCostRows } from '@/lib/azureCostQuery';
import { persistPulledBilling } from '@/lib/pullBillingPersist';
import type { AzureCredentials } from '@/lib/azureCostQuery';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

// Cost Management is gated by its own RBAC role: a service principal with
// plain "Reader" (enough for the Resources and Users tabs) still gets a 403
// here. Raw ARM text doesn't mention that, so name the missing grant — the
// same treatment the Azure AD users route gives Graph permission errors.
function annotateAuthorizationError(message: string): string {
  const looksLikeAuthorizationFailure = /authorization|forbidden|403|does not have access|AuthorizationFailed/i.test(
    message
  );
  if (!looksLikeAuthorizationFailure) return message;
  return (
    `${message} — Azure Cost Management needs its own role: assign "Cost Management Reader" to this app ` +
    `registration on the subscription. The "Reader" role used by the Resources tab is not sufficient.`
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, credentialId, billingMonth, archiveFirst } = body as {
    companyId?: string;
    credentialId?: string;
    billingMonth?: string;
    archiveFirst?: boolean;
  };

  if (
    typeof companyId !== 'string' ||
    typeof credentialId !== 'string' ||
    typeof billingMonth !== 'string' ||
    typeof archiveFirst !== 'boolean'
  ) {
    return NextResponse.json(
      { error: 'companyId, credentialId, billingMonth, and archiveFirst are all required.' },
      { status: 400 }
    );
  }
  if (!/^\d{4}-\d{2}-01$/.test(billingMonth)) {
    return NextResponse.json({ error: 'billingMonth must be the first day of a month, e.g. 2026-08-01.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const now = new Date();
  const currentMonthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  if (billingMonth > currentMonthStart) {
    return NextResponse.json({ error: 'billingMonth cannot be after the current calendar month.' }, { status: 400 });
  }

  const adminClient = createAdminClient();

  const { data: credRow, error: credError } = await adminClient
    .from('cloud_provider_credentials')
    .select('label, encrypted_payload')
    .eq('company_id', companyId)
    .eq('provider', 'azure')
    .eq('id', credentialId)
    .maybeSingle();

  if (credError || !credRow) {
    return NextResponse.json({ error: 'Could not look up the Azure connection.' }, { status: 500 });
  }

  let secrets: AzureCredentials;
  try {
    secrets = decryptCredentials<AzureCredentials>(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt Azure credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored Azure credentials.' }, { status: 500 });
  }

  const { rangeStart, rangeEnd } = resolvePullDateRange(billingMonth, now);

  let pulled: Awaited<ReturnType<typeof fetchAzureCostRows>>;
  try {
    pulled = await fetchAzureCostRows(secrets, rangeStart, rangeEnd);
  } catch (err) {
    // Logged so a 403-vs-429 distinction is diagnosable in production; the
    // message carries no credentials (it is built from the response body).
    console.error('Azure Cost Management pull failed:', err);
    return NextResponse.json(
      { error: `Azure Cost Management: ${annotateAuthorizationError(errorMessage(err))}` },
      { status: 502 }
    );
  }

  const { rows, rawPages } = pulled;

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Azure Cost Management returned no cost data for this month.' }, { status: 502 });
  }

  // Archiving happens inside the helper, deliberately after the Azure call
  // above has already succeeded — a failed pull must never cost the user
  // their active period.
  const persisted = await persistPulledBilling({
    adminClient,
    companyId,
    provider: 'azure',
    billingMonth,
    archiveFirst,
    rows,
    rawResponse: rawPages,
    artifactSuffix: 'azure-cost-management-pull.json',
    filename: `Azure Cost Management — ${credRow.label}`,
    uploadedBy: guard.userId,
    rangeStart,
    rangeEndExclusive: rangeEnd,
  });

  if (!persisted.ok) {
    return NextResponse.json({ error: persisted.error }, { status: persisted.status });
  }

  return NextResponse.json(persisted.response);
}
