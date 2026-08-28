'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { LineItemFilters } from '@/lib/lineItemFilters';
import { formatCost } from '@/lib/formatCost';
import {
  fetchLineItemGroups,
  fetchLineItemSummary,
  GROUPABLE_COLUMNS,
  type GroupableColumn,
  type LineItemGroup,
  type LineItemSummary,
} from '@/lib/lineItemAggregates';
import styles from './LineItemTotals.module.css';

interface LineItemTotalsProps {
  /** The same object the grid queries with, so both describe the same rows. */
  filters: LineItemFilters;
}

/** Rows with nothing in the grouped column are a real group worth chasing. */
const NO_VALUE_LABEL = 'Untagged';

export default function LineItemTotals({ filters }: LineItemTotalsProps) {
  const [summary, setSummary] = useState<LineItemSummary | null>(null);
  const [groupBy, setGroupBy] = useState<GroupableColumn | ''>('');
  // Tagged with the column that produced them. Storing bare rows meant either
  // clearing them synchronously in the effect -- which cascades renders -- or
  // briefly showing the previous grouping's subtotals under the new heading
  // while the next fetch was still in flight.
  const [groups, setGroups] = useState<{ column: GroupableColumn; rows: LineItemGroup[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The grid pages fifty rows at a time, so this has to come from the database
  // and has to move whenever the filter does -- a stale total silently
  // describes the previous filter.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await fetchLineItemSummary(createClient(), filters);
        if (!cancelled) {
          setSummary(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          // Blank rather than stale: a total left on screen from the previous
          // filter is worse than no total, because it still looks authoritative.
          setSummary(null);
          setError(err instanceof Error ? err.message : 'Could not total these line items.');
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  useEffect(() => {
    if (!groupBy) return;
    let cancelled = false;
    const column = groupBy;

    async function load() {
      try {
        const rows = await fetchLineItemGroups(createClient(), filters, column);
        if (!cancelled) setGroups({ column, rows });
      } catch {
        // The headline total above already reports a failed aggregate; a
        // second copy of the same message helps nobody.
        if (!cancelled) setGroups({ column, rows: [] });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [filters, groupBy]);

  // Only render subtotals that belong to the grouping currently selected.
  const visibleGroups = groupBy && groups?.column === groupBy ? groups.rows : [];

  return (
    <div className={styles.totals}>
      <div className={styles.headline}>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : summary ? (
          <p className={styles.summary}>
            <strong>{formatCost(summary.totalCost)}</strong> across {summary.rowCount.toLocaleString()} line
            item{summary.rowCount === 1 ? '' : 's'}
          </p>
        ) : (
          <p className={styles.summary}>Totalling…</p>
        )}

        <label className="print-hidden" htmlFor="line-items-group-by">
          Group by
        </label>
        <select
          id="line-items-group-by"
          className="print-hidden"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as GroupableColumn | '')}
        >
          <option value="">Nothing</option>
          {GROUPABLE_COLUMNS.map((column) => (
            <option key={column.value} value={column.value}>
              {column.label}
            </option>
          ))}
        </select>
      </div>

      {visibleGroups.length > 0 && (
        <table className={styles.groups}>
          <thead>
            <tr>
              <th>{GROUPABLE_COLUMNS.find((column) => column.value === groupBy)?.label}</th>
              <th>Line items</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {visibleGroups.map((group) => (
              <tr key={group.groupKey ?? '__none__'}>
                <td>{group.groupKey ?? NO_VALUE_LABEL}</td>
                <td>{group.rowCount.toLocaleString()}</td>
                <td>{formatCost(group.totalCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
