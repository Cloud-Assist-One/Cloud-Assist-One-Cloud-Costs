'use client';

import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import type { CloudProvider, CostRecord } from '@/lib/types';
import { aggregateByDate, aggregateByService, totalCost } from '@/lib/reportAggregation';
import { computeDateRange, shiftReferenceDate, type Granularity } from '@/lib/dateRange';
import DateRangePicker from './DateRangePicker';
import styles from './CostReportTab.module.css';

interface CostReportTabProps {
  companyId: string;
  cloudProvider: CloudProvider;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function CostReportTab({ companyId, cloudProvider }: CostReportTabProps) {
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
      const pageSize = 1000;
      const allRows: CostRecord[] = [];
      let offset = 0;

      // PostgREST caps rows per request (commonly 1000), so page through until a
      // short page tells us we've reached the end — otherwise large result sets
      // would be silently truncated.
      for (;;) {
        const { data } = await supabase
          .from('cost_records')
          .select('*')
          .eq('company_id', companyId)
          .eq('cloud_provider', cloudProvider)
          .gte('usage_date', range.start)
          .lte('usage_date', range.end)
          .range(offset, offset + pageSize - 1);

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
  }, [companyId, cloudProvider, range.start, range.end]);

  const byDate = useMemo(() => aggregateByDate(records), [records]);
  const byService = useMemo(() => aggregateByService(records), [records]);
  const total = useMemo(() => totalCost(records), [records]);

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
        <>
          <p className={styles.total}>{formatCurrency(total)}</p>

          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={byDate}>
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="total" stroke="#2258d3" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={byService}>
                <XAxis dataKey="service_name" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="total" fill="#2258d3" />
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
          </table>
        </>
      )}
    </div>
  );
}
