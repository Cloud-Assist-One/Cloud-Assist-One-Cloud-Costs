'use client';

import { useCallback, useEffect, useState } from 'react';
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPeriods = useCallback(async (): Promise<(BillingPeriod & { label: string })[]> => {
    const supabase = createClient();
    const { data: archivedPeriods } = await supabase
      .from('billing_periods')
      .select('*')
      .eq('company_id', companyId)
      .eq('status', 'archived')
      .order('archived_at', { ascending: false });

    return Promise.all(
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
  }, [companyId]);

  const loadPeriods = useCallback(async () => {
    const periodsWithLabels = await fetchPeriods();
    setPeriods(periodsWithLabels);
    setLoading(false);
  }, [fetchPeriods]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const periodsWithLabels = await fetchPeriods();
      if (!cancelled) {
        setPeriods(periodsWithLabels);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [fetchPeriods]);

  function startDelete(periodId: string) {
    setDeletingId(periodId);
    setConfirmText('');
    setError(null);
  }

  function cancelDelete() {
    setDeletingId(null);
    setConfirmText('');
  }

  async function confirmDelete(periodId: string) {
    if (confirmText !== 'DELETE') return;
    setDeleting(true);
    setError(null);
    const response = await fetch(`/api/periods/${periodId}`, { method: 'DELETE' });
    const body = await response.json();
    setDeleting(false);
    if (!response.ok) {
      setError(body.error ?? 'Could not delete this period.');
      return;
    }
    setDeletingId(null);
    setConfirmText('');
    loadPeriods();
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  return (
    <div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {periods.length === 0 ? (
        <p>No archived periods yet.</p>
      ) : (
        <ul className={styles.list}>
          {periods.map((period) => (
            <li key={period.id}>
              <button type="button" onClick={() => onSelectPeriod(period.id)}>
                {period.label}
              </button>
              <span className={styles.archivedAt}>
                Archived {period.archived_at ? new Date(period.archived_at).toLocaleDateString() : ''}
              </span>
              {deletingId === period.id ? (
                <div className={styles.confirmDelete}>
                  <label htmlFor={`confirm-delete-${period.id}`}>
                    Type &quot;DELETE&quot; to permanently delete this archived report and all its data
                  </label>
                  <input
                    id={`confirm-delete-${period.id}`}
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.deleteButton}
                    disabled={confirmText !== 'DELETE' || deleting}
                    onClick={() => confirmDelete(period.id)}
                  >
                    {deleting ? 'Deleting…' : 'Confirm delete'}
                  </button>
                  <button type="button" onClick={cancelDelete}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" className={styles.deleteButton} onClick={() => startDelete(period.id)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
