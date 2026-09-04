import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { requireActiveBilling } from '@/lib/billingGuard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { resolvePullDateRange } from '@/lib/billingPullDateRange';
import { fetchAzureCostDetailsCsv } from '@/lib/azureCostDetails';
import { parseCostFile } from '@/lib/parseCostFile';
import { persistPulledBilling } from '@/lib/pullBillingPersist';
import type { AzureCredentials } from '@/lib/azureCostQuery';

// Generating a cost details report is asynchronous and Azure asks for waits of
// up to a minute between polls. 300s is the ceiling on both Hobby and Pro.
export const maxDuration = 300;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

/** Turns an exclusive range end into the inclusive one the report expects. */
function inclusiveEnd(exclusiveEnd: string): string {
  const date = new Date(`${exclusiveEnd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
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

  // Pulling cost data is a mutating side effect on the company's cost
  // records -- an expired client must not keep it working via a direct API
  // call after the UI has locked them out.
  const billing = await requireActiveBilling(companyId, guard.role);
  if (!billing.allowed) {
    return NextResponse.json({ error: billing.message }, { status: billing.status });
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

  // The report's timePeriod end is inclusive, while resolvePullDateRange
  // returns an exclusive end for the database range.
  const reportEnd = inclusiveEnd(rangeEnd);

  let report: Awaited<ReturnType<typeof fetchAzureCostDetailsCsv>>;
  try {
    report = await fetchAzureCostDetailsCsv(secrets, rangeStart, reportEnd);
  } catch (err) {
    // Logged so a 403-vs-429 distinction is diagnosable in production; the
    // message carries no credentials (it is built from the response body).
    console.error('Azure Cost Details pull failed:', err);
    return NextResponse.json(
      { error: `Azure Cost Management: ${annotateAuthorizationError(errorMessage(err))}` },
      { status: 502 }
    );
  }

  if (report.status === 'NoDataFound' || report.csv.trim() === '') {
    return NextResponse.json({ error: 'Azure Cost Management returned no cost data for this month.' }, { status: 502 });
  }

  // The report is a CSV of the same shape the upload path already parses, so
  // both routes produce identical rows and fill the same detail columns.
  const parsed = parseCostFile(Buffer.from(report.csv, 'utf8'));

  if (parsed.rows.length === 0) {
    const detail = parsed.errors.length > 0 ? ` (${parsed.errors[0]})` : '';
    return NextResponse.json(
      { error: `Azure returned a cost report that could not be read${detail}.` },
      { status: 502 }
    );
  }

  const rows = parsed.rows;

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
    rawResponse: report.csv,
    artifactSuffix: 'azure-cost-details-pull.csv',
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
