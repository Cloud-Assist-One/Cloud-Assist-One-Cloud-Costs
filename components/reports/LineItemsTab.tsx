'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
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

const columnHelper = createColumnHelper<CostRecord & { referenced: boolean }>();

const columns = [
  columnHelper.accessor('usage_date', { header: 'Date', cell: (info) => info.getValue() }),
  columnHelper.accessor('cloud_provider', {
    header: 'Provider',
    cell: (info) => CLOUD_PROVIDER_LABELS[info.getValue()],
  }),
  columnHelper.accessor('service_name', { header: 'Service', cell: (info) => info.getValue() }),
  columnHelper.accessor('account_id', { header: 'Account', cell: (info) => info.getValue() ?? '—' }),
  columnHelper.accessor('cost', { header: 'Cost', cell: (info) => formatCurrency(info.getValue()) }),
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
