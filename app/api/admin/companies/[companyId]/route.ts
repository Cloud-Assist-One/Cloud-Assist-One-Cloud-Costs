import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

const STORAGE_BUCKETS = ['billing-files', 'voice-notes'];

export async function DELETE(_request: Request, context: RouteContext<'/api/admin/companies/[companyId]'>) {
  const guard = await requireAdmin();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const { companyId } = await context.params;

  const adminClient = createAdminClient();

  const { data: company, error: companyError } = await adminClient
    .from('companies')
    .select('id')
    .eq('id', companyId)
    .maybeSingle();

  if (companyError) {
    console.error('Failed to look up company before delete:', companyError);
    return NextResponse.json({ error: 'Could not look up that company.' }, { status: 500 });
  }

  if (!company) {
    return NextResponse.json({ error: 'Company not found.' }, { status: 404 });
  }

  // Client users' profile rows cascade-delete with the company below, but
  // their underlying auth accounts do not — collect them first so they can
  // be removed via the Admin API afterward (never touch auth.users via SQL).
  const { data: clientProfiles, error: profilesError } = await adminClient
    .from('profiles')
    .select('id')
    .eq('company_id', companyId)
    .eq('role', 'client');

  if (profilesError) {
    console.error('Failed to look up client profiles before delete:', profilesError);
    return NextResponse.json({ error: 'Could not look up this company\'s users.' }, { status: 500 });
  }

  // Uploaded files and voice notes live in Storage under `{companyId}/...`,
  // not as DB rows, so the table cascade below never reaches them.
  for (const bucket of STORAGE_BUCKETS) {
    const { data: files, error: listError } = await adminClient.storage.from(bucket).list(companyId, { limit: 1000 });
    if (listError) {
      console.error(`Failed to list ${bucket} files before delete:`, listError);
      return NextResponse.json({ error: 'Could not look up this company\'s stored files.' }, { status: 500 });
    }
    if (files && files.length > 0) {
      const paths = files.map((file) => `${companyId}/${file.name}`);
      const { error: removeError } = await adminClient.storage.from(bucket).remove(paths);
      if (removeError) {
        console.error(`Failed to remove ${bucket} files:`, removeError);
        return NextResponse.json({ error: 'Could not delete this company\'s stored files.' }, { status: 500 });
      }
    }
  }

  const { error: deleteError } = await adminClient.from('companies').delete().eq('id', companyId);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  for (const profile of clientProfiles ?? []) {
    const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(profile.id);
    if (deleteUserError) {
      // The company and its data are already gone at this point — surface the
      // partial failure rather than reporting a clean success.
      console.error(`Failed to delete auth user ${profile.id} after company delete:`, deleteUserError);
      return NextResponse.json(
        { error: 'Company data deleted, but one or more user accounts could not be removed.' },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ deleted: true });
}
