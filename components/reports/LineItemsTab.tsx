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
import type { CostRecord } from '@/lib/types';
import { fetchLineItemsPage, fetchReferencedRecordIds, type LineItemSortColumn } from '@/lib/lineItemQuery';
import { CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import { formatTags } from '@/lib/billingCode';
import LineItemFilterBar, { type EditableFilters } from './LineItemFilterBar';
import LineItemTotals from './LineItemTotals';
import LineItemExportActions from './LineItemExportActions';
import type { LineItemFilters } from '@/lib/lineItemFilters';
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
  // CUR emits a great many $0 lines -- free tier, zero usage, metadata-only
  // rows. They are noise in a cost report, so the tab opens without them; the
  // checkbox turns them back on.
  const [filters, setFilters] = useState<EditableFilters>({ excludeZeroCost: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composed once and shared: the grid below and the totals above must
  // describe the same rows, and two separately-built filter objects are how
  // they would quietly drift apart.
  const activeFilters = useMemo<LineItemFilters>(
    () => ({
      ...filters,
      periodId,
      serviceNames: serviceFilter.length > 0 ? serviceFilter : undefined,
    }),
    [filters, periodId, serviceFilter]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const supabase = createClient();

      try {
        const page = await fetchLineItemsPage(
          supabase,
          activeFilters,
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
  }, [companyId, activeFilters, sortColumn, sortDirection, pageIndex]);

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
      <LineItemFilterBar
        filters={filters}
        onChange={(next) => {
          setFilters(next);
          setPageIndex(0);
        }}
        serviceFilterCount={serviceFilter.length}
        onClearServiceFilter={() => {
          setServiceFilter([]);
          setPageIndex(0);
        }}
      />

      <LineItemTotals filters={activeFilters} />

      <LineItemExportActions
        filters={activeFilters}
        sort={{ column: sortColumn, direction: sortDirection }}
      />

      <div className={`${styles.controls} print-hidden`}>
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
