import { NextRequest, NextResponse } from 'next/server';
import {
  EC2Client,
  DescribeVolumesCommand,
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeNatGatewaysCommand,
} from '@aws-sdk/client-ec2';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import {
  S3Client,
  ListBucketsCommand,
  GetBucketLifecycleConfigurationCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ComputeOptimizerClient, GetEC2InstanceRecommendationsCommand } from '@aws-sdk/client-compute-optimizer';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { collectPages } from '@/lib/awsPagination';
import { mapWithConcurrency } from '@/lib/concurrency';
import { unavailableCheck } from '@/lib/findings';
import { fetchCostsForResources, lookupCost } from '@/lib/findingCosts';
import {
  unattachedVolumes,
  unassociatedElasticIps,
  longStoppedInstances,
  orphanedSnapshots,
  emptyLoadBalancers,
  idleNatGateways,
  stoppedRdsInstances,
  bucketsWithoutLifecycle,
  staleMultipartUploads,
  logGroupsWithoutRetention,
  overProvisionedInstances,
  MULTIPART_UPLOAD_STALE_DAYS,
  type BucketLifecycleInput,
  type MultipartUploadBucketInput,
} from '@/lib/aws/costLeakage';
import type { CheckResult, FindingsResponse } from '@/lib/types';

// Matches the cap the resources route uses, for the same throttling reason.
// Caps every per-resource fan-out in this route -- load balancer target
// lookups and the per-bucket S3 lookups below -- not just the check it was
// first written for.
const TARGET_LOOKUP_CONCURRENCY = 8;

// Two checks fan out per bucket. An account with a thousand buckets would
// otherwise make two thousand calls inside the 300-second budget, so the scan
// is bounded and the shortfall is reported as its own finding.
const MAX_BUCKETS_SCANNED = 200;

// Compute Optimizer's installed SDK enum serializes on the wire as
// single-word PascalCase ("Overprovisioned", "Underprovisioned", "Optimized",
// "NotOptimized"), not the SCREAMING_SNAKE_CASE the rule filters on
// ("OVER_PROVISIONED", ...). AWS's own doc comment on this field contradicts
// the SDK types and claims responses already arrive as OVER_PROVISIONED /
// UNDER_PROVISIONED / OPTIMIZED -- that can't be settled without a live
// enrolled account, so this map is deliberately permissive: an unmapped
// value (e.g. an already-SCREAMING_SNAKE_CASE response) falls through
// unchanged via the `?? rec.finding ?? ''` below, which the rule still
// matches directly. That fallthrough is load-bearing, not defensive
// noise -- accepting both spellings cannot produce a false positive, since
// no other value normalizes to OVER_PROVISIONED, and removing it would
// break whichever spelling AWS actually sends.
const COMPUTE_OPTIMIZER_FINDING_LABELS: Record<string, string> = {
  Overprovisioned: 'OVER_PROVISIONED',
  Underprovisioned: 'UNDER_PROVISIONED',
  Optimized: 'OPTIMIZED',
  NotOptimized: 'NOT_OPTIMIZED',
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

function nameTag(tags: { Key?: string; Value?: string }[] | undefined): string | null {
  return tags?.find((tag) => tag.Key === 'Name')?.Value ?? null;
}

// AWS's raw SDK error text does not reliably name the missing permission,
// so each check's required action(s) are looked up here and appended
// rather than relying on the SDK message alone. Mirrors the Azure routes'
// permissionHint, which does the same for the service principal's role,
// and the AWS security-checks route's equivalent map.
const REQUIRED_PERMISSIONS: Record<string, string> = {
  'unattached-ebs-volumes': 'ec2:DescribeVolumes',
  'unassociated-elastic-ips': 'ec2:DescribeAddresses',
  'long-stopped-instances': 'ec2:DescribeInstances',
  'orphaned-snapshots': 'ec2:DescribeSnapshots (and DescribeVolumes, to cross-reference existing volumes)',
  'empty-load-balancers':
    'elasticloadbalancing:DescribeLoadBalancers, DescribeTargetGroups, and DescribeTargetHealth',
  'idle-nat-gateways': 'ec2:DescribeNatGateways (and DescribeInstances, to cross-reference busy VPCs)',
  'stopped-rds-instances': 'rds:DescribeDBInstances',
  'buckets-without-lifecycle': 's3:GetLifecycleConfiguration',
  'stale-multipart-uploads': 's3:ListBucketMultipartUploads',
  'log-groups-without-retention': 'logs:DescribeLogGroups',
};

// The AWS-managed SecurityAudit policy grants every permission in
// REQUIRED_PERMISSIONS above, so it is worth naming once as the fix.
function withPermissionHint(checkId: string, message: string): string {
  const actions = REQUIRED_PERMISSIONS[checkId];
  if (!actions) return message;
  return `${message} The credential needs ${actions}. The AWS-managed SecurityAudit policy covers this and every other permission these checks need.`;
}

// Every check runs in isolation so one denied permission degrades one
// section instead of blanking the tab.
async function runCheck(
  checkId: string,
  title: string,
  run: () => Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await run();
  } catch (err) {
    return unavailableCheck(checkId, title, 'builtin', withPermissionHint(checkId, errorMessage(err)));
  }
}

