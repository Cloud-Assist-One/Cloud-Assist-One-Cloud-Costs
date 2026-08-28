'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { LineItemFilters } from '@/lib/lineItemFilters';
import type { LineItemSort } from '@/lib/lineItemQuery';
import {
  EXPORT_ROW_CAP,
  fetchAllLineItems,
  LINE_ITEM_CSV_COLUMNS,
  lineItemsToCsv,
  withBillingCode,
} from '@/lib/lineItemExport';
import styles from './LineItemExportActions.module.css';

interface LineItemExportActionsProps {
  /** The same filters the grid and totals use. */
  filters: LineItemFilters;
  sort: LineItemSort;
}

function downloadCsv(csv: string, filename: string) {
  // A BOM, so Excel opens UTF-8 as UTF-8 instead of mangling any non-ASCII
  // resource name in the file.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function LineItemExportActions({ filters, sort }: LineItemExportActionsProps) {
  const [busy, setBusy] = useState<'csv' | 'print' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [printRows, setPrintRows] = useState<Record<string, unknown>[] | null>(null);

  /** Both actions cover the whole filtered set, not the page on screen. */
  async function loadEverything() {
    const result = await fetchAllLineItems(createClient(), filters, sort);
    setNotice(
      result.capped
        ? `Included the first ${EXPORT_ROW_CAP.toLocaleString()} of ${result.totalCount.toLocaleString()} matching line items. Narrow the filter to cover the rest.`
        : null
    );
    return result;
  }

  async function handleExport() {
    setBusy('csv');
    try {
      const { rows } = await loadEverything();
      downloadCsv(lineItemsToCsv(rows), `line-items-${filters.periodId}.csv`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not build the export.');
    } finally {
      setBusy(null);
    }
  }

  async function handlePrint() {
    setBusy('print');
    try {
      const { rows } = await loadEverything();
      // Same derivation the CSV uses, or the Billing Code column prints blank.
      setPrintRows(withBillingCode(rows));
      // Let React paint the full table before the print dialog snapshots it;
      // printing in the same tick would capture the paged grid instead.
      await new Promise((resolve) => setTimeout(resolve, 0));
      window.print();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not build the printable report.');
    } finally {
      setBusy(null);
      setPrintRows(null);
    }
  }

  return (
    <>
      <div className={`${styles.actions} print-hidden`}>
        <button type="button" onClick={handleExport} disabled={busy !== null}>
          {busy === 'csv' ? 'Building…' : 'Export CSV'}
        </button>
        <button type="button" onClick={handlePrint} disabled={busy !== null}>
          {busy === 'print' ? 'Preparing…' : 'Print all'}
        </button>
        {notice && (
          <span role="status" className={styles.notice}>
            {notice}
          </span>
        )}
      </div>

      {/* Screen-hidden, print-only: the grid shows fifty rows, and a report
          that prints only what happened to be on screen is not the report. */}
      {printRows && (
        <table className={styles.printTable}>
          <thead>
            <tr>
              {LINE_ITEM_CSV_COLUMNS.map((column) => (
                <th key={column.key}>{column.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {printRows.map((row, index) => (
              <tr key={String(row.id ?? index)}>
                {LINE_ITEM_CSV_COLUMNS.map((column) => (
                  <td key={column.key}>{String(row[column.key] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
