'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResourceGrid, ResourceLegend } from './ResourceGrid';
import type {
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

      <ResourceLegend />

      <ResourceGrid<Ec2InstanceRow>
        title="EC2 Instances"
        emptyLabel="No EC2 instances found."
        result={response.ec2}
        getCreatedAt={(r) => r.launchTime}
        getName={(r) => r.name ?? r.instanceId}
        resourceType="EC2 instance"
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

      <ResourceGrid<LambdaFunctionRow>
        title="Lambda Functions"
        emptyLabel="No Lambda functions found."
        result={response.lambda}
        getCreatedAt={(r) => r.lastModified}
        getName={(r) => r.functionName}
        resourceType="Lambda function"
        columns={[
          { header: 'Function name', render: (r) => r.functionName },
          { header: 'Runtime', render: (r) => r.runtime ?? '—' },
          { header: 'Memory (MB)', render: (r) => r.memorySize ?? '—', align: 'right' },
          { header: 'Timeout (s)', render: (r) => r.timeout ?? '—', align: 'right' },
          { header: 'Last modified', render: (r) => r.lastModified ?? '—' },
        ]}
      />

      <ResourceGrid<EcsServiceRow>
        title="ECS Containers"
        emptyLabel="No ECS services found."
        result={response.ecs}
        getCreatedAt={(r) => r.createdAt}
        getName={(r) => r.serviceName}
        resourceType="ECS service"
        columns={[
          { header: 'Cluster', render: (r) => r.cluster },
          { header: 'Service', render: (r) => r.serviceName },
          { header: 'Desired count', render: (r) => r.desiredCount, align: 'right' },
          { header: 'Running count', render: (r) => r.runningCount, align: 'right' },
          { header: 'Launch type', render: (r) => r.launchType ?? '—' },
        ]}
      />

      <ResourceGrid<RdsInstanceRow>
        title="RDS Instances"
        emptyLabel="No RDS instances found."
        result={response.rds}
        getCreatedAt={(r) => r.instanceCreateTime}
        getName={(r) => r.dbInstanceIdentifier}
        resourceType="RDS instance"
        columns={[
          { header: 'DB identifier', render: (r) => r.dbInstanceIdentifier },
          { header: 'Engine', render: (r) => r.engine },
          { header: 'Instance class', render: (r) => r.dbInstanceClass },
          { header: 'Status', render: (r) => r.status },
          { header: 'Multi-AZ', render: (r) => (r.multiAz ? 'Yes' : 'No') },
          { header: 'Storage (GB)', render: (r) => r.allocatedStorage, align: 'right' },
        ]}
      />

      <ResourceGrid<DynamoTableRow>
        title="DynamoDB Tables"
        emptyLabel="No DynamoDB tables found."
        result={response.dynamodb}
        getCreatedAt={(r) => r.creationDateTime}
        getName={(r) => r.tableName}
        resourceType="DynamoDB table"
        columns={[{ header: 'Table name', render: (r) => r.tableName }]}
      />

      <ResourceGrid<ApiRow>
        title="APIs"
        emptyLabel="No APIs found."
        result={response.apis}
        getCreatedAt={(r) => r.createdDate}
        getName={(r) => r.name}
        resourceType="API"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'ID', render: (r) => r.id },
          { header: 'Type', render: (r) => r.type },
          { header: 'Created', render: (r) => r.createdDate ?? '—' },
          { header: 'Endpoint', render: (r) => r.endpoint ?? '—' },
        ]}
      />

      <ResourceGrid<S3BucketRow>
        title="S3 Buckets"
        emptyLabel="No S3 buckets found."
        result={response.s3}
        getCreatedAt={(r) => r.creationDate}
        getName={(r) => r.name}
        resourceType="S3 bucket"
        columns={[
          { header: 'Bucket name', render: (r) => r.name },
          { header: 'Created', render: (r) => r.creationDate ?? '—' },
        ]}
      />
    </div>
  );
}
