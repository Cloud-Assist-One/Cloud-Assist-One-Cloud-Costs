'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResourceGrid, ResourceLegend, tagColumn } from './ResourceGrid';
import type { AwsCredentialSummary, AwsIamUsersResponse, IamUserRow } from '@/lib/types';
import styles from './AwsIamUsersTab.module.css';

interface AwsIamUsersTabProps {
  companyId: string;
}

export default function AwsIamUsersTab({ companyId }: AwsIamUsersTabProps) {
  const [connections, setConnections] = useState<AwsCredentialSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [response, setResponse] = useState<AwsIamUsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(
    async (credentialId: string) => {
      const res = await fetch(`/api/aws/iam-users?companyId=${companyId}&credentialId=${credentialId}`);
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? 'Could not load IAM users.');
      }
      return body as AwsIamUsersResponse;
    },
    [companyId]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const listRes = await fetch(`/api/settings/aws-credentials?companyId=${companyId}`);
        const listBody = await listRes.json();
        const list = (listBody.connections ?? []) as AwsCredentialSummary[];
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
          setError(err instanceof Error ? err.message : 'Could not load IAM users.');
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
      setError(err instanceof Error ? err.message : 'Could not load IAM users.');
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
      setError(err instanceof Error ? err.message : 'Could not load IAM users.');
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
    return <p>AWS isn&apos;t connected yet. Add your AWS access key in the Settings tab to see IAM users.</p>;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div className={styles.accountPicker}>
          <label htmlFor="iam-account-picker">Account</label>
          <select
            id="iam-account-picker"
            value={selectedId ?? ''}
            disabled={refreshing}
            onChange={(e) => handleSelectConnection(e.target.value)}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.fetchedAt}>
          Last refreshed {new Date(response.fetchedAt).toLocaleTimeString()}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <ResourceLegend />

      <ResourceGrid<IamUserRow>
        title="IAM Users"
        emptyLabel="No IAM users found."
        result={response.users}
        getCreatedAt={(r) => r.createDate}
        getName={(r) => r.userName}
        resourceType="IAM user"
        columns={[
          { header: 'User name', render: (r) => r.userName },
          { header: 'User ID', render: (r) => r.userId },
          { header: 'Created', render: (r) => r.createDate ?? '—' },
          { header: 'Password last used', render: (r) => r.passwordLastUsed ?? '—' },
          ...tagColumn<IamUserRow>(response.tagKey),
        ]}
      />
    </div>
  );
}
