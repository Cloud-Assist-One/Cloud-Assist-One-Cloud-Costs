import { NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { requireActiveBilling } from '@/lib/billingGuard';
import { createAdminClient } from '@/lib/supabase/admin';

export async function DELETE(_request: Request, context: RouteContext<'/api/upload/[fileId]'>) {
  const { fileId } = await context.params;

  const adminClient = createAdminClient();

  const { data: file, error: fileError } = await adminClient
    .from('uploaded_files')
    .select('company_id, status, storage_path')
    .eq('id', fileId)
    .maybeSingle();

  if (fileError) {
    console.error('Failed to look up uploaded file before delete:', fileError);
    return NextResponse.json({ error: 'Could not look up that file.' }, { status: 500 });
  }

  if (!file) {
    return NextResponse.json({ error: 'File not found.' }, { status: 404 });
  }

  const guard = await requireCompanyAccess(file.company_id);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const billing = await requireActiveBilling(file.company_id, guard.role);
  if (!billing.allowed) {
    return NextResponse.json({ error: billing.message }, { status: billing.status });
  }

  // Only a failed upload can be self-served away — a processed file's cost
  // data is depended on by reports/notes/todos, so that stays staff-managed.
  if (file.status !== 'error') {
    return NextResponse.json(
      { error: 'Only files with an error status can be deleted.' },
      { status: 400 }
    );
  }

  const { error: removeError } = await adminClient.storage.from('billing-files').remove([file.storage_path]);
  if (removeError) {
    console.error('Failed to remove stored file before delete:', removeError);
    return NextResponse.json({ error: 'Could not delete the stored file.' }, { status: 500 });
  }

  const { error: deleteError } = await adminClient.from('uploaded_files').delete().eq('id', fileId);
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
