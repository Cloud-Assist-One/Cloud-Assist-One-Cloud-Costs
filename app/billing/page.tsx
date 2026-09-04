import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCompanyAccess } from '@/lib/companyBilling';
import LoginForm from '@/components/auth/LoginForm';
import PlanCards from '@/components/billing/PlanCards';

export default async function BillingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return <LoginForm />;

  const { data: profile } = await supabase
    .from('profiles')
    .select('company_id')
    .eq('id', user.id)
    .single();

  if (!profile?.company_id) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <p>No company is linked to your account.</p>
      </main>
    );
  }

  const adminClient = createAdminClient();
  const access = await fetchCompanyAccess(adminClient, profile.company_id);
  const { data: company } = await adminClient
    .from('companies')
    .select('stripe_customer_id')
    .eq('id', profile.company_id)
    .maybeSingle();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <div>
        <h1 className="text-3xl font-semibold">Billing</h1>
        {access.state === 'trialing' ? (
          <p className="mt-2 text-muted-foreground">
            {access.daysLeft} {access.daysLeft === 1 ? 'day' : 'days'} left in your free trial.
          </p>
        ) : null}
        {access.state === 'trial_expired' ? (
          <p className="mt-2 text-muted-foreground">
            Your trial has ended. Choose a plan to restore access.
          </p>
        ) : null}
        {access.state === 'past_due' ? (
          <p className="mt-2 text-destructive">
            Your last payment failed. Update your card to keep your account active.
          </p>
        ) : null}
      </div>

      <PlanCards
        companyId={profile.company_id}
        access={access}
        hasCustomer={Boolean(company?.stripe_customer_id)}
      />
    </main>
  );
}
