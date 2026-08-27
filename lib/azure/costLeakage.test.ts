import {
  unattachedDisks,
  unassociatedPublicIps,
  stoppedNotDeallocatedVms,
  orphanedSnapshots,
  emptyAppServicePlans,
  emptyBackendPoolLoadBalancers,
  orphanedNetworkInterfaces,
  storageAccountsWithoutLifecycle,
  workspacesWithCostlyLogSettings,
} from './costLeakage';

describe('unattachedDisks', () => {
  it('flags an unattached managed disk', () => {
    const result = unattachedDisks([
      {
        id: '/subscriptions/s1/disks/disk-1',
        name: 'disk-1',
        diskState: 'Unattached',
        sizeGb: 512,
        location: 'eastus',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('512 GB');
    expect(result.findings[0].monthlyCost).toBeNull();
  });

  it('ignores a disk attached to a VM', () => {
    const result = unattachedDisks([
      { id: '/subscriptions/s1/disks/disk-2', name: 'disk-2', diskState: 'Attached', sizeGb: 128, location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a disk reserved for an upload, which is a transient state rather than waste', () => {
    const result = unattachedDisks([
      {
        id: '/subscriptions/s1/disks/disk-3',
        name: 'disk-3',
        diskState: 'ActiveUpload',
        sizeGb: 64,
        location: 'eastus',
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('unassociatedPublicIps', () => {
  it('flags a public IP with no IP configuration', () => {
    const result = unassociatedPublicIps([
      {
        id: '/subscriptions/s1/publicIPAddresses/ip-1',
        name: 'ip-1',
        ipAddress: '20.0.0.1',
        hasIpConfiguration: false,
        location: 'eastus',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('ip-1');
  });

  it('ignores an attached public IP', () => {
    const result = unassociatedPublicIps([
      {
        id: '/subscriptions/s1/publicIPAddresses/ip-2',
        name: 'ip-2',
        ipAddress: '20.0.0.2',
        hasIpConfiguration: true,
        location: 'eastus',
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('stoppedNotDeallocatedVms', () => {
  it('flags a VM that is stopped but not deallocated, because compute still bills', () => {
    const result = stoppedNotDeallocatedVms([
      { id: '/subscriptions/s1/vms/vm-1', name: 'vm-1', powerState: 'PowerState/stopped', location: 'eastus' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('deallocated');
  });

  it('ignores a deallocated VM, which has stopped billing for compute', () => {
    const result = stoppedNotDeallocatedVms([
      { id: '/subscriptions/s1/vms/vm-2', name: 'vm-2', powerState: 'PowerState/deallocated', location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a running VM', () => {
    const result = stoppedNotDeallocatedVms([
      { id: '/subscriptions/s1/vms/vm-3', name: 'vm-3', powerState: 'PowerState/running', location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a VM whose power state could not be read', () => {
    const result = stoppedNotDeallocatedVms([
      { id: '/subscriptions/s1/vms/vm-4', name: 'vm-4', powerState: null, location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('orphanedSnapshots', () => {
  it('flags a snapshot whose source disk is gone', () => {
    const result = orphanedSnapshots(
      [
        {
          id: '/subscriptions/s1/snapshots/snap-1',
          name: 'snap-1',
          sourceDiskId: '/subscriptions/s1/disks/gone',
          sizeGb: 128,
          location: 'eastus',
        },
      ],
      new Set(['/subscriptions/s1/disks/alive'])
    );

    expect(result.findings).toHaveLength(1);
  });

  it('matches the source disk id case-insensitively, since ARM casing is inconsistent', () => {
    const result = orphanedSnapshots(
      [
        {
          id: '/subscriptions/s1/snapshots/snap-2',
          name: 'snap-2',
          sourceDiskId: '/SUBSCRIPTIONS/S1/DISKS/ALIVE',
          sizeGb: 128,
          location: 'eastus',
        },
      ],
      new Set(['/subscriptions/s1/disks/alive'])
    );

    expect(result.findings).toEqual([]);
  });
});

describe('emptyAppServicePlans', () => {
  it('flags a plan hosting no apps', () => {
    const result = emptyAppServicePlans([
      { id: '/subscriptions/s1/plans/plan-1', name: 'plan-1', numberOfSites: 0, sku: 'P1v3', location: 'eastus' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('P1v3');
  });

  it('ignores a plan hosting apps', () => {
    const result = emptyAppServicePlans([
      { id: '/subscriptions/s1/plans/plan-2', name: 'plan-2', numberOfSites: 2, sku: 'P1v3', location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('emptyBackendPoolLoadBalancers', () => {
  it('flags a load balancer with no backend addresses', () => {
    const result = emptyBackendPoolLoadBalancers([
      { id: '/subscriptions/s1/lb/lb-1', name: 'lb-1', backendAddressCount: 0, sku: 'Standard', location: 'eastus' },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('ignores a load balancer with backends', () => {
    const result = emptyBackendPoolLoadBalancers([
      { id: '/subscriptions/s1/lb/lb-2', name: 'lb-2', backendAddressCount: 4, sku: 'Standard', location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('orphanedNetworkInterfaces', () => {
  it('flags a NIC attached to nothing', () => {
    const result = orphanedNetworkInterfaces([
      { id: '/subscriptions/s1/nics/nic-1', name: 'nic-1', hasVirtualMachine: false, location: 'eastus' },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('ignores a NIC attached to a VM', () => {
    const result = orphanedNetworkInterfaces([
      { id: '/subscriptions/s1/nics/nic-2', name: 'nic-2', hasVirtualMachine: true, location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('storageAccountsWithoutLifecycle', () => {
  it('flags an account with no management policy', () => {
    const result = storageAccountsWithoutLifecycle([
      { id: '/subscriptions/s1/storage/sa1', name: 'sa1', location: 'eastus', hasLifecyclePolicy: false, lookupError: null },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('sa1');
  });

  it('ignores an account that has one', () => {
    const result = storageAccountsWithoutLifecycle([
      { id: '/subscriptions/s1/storage/sa2', name: 'sa2', location: 'eastus', hasLifecyclePolicy: true, lookupError: null },
    ]);

    expect(result.findings).toEqual([]);
  });

  // Unknown is not clean — the same rule the AWS bucket check follows.
  it('reports an account whose policy could not be read', () => {
    const result = storageAccountsWithoutLifecycle([
      { id: '/subscriptions/s1/storage/sa3', name: 'sa3', location: 'eastus', hasLifecyclePolicy: false, lookupError: 'Forbidden' },
    ]);

    expect(result.findings[0].detail).toContain('could not be read');
    expect(result.findings[0].detail).toContain('Forbidden');
  });
});

describe('workspacesWithCostlyLogSettings', () => {
  function workspace(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: '/subscriptions/s1/workspaces/law-prod',
      name: 'law-prod',
      location: 'eastus',
      retentionInDays: 30,
      dailyQuotaGb: 5,
      ...overrides,
    };
  }

  it('flags retention above the free allowance', () => {
    const result = workspacesWithCostlyLogSettings([workspace({ retentionInDays: 180 })]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('180 days');
  });

  it('flags a workspace with no daily ingestion cap', () => {
    const result = workspacesWithCostlyLogSettings([workspace({ dailyQuotaGb: null })]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('no daily ingestion cap');
  });

  it('reports both reasons in one finding when both apply', () => {
    const result = workspacesWithCostlyLogSettings([workspace({ retentionInDays: 365, dailyQuotaGb: null })]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('365 days');
    expect(result.findings[0].detail).toContain('no daily ingestion cap');
  });

  it('ignores a workspace at the free retention with a cap set', () => {
    const result = workspacesWithCostlyLogSettings([workspace()]);

    expect(result.findings).toEqual([]);
  });

  it('treats the free allowance itself as fine, not costly', () => {
    const result = workspacesWithCostlyLogSettings([workspace({ retentionInDays: 30 })]);

    expect(result.findings).toEqual([]);
  });
});
