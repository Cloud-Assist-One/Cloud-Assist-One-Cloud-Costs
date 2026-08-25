'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import type { CloudProvider, CostRecord } from '@/lib/types';
import { aggregateByDate, aggregateByService, totalCost } from '@/lib/reportAggregation';
import { formatBillingMonth } from '@/lib/cloudProvider';
import PullBillingModal from './PullBillingModal';
import styles from './CostReportTab.module.css';

interface CostReportTabProps {
  companyId: string;
  cloudProvider: CloudProvider;
  periodId: string;
  isReadOnly?: boolean;
  onServiceClick?: (serviceName: string) => void;
  onPeriodArchived?: (newPeriodId: string) => void;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function CostReportTab({
  companyId,
  cloudProvider,
  periodId,
  isReadOnly,
  onServiceClick,
  onPeriodArchived,
}: CostReportTabProps) {
  const [records, setRecords] = useState<CostRecord[]>([]);
  const [billingMonth, setBillingMonth] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPullBillingModal, setShowPullBillingModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadBillingMonth() {
      const supabase = createClient();
      const { data } = await supabase
        .from('uploaded_files')
        .select('billing_month')
        .eq('company_id', companyId)
        .eq('cloud_provider', cloudProvider)
        .eq('period_id', periodId)
        .eq('status', 'processed')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) {
        setBillingMonth(data?.billing_month ?? null);
      }
    }

    loadBillingMonth();
    return () => {
      cancelled = true;
    };
  }, [companyId, cloudProvider, periodId, refreshKey]);

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
          .eq('cloud_provider', cloudProvider)
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
  }, [companyId, cloudProvider, periodId, refreshKey]);

  const handlePulled = useCallback(
    (result: { rowCount: number; newPeriodId?: string }) => {
      setRefreshKey((k) => k + 1);
      if (result.newPeriodId) {
        onPeriodArchived?.(result.newPeriodId);
      }
    },
    [onPeriodArchived]
  );

  const byDate = useMemo(() => aggregateByDate(records), [records]);
  const byService = useMemo(() => aggregateByService(records), [records]);
  const total = useMemo(() => totalCost(records), [records]);

  // Only these two providers have a billing API integration behind them; GCP
  // and Snowflake are still upload-only. Declared as a const so TypeScript
  // narrows cloudProvider to the modal's accepted union where it's used.
  const canPullBilling = cloudProvider === 'aws' || cloudProvider === 'azure';

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.actionsBar} print-hidden`}>
        {canPullBilling && !isReadOnly && (
          <button type="button" onClick={() => setShowPullBillingModal(true)}>
            Pull Billing
          </button>
        )}
        <button type="button" onClick={() => window.print()}>
          Print
        </button>
      </div>

      {showPullBillingModal && canPullBilling && (
        <PullBillingModal
          companyId={companyId}
          provider={cloudProvider}
          onClose={() => setShowPullBillingModal(false)}
          onPulled={handlePulled}
        />
      )}

      {billingMonth && <p className={styles.billingMonth}>Billing month: {formatBillingMonth(billingMonth)}</p>}

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
          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={byDate}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Line type="monotone" dataKey="total" name="Daily total" stroke="var(--primary)" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={byService}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="service_name" />
                <YAxis />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Bar
                  dataKey="total"
                  name="Cost by service"
                  fill="var(--primary)"
                  onClick={(data) => onServiceClick?.(data.service_name)}
                  cursor={onServiceClick ? 'pointer' : undefined}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>Service</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {byService.map((row) => (
                <tr key={row.service_name}>
                  <td>{row.service_name}</td>
                  <td>{formatCurrency(row.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td>{formatCurrency(total)}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}
