import { NextRequest, NextResponse } from 'next/server';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { LambdaClient, ListFunctionsCommand, ListTagsCommand } from '@aws-sdk/client-lambda';
import { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
  ListTagsOfResourceCommand,
} from '@aws-sdk/client-dynamodb';
import { APIGatewayClient, GetRestApisCommand } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client, GetApisCommand } from '@aws-sdk/client-apigatewayv2';
import { S3Client, ListBucketsCommand, GetBucketTaggingCommand } from '@aws-sdk/client-s3';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { collectPages } from '@/lib/awsPagination';
import { tagValue, lookupTag, tagFailureWarning } from '@/lib/resourceTags';
import { mapWithConcurrency } from '@/lib/concurrency';
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

// Per-resource tag lookups (Lambda, DynamoDB, S3) run one AWS API call per
// resource. An account with thousands of resources firing all of them at
// once gets throttled; capping how many run concurrently keeps well clear
// of that without making a 2,000-bucket account painfully slow.
const TAG_LOOKUP_CONCURRENCY = 8;

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
    .select('encrypted_payload, region, metadata')
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

  // The tag to surface as an extra column is configured per connection. When
  // it's blank the feature is off, and the services that need a separate tag
  // call per resource (Lambda, DynamoDB, S3) skip that call entirely — so an
  // unconfigured connection needs no extra IAM permissions.
  const tagKey = ((credRow.metadata as Record<string, unknown> | null)?.tagKey as string | undefined) ?? '';

  async function fetchEc2(): Promise<AwsResourceResult<Ec2InstanceRow>> {
    try {
      const client = new EC2Client(clientConfig);
      const reservations = await collectPages(
        (NextToken) => client.send(new DescribeInstancesCommand({ NextToken })),
        (page) => page.Reservations,
        (page) => page.NextToken
      );
      const rows: Ec2InstanceRow[] = [];
      for (const reservation of reservations) {
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
            // EC2 returns tags inline, so no extra call is needed here.
            tagValue: tagValue(instance.Tags, tagKey),
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
      const functions = await collectPages(
        (Marker) => client.send(new ListFunctionsCommand({ Marker })),
        (page) => page.Functions,
        (page) => page.NextMarker
      );
      // ListFunctions omits tags, so each function needs its own ListTags.
      // That's one AWS call per function, so it's bounded and its failures
      // are counted rather than being silently swallowed into blank cells.
      let tagFailures = 0;
      const rows = await mapWithConcurrency(functions, TAG_LOOKUP_CONCURRENCY, async (fn): Promise<LambdaFunctionRow> => {
        const tagResult = await lookupTag(tagKey, async () => {
          if (!fn.FunctionArn) return null;
          const tags = await client.send(new ListTagsCommand({ Resource: fn.FunctionArn }));
          return tagValue(tags.Tags, tagKey);
        });
        if (!tagResult.ok) tagFailures++;
        return {
          functionName: fn.FunctionName ?? '',
          runtime: fn.Runtime ?? null,
          memorySize: fn.MemorySize ?? null,
          timeout: fn.Timeout ?? null,
          lastModified: fn.LastModified ?? null,
          tagValue: tagResult.ok ? tagResult.value : null,
        };
      });
      return { data: rows, error: tagFailureWarning(tagFailures, functions.length) };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchEcs(): Promise<AwsResourceResult<EcsServiceRow>> {
    try {
      const client = new ECSClient(clientConfig);
      const clusterArns = await collectPages(
        (nextToken) => client.send(new ListClustersCommand({ nextToken })),
        (page) => page.clusterArns,
        (page) => page.nextToken
      );
      const rows: EcsServiceRow[] = [];
      for (const clusterArn of clusterArns) {
        const serviceArns = await collectPages(
          (nextToken) =>
            client.send(new ListServicesCommand({ cluster: clusterArn, nextToken, maxResults: 100 })),
          (page) => page.serviceArns,
          (page) => page.nextToken
        );
        for (const batch of chunk(serviceArns, 10)) {
          if (batch.length === 0) continue;
          const describeResult = await client.send(
            // 'TAGS' makes DescribeServices return tags inline, avoiding a
            // separate tag call per service — but only ask for it when a tag
            // key is actually configured, so an unconfigured connection
            // fires no new API behavior at all.
            new DescribeServicesCommand({
              cluster: clusterArn,
              services: batch,
              include: tagKey ? ['TAGS'] : undefined,
            })
          );
          for (const service of describeResult.services ?? []) {
            rows.push({
              cluster: clusterArn.split('/').pop() ?? clusterArn,
              serviceName: service.serviceName ?? '',
              desiredCount: service.desiredCount ?? 0,
              runningCount: service.runningCount ?? 0,
              launchType: service.launchType ?? null,
              createdAt: service.createdAt ? new Date(service.createdAt).toISOString() : null,
              tagValue: tagValue(service.tags, tagKey),
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
      const instances = await collectPages(
        (Marker) => client.send(new DescribeDBInstancesCommand({ Marker })),
        (page) => page.DBInstances,
        (page) => page.Marker
      );
      const rows = instances.map((db) => ({
        dbInstanceIdentifier: db.DBInstanceIdentifier ?? '',
        engine: db.Engine ?? '',
        dbInstanceClass: db.DBInstanceClass ?? '',
        status: db.DBInstanceStatus ?? '',
        multiAz: db.MultiAZ ?? false,
        allocatedStorage: db.AllocatedStorage ?? 0,
        instanceCreateTime: db.InstanceCreateTime ? new Date(db.InstanceCreateTime).toISOString() : null,
        // RDS returns TagList inline on DescribeDBInstances.
        tagValue: tagValue(db.TagList, tagKey),
      }));
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchDynamoDb(): Promise<AwsResourceResult<DynamoTableRow>> {
    try {
      const client = new DynamoDBClient(clientConfig);
      const tableNames = await collectPages(
        (ExclusiveStartTableName) => client.send(new ListTablesCommand({ ExclusiveStartTableName })),
        (page) => page.TableNames,
        (page) => page.LastEvaluatedTableName
      );
      // A per-table Describe call is needed to get each table's creation
      // date (ListTables returns only names) — bounded concurrency, since
      // this is specifically what the age-based color flag needs. The same
      // call yields the ARN that the tag lookup needs.
      let tagFailures = 0;
      const rows = await mapWithConcurrency(tableNames, TAG_LOOKUP_CONCURRENCY, async (tableName): Promise<DynamoTableRow> => {
        try {
          const describeResult = await client.send(new DescribeTableCommand({ TableName: tableName }));
          const creationDateTime = describeResult.Table?.CreationDateTime;
          const tagResult = await lookupTag(tagKey, async () => {
            const tableArn = describeResult.Table?.TableArn;
            if (!tableArn) return null;
            // ListTagsOfResource paginates (NextToken) — a table whose
            // wanted tag sits on a later page would otherwise show blank.
            const tags = await collectPages(
              (NextToken) => client.send(new ListTagsOfResourceCommand({ ResourceArn: tableArn, NextToken })),
              (page) => page.Tags,
              (page) => page.NextToken
            );
            return tagValue(tags, tagKey);
          });
          if (!tagResult.ok) tagFailures++;
          return {
            tableName,
            creationDateTime: creationDateTime ? new Date(creationDateTime).toISOString() : null,
            tagValue: tagResult.ok ? tagResult.value : null,
          };
        } catch {
          return { tableName, creationDateTime: null, tagValue: null };
        }
      });
      return { data: rows, error: tagFailureWarning(tagFailures, tableNames.length) };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchApis(): Promise<AwsResourceResult<ApiRow>> {
    const rows: ApiRow[] = [];
    const errors: string[] = [];

    try {
      const client = new APIGatewayClient(clientConfig);
      const items = await collectPages(
        (position) => client.send(new GetRestApisCommand({ position, limit: 500 })),
        (page) => page.items,
        (page) => page.position
      );
      for (const api of items) {
        rows.push({
          id: api.id ?? '',
          name: api.name ?? '',
          type: 'REST',
          createdDate: api.createdDate ? new Date(api.createdDate).toISOString() : null,
          endpoint: api.endpointConfiguration?.types?.join(', ') ?? null,
          // API Gateway returns tags inline as a plain record.
          tagValue: tagValue(api.tags, tagKey),
        });
      }
    } catch (err) {
      errors.push(`REST APIs: ${errorMessage(err)}`);
    }

    try {
      const clientV2 = new ApiGatewayV2Client(clientConfig);
      const items = await collectPages(
        (NextToken) => clientV2.send(new GetApisCommand({ NextToken })),
        (page) => page.Items,
        (page) => page.NextToken
      );
      for (const api of items) {
        rows.push({
          id: api.ApiId ?? '',
          name: api.Name ?? '',
          type: 'HTTP',
          createdDate: api.CreatedDate ? new Date(api.CreatedDate).toISOString() : null,
          endpoint: api.ApiEndpoint ?? null,
          tagValue: tagValue(api.Tags, tagKey),
        });
      }
    } catch (err) {
      errors.push(`HTTP APIs: ${errorMessage(err)}`);
    }

    return { data: rows, error: errors.length > 0 ? errors.join(' | ') : null };
  }

  async function fetchS3(): Promise<AwsResourceResult<S3BucketRow>> {
    try {
      // ListBuckets returns buckets from every region, but this client is
      // pinned to the connection's one configured region. Without
      // followRegionRedirects, GetBucketTagging against an out-of-region
      // bucket throws PermanentRedirect instead of transparently retrying
      // against the bucket's real region.
      const client = new S3Client({ ...clientConfig, followRegionRedirects: true });
      const buckets = await collectPages(
        (ContinuationToken) => client.send(new ListBucketsCommand({ ContinuationToken })),
        (page) => page.Buckets,
        (page) => page.ContinuationToken
      );
      let tagFailures = 0;
      const rows = await mapWithConcurrency(buckets, TAG_LOOKUP_CONCURRENCY, async (bucket): Promise<S3BucketRow> => {
        const tagResult = await lookupTag(tagKey, async () => {
          if (!bucket.Name) return null;
          try {
            const tags = await client.send(new GetBucketTaggingCommand({ Bucket: bucket.Name }));
            return tagValue(tags.TagSet, tagKey);
          } catch (err) {
            // An untagged bucket returns NoSuchTagSet rather than an empty
            // TagSet — that's "no tag", not a failed lookup, so it must not
            // count toward the failure warning below.
            if (err instanceof Error && err.name === 'NoSuchTagSet') return null;
            throw err;
          }
        });
        if (!tagResult.ok) tagFailures++;
        return {
          name: bucket.Name ?? '',
          creationDate: bucket.CreationDate ? new Date(bucket.CreationDate).toISOString() : null,
          tagValue: tagResult.ok ? tagResult.value : null,
        };
      });
      return { data: rows, error: tagFailureWarning(tagFailures, buckets.length) };
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
    tagKey,
    ec2,
    lambda,
    ecs,
    rds,
    dynamodb,
    apis,
    s3,
  } satisfies AwsResourcesResponse);
}
