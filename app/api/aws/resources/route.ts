import { NextRequest, NextResponse } from 'next/server';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayClient, GetRestApisCommand } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client, GetApisCommand } from '@aws-sdk/client-apigatewayv2';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
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

// ECS's DescribeServicesCommand accepts at most 10 service ARNs per call.
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const credentialId = request.nextUrl.searchParams.get('credentialId');
  if (!companyId || !credentialId) {
    return NextResponse.json({ error: 'companyId and credentialId are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data: credRow, error: credError } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .eq('id', credentialId)
    .maybeSingle();

  if (credError) {
    console.error('Failed to look up AWS credentials:', credError);
    return NextResponse.json({ error: 'Could not look up the AWS connection.' }, { status: 500 });
  }

  if (!credRow) {
    return NextResponse.json({ connected: false } satisfies AwsResourcesResponse);
  }

  let secrets: { accessKeyId: string; secretAccessKey: string };
  try {
    secrets = decryptCredentials(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt AWS credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored AWS credentials.' }, { status: 500 });
  }

  const region = credRow.region ?? 'us-east-1';
  const clientConfig = {
    region,
    credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
  };

  async function fetchEc2(): Promise<AwsResourceResult<Ec2InstanceRow>> {
    try {
      const client = new EC2Client(clientConfig);
      const result = await client.send(new DescribeInstancesCommand({}));
      const rows: Ec2InstanceRow[] = [];
      for (const reservation of result.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const nameTag = instance.Tags?.find((tag) => tag.Key === 'Name');
          rows.push({
            instanceId: instance.InstanceId ?? '',
            name: nameTag?.Value ?? null,
            instanceType: instance.InstanceType ?? '',
            state: instance.State?.Name ?? '',
            availabilityZone: instance.Placement?.AvailabilityZone ?? null,
            privateIp: instance.PrivateIpAddress ?? null,
            publicIp: instance.PublicIpAddress ?? null,
            launchTime: instance.LaunchTime ? new Date(instance.LaunchTime).toISOString() : null,
          });
        }
      }
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchLambda(): Promise<AwsResourceResult<LambdaFunctionRow>> {
    try {
      const client = new LambdaClient(clientConfig);
      const result = await client.send(new ListFunctionsCommand({}));
      const rows = (result.Functions ?? []).map((fn) => ({
        functionName: fn.FunctionName ?? '',
        runtime: fn.Runtime ?? null,
        memorySize: fn.MemorySize ?? null,
        timeout: fn.Timeout ?? null,
        lastModified: fn.LastModified ?? null,
      }));
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchEcs(): Promise<AwsResourceResult<EcsServiceRow>> {
    try {
      const client = new ECSClient(clientConfig);
      const clustersResult = await client.send(new ListClustersCommand({}));
      const rows: EcsServiceRow[] = [];
      for (const clusterArn of clustersResult.clusterArns ?? []) {
        const servicesResult = await client.send(new ListServicesCommand({ cluster: clusterArn }));
        const serviceArns = servicesResult.serviceArns ?? [];
        for (const batch of chunk(serviceArns, 10)) {
          if (batch.length === 0) continue;
          const describeResult = await client.send(
            new DescribeServicesCommand({ cluster: clusterArn, services: batch })
          );
          for (const service of describeResult.services ?? []) {
            rows.push({
              cluster: clusterArn.split('/').pop() ?? clusterArn,
              serviceName: service.serviceName ?? '',
              desiredCount: service.desiredCount ?? 0,
              runningCount: service.runningCount ?? 0,
              launchType: service.launchType ?? null,
              createdAt: service.createdAt ? new Date(service.createdAt).toISOString() : null,
            });
          }
        }
      }
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchRds(): Promise<AwsResourceResult<RdsInstanceRow>> {
    try {
      const client = new RDSClient(clientConfig);
      const result = await client.send(new DescribeDBInstancesCommand({}));
      const rows = (result.DBInstances ?? []).map((db) => ({
        dbInstanceIdentifier: db.DBInstanceIdentifier ?? '',
        engine: db.Engine ?? '',
        dbInstanceClass: db.DBInstanceClass ?? '',
        status: db.DBInstanceStatus ?? '',
        multiAz: db.MultiAZ ?? false,
        allocatedStorage: db.AllocatedStorage ?? 0,
        instanceCreateTime: db.InstanceCreateTime ? new Date(db.InstanceCreateTime).toISOString() : null,
      }));
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchDynamoDb(): Promise<AwsResourceResult<DynamoTableRow>> {
    try {
      const client = new DynamoDBClient(clientConfig);
      const result = await client.send(new ListTablesCommand({}));
      const tableNames = result.TableNames ?? [];
      // A per-table Describe call is needed to get each table's creation
      // date (ListTables returns only names) — run in parallel since this
      // is specifically what the age-based color flag needs.
      const rows = await Promise.all(
        tableNames.map(async (tableName): Promise<DynamoTableRow> => {
          try {
            const describeResult = await client.send(new DescribeTableCommand({ TableName: tableName }));
            const creationDateTime = describeResult.Table?.CreationDateTime;
            return { tableName, creationDateTime: creationDateTime ? new Date(creationDateTime).toISOString() : null };
          } catch {
            return { tableName, creationDateTime: null };
          }
        })
      );
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchApis(): Promise<AwsResourceResult<ApiRow>> {
    const rows: ApiRow[] = [];
    const errors: string[] = [];

    try {
      const client = new APIGatewayClient(clientConfig);
      const result = await client.send(new GetRestApisCommand({}));
      for (const api of result.items ?? []) {
        rows.push({
          id: api.id ?? '',
          name: api.name ?? '',
          type: 'REST',
          createdDate: api.createdDate ? new Date(api.createdDate).toISOString() : null,
          endpoint: api.endpointConfiguration?.types?.join(', ') ?? null,
        });
      }
    } catch (err) {
      errors.push(`REST APIs: ${errorMessage(err)}`);
    }

    try {
      const clientV2 = new ApiGatewayV2Client(clientConfig);
      const resultV2 = await clientV2.send(new GetApisCommand({}));
      for (const api of resultV2.Items ?? []) {
        rows.push({
          id: api.ApiId ?? '',
          name: api.Name ?? '',
          type: 'HTTP',
          createdDate: api.CreatedDate ? new Date(api.CreatedDate).toISOString() : null,
          endpoint: api.ApiEndpoint ?? null,
        });
      }
    } catch (err) {
      errors.push(`HTTP APIs: ${errorMessage(err)}`);
    }

    return { data: rows, error: errors.length > 0 ? errors.join(' | ') : null };
  }

  async function fetchS3(): Promise<AwsResourceResult<S3BucketRow>> {
    try {
      const client = new S3Client(clientConfig);
      const result = await client.send(new ListBucketsCommand({}));
      const rows = (result.Buckets ?? []).map((bucket) => ({
        name: bucket.Name ?? '',
        creationDate: bucket.CreationDate ? new Date(bucket.CreationDate).toISOString() : null,
      }));
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  // Each fetcher catches its own errors and always resolves (never rejects),
  // so one service's failure (e.g. a missing IAM permission) never blanks
  // out the others — Promise.all is safe here without allSettled.
  const [ec2, lambda, ecs, rds, dynamodb, apis, s3] = await Promise.all([
    fetchEc2(),
    fetchLambda(),
    fetchEcs(),
    fetchRds(),
    fetchDynamoDb(),
    fetchApis(),
    fetchS3(),
  ]);

  return NextResponse.json({
    connected: true,
    region,
    fetchedAt: new Date().toISOString(),
    ec2,
    lambda,
    ecs,
    rds,
    dynamodb,
    apis,
    s3,
  } satisfies AwsResourcesResponse);
}
