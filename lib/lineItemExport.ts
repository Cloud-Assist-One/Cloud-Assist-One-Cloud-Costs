import type { SupabaseClient } from '@supabase/supabase-js';
import type { CostRecord } from './types';
import type { LineItemFilters } from './lineItemFilters';
import { fetchLineItemsPage, type LineItemSort } from './lineItemQuery';
import { isBillingCodeTag } from './billingCode';
import { toCsv, type CsvColumn } from './toCsv';

/**
 * Every row matching the current filter, for the CSV export and the print
 * view — both of which have to cover the whole filtered set rather than the
 * fifty rows the grid happens to be showing.
 *
 * Paged through the user's own Supabase client, so RLS decides what is
 * visible; there is no server route holding elevated credentials.
 */

/**
 * Ceiling on how many rows one export pulls into the browser.
 *
 * A CUR month can run to hundreds of thousands of lines, and the alternative
 * to a cap is a tab that hangs. When it bites it is reported, never silently
 * applied — a CSV that stops at row N while looking complete is the same
 * failure as a bucket scan that reports "3 findings" after examining an
 * eighth of the bucket.
 */
export const EXPORT_ROW_CAP = 10_000;

const EXPORT_PAGE_SIZE = 1_000;

export interface AllLineItems {
  rows: CostRecord[];
  /** What the filter actually matches, which may exceed what was fetched. */
  totalCount: number;
  capped: boolean;
}

export async function fetchAllLineItems(
  supabase: SupabaseClient,
  filters: LineItemFilters,
  sort: LineItemSort,
  // Injected so the paging loop is testable without a database.
  { fetchPage = fetchLineItemsPage }: { fetchPage?: typeof fetchLineItemsPage } = {}
): Promise<AllLineItems> {
  const rows: CostRecord[] = [];
  let totalCount = 0;

  for (let pageIndex = 0; rows.length < EXPORT_ROW_CAP; pageIndex++) {
    const page = await fetchPage(supabase, filters, sort, { pageIndex, pageSize: EXPORT_PAGE_SIZE });
    totalCount = page.totalCount;
    rows.push(...page.rows);

    // A short page means the end; without this the loop would keep asking for
    // pages past the data forever.
    if (page.rows.length < EXPORT_PAGE_SIZE) break;
  }

  return {
    rows: rows.slice(0, EXPORT_ROW_CAP),
    totalCount,
    capped: totalCount > EXPORT_ROW_CAP,
  };
}

export const LINE_ITEM_CSV_COLUMNS: CsvColumn[] = [
  { key: 'usage_date', header: 'Date' },
  { key: 'cloud_provider', header: 'Provider' },
  { key: 'service_name', header: 'Service' },
  { key: 'cost', header: 'Cost' },
  { key: 'account_id', header: 'Account' },
  { key: 'resource_id', header: 'Resource ID' },
  { key: 'region', header: 'Region' },
  { key: 'instance_type', header: 'Instance Type' },
  { key: 'database_engine', header: 'DB Engine' },
  { key: 'meter_category', header: 'Meter Category' },
  { key: 'meter_name', header: 'Meter Name' },
  { key: 'subscription_id', header: 'Subscription ID' },
  { key: 'subscription_name', header: 'Subscription Name' },
  { key: 'purchase_type', header: 'Purchase Type' },
  { key: 'quantity', header: 'Quantity' },
  { key: 'unit', header: 'Unit' },
  { key: 'unit_price', header: 'Unit Price' },
  { key: 'charge_type', header: 'Charge Type' },
  { key: 'billing_code', header: 'Billing Code' },
];

/** The tag's many spellings resolved to one value, as the grid shows it. */
function billingCodeOf(tags: unknown): string | null {
  if (!tags || typeof tags !== 'object') return null;
  const match = Object.entries(tags as Record<string, string>).find(([key]) => isBillingCodeTag(key));
  return match ? match[1] : null;
}

/**
 * Rows with billing_code filled in from their tags.
 *
 * The grid derives it for display and the database has its own generated
 * column, but a CostRecord read through PostgREST carries only `tags`. Both
 * the CSV and the print view render from this, so a report grouped by billing
 * code can be reproduced from either.
 */
export function withBillingCode(rows: readonly CostRecord[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    ...row,
    billing_code: billingCodeOf((row as { tags?: unknown }).tags),
  }));
}

export function lineItemsToCsv(rows: readonly CostRecord[]): string {
  return toCsv(withBillingCode(rows), LINE_ITEM_CSV_COLUMNS);
}
