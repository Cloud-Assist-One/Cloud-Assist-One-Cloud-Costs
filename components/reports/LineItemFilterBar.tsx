'use client';

import { useEffect, useState } from 'react';
import type { CloudProvider } from '@/lib/types';
import type { LineItemFilters } from '@/lib/lineItemFilters';
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import styles from './LineItemFilterBar.module.css';

/** Everything the bar can set. periodId is the tab's, not the bar's, to give. */
export type EditableFilters = Omit<LineItemFilters, 'periodId' | 'serviceNames'>;

interface LineItemFilterBarProps {
  filters: EditableFilters;
  onChange: (next: EditableFilters) => void;
  /** Rendered inside the bar so the service pill sits with the other filters. */
  serviceFilterCount: number;
  onClearServiceFilter: () => void;
}

// Long enough that typing a resource id does not fire a query per keystroke,
// short enough that the grid still feels attached to the box.
const SEARCH_DEBOUNCE_MS = 300;

/** Empty string from an input means "no filter", not "match the empty string". */
function orUndefined(value: string): string | undefined {
  return value.trim() === '' ? undefined : value.trim();
}

function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default function LineItemFilterBar({
  filters,
  onChange,
  serviceFilterCount,
  onClearServiceFilter,
}: LineItemFilterBarProps) {
  const [searchDraft, setSearchDraft] = useState(filters.searchText ?? '');
  const [expanded, setExpanded] = useState(false);

  // The search box keeps its own draft so typing stays responsive, and only
  // the settled value reaches the query. Every other control commits on
  // change, since they are all discrete choices rather than free text.
  useEffect(() => {
    const settled = orUndefined(searchDraft);
    if (settled === filters.searchText) return;

    const timer = setTimeout(() => onChange({ ...filters, searchText: settled }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, filters, onChange]);

  function set<K extends keyof EditableFilters>(key: K, value: EditableFilters[K]) {
    onChange({ ...filters, [key]: value });
  }

  const activeCount = Object.entries(filters).filter(
    ([key, value]) => key !== 'searchText' && value !== undefined && value !== false
  ).length;

  return (
    <div className={`${styles.bar} print-hidden`}>
      <div className={styles.row}>
        <label className={styles.searchLabel} htmlFor="line-items-search">
          Search
        </label>
        <input
          id="line-items-search"
          type="search"
          className={styles.search}
          placeholder="Resource, service, meter, region…"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
        />

        <label htmlFor="line-items-provider">Provider</label>
        <select
          id="line-items-provider"
          value={filters.cloudProvider ?? ''}
          onChange={(e) => set('cloudProvider', (e.target.value || undefined) as CloudProvider | undefined)}
        >
          <option value="">All</option>
          {CLOUD_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {CLOUD_PROVIDER_LABELS[provider]}
            </option>
          ))}
        </select>

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={filters.excludeZeroCost ?? false}
            onChange={(e) => set('excludeZeroCost', e.target.checked || undefined)}
          />
          Hide $0 lines
        </label>

        {serviceFilterCount > 0 && (
          <button type="button" onClick={onClearServiceFilter}>
            Clear service filter ({serviceFilterCount})
          </button>
        )}

        <button type="button" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}>
          {expanded ? 'Fewer filters' : 'More filters'}
          {activeCount > 0 ? ` (${activeCount})` : ''}
        </button>
      </div>

      {expanded && (
        <div className={styles.row}>
          <label htmlFor="line-items-billing-code">Billing code</label>
          <input
            id="line-items-billing-code"
            value={filters.billingCode ?? ''}
            onChange={(e) => set('billingCode', orUndefined(e.target.value))}
          />

          <label htmlFor="line-items-account">Account</label>
          <input
            id="line-items-account"
            value={filters.accountId ?? ''}
            onChange={(e) => set('accountId', orUndefined(e.target.value))}
          />

          <label htmlFor="line-items-region">Region</label>
          <input
            id="line-items-region"
            value={filters.region ?? ''}
            onChange={(e) => set('region', orUndefined(e.target.value))}
          />

          <label htmlFor="line-items-date-from">From</label>
          <input
            id="line-items-date-from"
            type="date"
            value={filters.dateFrom ?? ''}
            onChange={(e) => set('dateFrom', orUndefined(e.target.value))}
          />

          <label htmlFor="line-items-date-to">To</label>
          <input
            id="line-items-date-to"
            type="date"
            value={filters.dateTo ?? ''}
            onChange={(e) => set('dateTo', orUndefined(e.target.value))}
          />

          <label htmlFor="line-items-cost-min">Cost min</label>
          <input
            id="line-items-cost-min"
            type="number"
            step="any"
            className={styles.number}
            value={filters.costMin ?? ''}
            onChange={(e) => set('costMin', numberOrUndefined(e.target.value))}
          />

          <label htmlFor="line-items-cost-max">Cost max</label>
          <input
            id="line-items-cost-max"
            type="number"
            step="any"
            className={styles.number}
            value={filters.costMax ?? ''}
            onChange={(e) => set('costMax', numberOrUndefined(e.target.value))}
          />
        </div>
      )}
    </div>
  );
}
