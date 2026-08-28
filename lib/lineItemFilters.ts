import type { CloudProvider } from './types';

/**
 * What the Line Items tab is currently showing.
 *
 * One object, applied by one function, so the grid, the totals and the export
 * can never disagree about what "the current filter" means. A total that
 * counts different rows than the grid below it is worse than no total.
 */
export interface LineItemFilters {
  periodId: string;
  serviceNames?: string[];
  cloudProvider?: CloudProvider;
  /** Free text, matched against the generated search_text column. */
  searchText?: string;
  billingCode?: string;
  accountId?: string;
  region?: string;
  /** Inclusive, and expected to sit inside the period. */
  dateFrom?: string;
  dateTo?: string;
  costMin?: number;
  costMax?: number;
  /**
   * Drop rows costing exactly zero.
   *
   * CUR emits a great many $0 lines -- free tier, zero usage, metadata-only
   * rows -- which bury the rows worth looking at. Deliberately "not equal to
   * zero" rather than "greater than zero": a negative cost is a credit or
   * refund, which is real money and worth seeing.
   */
  excludeZeroCost?: boolean;
}

/**
 * The subset of the PostgREST builder this needs, so tests need no database.
 *
 * Methods return this interface rather than `this`: PostgREST's own builder
 * type is deeply recursive, and threading it through a generic here made
 * TypeScript give up with "type instantiation is excessively deep".
 */
export interface FilterableQuery {
  eq(column: string, value: unknown): FilterableQuery;
  neq(column: string, value: unknown): FilterableQuery;
  in(column: string, values: readonly unknown[]): FilterableQuery;
  ilike(column: string, pattern: string): FilterableQuery;
  gte(column: string, value: unknown): FilterableQuery;
  lte(column: string, value: unknown): FilterableQuery;
}

// "%" and "_" are LIKE wildcards, so a user searching for "100%" would
// otherwise match every row instead of the one they meant.
function escapeLikeWildcards(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function applyLineItemFilters<Q extends object>(query: Q, filters: LineItemFilters): Q {
  // Q stays unconstrained so the caller keeps its own PostgREST type; the
  // structural interface above is what this function actually works against.
  let next = (query as unknown as FilterableQuery).eq('period_id', filters.periodId);

  if (filters.cloudProvider) {
    next = next.eq('cloud_provider', filters.cloudProvider);
  }
  // An empty array would ask PostgREST to match nothing, blanking the grid
  // rather than leaving it unfiltered.
  if (filters.serviceNames && filters.serviceNames.length > 0) {
    next = next.in('service_name', filters.serviceNames);
  }

  const searchText = filters.searchText?.trim().toLowerCase();
  if (searchText) {
    // search_text is stored lowercased by the generated column, so the term is
    // lowered to match rather than relying on ilike's case folding, which
    // cannot use the trigram index as directly.
    next = next.ilike('search_text', `%${escapeLikeWildcards(searchText)}%`);
  }

  if (filters.billingCode) {
    next = next.eq('billing_code', filters.billingCode);
  }
  if (filters.accountId) {
    next = next.eq('account_id', filters.accountId);
  }
  if (filters.region) {
    next = next.eq('region', filters.region);
  }

  if (filters.dateFrom) {
    next = next.gte('usage_date', filters.dateFrom);
  }
  if (filters.dateTo) {
    next = next.lte('usage_date', filters.dateTo);
  }

  // Compared against undefined, not truthiness: 0 is a real threshold and a
  // truthiness check would silently drop "everything at or above nothing".
  if (filters.costMin !== undefined) {
    next = next.gte('cost', filters.costMin);
  }
  if (filters.costMax !== undefined) {
    next = next.lte('cost', filters.costMax);
  }
  if (filters.excludeZeroCost) {
    next = next.neq('cost', 0);
  }

  return next as unknown as Q;
}
