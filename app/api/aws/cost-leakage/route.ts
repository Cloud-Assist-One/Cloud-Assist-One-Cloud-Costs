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
} from '@/lib/aws/costLeakage';
import type { CheckResult, FindingsResponse } from '@/lib/types';

// Matches the cap the resources route uses, for the same throttling reason.
const TARGET_LOOKUP_CONCURRENCY = 8;

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
