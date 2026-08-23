import { createClient } from '@/lib/supabase/server';

type AccessGuardResult =
  | { authorized: true; userId: string; role: 'client' | 'staff' | 'admin' }
  | { authorized: false; status: number; message: string };

export async function requireCompanyAccess(companyId: string): Promise<AccessGuardResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { authorized: false, status: 401, message: 'Not signed in.' };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, company_id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return { authorized: false, status: 403, message: 'No profile found.' };
  }

  if (profile.role === 'staff' || profile.role === 'admin') {
    return { authorized: true, userId: user.id, role: profile.role };
  }

  if (profile.company_id === companyId) {
    return { authorized: true, userId: user.id, role: 'client' };
  }

  return { authorized: false, status: 403, message: 'You do not have access to this company.' };
}

type StaffGuardResult = { authorized: true; userId: string } | { authorized: false; status: number; message: string };

// Admin is a superset of staff — every staff-gated route stays open to admins too.
export async function requireStaff(): Promise<StaffGuardResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { authorized: false, status: 401, message: 'Not signed in.' };
  }

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();

  if (profile?.role !== 'staff' && profile?.role !== 'admin') {
    return { authorized: false, status: 403, message: 'Staff access required.' };
  }

  return { authorized: true, userId: user.id };
}

export async function requireAdmin(): Promise<StaffGuardResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { authorized: false, status: 401, message: 'Not signed in.' };
  }

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();

  if (profile?.role !== 'admin') {
    return { authorized: false, status: 403, message: 'Admin access required.' };
  }

  return { authorized: true, userId: user.id };
}
