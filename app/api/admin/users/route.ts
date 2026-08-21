import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET() {
  const guard = await requireStaff();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('profiles')
    .select('id, email, role, company_id, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ users: data });
}

export async function POST(request: NextRequest) {
  const guard = await requireStaff();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const body = await request.json();
  const { email, password, role, companyId } = body as {
    email?: string;
    password?: string;
    role?: string;
    companyId?: string;
  };

  if (!email || !password || (role !== 'client' && role !== 'staff')) {
    return NextResponse.json({ error: 'email, password, and a valid role are required.' }, { status: 400 });
  }
  if (role === 'client' && !companyId) {
    return NextResponse.json({ error: 'companyId is required for client accounts.' }, { status: 400 });
  }

  const adminClient = createAdminClient();
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError || !created.user) {
    return NextResponse.json({ error: createError?.message ?? 'Could not create the user.' }, { status: 500 });
  }

  const { error: profileError } = await adminClient
    .from('profiles')
    .update({ role, company_id: role === 'client' ? companyId : null })
    .eq('id', created.user.id);

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ id: created.user.id, email, role, companyId: role === 'client' ? companyId : null });
}
