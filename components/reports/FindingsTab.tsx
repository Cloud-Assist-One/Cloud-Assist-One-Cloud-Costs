'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import FindingsGrid from './FindingsGrid';
import type { FindingsResponse } from '@/lib/types';
import styles from './FindingsTab.module.css';

interface ConnectionSummary {
  id: string;
  label: string;
}

interface FindingsTabProps {
  companyId: string;
  periodId: string | null;
  provider: 'aws' | 'azure';
  kind: 'security-checks' | 'cost-leakage';
}

const PROVIDER_LABEL = { aws: 'AWS', azure: 'Azure' } as const;

export default function FindingsTab({ companyId, periodId, provider, kind }: FindingsTabProps) {
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [response, setResponse] = useState<FindingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerLabel = PROVIDER_LABEL[provider];

  const loadFindings = useCallback(
    async (credentialId: string) => {
      // The cost join needs a period; the security routes ignore it, so it
      // is only sent when there is one to send.
      const periodParam = periodId ? `&periodId=${periodId}` : '';
      const res = await fetch(`/api/${provider}/${kind}?companyId=${companyId}&credentialId=${credentialId}${periodParam}`);
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? `Could not load ${providerLabel} findings.`);
      }
      return body as FindingsResponse;
    },
    [companyId, kind, periodId, provider, providerLabel]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const listRes = await fetch(`/api/settings/${provider}-credentials?companyId=${companyId}`);
        const listBody = await listRes.json();
        const list = (listBody.connections ?? []) as ConnectionSummary[];
        if (cancelled) return;
        setConnections(list);

        if (list.length === 0) {
          setLoading(false);
          return;
        }

        const firstId = list[0].id;
        setSelectedId(firstId);
        const result = await loadFindings(firstId);
        if (!cancelled) {
          setResponse(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : `Could not load ${providerLabel} findings.`);
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadFindings, provider, providerLabel]);

  async function refetch(credentialId: string) {
    setRefreshing(true);
    setError(null);
    try {
      setResponse(await loadFindings(credentialId));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not load ${providerLabel} findings.`);
    }
    setRefreshing(false);
  }

  async function handleSelectConnection(id: string) {
    setSelectedId(id);
    await refetch(id);
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  if (error) {
    return (
      <p role="alert" className={styles.error}>
        {error}
      </p>
    );
  }

  if (!connections || connections.length === 0 || !response?.connected) {
    return (
      <p>
        {providerLabel} isn&apos;t connected yet. Add your {providerLabel} credentials in the Settings tab to see live
        findings.
      </p>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div className={styles.accountPicker}>
          <label htmlFor={`${provider}-${kind}-account-picker`}>Account</label>
          <select
            id={`${provider}-${kind}-account-picker`}
            value={selectedId ?? ''}
            disabled={refreshing}
            onChange={(e) => handleSelectConnection(e.target.value)}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.fetchedAt}>
          {response.region ? `Region ${response.region} — ` : ''}last refreshed{' '}
          {new Date(response.fetchedAt).toLocaleTimeString()}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => selectedId && refetch(selectedId)}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <FindingsGrid checks={response.checks} kind={kind} />
    </div>
  );
}
