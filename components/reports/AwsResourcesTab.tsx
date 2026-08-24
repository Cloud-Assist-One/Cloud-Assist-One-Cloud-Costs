'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getResourceAgeColor } from '@/lib/resourceAge';
import type {
  AwsResourceResult,
  AwsResourcesResponse,
  Ec2InstanceRow,
  LambdaFunctionRow,
  EcsServiceRow,
  RdsInstanceRow,
  DynamoTableRow,
  ApiRow,
  S3BucketRow,
} from '@/lib/types';
import styles from './AwsResourcesTab.module.css';

interface AwsResourcesTabProps {
  companyId: string;
}

const AGE_ROW_CLASS = {
  orange: styles.rowOrange,
  blue: styles.rowBlue,
  green: styles.rowGreen,
} as const;

function Grid<T extends object>({
  title,
  emptyLabel,
  result,
  columns,
  getCreatedAt,
}: {
  title: string;
  emptyLabel: string;
  result: AwsResourceResult<T>;
  columns: { header: string; render: (row: T) => React.ReactNode; align?: 'right' }[];
  getCreatedAt: (row: T) => string | null;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3>{title}</h3>
        {result.data.length > 0 && <span className={styles.countBadge}>{result.data.length}</span>}
      </div>
      {result.error && (
        <p role="alert" className={styles.error}>
          {result.error}
        </p>
      )}
      {result.data.length === 0 ? (
        <p>{emptyLabel}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.header} className={col.align === 'right' ? styles.numeric : undefined}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.data.map((row, index) => {
              const ageColor = getResourceAgeColor(getCreatedAt(row));
              return (
                <tr key={index} className={ageColor ? AGE_ROW_CLASS[ageColor] : undefined}>
                  {columns.map((col) => (
                    <td key={col.header} className={col.align === 'right' ? styles.numeric : undefined}>
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function AwsResourcesTab({ companyId }: AwsResourcesTabProps) {
  const [response, setResponse] = useState<AwsResourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadResources = useCallback(async () => {
    const res = await fetch(`/api/aws/resources?companyId=${companyId}`);
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error ?? 'Could not load AWS resources.');
    }
    return body as AwsResourcesResponse;
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await loadResources();
        if (!cancelled) {
          setResponse(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load AWS resources.');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [loadResources]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadResources();
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load AWS resources.');
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
    return <p>AWS isn&apos;t connected yet. Add your AWS access key in the Settings tab to see live resources.</p>;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.fetchedAt}>
          Region {response.region} — last refreshed {new Date(response.fetchedAt).toLocaleTimeString()}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <div className={styles.legend}>
        <span className={`${styles.legendSwatch} ${styles.rowOrange}`} /> New in the last 24 hours
        <span className={`${styles.legendSwatch} ${styles.rowBlue}`} /> New in the last week
        <span className={`${styles.legendSwatch} ${styles.rowGreen}`} /> New in the last month
      </div>

      <Grid<Ec2InstanceRow>
        title="EC2 Instances"
        emptyLabel="No EC2 instances found."
        result={response.ec2}
        getCreatedAt={(r) => r.launchTime}
        columns={[
          { header: 'Instance ID', render: (r) => r.instanceId },
          { header: 'Name', render: (r) => r.name ?? '—' },
          { header: 'Type', render: (r) => r.instanceType },
          { header: 'State', render: (r) => r.state },
          { header: 'AZ', render: (r) => r.availabilityZone ?? '—' },
          { header: 'Private IP', render: (r) => r.privateIp ?? '—' },
          { header: 'Public IP', render: (r) => r.publicIp ?? '—' },
        ]}
      />

      <Grid<LambdaFunctionRow>
        title="Lambda Functions"
        emptyLabel="No Lambda functions found."
        result={response.lambda}
        getCreatedAt={(r) => r.lastModified}
        columns={[
          { header: 'Function name', render: (r) => r.functionName },
          { header: 'Runtime', render: (r) => r.runtime ?? '—' },
          { header: 'Memory (MB)', render: (r) => r.memorySize ?? '—', align: 'right' },
          { header: 'Timeout (s)', render: (r) => r.timeout ?? '—', align: 'right' },
          { header: 'Last modified', render: (r) => r.lastModified ?? '—' },
        ]}
      />

      <Grid<EcsServiceRow>
        title="ECS Containers"
        emptyLabel="No ECS services found."
        result={response.ecs}
        getCreatedAt={(r) => r.createdAt}
        columns={[
          { header: 'Cluster', render: (r) => r.cluster },
          { header: 'Service', render: (r) => r.serviceName },
          { header: 'Desired count', render: (r) => r.desiredCount, align: 'right' },
          { header: 'Running count', render: (r) => r.runningCount, align: 'right' },
          { header: 'Launch type', render: (r) => r.launchType ?? '—' },
        ]}
      />

      <Grid<RdsInstanceRow>
        title="RDS Instances"
        emptyLabel="No RDS instances found."
        result={response.rds}
        getCreatedAt={(r) => r.instanceCreateTime}
        columns={[
          { header: 'DB identifier', render: (r) => r.dbInstanceIdentifier },
          { header: 'Engine', render: (r) => r.engine },
          { header: 'Instance class', render: (r) => r.dbInstanceClass },
          { header: 'Status', render: (r) => r.status },
          { header: 'Multi-AZ', render: (r) => (r.multiAz ? 'Yes' : 'No') },
          { header: 'Storage (GB)', render: (r) => r.allocatedStorage, align: 'right' },
        ]}
      />

      <Grid<DynamoTableRow>
        title="DynamoDB Tables"
        emptyLabel="No DynamoDB tables found."
        result={response.dynamodb}
        getCreatedAt={(r) => r.creationDateTime}
        columns={[{ header: 'Table name', render: (r) => r.tableName }]}
      />

      <Grid<ApiRow>
        title="APIs"
        emptyLabel="No APIs found."
        result={response.apis}
        getCreatedAt={(r) => r.createdDate}
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'ID', render: (r) => r.id },
          { header: 'Type', render: (r) => r.type },
          { header: 'Created', render: (r) => r.createdDate ?? '—' },
          { header: 'Endpoint', render: (r) => r.endpoint ?? '—' },
        ]}
      />

      <Grid<S3BucketRow>
        title="S3 Buckets"
        emptyLabel="No S3 buckets found."
        result={response.s3}
        getCreatedAt={(r) => r.creationDate}
        columns={[
          { header: 'Bucket name', render: (r) => r.name },
          { header: 'Created', render: (r) => r.creationDate ?? '—' },
        ]}
      />
    </div>
  );
}
