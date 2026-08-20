import { createClient } from '@/lib/supabase/server';
import LoginForm from '@/components/auth/LoginForm';
import AppShell from '@/components/shell/AppShell';

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

  return (
    <AppShell
      userId={user.id}
      role={profile?.role === 'staff' ? 'staff' : 'client'}
      companyId={profile?.company_id ?? null}
    />
  );
}
