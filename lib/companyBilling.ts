import type { createAdminClient } from '@/lib/supabase/admin';
import { resolveCompanyAccess, type CompanyAccess } from '@/lib/companyAccess';

const BILLING_COLUMNS =
  'subscription_tier, trial_ends_at, stripe_subscription_id, subscription_status';

/**
 * A lookup failure must never hand out access: an unverifiable company is
 * treated as expired, the same way getConnectionAllowance refuses rather
 * than granting a connection it could not verify.
 */
export async function fetchCompanyAccess(
  adminClient: ReturnType<typeof createAdminClient>,
  companyId: string
): Promise<CompanyAccess> {
  const { data, error } = await adminClient
    .from('companies')
    .select(BILLING_COLUMNS)
    .eq('id', companyId)
    .maybeSingle();

  if (error) return { state: 'trial_expired', trialEndsAt: null };

  return resolveCompanyAccess(data ?? null);
}
