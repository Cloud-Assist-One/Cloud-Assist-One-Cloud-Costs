'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type CellContext,
} from '@tanstack/react-table';
import { createClient } from '@/lib/supabase/client';
import type { CloudProvider, CostRecord } from '@/lib/types';
import { fetchLineItemsPage, fetchReferencedRecordIds, type LineItemSortColumn } from '@/lib/lineItemQuery';
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import styles from './LineItemsTab.module.css';

interface LineItemsTabProps {
  companyId: string;
  periodId: string;
  initialServiceFilter?: string[];
}

const PAGE_SIZE = 50;

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

type LineItemRow = CostRecord & { referenced: boolean };

const columnHelper = createColumnHelper<LineItemRow>();

// Shared by every "just show the text, or an em dash" column below. Long
// values (resource ids, names) truncate visually but keep the full value
// available via the title attribute on hover.
function textCell(info: CellContext<LineItemRow, string | null>) {
  const value = info.getValue();
  if (value === null) return '—';
  return (
    <span className={styles.truncate} title={value}>
      {value}
    </span>
  );
}

// Providers report usage quantities at full float precision, which renders
// as things like 0.000277777777777778 and pushes the column far wider than
// the number is worth. Eight decimals is past the point of meaning for a
// billing quantity, and trailing zeros are dropped so whole numbers stay
// short.
const MAX_QUANTITY_DECIMALS = 8;

export function formatQuantity(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return String(value);

  const rounded = Number(value.toFixed(MAX_QUANTITY_DECIMALS));
  // A value smaller than the last kept decimal would round to zero, which
  // reads as "no usage" rather than "a very small amount".
  if (rounded === 0) return value > 0 ? `<0.00000001` : `>-0.00000001`;
  return String(rounded);
}

function numberCell(info: CellContext<LineItemRow, number | null>) {
  const value = info.getValue();
  return value === null ? '—' : String(value);
}

function quantityCell(info: CellContext<LineItemRow, number | null>) {
  return formatQuantity(info.getValue());
}

/**
 * True for the billing-code tag under any spelling.
 *
 * Tag keys are typed by hand in each cloud console, so the same tag shows up
 * as "Billing Code", "billing_code", "BillingCode", "billing-code" and so on.
 * Comparing on letters and digits alone treats them all as one tag.
 */
export function isBillingCodeTag(key: string): boolean {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'billingcode';
}

/**
 * Shows only the billing code, not the whole tag set.
 *
 * A resource can carry dozens of tags, which made the column an unreadable
 * run-on string. The billing code is the one this grid is used to group by.
 */
export function formatTags(tags: Record<string, string> | null): string {
  if (!tags) return '—';
  const matches = Object.entries(tags).filter(([key]) => isBillingCodeTag(key));
  if (matches.length === 0) return '—';
  // Keyed only by value: the column header already says what it is, and a
  // resource tagged twice under different spellings should read as its
  // values, not repeat the key.
  return matches.map(([, value]) => value).join(', ');
}

// Columns that can be sorted server-side beyond the two with their own
// buttons above (Date, Cost). Kept in step with the visible columns: an
// option for a column the grid no longer shows sorts by something invisible.
// `tags` is jsonb and deliberately excluded — sorting it isn't meaningful.
const MORE_SORT_OPTIONS: { value: LineItemSortColumn; label: string }[] = [
  { value: 'resource_id', label: 'Resource ID' },
  { value: 'region', label: 'Region' },
  { value: 'instance_type', label: 'Instance Type' },
  { value: 'database_engine', label: 'Database Engine' },
  { value: 'meter_category', label: 'Meter Category' },
  { value: 'meter_name', label: 'Meter Name' },
  { value: 'subscription_id', label: 'Subscription ID' },
  { value: 'subscription_name', label: 'Subscription Name' },
  { value: 'purchase_type', label: 'Purchase Type' },
  { value: 'quantity', label: 'Quantity' },
  { value: 'unit', label: 'Unit' },
  { value: 'unit_price', label: 'Unit Price' },
  { value: 'charge_type', label: 'Charge Type' },
];

