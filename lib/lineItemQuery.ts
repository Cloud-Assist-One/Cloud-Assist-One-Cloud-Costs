import type { SupabaseClient } from '@supabase/supabase-js';
import type { CostRecord } from './types';
import { applyLineItemFilters, type LineItemFilters } from './lineItemFilters';

export type { LineItemFilters } from './lineItemFilters';

export type LineItemSortColumn =
  | 'usage_date'
  | 'cost'
  | 'resource_id'
  | 'resource_group'
  | 'region'
  | 'availability_zone'
  | 'instance_type'
  | 'database_engine'
  | 'meter_category'
  | 'meter_name'
  | 'usage_type'
  | 'operation'
  | 'subscription_id'
  | 'subscription_name'
  | 'purchase_type'
  | 'reservation_id'
  | 'reservation_name'
  | 'quantity'
  | 'unit'
  | 'unit_price'
  | 'effective_price'
  | 'currency'
  | 'charge_type';
export type SortDirection = 'asc' | 'desc';

export interface LineItemSort {
  column: LineItemSortColumn;
  direction: SortDirection;
}

export interface LineItemPageRequest {
  pageIndex: number;
  pageSize: number;
}

export interface LineItemPage {
  rows: CostRecord[];
  totalCount: number;
}

export async function fetchLineItemsPage(
  supabase: SupabaseClient,
  filters: LineItemFilters,
  sort: LineItemSort,
  page: LineItemPageRequest
): Promise<LineItemPage> {
  // Every filter goes through the one shared applier, so the grid, the totals
  // and the export can never disagree about which rows are "current".
  const query = applyLineItemFilters(
    supabase.from('cost_records').select('*', { count: 'exact' }),
    filters
  );

  const from = page.pageIndex * page.pageSize;
  const to = from + page.pageSize - 1;

  const { data, count, error } = await query
    .order(sort.column, { ascending: sort.direction === 'asc' })
    .range(from, to);

  if (error) {
    throw new Error(error.message);
  }

  return { rows: (data ?? []) as CostRecord[], totalCount: count ?? 0 };
}

export async function fetchReferencedRecordIds(
  supabase: SupabaseClient,
  recordIds: string[]
): Promise<Set<string>> {
  if (recordIds.length === 0) {
    return new Set();
  }

  const [notesResult, todosResult] = await Promise.all([
    supabase.from('review_notes').select('cost_record_id').in('cost_record_id', recordIds),
    supabase.from('review_todos').select('cost_record_id').in('cost_record_id', recordIds),
  ]);

  const referenced = new Set<string>();
  for (const row of notesResult.data ?? []) {
    if (row.cost_record_id) referenced.add(row.cost_record_id);
  }
  for (const row of todosResult.data ?? []) {
    if (row.cost_record_id) referenced.add(row.cost_record_id);
  }
  return referenced;
}
