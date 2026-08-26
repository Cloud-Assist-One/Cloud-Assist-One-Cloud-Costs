import { createAdminClient } from '@/lib/supabase/admin';
import {
  canAddConnection,
  connectionLimitFor,
  connectionLimitMessage,
  isSubscriptionTier,
} from '@/lib/subscriptionTiers';

export interface ConnectionAllowance {
  tier: string;
  limit: number | null; // null = unlimited
  used: number;
  canAdd: boolean;
  message: string | null; // from connectionLimitMessage when at the cap
}

// Shared by the four provider POST routes (the real enforcement — a user
// could POST directly) and the connection-allowance GET route (the UI's
// courtesy greying). Connections are capped per company across every
// provider, so the count below is never filtered by provider.
export async function getConnectionAllowance(
  adminClient: ReturnType<typeof createAdminClient>,
  companyId: string
): Promise<ConnectionAllowance> {
  const { data: company, error: companyError } = await adminClient
    .from('companies')
    .select('subscription_tier')
    .eq('id', companyId)
    .maybeSingle();

  const tier = isSubscriptionTier(company?.subscription_tier) ? company!.subscription_tier : 'free';
  const limit = connectionLimitFor(tier);

  const { count, error: countError } = await adminClient
    .from('cloud_provider_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);

  const used = count ?? 0;

  // A lookup failure must never grant extra connections: refuse outright
  // rather than deriving canAdd from a limit or count we couldn't verify.
  if (companyError || countError) {
    return {
      tier,
      limit,
      used,
      canAdd: false,
      message: 'Could not verify your connection limit. Please try again.',
    };
  }

  return {
    tier,
    limit,
    used,
    canAdd: canAddConnection(tier, used),
    message: connectionLimitMessage(tier, used),
  };
}
