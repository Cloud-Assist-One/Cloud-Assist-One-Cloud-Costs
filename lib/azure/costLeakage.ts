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

// Log Analytics includes 30 days of retention; beyond that bills per GB-month.
export const LOG_ANALYTICS_FREE_RETENTION_DAYS = 30;

export interface StorageLifecycleInput {
  id: string;
  name: string;
  location: string | null;
  hasLifecyclePolicy: boolean;
  /** Set when the lookup failed for a reason other than "no policy configured". */
  lookupError: string | null;
}

export interface LogAnalyticsWorkspaceInput {
  id: string;
  name: string;
  location: string | null;
  retentionInDays: number | null;
  /** Null means no daily cap, so ingestion spend is unbounded. */
  dailyQuotaGb: number | null;
}

export function storageAccountsWithoutLifecycle(
  accounts: readonly StorageLifecycleInput[]
): CheckResult {
  const findings: Finding[] = [];

  for (const account of accounts) {
    if (account.lookupError) {
      // Unknown is not clean: staying silent would hide real waste behind a
      // permissions gap.
      findings.push(
        leak(
          account.id,
          account.name,
          account.location,
          `Storage account ${account.name}'s lifecycle policy could not be read (${account.lookupError}), so whether it tiers or expires old blobs is unknown.`
        )
      );
      continue;
    }

    if (account.hasLifecyclePolicy) continue;

    findings.push(
      leak(
        account.id,
        account.name,
        account.location,
        `Storage account ${account.name} has no lifecycle management policy, so nothing tiers or expires old blobs and its storage bill only grows.`
      )
    );
  }

  return okCheck(
    'storage-accounts-without-lifecycle',
    'Storage accounts with no lifecycle policy',
    'builtin',
    findings
  );
}

export function workspacesWithCostlyLogSettings(
  workspaces: readonly LogAnalyticsWorkspaceInput[]
): CheckResult {
  const findings: Finding[] = [];

  for (const workspace of workspaces) {
    const reasons: string[] = [];

    // Log Analytics always has a retention value, so "no retention" cannot
    // happen here the way it can on CloudWatch — the leak is retention bought
    // beyond the included allowance.
    if (workspace.retentionInDays !== null && workspace.retentionInDays > LOG_ANALYTICS_FREE_RETENTION_DAYS) {
      reasons.push(
        `retention is ${workspace.retentionInDays} days, beyond the ${LOG_ANALYTICS_FREE_RETENTION_DAYS} included`
      );
    }

    // Unbounded ingestion is future spend rather than accumulated waste, but it
    // is the setting that turns a noisy app into a surprise invoice.
    if (workspace.dailyQuotaGb === null) {
      reasons.push('there is no daily ingestion cap, so ingestion spend is unbounded');
    }

    if (reasons.length === 0) continue;

    findings.push(
      leak(
        workspace.id,
        workspace.name,
        workspace.location,
        `Log Analytics workspace ${workspace.name}: ${reasons.join(', and ')}.`
      )
    );
  }

  return okCheck(
    'workspaces-costly-log-settings',
    'Log Analytics workspaces with costly settings',
    'builtin',
    findings
  );
}

// Advisor's Cost category is broader than this check. It also returns
// unassociated public IPs and unattached disks -- both of which this tab
// already detects with its own rules -- and reserved-instance advice, which is
// deferred commitment coverage. Scoping to virtual machines is what keeps one
// piece of waste from appearing twice with two different cost figures.
const RIGHTSIZING_IMPACTED_FIELD = 'microsoft.compute/virtualmachines';

export interface AdvisorRecommendationInput {
  id: string;
  category: string;
  impactedField: string;
  impactedValue: string;
  problem: string;
  savingsAmount: number | null;
  savingsCurrency: string | null;
}

export function advisorRightsizingRecommendations(
  recommendations: readonly AdvisorRecommendationInput[]
): CheckResult {
  const findings: Finding[] = recommendations
    .filter(
      (rec) =>
        rec.category === 'Cost' && rec.impactedField.toLowerCase() === RIGHTSIZING_IMPACTED_FIELD
    )
    .map((rec) => {
      // The saving goes in the detail, not monthlyCost: that column carries what
      // the resource actually cost per the billing join.
      const saving =
        rec.savingsAmount !== null
          ? ` Estimated saving ${rec.savingsAmount.toFixed(2)} ${rec.savingsCurrency ?? ''}`.trimEnd() + '/month.'
          : '';

      return leak(
        rec.id,
        rec.impactedValue,
        null,
        `Azure Advisor: ${rec.problem} — ${rec.impactedValue}.${saving}`
      );
    });

  return okCheck('advisor-rightsizing', 'Underutilized virtual machines', 'builtin', findings);
}
