import {
  stoppedSince,
  unattachedVolumes,
  unassociatedElasticIps,
  longStoppedInstances,
  orphanedSnapshots,
  emptyLoadBalancers,
  idleNatGateways,
  stoppedRdsInstances,
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
      { volumeId: 'vol-1', arn: 'arn:vol-1', name: 'scratch', state: 'available', sizeGiB: 200, region: 'us-east-1' },
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
      { volumeId: 'vol-2', arn: 'arn:vol-2', name: null, state: 'in-use', sizeGiB: 8, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('falls back to the volume id when the volume has no Name tag', () => {
    const result = unattachedVolumes([
      { volumeId: 'vol-3', arn: 'arn:vol-3', name: null, state: 'available', sizeGiB: 1, region: 'us-east-1' },
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
          arn: 'arn:i-1',
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
          arn: 'arn:i-2',
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
          arn: 'arn:i-3',
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
          arn: 'arn:i-4',
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
          arn: 'arn:snap-1',
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
          arn: 'arn:snap-2',
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
      [{ natGatewayId: 'nat-1', arn: 'arn:nat-1', vpcId: 'vpc-empty', region: 'us-east-1' }],
      new Set(['vpc-busy'])
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('vpc-empty');
  });

  it('ignores a gateway in a VPC that still runs instances', () => {
    const result = idleNatGateways(
      [{ natGatewayId: 'nat-2', arn: 'arn:nat-2', vpcId: 'vpc-busy', region: 'us-east-1' }],
      new Set(['vpc-busy'])
    );

    expect(result.findings).toEqual([]);
  });

  it('uses the ARN as the resource id so the finding can be priced, and the gateway id as the name', () => {
    const result = idleNatGateways(
      [{ natGatewayId: 'nat-1', arn: 'arn:nat-1', vpcId: 'vpc-empty', region: 'us-east-1' }],
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
