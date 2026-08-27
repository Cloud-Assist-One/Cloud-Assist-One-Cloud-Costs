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
    return unavailableCheck(checkId, title, 'builtin', errorMessage(err));
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

  // Instances are read once and reused by three checks: the stopped-instance
  // rule, the snapshot rule's volume cross-reference, and the NAT gateway
  // rule's "does this VPC run anything" question.
  const instances = await collectPages(
    (token) => ec2.send(new DescribeInstancesCommand({ NextToken: token })),
    (page) => page.Reservations?.flatMap((reservation) => reservation.Instances ?? []) ?? [],
    (page) => page.NextToken
  ).catch(() => null);

  const volumesPromise = collectPages(
    (token) => ec2.send(new DescribeVolumesCommand({ NextToken: token })),
    (page) => page.Volumes ?? [],
    (page) => page.NextToken
  );

  const checks: CheckResult[] = [];

  const volumeRows = await volumesPromise.catch(() => null);

  checks.push(
    await runCheck('unattached-ebs-volumes', 'Unattached EBS volumes', async () => {
      if (!volumeRows) throw new Error('Could not list EBS volumes. The credential needs ec2:DescribeVolumes.');
      return unattachedVolumes(
        volumeRows.map((volume) => ({
          volumeId: volume.VolumeId ?? '',
          // A real ARN needs the account-ID segment, which this route has
          // no STS/IAM dependency to discover. The bare id is emitted
          // instead — lib/findingCosts matches it against billing rows
          // spelled either as a full ARN or a bare id.
          arn: volume.VolumeId ?? '',
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
        if (!instances) throw new Error('Could not list EC2 instances. The credential needs ec2:DescribeInstances.');
        return longStoppedInstances(
          instances.map((instance) => ({
            instanceId: instance.InstanceId ?? '',
            // Bare id, not a malformed ARN — see the volume mapping above.
            arn: instance.InstanceId ?? '',
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
          arn: snapshot.SnapshotId ?? '',
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
            arn: gateway.NatGatewayId ?? '',
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
    const costs = await fetchCostsForResources(adminClient, periodId, 'aws', resourceIds);
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
