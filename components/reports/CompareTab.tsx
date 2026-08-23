'use client';

import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import type { CostRecord } from '@/lib/types';
import { aggregateByCategoryComparison, totalCost } from '@/lib/reportAggregation';
import { categorizeService } from '@/lib/serviceCategory';
import { CLOUD_PROVIDER_LABELS, CLOUD_PROVIDER_COLORS } from '@/lib/cloudProvider';
import styles from './CompareTab.module.css';

interface CompareTabProps {
  companyId: string;
  periodId: string;
  onCategoryClick?: (serviceNames: string[]) => void;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function CompareTab({ companyId, periodId, onCategoryClick }: CompareTabProps) {
  const [records, setRecords] = useState<CostRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const supabase = createClient();
      const pageSize = 1000;
      const allRows: CostRecord[] = [];
      let offset = 0;

      // PostgREST caps rows per request (commonly 1000), so page through until a
      // short page tells us we've reached the end — otherwise large result sets
      // would be silently truncated.
      for (;;) {
        const { data, error: pageError } = await supabase
          .from('cost_records')
          .select('*')
          .eq('company_id', companyId)
          .eq('period_id', periodId)
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (pageError) {
          if (!cancelled) {
            setError('Could not load cost data. Please try again.');
            setLoading(false);
          }
          return;
        }

        const page = data ?? [];
        allRows.push(...page);

        if (page.length < pageSize) break;
        offset += pageSize;
      }

      if (!cancelled) {
        setRecords(allRows);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, periodId]);

  const awsRecords = useMemo(() => records.filter((r) => r.cloud_provider === 'aws'), [records]);
  const azureRecords = useMemo(() => records.filter((r) => r.cloud_provider === 'azure'), [records]);
  const gcpRecords = useMemo(() => records.filter((r) => r.cloud_provider === 'gcp'), [records]);
  const awsTotal = useMemo(() => totalCost(awsRecords), [awsRecords]);
  const azureTotal = useMemo(() => totalCost(azureRecords), [azureRecords]);
  const gcpTotal = useMemo(() => totalCost(gcpRecords), [gcpRecords]);
  // Compare covers AWS/Azure/Google Cloud — Snowflake records (if any) are
  // excluded here rather than silently folded into another column.
  const categoryComparison = useMemo(
    () =>
      aggregateByCategoryComparison(
        records.filter(
          (r): r is typeof r & { cloud_provider: 'aws' | 'azure' | 'gcp' } =>
            r.cloud_provider === 'aws' || r.cloud_provider === 'azure' || r.cloud_provider === 'gcp'
        ),
        categorizeService
      ),
    [records]
  );

  function handleCategoryClick(category: string) {
    if (!onCategoryClick) return;
    const serviceNames = Array.from(
      new Set(records.filter((r) => categorizeService(r.service_name) === category).map((r) => r.service_name))
    );
    onCategoryClick(serviceNames);
  }

  return (
    <div className={styles.wrapper}>
      <button type="button" className={`${styles.printButton} print-hidden`} onClick={() => window.print()}>
        Print
      </button>

      {loading ? (
        <p>Loading…</p>
      ) : error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : records.length === 0 ? (
        <p>No cost data for this period.</p>
      ) : (
        <>
          <div className={styles.cards}>
            <div className={styles.card}>
              <h3>{CLOUD_PROVIDER_LABELS.aws}</h3>
              <p className={styles.total}>{formatCurrency(awsTotal)}</p>
            </div>
            <div className={styles.card}>
              <h3>{CLOUD_PROVIDER_LABELS.azure}</h3>
              <p className={styles.total}>{formatCurrency(azureTotal)}</p>
            </div>
            <div className={styles.card}>
              <h3>{CLOUD_PROVIDER_LABELS.gcp}</h3>
              <p className={styles.total}>{formatCurrency(gcpTotal)}</p>
            </div>
          </div>

          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={categoryComparison}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="category" />
                <YAxis />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Bar
                  dataKey="aws"
                  name={CLOUD_PROVIDER_LABELS.aws}
                  fill={CLOUD_PROVIDER_COLORS.aws}
                  onClick={(data) => handleCategoryClick(data.category)}
                  cursor={onCategoryClick ? 'pointer' : undefined}
                />
                <Bar
                  dataKey="azure"
                  name={CLOUD_PROVIDER_LABELS.azure}
                  fill={CLOUD_PROVIDER_COLORS.azure}
                  onClick={(data) => handleCategoryClick(data.category)}
                  cursor={onCategoryClick ? 'pointer' : undefined}
                />
                <Bar
                  dataKey="gcp"
                  name={CLOUD_PROVIDER_LABELS.gcp}
                  fill={CLOUD_PROVIDER_COLORS.gcp}
                  onClick={(data) => handleCategoryClick(data.category)}
                  cursor={onCategoryClick ? 'pointer' : undefined}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>Category</th>
                <th>{CLOUD_PROVIDER_LABELS.aws}</th>
                <th>{CLOUD_PROVIDER_LABELS.azure}</th>
                <th>{CLOUD_PROVIDER_LABELS.gcp}</th>
              </tr>
            </thead>
            <tbody>
              {categoryComparison.map((row) => (
                <tr key={row.category}>
                  <td>{row.category}</td>
                  <td>{formatCurrency(row.aws)}</td>
                  <td>{formatCurrency(row.azure)}</td>
                  <td>{formatCurrency(row.gcp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
