'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { SupportRequestWithCompany } from '@/lib/types';
import SupportRequestsGrid from './SupportRequestsGrid';
import styles from './Support.module.css';

// Admin-only view of every client's support requests.
export default function SupportRequestsTab() {
  const [requests, setRequests] = useState<SupportRequestWithCompany[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadRequests() {
      try {
        const res = await fetch('/api/support-requests?scope=all');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? 'Could not load support requests.');
          return;
        }
        setRequests(body.requests ?? []);
        setError(null);
      } catch {
        if (!cancelled) setError('Could not load support requests.');
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    }

    loadRequests();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  function handleRefresh() {
    setRefreshing(true);
    setReloadToken((token) => token + 1);
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h2>Support requests</h2>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : requests === null ? (
        <p>Loading…</p>
      ) : (
        <SupportRequestsGrid requests={requests} showCompany emptyLabel="No support requests have been submitted yet." />
      )}
    </div>
  );
}
