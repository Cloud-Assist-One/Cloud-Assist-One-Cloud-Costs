import {
  stoppedSince,
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
  MULTIPART_UPLOAD_STALE_DAYS,
} from './costLeakage';

describe('stoppedSince', () => {
  it('pulls the timestamp out of an EC2 state transition reason', () => {
    expect(stoppedSince('User initiated (2026-07-01 12:30:00 GMT)')).toBe('2026-07-01T12:30:00.000Z');
  });

  it('returns null when the reason carries no timestamp', () => {
    expect(stoppedSince('User initiated')).toBeNull();
  });

  it('returns null for a missing reason', () => {
    expect(stoppedSince(null)).toBeNull();
  });
});

describe('unattachedVolumes', () => {
  it('flags a volume in the available state', () => {
    const result = unattachedVolumes([
      { volumeId: 'vol-1', resourceId: 'arn:vol-1', name: 'scratch', state: 'available', sizeGiB: 200, region: 'us-east-1' },
    ]);

    expect(result.status).toBe('ok');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceId).toBe('arn:vol-1');
    expect(result.findings[0].resourceName).toBe('scratch');
    expect(result.findings[0].detail).toContain('200 GiB');
    expect(result.findings[0].monthlyCost).toBeNull();
  });

  it('ignores a volume that is in use', () => {
    const result = unattachedVolumes([
      { volumeId: 'vol-2', resourceId: 'arn:vol-2', name: null, state: 'in-use', sizeGiB: 8, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('falls back to the volume id when the volume has no Name tag', () => {
    const result = unattachedVolumes([
      { volumeId: 'vol-3', resourceId: 'arn:vol-3', name: null, state: 'available', sizeGiB: 1, region: 'us-east-1' },
    ]);

    expect(result.findings[0].resourceName).toBe('vol-3');
  });
});

describe('unassociatedElasticIps', () => {
  it('flags an address with no association', () => {
    const result = unassociatedElasticIps([
      { allocationId: 'eipalloc-1', publicIp: '52.0.0.1', associationId: null, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('52.0.0.1');
  });

  it('ignores an address attached to something', () => {
    const result = unassociatedElasticIps([
      { allocationId: 'eipalloc-2', publicIp: '52.0.0.2', associationId: 'eipassoc-2', region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('longStoppedInstances', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('flags an instance stopped longer than the threshold', () => {
    const result = longStoppedInstances(
      [
        {
          instanceId: 'i-1',
          resourceId: 'arn:i-1',
          name: 'old-worker',
          state: 'stopped',
          stateTransitionReason: 'User initiated (2026-06-01 09:00:00 GMT)',
          region: 'us-east-1',
        },
      ],
      now
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('86 days');
  });

  it('ignores an instance stopped only a few days ago', () => {
    const result = longStoppedInstances(
      [
        {
          instanceId: 'i-2',
          resourceId: 'arn:i-2',
          name: null,
          state: 'stopped',
          stateTransitionReason: 'User initiated (2026-08-25 09:00:00 GMT)',
          region: 'us-east-1',
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });

  it('ignores a running instance', () => {
    const result = longStoppedInstances(
      [
        {
          instanceId: 'i-3',
          resourceId: 'arn:i-3',
          name: null,
          state: 'running',
          stateTransitionReason: null,
          region: 'us-east-1',
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });

  it('flags a stopped instance whose stop date cannot be parsed, since it is still billing for storage', () => {
    const result = longStoppedInstances(
      [
        {
          instanceId: 'i-4',
          resourceId: 'arn:i-4',
          name: null,
          state: 'stopped',
          stateTransitionReason: null,
          region: 'us-east-1',
        },
      ],
      now
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('unknown');
  });
});

describe('orphanedSnapshots', () => {
  it('flags a snapshot whose source volume is gone', () => {
    const result = orphanedSnapshots(
      [
        {
          snapshotId: 'snap-1',
          resourceId: 'arn:snap-1',
          volumeId: 'vol-deleted',
          sizeGiB: 50,
          startTime: '2026-01-01T00:00:00.000Z',
          region: 'us-east-1',
        },
      ],
      new Set(['vol-alive'])
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('vol-deleted');
  });

  it('ignores a snapshot whose source volume still exists', () => {
    const result = orphanedSnapshots(
      [
        {
          snapshotId: 'snap-2',
          resourceId: 'arn:snap-2',
          volumeId: 'vol-alive',
          sizeGiB: 50,
          startTime: '2026-01-01T00:00:00.000Z',
          region: 'us-east-1',
        },
      ],
      new Set(['vol-alive'])
    );

    expect(result.findings).toEqual([]);
  });
});

describe('emptyLoadBalancers', () => {
  it('flags a load balancer with no registered targets', () => {
    const result = emptyLoadBalancers([
      { arn: 'arn:lb-1', name: 'legacy-alb', targetCount: 0, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('legacy-alb');
  });

  it('ignores a load balancer that has targets', () => {
    const result = emptyLoadBalancers([{ arn: 'arn:lb-2', name: 'live-alb', targetCount: 3, region: 'us-east-1' }]);

    expect(result.findings).toEqual([]);
  });
});

describe('idleNatGateways', () => {
  it('flags a gateway in a VPC with no running instances', () => {
    const result = idleNatGateways(
      [{ natGatewayId: 'nat-1', resourceId: 'arn:nat-1', vpcId: 'vpc-empty', region: 'us-east-1' }],
      new Set(['vpc-busy'])
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('vpc-empty');
  });

  it('ignores a gateway in a VPC that still runs instances', () => {
    const result = idleNatGateways(
      [{ natGatewayId: 'nat-2', resourceId: 'arn:nat-2', vpcId: 'vpc-busy', region: 'us-east-1' }],
      new Set(['vpc-busy'])
    );

    expect(result.findings).toEqual([]);
  });

  it('uses the ARN as the resource id so the finding can be priced, and the gateway id as the name', () => {
    const result = idleNatGateways(
      [{ natGatewayId: 'nat-1', resourceId: 'arn:nat-1', vpcId: 'vpc-empty', region: 'us-east-1' }],
      new Set(['vpc-busy'])
    );

    expect(result.findings[0].resourceId).toBe('arn:nat-1');
    expect(result.findings[0].resourceName).toBe('nat-1');
  });
});

describe('stoppedRdsInstances', () => {
  it('flags a stopped database', () => {
    const result = stoppedRdsInstances([
      { arn: 'arn:db-1', identifier: 'reporting', status: 'stopped', allocatedStorage: 100, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('reporting');
  });

  it('ignores an available database', () => {
    const result = stoppedRdsInstances([
      { arn: 'arn:db-2', identifier: 'prod', status: 'available', allocatedStorage: 100, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('bucketsWithoutLifecycle', () => {
  it('flags a bucket with no lifecycle policy', () => {
    const result = bucketsWithoutLifecycle([
      { name: 'assets', region: 'us-east-1', hasLifecyclePolicy: false, lookupError: null },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('assets');
    expect(result.findings[0].monthlyCost).toBeNull();
  });

  it('ignores a bucket that has one', () => {
    const result = bucketsWithoutLifecycle([
      { name: 'archived', region: 'us-east-1', hasLifecyclePolicy: true, lookupError: null },
    ]);

    expect(result.findings).toEqual([]);
  });

  // A denied bucket is unknown, not clean. Reporting it as having a policy
  // would hide real waste behind a permissions gap.
  it('reports a bucket whose policy could not be read, rather than assuming it has one', () => {
    const result = bucketsWithoutLifecycle([
      { name: 'locked', region: 'us-east-1', hasLifecyclePolicy: false, lookupError: 'Access Denied' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('could not be read');
    expect(result.findings[0].detail).toContain('Access Denied');
  });

  it('adds a shortfall finding when the bucket cap bit', () => {
    const result = bucketsWithoutLifecycle(
      [{ name: 'assets', region: 'us-east-1', hasLifecyclePolicy: true, lookupError: null }],
      200,
      1432
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('200');
    expect(result.findings[0].detail).toContain('1432');
  });

  it('adds no shortfall finding when every bucket was examined', () => {
    const result = bucketsWithoutLifecycle(
      [{ name: 'assets', region: 'us-east-1', hasLifecyclePolicy: true, lookupError: null }],
      1,
      1
    );

    expect(result.findings).toEqual([]);
  });
});

describe('staleMultipartUploads', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('flags a bucket with uploads older than the threshold', () => {
    const result = staleMultipartUploads(
      [{ name: 'uploads', region: 'us-east-1', oldestInitiated: '2026-08-01T00:00:00.000Z', staleCount: 12 }],
      now
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('12');
    expect(result.findings[0].detail).toContain('26 days');
  });

  it('ignores a bucket with no stale uploads', () => {
    const result = staleMultipartUploads(
      [{ name: 'clean', region: 'us-east-1', oldestInitiated: null, staleCount: 0 }],
      now
    );

    expect(result.findings).toEqual([]);
  });

  // One bucket with 4,000 abandoned parts is one thing to go and fix.
  it('reports one finding per bucket rather than one per upload', () => {
    const result = staleMultipartUploads(
      [{ name: 'busy', region: 'us-east-1', oldestInitiated: '2026-07-01T00:00:00.000Z', staleCount: 4000 }],
      now
    );

    expect(result.findings).toHaveLength(1);
  });
});

describe('logGroupsWithoutRetention', () => {
  it('flags a log group that never expires', () => {
    const result = logGroupsWithoutRetention([
      { name: '/aws/lambda/api', arn: 'arn:aws:logs:us-east-1:1:log-group:/aws/lambda/api', retentionInDays: null, storedBytes: 5_368_709_120, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('/aws/lambda/api');
    expect(result.findings[0].detail).toContain('never expire');
  });

  // The stored size is what turns "a setting nobody chose" into "this is
  // costing real money right now".
  it('states how much has already accumulated', () => {
    const result = logGroupsWithoutRetention([
      { name: '/aws/lambda/api', arn: 'arn:log', retentionInDays: null, storedBytes: 5_368_709_120, region: 'us-east-1' },
    ]);

    expect(result.findings[0].detail).toContain('5.0 GB');
  });

  it('ignores a log group with a retention period set', () => {
    const result = logGroupsWithoutRetention([
      { name: '/aws/lambda/short', arn: 'arn:log', retentionInDays: 30, storedBytes: 1000, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('handles a log group whose size is not reported', () => {
    const result = logGroupsWithoutRetention([
      { name: '/aws/new', arn: 'arn:log', retentionInDays: null, storedBytes: null, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).not.toContain('NaN');
  });

  it('reports nothing for an account with no log groups', () => {
    expect(logGroupsWithoutRetention([]).findings).toEqual([]);
  });
});
