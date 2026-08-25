import { NextRequest, NextResponse } from 'next/server';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import type { GetCostAndUsageCommandOutput } from '@aws-sdk/client-cost-explorer';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { checkBillingMonthMatches } from '@/lib/billingMonthCheck';
import { resolvePullDateRange } from '@/lib/billingPullDateRange';
import type { PullBillingSuccessResponse } from '@/lib/types';

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

  // Archiving is deferred until after every fallible step above (credential
  // lookup/decrypt, date-range resolution, the Cost Explorer call itself) has
  // succeeded. Archiving before that risked burning the user's active period
  // on a call that was always going to fail — e.g. a missing
  // ce:GetCostAndUsage permission, a bad key, or an empty month — and
  // "Try Again" would then archive again, chaining period churn.
  let periodId: string;
  let newPeriodId: string | undefined;

  if (archiveFirst) {
    const { data: archivedId, error: archiveError } = await adminClient.rpc('archive_billing_period', {
      p_company_id: companyId,
    });
    if (archiveError || !archivedId) {
      return NextResponse.json({ error: archiveError?.message ?? 'Could not archive the current period.' }, { status: 500 });
    }
    periodId = archivedId;
    newPeriodId = archivedId;
  } else {
    const { data: activePeriod, error: activePeriodError } = await adminClient
      .from('billing_periods')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .single();
    if (activePeriodError || !activePeriod) {
      return NextResponse.json({ error: 'No active billing period found for this company.' }, { status: 500 });
    }
    periodId = activePeriod.id;
  }

  const monthCheck = await checkBillingMonthMatches(adminClient, periodId, 'aws', billingMonth);
  if (!monthCheck.ok) {
    return NextResponse.json({ error: monthCheck.errorMessage }, { status: monthCheck.status ?? 500 });
  }

  const storagePath = `${companyId}/${Date.now()}-aws-cost-explorer-pull.json`;
  const { error: uploadError } = await adminClient.storage
    .from('billing-files')
    .upload(storagePath, JSON.stringify(resultsByTime), { contentType: 'application/json' });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: uploadedFile, error: insertFileError } = await adminClient
    .from('uploaded_files')
    .insert({
      company_id: companyId,
      cloud_provider: 'aws',
      filename: `AWS Cost Explorer — ${credRow.label}`,
      storage_path: storagePath,
      status: 'processing',
      uploaded_by: guard.userId,
      billing_month: billingMonth,
    })
    .select()
    .single();

  if (insertFileError || !uploadedFile) {
    return NextResponse.json({ error: insertFileError?.message ?? 'Could not record the pull.' }, { status: 500 });
  }

  const { error: deleteRecordsError } = await adminClient
    .from('cost_records')
    .delete()
    .eq('company_id', companyId)
    .eq('cloud_provider', 'aws')
    .eq('period_id', periodId)
    .gte('usage_date', rangeStart)
    .lt('usage_date', rangeEnd);

  if (deleteRecordsError) {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: deleteRecordsError.message })
      .eq('id', uploadedFile.id);
    return NextResponse.json({ error: deleteRecordsError.message }, { status: 500 });
  }

  const { error: insertRecordsError } = await adminClient.from('cost_records').insert(
    rows.map((row) => ({
      company_id: companyId,
      cloud_provider: 'aws' as const,
      service_name: row.service_name,
      usage_date: row.usage_date,
      cost: row.cost,
      account_id: null,
      source_file_id: uploadedFile.id,
    }))
  );

  if (insertRecordsError) {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: insertRecordsError.message })
      .eq('id', uploadedFile.id);
    return NextResponse.json({ error: insertRecordsError.message }, { status: 500 });
  }

  await adminClient.from('uploaded_files').update({ status: 'processed', row_count: rows.length }).eq('id', uploadedFile.id);

  const response: PullBillingSuccessResponse = {
    uploadedFileId: uploadedFile.id,
    status: 'processed',
    rowCount: rows.length,
    ...(newPeriodId ? { newPeriodId } : {}),
  };
  return NextResponse.json(response);
}
