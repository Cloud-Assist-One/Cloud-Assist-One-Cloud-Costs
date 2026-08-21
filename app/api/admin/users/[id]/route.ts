import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

export async function DELETE(_request: Request, context: RouteContext<'/api/admin/users/[id]'>) {
  const guard = await requireStaff();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const { id } = await context.params;

  const adminClient = createAdminClient();
  const { error } = await adminClient.auth.admin.deleteUser(id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
