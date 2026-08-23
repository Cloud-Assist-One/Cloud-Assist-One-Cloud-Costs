'use client';

import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import type { CloudProvider } from '@/lib/types';
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import styles from './TrendSidebar.module.css';

interface TrendSidebarProps {
  companyId: string;
}

interface MonthlyTotal {
  month: string;
  cloud_provider: CloudProvider;
  total: number;
}

type MonthlyEntry = { month: string } & Record<CloudProvider, number>;

const PROVIDER_COLORS: Record<CloudProvider, string> = {
  aws: 'var(--primary)',
  azure: 'var(--muted-foreground)',
  gcp: '#22a06b',
  snowflake: '#e08a2e',
};

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function TrendSidebar({ companyId }: TrendSidebarProps) {
  const [rows, setRows] = useState<MonthlyTotal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from('monthly_cost_by_provider')
        .select('*')
        .eq('company_id', companyId)
        .order('month', { ascending: true });
      if (!cancelled) {
        setRows((data ?? []) as MonthlyTotal[]);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const chartData = useMemo(() => {
    const byMonth = new Map<string, MonthlyEntry>();
    for (const row of rows) {
      const entry =
        byMonth.get(row.month) ??
        ({ month: row.month, aws: 0, azure: 0, gcp: 0, snowflake: 0 } as MonthlyEntry);
      entry[row.cloud_provider] = row.total;
      byMonth.set(row.month, entry);
    }
    return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [rows]);

  if (loading) {
    return <p>Loading…</p>;
  }

  if (rows.length === 0) {
    return <p>No trend data yet.</p>;
  }

  return (
    <aside className={styles.wrapper}>
      <h3>12-month trend</h3>
      <div className={styles.chart}>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={chartData}>
            <XAxis dataKey="month" hide />
            <YAxis hide />
            <Tooltip />
            {CLOUD_PROVIDERS.map((provider) => (
              <Line
                key={provider}
                type="monotone"
                dataKey={provider}
                stroke={PROVIDER_COLORS[provider]}
                name={CLOUD_PROVIDER_LABELS[provider]}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className={styles.list}>
        {chartData.map((entry) => (
          <li key={entry.month}>
            <span>{entry.month}</span>
            {CLOUD_PROVIDERS.map((provider) => (
              <div key={provider}>
                {CLOUD_PROVIDER_LABELS[provider]} <span>{formatCurrency(entry[provider])}</span>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </aside>
  );
}