const columns = [
  columnHelper.accessor('usage_date', { header: 'Date', cell: (info) => info.getValue() }),
  columnHelper.accessor('cloud_provider', {
    header: 'Provider',
    cell: (info) => CLOUD_PROVIDER_LABELS[info.getValue()],
  }),
  columnHelper.accessor('service_name', { header: 'Service', cell: (info) => info.getValue() }),
  columnHelper.accessor('account_id', { header: 'Account', cell: (info) => info.getValue() ?? '—' }),
  columnHelper.accessor('cost', { header: 'Cost', cell: (info) => formatCurrency(info.getValue()) }),
  columnHelper.accessor('resource_id', { header: 'Resource ID', cell: textCell }),
  columnHelper.accessor('region', { header: 'Region', cell: textCell }),
  columnHelper.accessor('instance_type', { header: 'Instance Type', cell: textCell }),
  columnHelper.accessor('database_engine', { header: 'DB Engine', cell: textCell }),
  columnHelper.accessor('meter_category', { header: 'Meter Category', cell: textCell }),
  columnHelper.accessor('meter_name', { header: 'Meter Name', cell: textCell }),
  columnHelper.accessor('subscription_id', { header: 'Subscription ID', cell: textCell }),
  columnHelper.accessor('subscription_name', { header: 'Subscription Name', cell: textCell }),
  columnHelper.accessor('purchase_type', { header: 'Purchase Type', cell: textCell }),
  columnHelper.accessor('quantity', { header: 'Quantity', cell: quantityCell }),
  columnHelper.accessor('unit', { header: 'Unit', cell: textCell }),
  columnHelper.accessor('unit_price', { header: 'Unit Price', cell: numberCell }),
  columnHelper.accessor('charge_type', { header: 'Charge Type', cell: textCell }),
  columnHelper.accessor('tags', {
    header: 'Billing Code',
    cell: (info) => {
      const text = formatTags(info.getValue());
      return text === '—' ? (
        '—'
      ) : (
        <span className={styles.truncate} title={text}>
          {text}
        </span>
      );
    },
  }),
  columnHelper.accessor('referenced', {
    header: '',
    cell: (info) => (info.getValue() ? <span title="Referenced by a note or follow-up">📝</span> : null),
  }),
];

export default function LineItemsTab({ companyId, periodId, initialServiceFilter }: LineItemsTabProps) {
  const [rows, setRows] = useState<CostRecord[]>([]);
  const [referencedIds, setReferencedIds] = useState<Set<string>>(new Set());
  const [totalCount, setTotalCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortColumn, setSortColumn] = useState<LineItemSortColumn>('usage_date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [serviceFilter, setServiceFilter] = useState<string[]>(initialServiceFilter ?? []);
  const [providerFilter, setProviderFilter] = useState<CloudProvider | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const supabase = createClient();

      try {
        const page = await fetchLineItemsPage(
          supabase,
          {
            periodId,
            serviceNames: serviceFilter.length > 0 ? serviceFilter : undefined,
            cloudProvider: providerFilter || undefined,
          },
          { column: sortColumn, direction: sortDirection },
          { pageIndex, pageSize: PAGE_SIZE }
        );
        if (cancelled) return;

        const referenced = await fetchReferencedRecordIds(supabase, page.rows.map((row) => row.id));
        if (cancelled) return;

        setRows(page.rows);
        setTotalCount(page.totalCount);
        setReferencedIds(referenced);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load line items.');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, periodId, serviceFilter, providerFilter, sortColumn, sortDirection, pageIndex]);

  const tableRows = useMemo(
    () => rows.map((row) => ({ ...row, referenced: referencedIds.has(row.id) })),
    [rows, referencedIds]
  );

  const table = useReactTable({
    data: tableRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  function toggleSort(column: LineItemSortColumn) {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
    setPageIndex(0);
  }

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.controls} print-hidden`}>
        <label htmlFor="line-items-provider">Provider</label>
        <select
          id="line-items-provider"
          value={providerFilter}
          onChange={(e) => {
            setProviderFilter(e.target.value as CloudProvider | '');
            setPageIndex(0);
          }}
        >
          <option value="">All</option>
          {CLOUD_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {CLOUD_PROVIDER_LABELS[provider]}
            </option>
          ))}
        </select>
        {serviceFilter.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setServiceFilter([]);
              setPageIndex(0);
            }}
          >
            Clear service filter ({serviceFilter.length})
          </button>
        )}
        <button type="button" onClick={() => toggleSort('usage_date')}>
          Sort by date {sortColumn === 'usage_date' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
        </button>
        <button type="button" onClick={() => toggleSort('cost')}>
          Sort by cost {sortColumn === 'cost' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
        </button>
        <label htmlFor="line-items-more-sort">More sort options</label>
        <select
          id="line-items-more-sort"
          value={MORE_SORT_OPTIONS.some((opt) => opt.value === sortColumn) ? sortColumn : ''}
          onChange={(e) => {
            if (e.target.value) toggleSort(e.target.value as LineItemSortColumn);
          }}
        >
          <option value="">More sort options…</option>
          {MORE_SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
              {sortColumn === opt.value ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : rows.length === 0 ? (
        <p>No line items match this filter.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className={`${styles.pagination} print-hidden`}>
            <button type="button" disabled={pageIndex === 0} onClick={() => setPageIndex((p) => p - 1)}>
              Previous
            </button>
            <span>
              Page {pageIndex + 1} of {pageCount}
            </span>
            <button
              type="button"
              disabled={pageIndex + 1 >= pageCount}
              onClick={() => setPageIndex((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
