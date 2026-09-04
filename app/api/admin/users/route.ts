import { NextRequest, NextResponse } from 'next/server';
import { requireStaff, requireAdmin } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { collectAuthActivity, mergeAuthActivity } from '@/lib/adminUserActivity';
import type { Profile } from '@/lib/types';

// The admin auth API's own maximum. Fewer, larger pages over many small ones:
// this list is read whole every time Email Management loads.
const AUTH_PAGE_SIZE = 1000;

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

  const profiles = (data ?? []) as Profile[];

  // Whether the magic link was ever used, and when they last signed in, live
  // in auth.users -- a separate paginated API, since PostgREST does not expose
  // that schema. Failing the whole request rather than returning the profiles
  // without it: blank columns are indistinguishable from a genuine "never
  // signed in", and that is the exact question this list is read to answer.
  let activity;
  try {
    activity = await collectAuthActivity(async (page) => {
      const { data: authData, error: authError } = await adminClient.auth.admin.listUsers({
        page,
        perPage: AUTH_PAGE_SIZE,
      });
      if (authError) throw authError;
      return {
        users: authData.users,
        nextPage: 'nextPage' in authData ? authData.nextPage : null,
      };
    });
  } catch (err) {
    console.error('admin users: failed to read sign-in activity:', err);
    return NextResponse.json({ error: 'Could not read sign-in activity for these accounts.' }, { status: 500 });
  }

  return NextResponse.json({ users: mergeAuthActivity(profiles, activity) });
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

  if (!email || !password || (role !== 'client' && role !== 'staff' && role !== 'admin')) {
    return NextResponse.json({ error: 'email, password, and a valid role are required.' }, { status: 400 });
  }
  if (role === 'client' && !companyId) {
    return NextResponse.json({ error: 'companyId is required for client accounts.' }, { status: 400 });
  }
  if (role === 'admin') {
    const adminGuard = await requireAdmin();
    if (!adminGuard.authorized) {
      return NextResponse.json({ error: 'Only an admin can create another admin account.' }, { status: 403 });
    }
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
