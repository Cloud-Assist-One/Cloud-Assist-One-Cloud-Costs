import { okCheck } from '@/lib/findings';
import type { CheckResult, Finding } from '@/lib/types';

export interface DiskInput {
  id: string;
  name: string;
  diskState: string | null;
  sizeGb: number | null;
  location: string | null;
}

export interface PublicIpInput {
  id: string;
  name: string;
  ipAddress: string | null;
  hasIpConfiguration: boolean;
  location: string | null;
}

export interface VmInput {
  id: string;
  name: string;
  powerState: string | null;
  location: string | null;
}

export interface SnapshotInput {
  id: string;
  name: string;
  sourceDiskId: string | null;
  sizeGb: number | null;
  location: string | null;
}

export interface AppServicePlanInput {
  id: string;
  name: string;
  numberOfSites: number;
  sku: string | null;
  location: string | null;
}

export interface LoadBalancerInput {
  id: string;
  name: string;
  backendAddressCount: number;
  sku: string | null;
  location: string | null;
}

export interface NetworkInterfaceInput {
  id: string;
  name: string;
  hasVirtualMachine: boolean;
  location: string | null;
}

function leak(resourceId: string, resourceName: string, region: string | null, detail: string): Finding {
  return { severity: 'low', resourceId, resourceName, region, detail, monthlyCost: null };
}

export function unattachedDisks(disks: readonly DiskInput[]): CheckResult {
  const findings = disks
    // Only 'Unattached' is waste. 'Reserved', 'ActiveUpload' and friends are
    // transient states in the middle of an operation.
    .filter((disk) => disk.diskState === 'Unattached')
    .map((disk) =>
      leak(
        disk.id,
        disk.name,
        disk.location,
        `Managed disk ${disk.name} (${disk.sizeGb ?? '?'} GB) is not attached to a VM and bills for its full provisioned size.`
      )
    );

  return okCheck('unattached-managed-disks', 'Unattached managed disks', 'builtin', findings);
}

export function unassociatedPublicIps(addresses: readonly PublicIpInput[]): CheckResult {
  const findings = addresses
    .filter((address) => !address.hasIpConfiguration)
    .map((address) =>
      leak(
        address.id,
        address.name,
        address.location,
        `Public IP ${address.name}${address.ipAddress ? ` (${address.ipAddress})` : ''} is reserved but not associated with any resource.`
      )
    );

  return okCheck('unassociated-public-ips', 'Unassociated public IPs', 'builtin', findings);
}

export function stoppedNotDeallocatedVms(vms: readonly VmInput[]): CheckResult {
  const findings = vms
    // 'PowerState/stopped' still bills full compute; only
    // 'PowerState/deallocated' releases the hardware and stops the meter.
    // This is the distinction most customers do not know exists.
    .filter((vm) => vm.powerState === 'PowerState/stopped')
    .map((vm) =>
      leak(
        vm.id,
        vm.name,
        vm.location,
        `VM ${vm.name} is stopped but not deallocated, so Azure still bills full compute for it. Deallocate it to stop the charge.`
      )
    );

  return okCheck('stopped-not-deallocated-vms', 'VMs stopped but still billing', 'builtin', findings);
}

export function orphanedSnapshots(
  snapshots: readonly SnapshotInput[],
  existingDiskIds: ReadonlySet<string>
): CheckResult {
  // ARM returns resource IDs with inconsistent casing between services, so
  // the comparison set is normalized rather than trusted as-is.
  const normalized = new Set([...existingDiskIds].map((id) => id.toLowerCase()));

  const findings = snapshots
    .filter((snapshot) => snapshot.sourceDiskId && !normalized.has(snapshot.sourceDiskId.toLowerCase()))
    .map((snapshot) =>
      leak(
        snapshot.id,
        snapshot.name,
        snapshot.location,
        `Snapshot of a disk that no longer exists (${snapshot.sizeGb ?? '?'} GB).`
      )
    );

  return okCheck('orphaned-snapshots', 'Snapshots of deleted disks', 'builtin', findings);
}

export function emptyAppServicePlans(plans: readonly AppServicePlanInput[]): CheckResult {
  const findings = plans
    .filter((plan) => plan.numberOfSites === 0)
    .map((plan) =>
      leak(
        plan.id,
        plan.name,
        plan.location,
        `App Service plan ${plan.name} (${plan.sku ?? 'unknown SKU'}) hosts no apps but bills for its reserved capacity.`
      )
    );

  return okCheck('empty-app-service-plans', 'App Service plans with no apps', 'builtin', findings);
}

export function emptyBackendPoolLoadBalancers(loadBalancers: readonly LoadBalancerInput[]): CheckResult {
  const findings = loadBalancers
    .filter((loadBalancer) => loadBalancer.backendAddressCount === 0)
    .map((loadBalancer) =>
      leak(
        loadBalancer.id,
        loadBalancer.name,
        loadBalancer.location,
        `Load balancer ${loadBalancer.name} (${loadBalancer.sku ?? 'unknown SKU'}) has an empty backend pool.`
      )
    );

  return okCheck('empty-backend-load-balancers', 'Load balancers with empty backend pools', 'builtin', findings);
}

export function orphanedNetworkInterfaces(interfaces: readonly NetworkInterfaceInput[]): CheckResult {
  const findings = interfaces
    .filter((nic) => !nic.hasVirtualMachine)
    .map((nic) =>
      leak(
        nic.id,
        nic.name,
        nic.location,
        `Network interface ${nic.name} is not attached to a VM. It is usually left behind when a VM is deleted, and can hold a public IP allocated alongside it.`
      )
    );

  return okCheck('orphaned-network-interfaces', 'Orphaned network interfaces', 'builtin', findings);
}
