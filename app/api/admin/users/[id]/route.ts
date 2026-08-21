import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

export async function DELETE(_request: Request, context: RouteContext<'/api/admin/users/[id]'>) {
  const guard = await requireStaff();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const { id } = await context.params;

  if (id === guard.userId) {
    return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 400 });
  }

  const adminClient = createAdminClient();

  const { data: target, error: targetError } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', id)
    .single();

  if (targetError || !target) {
    return NextResponse.json({ error: targetError?.message ?? 'User not found.' }, { status: 404 });
  }

  // Deleting the last staff account would permanently lock the org out of the
  // Admin tab — there is no self-signup path to create a replacement.
  if (target.role === 'staff') {
    const { count, error: countError } = await adminClient
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'staff');

    if (countError) {
      return NextResponse.json({ error: countError.message }, { status: 500 });
    }

    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        { error: 'You cannot delete the last remaining staff account.' },
        { status: 400 }
      );
    }
  }

  const { error } = await adminClient.auth.admin.deleteUser(id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
