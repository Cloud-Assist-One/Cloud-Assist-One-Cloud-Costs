import { createAdminClient } from '@/lib/supabase/admin';
import { CLOUD_PROVIDER_LABELS, formatBillingMonth } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';

export interface BillingMonthCheckResult {
  ok: boolean;
  errorMessage: string | null;
}

// Every cloud provider's data in a period must be for the same billing
// month — otherwise the charts/Compare/trend view would silently mix
// different months together. Shared by the file-upload route and the AWS
// Pull Billing route so the two paths can't drift apart on this rule.
export async function checkBillingMonthMatches(
  adminClient: ReturnType<typeof createAdminClient>,
  periodId: string,
  cloudProvider: CloudProvider,
  billingMonth: string
): Promise<BillingMonthCheckResult> {
  const { data: otherProviderFiles, error } = await adminClient
    .from('uploaded_files')
    .select('cloud_provider, billing_month')
    .eq('period_id', periodId)
    .eq('status', 'processed')
    .neq('cloud_provider', cloudProvider)
    .not('billing_month', 'is', null);

  if (error) {
    return { ok: false, errorMessage: "Could not verify this period's billing month." };
  }

  const mismatch = (otherProviderFiles ?? []).find((f) => f.billing_month !== billingMonth);
  if (mismatch) {
    return {
      ok: false,
      errorMessage:
        `${CLOUD_PROVIDER_LABELS[cloudProvider]} is billed for ${formatBillingMonth(billingMonth)}, but ` +
        `${CLOUD_PROVIDER_LABELS[mismatch.cloud_provider as CloudProvider]} in this period is for ` +
        `${formatBillingMonth(mismatch.billing_month as string)}. Every provider in a period must be for the same ` +
        `billing month — archive this period and start a new one, then re-upload every provider for the same month.`,
    };
  }

  return { ok: true, errorMessage: null };
}
