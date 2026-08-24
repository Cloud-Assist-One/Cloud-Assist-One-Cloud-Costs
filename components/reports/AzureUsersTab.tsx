'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResourceGrid, ResourceLegend } from './ResourceGrid';
import type { AzureCredentialSummary, AzureAdUsersResponse, AzureAdUserRow } from '@/lib/types';
import styles from './AzureUsersTab.module.css';

interface AzureUsersTabProps {
  companyId: string;
}

export default function AzureUsersTab({ companyId }: AzureUsersTabProps) {
  const [connections, setConnections] = useState<AzureCredentialSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [response, setResponse] = useState<AzureAdUsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(
    async (credentialId: string) => {
      const res = await fetch(`/api/azure/ad-users?companyId=${companyId}&credentialId=${credentialId}`);
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? 'Could not load Azure AD users.');
      }
      return body as AzureAdUsersResponse;
    },
    [companyId]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const listRes = await fetch(`/api/settings/azure-credentials?companyId=${companyId}`);
        const listBody = await listRes.json();
        const list = (listBody.connections ?? []) as AzureCredentialSummary[];
        if (cancelled) return;
        setConnections(list);

        if (list.length === 0) {
          setLoading(false);
          return;
        }

        const firstId = list[0].id;
        setSelectedId(firstId);
        const result = await loadUsers(firstId);
        if (!cancelled) {
          setResponse(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load Azure AD users.');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadUsers]);

  async function handleSelectConnection(id: string) {
    setSelectedId(id);
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadUsers(id);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Azure AD users.');
    }
    setRefreshing(false);
  }

  async function handleRefresh() {
    if (!selectedId) return;
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadUsers(selectedId);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Azure AD users.');
    }
    setRefreshing(false);
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
    return <p>Azure isn&apos;t connected yet. Add your Azure connection in the Settings tab to see Azure AD users.</p>;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div className={styles.accountPicker}>
          <label htmlFor="azure-users-account-picker">Account</label>
          <select
            id="azure-users-account-picker"
            value={selectedId ?? ''}
            onChange={(e) => handleSelectConnection(e.target.value)}
            disabled={refreshing}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.fetchedAt}>Last refreshed {new Date(response.fetchedAt).toLocaleTimeString()}</span>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <ResourceLegend />

      <ResourceGrid<AzureAdUserRow>
        title="Azure AD Users"
        emptyLabel="No Azure AD users found."
        result={response.users}
        getCreatedAt={(r) => r.createdDateTime}
        getName={(r) => r.displayName ?? r.userPrincipalName ?? r.id}
        resourceType="Azure AD user"
        columns={[
          { header: 'Display name', render: (r) => r.displayName ?? '—' },
          { header: 'User principal name', render: (r) => r.userPrincipalName ?? '—' },
          { header: 'Created', render: (r) => r.createdDateTime ?? '—' },
        ]}
      />
    </div>
  );
}
