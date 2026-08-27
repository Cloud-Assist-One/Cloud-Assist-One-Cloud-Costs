import { okCheck } from '@/lib/findings';
import type { CheckResult, Finding } from '@/lib/types';

// An instance stopped for a month is almost certainly forgotten rather than
// paused for the weekend, and its EBS volumes have been billing the whole
// time.
export const STOPPED_INSTANCE_DAYS = 30;

export interface VolumeInput {
  volumeId: string;
  // Not necessarily an ARN: this route has no STS/IAM dependency to
  // discover the account-ID segment an EBS ARN requires, so it may carry
  // just the bare volume id -- see the route for what it actually sends.
  resourceId: string;
  name: string | null;
  state: string;
  sizeGiB: number | null;
  region: string;
}

export interface ElasticIpInput {
  allocationId: string;
  publicIp: string;
  associationId: string | null;
  region: string;
}

export interface InstanceInput {
  instanceId: string;
  resourceId: string;
  name: string | null;
  state: string;
  stateTransitionReason: string | null;
  region: string;
}

export interface SnapshotInput {
  snapshotId: string;
  resourceId: string;
  volumeId: string | null;
  sizeGiB: number | null;
  startTime: string | null;
  region: string;
}

export interface LoadBalancerInput {
  arn: string;
  name: string;
  targetCount: number;
  region: string;
}

export interface NatGatewayInput {
  natGatewayId: string;
  resourceId: string;
  vpcId: string | null;
  region: string;
}

export interface RdsInput {
  arn: string;
  identifier: string;
  status: string;
  allocatedStorage: number | null;
  region: string;
}

// Leakage findings have no meaningful severity — the grid ranks them by
// cost instead — so every one of them is emitted as 'low'.
function leak(resourceId: string, resourceName: string, region: string | null, detail: string): Finding {
  return { severity: 'low', resourceId, resourceName, region, detail, monthlyCost: null };
}

