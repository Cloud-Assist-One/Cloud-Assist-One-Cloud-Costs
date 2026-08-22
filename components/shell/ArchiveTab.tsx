'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { BillingPeriod } from '@/lib/types';
import styles from './ArchiveTab.module.css';

interface ArchiveTabProps {
  companyId: string;
  onSelectPeriod: (periodId: string) => void;
}

export default function ArchiveTab({ companyId, onSelectPeriod }: ArchiveTabProps) {
  const [periods, setPeriods] = useState<(BillingPeriod & { label: string })[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const supabase = createClient();
      const { data: archivedPeriods } = await supabase
        .from('billing_periods')
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'archived')
        .order('archived_at', { ascending: false });

      const periodsWithLabels = await Promise.all(
        (archivedPeriods ?? []).map(async (period: BillingPeriod) => {
          const { data: range } = await supabase
            .from('cost_records')
            .select('usage_date')
            .eq('period_id', period.id)
            .order('usage_date', { ascending: true })
            .limit(1)
            .maybeSingle();
          const { data: rangeEnd } = await supabase
            .from('cost_records')
            .select('usage_date')
            .eq('period_id', period.id)
            .order('usage_date', { ascending: false })
            .limit(1)
            .maybeSingle();

          const label =
            range && rangeEnd
              ? range.usage_date === rangeEnd.usage_date
                ? range.usage_date
                : `${range.usage_date} – ${rangeEnd.usage_date}`
              : 'No data';

          return { ...period, label };
        })
      );

      if (!cancelled) {
        setPeriods(periodsWithLabels);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (loading) {
    return <p>Loading…</p>;
  }

  if (periods.length === 0) {
    return <p>No archived periods yet.</p>;
  }

  return (
    <ul className={styles.list}>
      {periods.map((period) => (
        <li key={period.id}>
          <button type="button" onClick={() => onSelectPeriod(period.id)}>
            {period.label}
          </button>
          <span className={styles.archivedAt}>
            Archived {period.archived_at ? new Date(period.archived_at).toLocaleDateString() : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
