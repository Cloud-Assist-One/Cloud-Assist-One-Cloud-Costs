import { NextRequest, NextResponse } from 'next/server';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import type { GetCostAndUsageCommandOutput } from '@aws-sdk/client-cost-explorer';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { resolvePullDateRange } from '@/lib/billingPullDateRange';
import { persistPulledBilling } from '@/lib/pullBillingPersist';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
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
    .eq('provider', 'aws')
    .eq('id', credentialId)
    .maybeSingle();

  if (credError || !credRow) {
    return NextResponse.json({ error: 'Could not look up the AWS connection.' }, { status: 500 });
  }

  let secrets: { accessKeyId: string; secretAccessKey: string };
  try {
    secrets = decryptCredentials(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt AWS credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored AWS credentials.' }, { status: 500 });
  }

  const { rangeStart, rangeEnd } = resolvePullDateRange(billingMonth, now);

  const ceClient = new CostExplorerClient({
    region: 'us-east-1',
    credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
  });

  const resultsByTime: NonNullable<GetCostAndUsageCommandOutput['ResultsByTime']> = [];
  let nextPageToken: string | undefined;
  try {
    do {
      const page: GetCostAndUsageCommandOutput = await ceClient.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: rangeStart, End: rangeEnd },
          Granularity: 'DAILY',
          Metrics: ['UnblendedCost'],
          GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
          NextPageToken: nextPageToken,
        })
      );
      resultsByTime.push(...(page.ResultsByTime ?? []));
      nextPageToken = page.NextPageToken;
    } while (nextPageToken);
  } catch (err) {
    return NextResponse.json({ error: `AWS Cost Explorer: ${errorMessage(err)}` }, { status: 502 });
  }

  const rows: { service_name: string; usage_date: string; cost: number }[] = [];
  for (const result of resultsByTime) {
    const usageDate = result.TimePeriod?.Start;
    if (!usageDate) continue;
    for (const group of result.Groups ?? []) {
      const serviceName = group.Keys?.[0];
      const amount = group.Metrics?.UnblendedCost?.Amount;
      if (!serviceName || amount === undefined) continue;
      rows.push({ service_name: serviceName, usage_date: usageDate, cost: Number(amount) });
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'AWS Cost Explorer returned no cost data for this month.' }, { status: 502 });
  }

  // Persisting is deferred until after every fallible step above (credential
  // lookup/decrypt, date-range resolution, the Cost Explorer call itself) has
  // succeeded — in particular archiving, which happens inside the helper.
  // Archiving before that risked burning the user's active period on a call
  // that was always going to fail — e.g. a missing ce:GetCostAndUsage
  // permission, a bad key, or an empty month — and "Try Again" would then
  // archive again, chaining period churn.
  const persisted = await persistPulledBilling({
    adminClient,
    companyId,
    provider: 'aws',
    billingMonth,
    archiveFirst,
    rows,
    rawResponse: resultsByTime,
    artifactSuffix: 'aws-cost-explorer-pull.json',
    filename: `AWS Cost Explorer — ${credRow.label}`,
    uploadedBy: guard.userId,
    rangeStart,
    rangeEndExclusive: rangeEnd,
  });

  if (!persisted.ok) {
    return NextResponse.json({ error: persisted.error }, { status: persisted.status });
  }

  return NextResponse.json(persisted.response);
}
