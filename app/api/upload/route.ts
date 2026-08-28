import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { ingestCostFile } from '@/lib/ingestCostFile';
import { checkBillingMonthMatches } from '@/lib/billingMonthCheck';
import { CLOUD_PROVIDERS } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';

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

  const monthCheck = await checkBillingMonthMatches(adminClient, activePeriod.id, cloudProvider as CloudProvider, billingMonth);
  if (!monthCheck.ok) {
    return NextResponse.json({ error: monthCheck.errorMessage }, { status: monthCheck.status ?? 500 });
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
      origin: 'upload',
    })
    .select()
    .single();

  if (insertFileError || !uploadedFile) {
    return NextResponse.json({ error: insertFileError?.message ?? 'Could not record the upload.' }, { status: 500 });
  }

  const result = await ingestCostFile({
    adminClient,
    companyId,
    cloudProvider: cloudProvider as CloudProvider,
    periodId: activePeriod.id,
    uploadedFileId: uploadedFile.id,
    buffers: [fileBuffer],
  });

  if (result.status === 'error') {
    return NextResponse.json(
      { uploadedFileId: uploadedFile.id, status: 'error', errors: result.errors ?? [] },
      // The original returned 500 only when parseCostFile threw (couldn't even
      // read the file) and 200 for every in-band error (no rows, failed
      // delete, failed insert). ingestCostFile's `thrown` flag preserves that
      // distinction.
      result.thrown ? { status: 500 } : undefined
    );
  }

  return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'processed', rowCount: result.rowCount });
}
