import type { SupabaseClient } from '@supabase/supabase-js';
import type { LineItemFilters } from './lineItemFilters';

/**
 * Totals and subtotals for whatever the Line Items grid is currently showing.
 *
 * The grid pages fifty rows at a time, so the sum has to come from the
 * database. Both functions take the same filters the grid does, mapped here in
 * one place — a total that counts different rows than the grid beneath it is
 * worse than no total at all.
 *
 * Called with the user's Supabase client, never the admin one: the functions
 * are SECURITY INVOKER so the cost_records RLS policy is what stops a company
 * totalling anyone else's spend.
 */

export interface LineItemSummary {
  rowCount: number;
  totalCost: number;
}

export interface LineItemGroup {
  /** Null when the grouped column is empty for those rows — a real group. */
  groupKey: string | null;
  rowCount: number;
  totalCost: number;
}

export type GroupableColumn =
  | 'service_name'
  | 'billing_code'
  | 'account_id'
  | 'region'
  | 'charge_type'
  | 'cloud_provider';

// Mirrors the CASE whitelist in line_items_grouped. A column added here but
// not there would silently group every row under one null key.
export const GROUPABLE_COLUMNS: { value: GroupableColumn; label: string }[] = [
  { value: 'service_name', label: 'Service' },
  { value: 'billing_code', label: 'Billing Code' },
  { value: 'account_id', label: 'Account' },
  { value: 'region', label: 'Region' },
  { value: 'charge_type', label: 'Charge Type' },
  { value: 'cloud_provider', label: 'Provider' },
];

/** Postgres sends numeric as a string; untouched it would concatenate. */
function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface AggregateArgs {
  p_period_id: string;
  p_cloud_provider: string | null;
  p_service_names: string[] | null;
  p_search_text: string | null;
  p_billing_code: string | null;
  p_account_id: string | null;
  p_region: string | null;
  p_date_from: string | null;
  p_date_to: string | null;
  p_cost_min: number | null;
  p_cost_max: number | null;
  p_exclude_zero_cost: boolean;
}

/**
 * The filter object as the aggregate functions' arguments.
 *
 * Unset filters are sent as explicit nulls rather than omitted: PostgREST drops
 * undefined keys, which would silently fall through to whatever default the
 * function declares instead of stating "no filter".
 */
export function aggregateArgs(filters: LineItemFilters): AggregateArgs {
  const searchText = filters.searchText?.trim().toLowerCase();

  return {
    p_period_id: filters.periodId,
    p_cloud_provider: filters.cloudProvider ?? null,
    p_service_names: filters.serviceNames && filters.serviceNames.length > 0 ? filters.serviceNames : null,
    // Lowercased and trimmed exactly as applyLineItemFilters does, so the
    // total counts the rows the grid shows.
    p_search_text: searchText ? searchText : null,
    p_billing_code: filters.billingCode ?? null,
    p_account_id: filters.accountId ?? null,
    p_region: filters.region ?? null,
    p_date_from: filters.dateFrom ?? null,
    p_date_to: filters.dateTo ?? null,
    // ?? not ||, so a floor or ceiling of zero survives.
    p_cost_min: filters.costMin ?? null,
    p_cost_max: filters.costMax ?? null,
    p_exclude_zero_cost: filters.excludeZeroCost ?? false,
  };
}

export async function fetchLineItemSummary(
  supabase: SupabaseClient,
  filters: LineItemFilters
): Promise<LineItemSummary> {
  const { data, error } = await supabase.rpc('line_items_summary', aggregateArgs(filters));

  if (error) throw new Error(error.message);

  const row = (data as { row_count: number; total_cost: unknown }[] | null)?.[0];
  if (!row) return { rowCount: 0, totalCost: 0 };

  return { rowCount: toNumber(row.row_count), totalCost: toNumber(row.total_cost) };
}

export async function fetchLineItemGroups(
  supabase: SupabaseClient,
  filters: LineItemFilters,
  groupBy: GroupableColumn
): Promise<LineItemGroup[]> {
  const { data, error } = await supabase.rpc('line_items_grouped', {
    ...aggregateArgs(filters),
    p_group_by: groupBy,
  });

  if (error) throw new Error(error.message);

  return ((data as { group_key: string | null; row_count: number; total_cost: unknown }[] | null) ?? []).map(
    (row) => ({
      groupKey: row.group_key,
      rowCount: toNumber(row.row_count),
      totalCost: toNumber(row.total_cost),
    })
  );
}
