import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCompanyAccess } from '@/lib/companyBilling';

export type BillingGuardResult =
  | { allowed: true }
  | { allowed: false; status: number; message: string };

/**
 * The real enforcement. The UI swap in app/page.tsx is a courtesy -- a user
 * can POST directly, so every mutating route calls this. Same reasoning as
 * the comment in connectionAllowance.ts.
 *
 * `role` defaults to 'client' so existing call sites that only pass a
 * companyId keep gating as before. Staff and admins are exempt -- they run
 * the business, and app/page.tsx already never shows them the lock, so an
 * admin acting on behalf of an expired client must not hit a 403 the UI
 * never predicted. The check lives here, not at each call site, so every
 * route that calls requireActiveBilling inherits it automatically.
 */
export async function requireActiveBilling(
  companyId: string,
  role: 'client' | 'staff' | 'admin' = 'client'
): Promise<BillingGuardResult> {
  if (role === 'staff' || role === 'admin') return { allowed: true };

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
