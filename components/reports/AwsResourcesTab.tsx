'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
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

function Grid<T extends object>({
  title,
  emptyLabel,
  result,
  columns,
}: {
  title: string;
  emptyLabel: string;
  result: AwsResourceResult<T>;
  columns: { header: string; render: (row: T) => React.ReactNode }[];
}) {
  return (
    <section className={styles.section}>
      <h3>{title}</h3>
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
                <th key={col.header}>{col.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.data.map((row, index) => (
              <tr key={index}>
                {columns.map((col) => (
                  <td key={col.header}>{col.render(row)}</td>
                ))}
              </tr>
            ))}
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

      <Grid<Ec2InstanceRow>
        title="EC2 Instances"
        emptyLabel="No EC2 instances found."
        result={response.ec2}
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
        columns={[
          { header: 'Function name', render: (r) => r.functionName },
          { header: 'Runtime', render: (r) => r.runtime ?? '—' },
          { header: 'Memory (MB)', render: (r) => r.memorySize ?? '—' },
          { header: 'Timeout (s)', render: (r) => r.timeout ?? '—' },
          { header: 'Last modified', render: (r) => r.lastModified ?? '—' },
        ]}
      />

      <Grid<EcsServiceRow>
        title="ECS Containers"
        emptyLabel="No ECS services found."
        result={response.ecs}
        columns={[
          { header: 'Cluster', render: (r) => r.cluster },
          { header: 'Service', render: (r) => r.serviceName },
          { header: 'Desired count', render: (r) => r.desiredCount },
          { header: 'Running count', render: (r) => r.runningCount },
          { header: 'Launch type', render: (r) => r.launchType ?? '—' },
        ]}
      />

      <Grid<RdsInstanceRow>
        title="RDS Instances"
        emptyLabel="No RDS instances found."
        result={response.rds}
        columns={[
          { header: 'DB identifier', render: (r) => r.dbInstanceIdentifier },
          { header: 'Engine', render: (r) => r.engine },
          { header: 'Instance class', render: (r) => r.dbInstanceClass },
          { header: 'Status', render: (r) => r.status },
          { header: 'Multi-AZ', render: (r) => (r.multiAz ? 'Yes' : 'No') },
          { header: 'Storage (GB)', render: (r) => r.allocatedStorage },
        ]}
      />

      <Grid<DynamoTableRow>
        title="DynamoDB Tables"
        emptyLabel="No DynamoDB tables found."
        result={response.dynamodb}
        columns={[{ header: 'Table name', render: (r) => r.tableName }]}
      />

      <Grid<ApiRow>
        title="APIs"
        emptyLabel="No APIs found."
        result={response.apis}
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
        columns={[
          { header: 'Bucket name', render: (r) => r.name },
          { header: 'Created', render: (r) => r.creationDate ?? '—' },
        ]}
      />
    </div>
  );
}
