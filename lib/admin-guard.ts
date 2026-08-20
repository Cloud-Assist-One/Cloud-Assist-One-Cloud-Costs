import { createClient } from '@/lib/supabase/server';

type AccessGuardResult =
  | { authorized: true; userId: string; role: 'client' | 'staff' }
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

  if (profile.role === 'staff') {
    return { authorized: true, userId: user.id, role: 'staff' };
  }

  if (profile.company_id === companyId) {
    return { authorized: true, userId: user.id, role: 'client' };
  }

  return { authorized: false, status: 403, message: 'You do not have access to this company.' };
}
