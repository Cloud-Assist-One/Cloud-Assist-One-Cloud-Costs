import type { SupabaseClient } from '@supabase/supabase-js';

export interface PeriodTarget {
  periodId: string;
  kind: 'active' | 'archived';
}

/**
 * The period a discovered month's data belongs in.
 *
 * Pull Billing archives the active period before importing, so by the time
 * this runs the active period is empty and the newest month can take it.
 * Earlier months get an archived period of their own — reused if one already
 * exists, which is what makes a re-pull idempotent rather than duplicating
 * history.
 *
 * Archived periods are inserted directly rather than through
 * archive_billing_period(), which only ever archives the *active* period.
 */
export async function periodForMonth(
  adminClient: SupabaseClient,
  companyId: string,
  month: string,
  activePeriodId: string,
  isLatestMonth: boolean
): Promise<PeriodTarget> {
  if (isLatestMonth) {
    // A freshly created active period has no billing month until something
    // lands in it.
    await adminClient.from('billing_periods').update({ billing_month: month }).eq('id', activePeriodId);
    return { periodId: activePeriodId, kind: 'active' };
  }

  const { data: existing } = await adminClient
    .from('billing_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'archived')
    .eq('billing_month', month)
    .maybeSingle();

  if (existing) return { periodId: (existing as { id: string }).id, kind: 'archived' };

  const { data: created, error } = await adminClient
    .from('billing_periods')
    .insert({
      company_id: companyId,
      status: 'archived',
      billing_month: month,
      // The Archive tab orders by this, so a period created by a pull has to
      // carry one just as one closed by hand does.
      archived_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error || !created) {
    throw new Error(`Could not create an archived period for ${month}: ${error?.message ?? 'unknown error'}`);
  }

  return { periodId: (created as { id: string }).id, kind: 'archived' };
}
