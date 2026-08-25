import type { createAdminClient } from '@/lib/supabase/admin';
import { checkBillingMonthMatches } from '@/lib/billingMonthCheck';
import type { CloudProvider, PullBillingSuccessResponse } from '@/lib/types';

export interface PulledCostRow {
  service_name: string;
  usage_date: string;
  cost: number;
}

export interface PersistPulledBillingArgs {
  adminClient: ReturnType<typeof createAdminClient>;
  companyId: string;
  provider: CloudProvider;
  billingMonth: string;
  archiveFirst: boolean;
  rows: PulledCostRow[];
  /** The provider's raw API response, stored verbatim as the audit artifact. */
  rawResponse: unknown;
  /** Storage filename suffix, e.g. "aws-cost-explorer-pull.json". */
  artifactSuffix: string;
  /** Value for uploaded_files.filename, e.g. "AWS Cost Explorer — Production". */
  filename: string;
  uploadedBy: string;
  rangeStart: string;
  /** Exclusive, matching resolvePullDateRange. */
  rangeEndExclusive: string;
}

export type PersistPulledBillingResult =
  | { ok: true; response: PullBillingSuccessResponse }
  | { ok: false; status: number; error: string };

/**
 * Writes a pulled batch of cost rows into the billing tables.
 *
 * Shared by every provider's pull-billing route so the ordering below stays
 * identical between them: archiving is deferred until the provider's API call
 * has already succeeded (callers must fetch first), the cross-provider month
 * check runs against the final target period, and existing rows in the pulled
 * date range are replaced rather than added to.
 */
export async function persistPulledBilling(args: PersistPulledBillingArgs): Promise<PersistPulledBillingResult> {
  const {
    adminClient,
    companyId,
    provider,
    billingMonth,
    archiveFirst,
    rows,
    rawResponse,
    artifactSuffix,
    filename,
    uploadedBy,
    rangeStart,
    rangeEndExclusive,
  } = args;

  let periodId: string;
  let newPeriodId: string | undefined;

  if (archiveFirst) {
    const { data: archivedId, error: archiveError } = await adminClient.rpc('archive_billing_period', {
      p_company_id: companyId,
    });
    if (archiveError || !archivedId) {
      return { ok: false, status: 500, error: archiveError?.message ?? 'Could not archive the current period.' };
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
      return { ok: false, status: 500, error: 'No active billing period found for this company.' };
    }
    periodId = activePeriod.id;
  }

  const monthCheck = await checkBillingMonthMatches(adminClient, periodId, provider, billingMonth);
  if (!monthCheck.ok) {
    return { ok: false, status: monthCheck.status ?? 500, error: monthCheck.errorMessage ?? 'Billing month mismatch.' };
  }

  const storagePath = `${companyId}/${Date.now()}-${artifactSuffix}`;
  const { error: uploadError } = await adminClient.storage
    .from('billing-files')
    .upload(storagePath, JSON.stringify(rawResponse), { contentType: 'application/json' });

  if (uploadError) {
    return { ok: false, status: 500, error: uploadError.message };
  }

  const { data: uploadedFile, error: insertFileError } = await adminClient
    .from('uploaded_files')
    .insert({
      company_id: companyId,
      cloud_provider: provider,
      filename,
      storage_path: storagePath,
      status: 'processing',
      uploaded_by: uploadedBy,
      billing_month: billingMonth,
    })
    .select()
    .single();

  if (insertFileError || !uploadedFile) {
    return { ok: false, status: 500, error: insertFileError?.message ?? 'Could not record the pull.' };
  }

  // Re-running a pull for the same range replaces its data instead of adding
  // to it. rangeEndExclusive is exclusive, hence .lt rather than .lte.
  const { error: deleteRecordsError } = await adminClient
    .from('cost_records')
    .delete()
    .eq('company_id', companyId)
    .eq('cloud_provider', provider)
    .eq('period_id', periodId)
    .gte('usage_date', rangeStart)
    .lt('usage_date', rangeEndExclusive);

  if (deleteRecordsError) {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: deleteRecordsError.message })
      .eq('id', uploadedFile.id);
    return { ok: false, status: 500, error: deleteRecordsError.message };
  }

  const { error: insertRecordsError } = await adminClient.from('cost_records').insert(
    rows.map((row) => ({
      company_id: companyId,
      cloud_provider: provider,
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
    return { ok: false, status: 500, error: insertRecordsError.message };
  }

  await adminClient.from('uploaded_files').update({ status: 'processed', row_count: rows.length }).eq('id', uploadedFile.id);

  return {
    ok: true,
    response: {
      uploadedFileId: uploadedFile.id,
      status: 'processed',
      rowCount: rows.length,
      ...(newPeriodId ? { newPeriodId } : {}),
    },
  };
}
