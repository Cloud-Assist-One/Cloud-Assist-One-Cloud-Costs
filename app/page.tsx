import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCompanyAccess } from '@/lib/companyBilling';
import LoginForm from '@/components/auth/LoginForm';
import AppShell from '@/components/shell/AppShell';
import TrialBanner from '@/components/billing/TrialBanner';
import TrialExpired from '@/components/billing/TrialExpired';

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <LoginForm />;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, company_id')
    .eq('id', user.id)
    .single();

  const role = profile?.role === 'admin' ? 'admin' : profile?.role === 'staff' ? 'staff' : 'client';

  // Staff and admins run the business; they are never gated by a client
  // company's billing state.
  const isInternal = role === 'staff' || role === 'admin';
  const access = profile?.company_id
    ? await fetchCompanyAccess(createAdminClient(), profile.company_id)
    : null;

  // Swapping in TrialExpired instead of AppShell -- rather than rendering
  // AppShell and hiding it, or redirecting client-side -- is what makes the
  // lock airtight: no gated tab or its data ever reaches the browser.
  if (!isInternal && access?.state === 'trial_expired') {
    return <TrialExpired />;
  }

  return (
    <>
      {!isInternal && access ? <TrialBanner access={access} /> : null}
      <AppShell
        userId={user.id}
        role={role}
        companyId={profile?.company_id ?? null}
        userEmail={user.email ?? ''}
      />
    </>
  );
}
