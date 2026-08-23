import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseCostFile } from '@/lib/parseCostFile';
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';

function formatMonth(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get('file');
  const cloudProvider = formData.get('cloudProvider');
  const companyId = formData.get('companyId');
  const billingMonth = formData.get('billingMonth');

  if (
    !(file instanceof File) ||
    typeof cloudProvider !== 'string' ||
    typeof companyId !== 'string' ||
    typeof billingMonth !== 'string'
  ) {
    return NextResponse.json({ error: 'Missing file, cloudProvider, companyId, or billingMonth.' }, { status: 400 });
  }
  if (!CLOUD_PROVIDERS.includes(cloudProvider as CloudProvider)) {
    return NextResponse.json(
      { error: `cloudProvider must be one of: ${CLOUD_PROVIDERS.join(', ')}.` },
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

  const adminClient = createAdminClient();

  const { data: activePeriod, error: activePeriodError } = await adminClient
    .from('billing_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .single();

  if (activePeriodError || !activePeriod) {
    return NextResponse.json({ error: 'No active billing period found for this company.' }, { status: 500 });
  }

  // Every cloud provider's data in a period must be for the same billing
  // month — otherwise the charts/Compare/trend view would silently mix
  // different months together. Check before touching Storage or the DB.
  const { data: otherProviderFiles, error: otherFilesError } = await adminClient
    .from('uploaded_files')
    .select('cloud_provider, billing_month')
    .eq('period_id', activePeriod.id)
    .eq('status', 'processed')
    .neq('cloud_provider', cloudProvider)
    .not('billing_month', 'is', null);

  if (otherFilesError) {
    return NextResponse.json({ error: 'Could not verify this period\'s billing month.' }, { status: 500 });
  }

  const mismatch = (otherProviderFiles ?? []).find((f) => f.billing_month !== billingMonth);
  if (mismatch) {
    return NextResponse.json(
      {
        error:
          `${CLOUD_PROVIDER_LABELS[cloudProvider as CloudProvider]} is billed for ${formatMonth(billingMonth)}, but ` +
          `${CLOUD_PROVIDER_LABELS[mismatch.cloud_provider as CloudProvider]} in this period is for ` +
          `${formatMonth(mismatch.billing_month as string)}. Every provider in a period must be for the same ` +
          `billing month — archive this period and start a new one, then re-upload every provider for the same month.`,
      },
      { status: 409 }
    );
  }

  const storagePath = `${companyId}/${Date.now()}-${file.name}`;
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await adminClient.storage
    .from('billing-files')
    .upload(storagePath, fileBuffer, { contentType: file.type || 'application/octet-stream' });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: uploadedFile, error: insertFileError } = await adminClient
    .from('uploaded_files')
    .insert({
      company_id: companyId,
      cloud_provider: cloudProvider,
      filename: file.name,
      storage_path: storagePath,
      status: 'processing',
      uploaded_by: guard.userId,
      billing_month: billingMonth,
    })
    .select()
    .single();

  if (insertFileError || !uploadedFile) {
    return NextResponse.json({ error: insertFileError?.message ?? 'Could not record the upload.' }, { status: 500 });
  }

  try {
    const { rows, errors } = parseCostFile(fileBuffer);

    if (rows.length === 0) {
      // Best-effort: if this update fails, the row is left at 'processing', but
      // the response below still reports the parse error to the caller.
      await adminClient
        .from('uploaded_files')
        .update({ status: 'error', error_message: errors.join(' ') || 'No valid rows found.' })
        .eq('id', uploadedFile.id);
      return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'error', errors });
    }

    // A re-upload for the same company/provider/date-range should replace the
    // prior data, not add to it — otherwise costs double every time a
    // corrected file is re-uploaded. Delete any existing records covering
    // the range this file parses to (a no-op on a first-time upload) before
    // inserting the fresh set.
    const usageDates = rows.map((row) => row.usage_date);
    const rangeStart = usageDates.reduce((min, date) => (date < min ? date : min));
    const rangeEnd = usageDates.reduce((max, date) => (date > max ? date : max));

    const { error: deleteRecordsError } = await adminClient
      .from('cost_records')
      .delete()
      .eq('company_id', companyId)
      .eq('cloud_provider', cloudProvider)
      .eq('period_id', activePeriod.id)
      .gte('usage_date', rangeStart)
      .lte('usage_date', rangeEnd);

    if (deleteRecordsError) {
      // Best-effort update; see note above.
      await adminClient
        .from('uploaded_files')
        .update({ status: 'error', error_message: deleteRecordsError.message })
        .eq('id', uploadedFile.id);
      return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'error', errors: [deleteRecordsError.message] });
    }

    const { error: insertRecordsError } = await adminClient.from('cost_records').insert(
      rows.map((row) => ({
        company_id: companyId,
        cloud_provider: cloudProvider,
        service_name: row.service_name,
        usage_date: row.usage_date,
        cost: row.cost,
        account_id: row.account_id,
        source_file_id: uploadedFile.id,
      }))
    );

    if (insertRecordsError) {
      // Best-effort update; see note above.
      await adminClient
        .from('uploaded_files')
        .update({ status: 'error', error_message: insertRecordsError.message })
        .eq('id', uploadedFile.id);
      return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'error', errors: [insertRecordsError.message] });
    }

    // Best-effort update; see note above.
    await adminClient
      .from('uploaded_files')
      .update({ status: 'processed', row_count: rows.length })
      .eq('id', uploadedFile.id);

    return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'processed', rowCount: rows.length });
  } catch (err) {
    // parseCostFile (via XLSX.read) throws on corrupted/unparseable binary
    // input rather than returning an error — catch that here so the
    // uploaded_files row never gets stuck at 'processing'.
    const message = err instanceof Error ? err.message : 'Could not process the file.';
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: message })
      .eq('id', uploadedFile.id);
    return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'error', errors: [message] }, { status: 500 });
  }
}
