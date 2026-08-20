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