export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const credentialId = request.nextUrl.searchParams.get('credentialId');
  const periodId = request.nextUrl.searchParams.get('periodId');
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
    return NextResponse.json({ connected: false } satisfies FindingsResponse);
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
  const ec2 = new EC2Client(clientConfig);
  const elb = new ElasticLoadBalancingV2Client(clientConfig);
  const rds = new RDSClient(clientConfig);
  // Bucket lookups are region-specific, and a bucket can live outside the
  // credential's configured region -- following the redirect keeps a
  // mismatched region from surfacing as a spurious lookup error.
  const s3 = new S3Client({ ...clientConfig, followRegionRedirects: true });

  // Instances are read once and reused by two checks: the stopped-instance
  // rule, and the NAT gateway rule's "does this VPC run anything" question.
  // (The snapshot rule cross-references volumes, not instances -- see
  // volumesPromise below.) Both fetches are independent multi-page pulls, so
  // they are started together and awaited together rather than serially.
  const instancesPromise = collectPages(
    (token) => ec2.send(new DescribeInstancesCommand({ NextToken: token })),
    (page) => page.Reservations?.flatMap((reservation) => reservation.Instances ?? []) ?? [],
    (page) => page.NextToken
  ).catch(() => null);

  const volumesPromise = collectPages(
    (token) => ec2.send(new DescribeVolumesCommand({ NextToken: token })),
    (page) => page.Volumes ?? [],
    (page) => page.NextToken
  ).catch(() => null);

  const checks: CheckResult[] = [];

  const [instances, volumeRows] = await Promise.all([instancesPromise, volumesPromise]);

  checks.push(
    await runCheck('unattached-ebs-volumes', 'Unattached EBS volumes', async () => {
      if (!volumeRows) throw new Error('Could not list EBS volumes.');
      return unattachedVolumes(
        volumeRows.map((volume) => ({
          volumeId: volume.VolumeId ?? '',
          // Not a real ARN: a real ARN needs the account-ID segment, which
          // this route has no STS/IAM dependency to discover. The bare id
          // is emitted instead — lib/findingCosts matches it against
          // billing rows spelled either as a full ARN or a bare id.
          resourceId: volume.VolumeId ?? '',
          name: nameTag(volume.Tags),
          state: volume.State ?? '',
          sizeGiB: volume.Size ?? null,
          region,
        }))
      );
    })
  );

  checks.push(
    await runCheck('unassociated-elastic-ips', 'Unassociated Elastic IPs', async () => {
      const response = await ec2.send(new DescribeAddressesCommand({}));
      return unassociatedElasticIps(
        (response.Addresses ?? []).map((address) => ({
          allocationId: address.AllocationId ?? address.PublicIp ?? '',
          publicIp: address.PublicIp ?? '',
          associationId: address.AssociationId ?? null,
          region,
        }))
      );
    })
  );

  checks.push(
    await runCheck(
      'long-stopped-instances',
      'Instances stopped over 30 days',
      async () => {
        if (!instances) throw new Error('Could not list EC2 instances.');
        return longStoppedInstances(
          instances.map((instance) => ({
            instanceId: instance.InstanceId ?? '',
            // Bare id, not a malformed ARN — see the volume mapping above.
            resourceId: instance.InstanceId ?? '',
            name: nameTag(instance.Tags),
            state: instance.State?.Name ?? '',
            stateTransitionReason: instance.StateTransitionReason ?? null,
            region,
          })),
          new Date()
        );
      }
    )
  );

  checks.push(
    await runCheck('orphaned-snapshots', 'Snapshots of deleted volumes', async () => {
      if (!volumeRows) throw new Error('Could not list EBS volumes, which is needed to tell which snapshots are orphaned.');
      const existingVolumeIds = new Set(volumeRows.map((volume) => volume.VolumeId ?? ''));
      const snapshots = await collectPages(
        // OwnerIds 'self' matters: without it this returns every public
        // snapshot on AWS, which is tens of thousands of rows.
        (token) => ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ['self'], NextToken: token })),
        (page) => page.Snapshots ?? [],
        (page) => page.NextToken
      );
      return orphanedSnapshots(
        snapshots.map((snapshot) => ({
          snapshotId: snapshot.SnapshotId ?? '',
          // Bare id, not a malformed ARN — see the volume mapping above.
          resourceId: snapshot.SnapshotId ?? '',
          volumeId: snapshot.VolumeId ?? null,
          sizeGiB: snapshot.VolumeSize ?? null,
          startTime: snapshot.StartTime?.toISOString() ?? null,
          region,
        })),
        existingVolumeIds
      );
    })
  );

  checks.push(
    await runCheck('empty-load-balancers', 'Load balancers with no targets', async () => {
      const loadBalancers = await collectPages(
        (token) => elb.send(new DescribeLoadBalancersCommand({ Marker: token })),
        (page) => page.LoadBalancers ?? [],
        (page) => page.NextMarker
      );

      const rows = await mapWithConcurrency(loadBalancers, TARGET_LOOKUP_CONCURRENCY, async (loadBalancer) => {
        const groups = await elb.send(
          new DescribeTargetGroupsCommand({ LoadBalancerArn: loadBalancer.LoadBalancerArn })
        );
        let targetCount = 0;
        for (const group of groups.TargetGroups ?? []) {
          const health = await elb.send(
            new DescribeTargetHealthCommand({ TargetGroupArn: group.TargetGroupArn })
          );
          targetCount += health.TargetHealthDescriptions?.length ?? 0;
        }
        return {
          // ELBv2 returns a real ARN (with account ID), so it passes
          // through unchanged for the cost join.
          arn: loadBalancer.LoadBalancerArn ?? '',
          name: loadBalancer.LoadBalancerName ?? '',
          targetCount,
          region,
        };
      });

      return emptyLoadBalancers(rows);
    })
  );

  checks.push(
    await runCheck('idle-nat-gateways', 'NAT gateways in empty VPCs', async () => {
      if (!instances) throw new Error('Could not list EC2 instances, which is needed to tell which VPCs are idle.');
      const busyVpcIds = new Set(
        instances
          .filter((instance) => instance.State?.Name === 'running')
          .map((instance) => instance.VpcId ?? '')
          .filter(Boolean)
      );
      const gateways = await collectPages(
        (token) => ec2.send(new DescribeNatGatewaysCommand({ NextToken: token })),
        (page) => page.NatGateways ?? [],
        (page) => page.NextToken
      );
      return idleNatGateways(
        gateways
          .filter((gateway) => gateway.State === 'available')
          .map((gateway) => ({
            natGatewayId: gateway.NatGatewayId ?? '',
            // NAT gateways have no ARN form at all, so both fields carry
            // the gateway id.
            resourceId: gateway.NatGatewayId ?? '',
            vpcId: gateway.VpcId ?? null,
            region,
          })),
        busyVpcIds
      );
    })
  );

  checks.push(
    await runCheck('stopped-rds-instances', 'Stopped RDS instances', async () => {
      const dbInstances = await collectPages(
        (token) => rds.send(new DescribeDBInstancesCommand({ Marker: token })),
        (page) => page.DBInstances ?? [],
        (page) => page.Marker
      );
      return stoppedRdsInstances(
        dbInstances.map((instance) => ({
          // RDS returns a real ARN (with account ID), so it passes through
          // unchanged for the cost join.
          arn: instance.DBInstanceArn ?? '',
          identifier: instance.DBInstanceIdentifier ?? '',
          status: instance.DBInstanceStatus ?? '',
          allocatedStorage: instance.AllocatedStorage ?? null,
          region,
        }))
      );
    })
  );

  // Both S3 checks walk the same bucket list; listing once and capping here
  // keeps the two checks consistent about which buckets they examined.
  let allBuckets: string[] = [];
  let bucketListError: string | null = null;
  try {
    const listed = await s3.send(new ListBucketsCommand({}));
    allBuckets = (listed.Buckets ?? []).map((bucket) => bucket.Name ?? '').filter(Boolean);
  } catch (err) {
    bucketListError = errorMessage(err);
  }

  const scannedBuckets = allBuckets.slice(0, MAX_BUCKETS_SCANNED);

  checks.push(
    await runCheck('buckets-without-lifecycle', 'Buckets with no lifecycle policy', async () => {
      if (bucketListError) throw new Error(`Could not list buckets: ${bucketListError}`);

      const rows = await mapWithConcurrency(scannedBuckets, TARGET_LOOKUP_CONCURRENCY, async (name) => {
        const row: BucketLifecycleInput = { name, region, hasLifecyclePolicy: false, lookupError: null };
        try {
          const config = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: name }));
          row.hasLifecyclePolicy = (config.Rules ?? []).length > 0;
        } catch (err) {
          // NoSuchLifecycleConfiguration IS the finding — a bucket with no
          // policy throws rather than returning an empty list. Anything else
          // leaves the bucket unknown, which the rule reports separately.
          const errName = err instanceof Error ? err.name : '';
          if (errName !== 'NoSuchLifecycleConfiguration') row.lookupError = errorMessage(err);
        }
        return row;
      });

      return bucketsWithoutLifecycle(rows, scannedBuckets.length, allBuckets.length);
    })
  );

  checks.push(
    await runCheck('stale-multipart-uploads', 'Incomplete multipart uploads', async () => {
      if (bucketListError) throw new Error(`Could not list buckets: ${bucketListError}`);

      const staleBefore = Date.now() - MULTIPART_UPLOAD_STALE_DAYS * 86_400_000;

      const rows = await mapWithConcurrency(scannedBuckets, TARGET_LOOKUP_CONCURRENCY, async (name) => {
        const row: MultipartUploadBucketInput = { name, region, oldestInitiated: null, staleCount: 0, lookupError: null };
        try {
          const uploads = await collectPages(
            (token) => s3.send(new ListMultipartUploadsCommand({ Bucket: name, KeyMarker: token })),
            (page) => page.Uploads ?? [],
            (page) => page.NextKeyMarker
          );
          for (const upload of uploads) {
            const initiated = upload.Initiated?.getTime();
            if (initiated === undefined || initiated > staleBefore) continue;
            row.staleCount += 1;
            const iso = new Date(initiated).toISOString();
            if (!row.oldestInitiated || iso < row.oldestInitiated) row.oldestInitiated = iso;
          }
        } catch (err) {
          // s3:ListBucketMultipartUploads is a distinct IAM action from
          // s3:GetLifecycleConfiguration, so a bucket policy can deny this
          // lookup while the lifecycle check above succeeds for the same
          // bucket. Unknown is not clean: leaving lookupError unset here
          // would render this bucket as "no stale uploads" instead of
          // "could not be checked".
          row.lookupError = errorMessage(err);
        }
        return row;
      });

      return staleMultipartUploads(rows, new Date(), scannedBuckets.length, allBuckets.length);
    })
  );

  checks.push(
    await runCheck('log-groups-without-retention', 'Log groups that never expire', async () => {
      const logs = new CloudWatchLogsClient(clientConfig);
      const groups = await collectPages(
        (token) => logs.send(new DescribeLogGroupsCommand({ nextToken: token })),
        (page) => page.logGroups ?? [],
        (page) => page.nextToken
      );

      return logGroupsWithoutRetention(
        groups.map((group) => ({
          name: group.logGroupName ?? '',
          arn: group.arn ?? group.logGroupName ?? '',
          retentionInDays: group.retentionInDays ?? null,
          storedBytes: group.storedBytes ?? null,
          region,
        }))
      );
    })
  );

  checks.push(
    await runCheck('over-provisioned-instances', 'Over-provisioned instances', async () => {
      const optimizer = new ComputeOptimizerClient(clientConfig);
      try {
        const recommendations = await collectPages(
          (token) => optimizer.send(new GetEC2InstanceRecommendationsCommand({ nextToken: token })),
          (page) => page.instanceRecommendations ?? [],
          (page) => page.nextToken
        );

        return overProvisionedInstances(
          recommendations.map((rec) => ({
            instanceArn: rec.instanceArn ?? '',
            instanceName: rec.instanceName ?? rec.instanceArn?.split('/').pop() ?? '',
            finding: COMPUTE_OPTIMIZER_FINDING_LABELS[rec.finding ?? ''] ?? rec.finding ?? '',
            currentInstanceType: rec.currentInstanceType ?? '',
            recommendedInstanceType: rec.recommendationOptions?.[0]?.instanceType ?? null,
            estimatedMonthlySavings:
              rec.recommendationOptions?.[0]?.savingsOpportunity?.estimatedMonthlySavings?.value ?? null,
            region,
          }))
        );
      } catch (err) {
        // Compute Optimizer is opt-in. Unlike Security Hub there is no built-in
        // fallback here, so going quiet would read as "no over-provisioned
        // instances" — the opposite conclusion.
        if (err instanceof Error && err.name === 'OptInRequiredException') {
          throw new Error(
            'AWS Compute Optimizer is not enabled for this account. Enable it in the Compute Optimizer console to see rightsizing recommendations here.'
          );
        }
        throw err;
      }
    })
  );

  // The cost join is best-effort: a billing lookup failure must not blank
  // out findings that are correct on their own.
  try {
    const resourceIds = checks.flatMap((check) => check.findings.map((finding) => finding.resourceId));
    const costs = await fetchCostsForResources(adminClient, periodId, 'aws', companyId, resourceIds);
    for (const check of checks) {
      for (const finding of check.findings) {
        finding.monthlyCost = lookupCost(costs, finding.resourceId);
      }
    }
  } catch (err) {
    console.error('Failed to join AWS leakage findings to billing data:', err);
  }

  return NextResponse.json({
    connected: true,
    region,
    fetchedAt: new Date().toISOString(),
    checks,
  } satisfies FindingsResponse);
}
