import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudProvider, CostRecord } from './types';

export type LineItemSortColumn = 'usage_date' | 'cost';
export type SortDirection = 'asc' | 'desc';

export interface LineItemFilters {
  periodId: string;
  serviceNames?: string[];
  cloudProvider?: CloudProvider;
}

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
  let query = supabase.from('cost_records').select('*', { count: 'exact' }).eq('period_id', filters.periodId);

  if (filters.cloudProvider) {
    query = query.eq('cloud_provider', filters.cloudProvider);
  }
  if (filters.serviceNames && filters.serviceNames.length > 0) {
    query = query.in('service_name', filters.serviceNames);
  }

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
