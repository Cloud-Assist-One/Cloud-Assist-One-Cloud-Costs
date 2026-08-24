'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResourceGrid, ResourceLegend } from './ResourceGrid';
import type { AwsIamUsersResponse, IamUserRow } from '@/lib/types';
import styles from './AwsIamUsersTab.module.css';

interface AwsIamUsersTabProps {
  companyId: string;
}

export default function AwsIamUsersTab({ companyId }: AwsIamUsersTabProps) {
  const [response, setResponse] = useState<AwsIamUsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const res = await fetch(`/api/aws/iam-users?companyId=${companyId}`);
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error ?? 'Could not load IAM users.');
    }
    return body as AwsIamUsersResponse;
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await loadUsers();
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
  }, [loadUsers]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadUsers();
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

  if (!response?.connected) {
    return <p>AWS isn&apos;t connected yet. Add your AWS access key in the Settings tab to see IAM users.</p>;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
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
          { header: 'Path', render: (r) => r.path },
          { header: 'Created', render: (r) => r.createDate ?? '—' },
          { header: 'Password last used', render: (r) => r.passwordLastUsed ?? '—' },
          { header: 'ARN', render: (r) => r.arn },
        ]}
      />
    </div>
  );
}
