import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCompanyAccess } from '@/lib/companyBilling';

export type BillingGuardResult =
  | { allowed: true }
  | { allowed: false; status: number; message: string };

/**
 * The real enforcement. The UI swap in app/page.tsx is a courtesy -- a user
 * can POST directly, so every mutating route calls this. Same reasoning as
 * the comment in connectionAllowance.ts.
 */
export async function requireActiveBilling(companyId: string): Promise<BillingGuardResult> {
  const access = await fetchCompanyAccess(createAdminClient(), companyId);

  if (access.state === 'trial_expired') {
    return {
      allowed: false,
      status: 403,
      message: 'Your free trial has ended. Add a payment method to continue.',
    };
  }

  return { allowed: true };
}
