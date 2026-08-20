import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseCostFile } from '@/lib/parseCostFile';

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get('file');
  const cloudProvider = formData.get('cloudProvider');
  const companyId = formData.get('companyId');

  if (!(file instanceof File) || typeof cloudProvider !== 'string' || typeof companyId !== 'string') {
    return NextResponse.json({ error: 'Missing file, cloudProvider, or companyId.' }, { status: 400 });
  }
  if (cloudProvider !== 'aws' && cloudProvider !== 'azure') {
    return NextResponse.json({ error: 'cloudProvider must be "aws" or "azure".' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
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
    })
    .select()
    .single();

  if (insertFileError || !uploadedFile) {
    return NextResponse.json({ error: insertFileError?.message ?? 'Could not record the upload.' }, { status: 500 });
  }

  const { rows, errors } = parseCostFile(fileBuffer);

  if (rows.length === 0) {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: errors.join(' ') || 'No valid rows found.' })
      .eq('id', uploadedFile.id);
    return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'error', errors });
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
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: insertRecordsError.message })
      .eq('id', uploadedFile.id);
    return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'error', errors: [insertRecordsError.message] });
  }

  await adminClient
    .from('uploaded_files')
    .update({ status: 'processed', row_count: rows.length })
    .eq('id', uploadedFile.id);

  return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'processed', rowCount: rows.length });
}