// EC2 does not expose a "stopped at" timestamp. The only record of when an
// instance stopped is embedded in StateTransitionReason, which reads
// "User initiated (2026-07-01 12:30:00 GMT)".
export function stoppedSince(reason: string | null): string | null {
  if (!reason) return null;
  const match = reason.match(/\((\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*GMT\)/);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function daysBetween(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

export function unattachedVolumes(volumes: readonly VolumeInput[]): CheckResult {
  const findings = volumes
    .filter((volume) => volume.state === 'available')
    .map((volume) =>
      leak(
        volume.resourceId,
        volume.name ?? volume.volumeId,
        volume.region,
        `Volume ${volume.volumeId} (${volume.sizeGiB ?? '?'} GiB) is not attached to any instance and bills for its full provisioned size.`
      )
    );

  return okCheck('unattached-ebs-volumes', 'Unattached EBS volumes', 'builtin', findings);
}

export function unassociatedElasticIps(addresses: readonly ElasticIpInput[]): CheckResult {
  const findings = addresses
    .filter((address) => !address.associationId)
    .map((address) =>
      leak(
        address.allocationId,
        address.publicIp,
        address.region,
        `Elastic IP ${address.publicIp} is allocated but not associated with any instance or interface, which AWS bills hourly.`
      )
    );

  return okCheck('unassociated-elastic-ips', 'Unassociated Elastic IPs', 'builtin', findings);
}

export function longStoppedInstances(instances: readonly InstanceInput[], now: Date): CheckResult {
  const findings: Finding[] = [];

  for (const instance of instances) {
    if (instance.state !== 'stopped') continue;

    const since = stoppedSince(instance.stateTransitionReason);

    // A stopped instance whose stop date we cannot read is still worth
    // reporting: compute is free but its volumes are not, and the missing
    // timestamp is a parsing gap on our side, not evidence it is in use.
    if (!since) {
      findings.push(
        leak(
          instance.resourceId,
          instance.name ?? instance.instanceId,
          instance.region,
          `Instance ${instance.instanceId} is stopped (for an unknown length of time) and its EBS volumes continue to bill.`
        )
      );
      continue;
    }

    const days = daysBetween(since, now);
    if (days < STOPPED_INSTANCE_DAYS) continue;

    findings.push(
      leak(
        instance.resourceId,
        instance.name ?? instance.instanceId,
        instance.region,
        `Instance ${instance.instanceId} has been stopped for ${days} days and its EBS volumes continue to bill.`
      )
    );
  }

  return okCheck('long-stopped-instances', `Instances stopped over ${STOPPED_INSTANCE_DAYS} days`, 'builtin', findings);
}

export function orphanedSnapshots(
  snapshots: readonly SnapshotInput[],
  existingVolumeIds: ReadonlySet<string>
): CheckResult {
  const findings = snapshots
    .filter((snapshot) => snapshot.volumeId && !existingVolumeIds.has(snapshot.volumeId))
    .map((snapshot) =>
      leak(
        snapshot.resourceId,
        snapshot.snapshotId,
        snapshot.region,
        `Snapshot of ${snapshot.volumeId}, a volume that no longer exists (${snapshot.sizeGiB ?? '?'} GiB).`
      )
    );

  return okCheck('orphaned-snapshots', 'Snapshots of deleted volumes', 'builtin', findings);
}

export function emptyLoadBalancers(loadBalancers: readonly LoadBalancerInput[]): CheckResult {
  const findings = loadBalancers
    .filter((loadBalancer) => loadBalancer.targetCount === 0)
    .map((loadBalancer) =>
      leak(
        loadBalancer.arn,
        loadBalancer.name,
        loadBalancer.region,
        `Load balancer ${loadBalancer.name} has no registered targets but bills an hourly charge.`
      )
    );

  return okCheck('empty-load-balancers', 'Load balancers with no targets', 'builtin', findings);
}

export function idleNatGateways(
  gateways: readonly NatGatewayInput[],
  vpcIdsWithRunningInstances: ReadonlySet<string>
): CheckResult {
  const findings = gateways
    .filter((gateway) => gateway.vpcId && !vpcIdsWithRunningInstances.has(gateway.vpcId))
    .map((gateway) =>
      leak(
        gateway.resourceId,
        gateway.natGatewayId,
        gateway.region,
        `NAT gateway sits in ${gateway.vpcId}, a VPC with no running instances, but bills hourly regardless of traffic.`
      )
    );

  return okCheck('idle-nat-gateways', 'NAT gateways in empty VPCs', 'builtin', findings);
}

export function stoppedRdsInstances(instances: readonly RdsInput[]): CheckResult {
  const findings = instances
    .filter((instance) => instance.status === 'stopped')
    .map((instance) =>
      leak(
        instance.arn,
        instance.identifier,
        instance.region,
        `Database ${instance.identifier} is stopped but still bills for ${instance.allocatedStorage ?? '?'} GB of provisioned storage, and AWS restarts it automatically after 7 days.`
      )
    );

  return okCheck('stopped-rds-instances', 'Stopped RDS instances', 'builtin', findings);
}

// An upload abandoned for a week is not an upload in progress. AWS bills the
// uploaded parts as storage until the upload is aborted, and they do not
// appear in the console's object listing.
export const MULTIPART_UPLOAD_STALE_DAYS = 7;

export interface BucketLifecycleInput {
  name: string;
  region: string;
  hasLifecyclePolicy: boolean;
  /** Set when the lookup failed for a reason other than "no policy configured". */
  lookupError: string | null;
}

export interface MultipartUploadBucketInput {
  name: string;
  region: string;
  /** Oldest stale upload's initiation time, or null when there are none. */
  oldestInitiated: string | null;
  staleCount: number;
}

// The route caps how many buckets it will examine. A section reporting "3
// buckets without a policy" after looking at an eighth of them claims a
// completeness it has not earned, so the shortfall is stated as its own row.
function shortfallFinding(scanned: number, total: number, what: string): Finding[] {
  if (total <= scanned) return [];
  return [
    leak(
      'bucket-scan-incomplete',
      'Bucket scan incomplete',
      null,
      `Examined ${scanned} of ${total} buckets. The remaining ${total - scanned} were not checked ${what}.`
    ),
  ];
}

export function bucketsWithoutLifecycle(
  buckets: readonly BucketLifecycleInput[],
  scanned = buckets.length,
  total = buckets.length
): CheckResult {
  const findings: Finding[] = [];

  for (const bucket of buckets) {
    if (bucket.lookupError) {
      // Unknown is not clean: saying nothing here would hide real waste behind
      // a permissions gap.
      findings.push(
        leak(
          `arn:aws:s3:::${bucket.name}`,
          bucket.name,
          bucket.region,
          `Bucket ${bucket.name}'s lifecycle policy could not be read (${bucket.lookupError}), so whether it expires old objects is unknown.`
        )
      );
      continue;
    }

    if (bucket.hasLifecyclePolicy) continue;

    findings.push(
      leak(
        `arn:aws:s3:::${bucket.name}`,
        bucket.name,
        bucket.region,
        `Bucket ${bucket.name} has no lifecycle policy, so nothing expires or tiers old objects and its storage bill only grows.`
      )
    );
  }

  findings.push(...shortfallFinding(scanned, total, 'for a lifecycle policy'));

  return okCheck('buckets-without-lifecycle', 'Buckets with no lifecycle policy', 'builtin', findings);
}

export function staleMultipartUploads(
  buckets: readonly MultipartUploadBucketInput[],
  now: Date,
  scanned = buckets.length,
  total = buckets.length
): CheckResult {
  const findings: Finding[] = [];

  for (const bucket of buckets) {
    if (bucket.staleCount === 0 || !bucket.oldestInitiated) continue;

    const days = Math.floor((now.getTime() - new Date(bucket.oldestInitiated).getTime()) / 86_400_000);

    findings.push(
      leak(
        `arn:aws:s3:::${bucket.name}`,
        bucket.name,
        bucket.region,
        `Bucket ${bucket.name} has ${bucket.staleCount} incomplete multipart upload(s), the oldest ${days} days old. Their uploaded parts bill as storage until the uploads are aborted, and they do not show in the object listing.`
      )
    );
  }

  findings.push(...shortfallFinding(scanned, total, 'for incomplete uploads'));

  return okCheck('stale-multipart-uploads', 'Incomplete multipart uploads', 'builtin', findings);
}
