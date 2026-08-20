'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { CostRecord } from '@/lib/types';
import { totalCost } from '@/lib/reportAggregation';
import { computeDateRange, shiftReferenceDate, type Granularity } from '@/lib/dateRange';
import DateRangePicker from './DateRangePicker';
import styles from './CompareTab.module.css';

interface CompareTabProps {
  companyId: string;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function CompareTab({ companyId }: CompareTabProps) {
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [referenceDate, setReferenceDate] = useState(() => new Date());
  const [records, setRecords] = useState<CostRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => computeDateRange(granularity, referenceDate), [granularity, referenceDate]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from('cost_records')
        .select('*')
        .eq('company_id', companyId)
        .gte('usage_date', range.start)
        .lte('usage_date', range.end);

      if (!cancelled) {
        setRecords(data ?? []);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, range.start, range.end]);

  const awsRecords = useMemo(() => records.filter((r) => r.cloud_provider === 'aws'), [records]);
  const azureRecords = useMemo(() => records.filter((r) => r.cloud_provider === 'azure'), [records]);
  const awsTotal = useMemo(() => totalCost(awsRecords), [awsRecords]);
  const azureTotal = useMemo(() => totalCost(azureRecords), [azureRecords]);

  return (
    <div className={styles.wrapper}>
      <DateRangePicker
        granularity={granularity}
        onGranularityChange={setGranularity}
        rangeLabel={`${range.start} – ${range.end}`}
        onPrev={() => setReferenceDate((prev) => shiftReferenceDate(granularity, prev, -1))}
        onNext={() => setReferenceDate((prev) => shiftReferenceDate(granularity, prev, 1))}
      />

      {loading ? (
        <p>Loading…</p>
      ) : records.length === 0 ? (
        <p>No cost data for this range.</p>
      ) : (
        <div className={styles.cards}>
          <div className={styles.card}>
            <h3>AWS</h3>
            <p className={styles.total}>{formatCurrency(awsTotal)}</p>
          </div>
          <div className={styles.card}>
            <h3>Azure</h3>
            <p className={styles.total}>{formatCurrency(azureTotal)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
