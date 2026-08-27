import { NextRequest, NextResponse } from 'next/server';
import { ClientSecretCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { StorageManagementClient } from '@azure/arm-storage';
import { OperationalInsightsManagementClient } from '@azure/arm-operationalinsights';
import { AdvisorManagementClient } from '@azure/arm-advisor';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { mapWithConcurrency } from '@/lib/concurrency';
import { unavailableCheck } from '@/lib/findings';
import { fetchCostsForResources, lookupCost } from '@/lib/findingCosts';
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
  advisorRightsizingRecommendations,
  type StorageLifecycleInput,
} from '@/lib/azure/costLeakage';
import type { CheckResult, FindingsResponse } from '@/lib/types';

// This route runs eight checks strictly sequentially, several of them
// paginated ARM list calls or per-resource fan-outs. The default 15s would
// cut it off mid-run. Matches the Azure Cost Details route.
export const maxDuration = 300;

// Matches the cap the resources route uses, for the same throttling reason.
// Caps every per-resource fan-out in this route -- the VM instance-view
// lookups below and the per-storage-account management-policy lookups --
// not just the check it was first written for.
const INSTANCE_VIEW_LOOKUP_CONCURRENCY = 8;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

// Every one of these row types carries a fully-qualified ARM resource id
// (/subscriptions/{sub}/resourceGroups/{rg}/providers/...) but not a flat
// resourceGroup field -- this is the standard way to recover it.
function resourceGroupFromId(id: string | undefined): string {
  if (!id) return '';
  const match = id.match(/\/resourceGroups\/([^/]+)/i);
  return match ? match[1] : '';
}

// Azure returns 403 with a long ARM message when the service principal is
// missing a role. Naming the role turns a support ticket into a two-minute fix.
function permissionHint(err: unknown): string {
  const message = errorMessage(err);
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 403) {
    return `${message} Grant the service principal the Reader role on this subscription.`;
  }
  return message;
}

async function runCheck(checkId: string, title: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run();
  } catch (err) {
    return unavailableCheck(checkId, title, 'builtin', permissionHint(err));
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
    .select('encrypted_payload')
    .eq('company_id', companyId)
    .eq('provider', 'azure')
    .eq('id', credentialId)
    .maybeSingle();

  if (credError) {
    console.error('Failed to look up Azure credentials:', credError);
    return NextResponse.json({ error: 'Could not look up the Azure connection.' }, { status: 500 });
  }

  if (!credRow) {
    return NextResponse.json({ connected: false } satisfies FindingsResponse);
  }

  let secrets: { tenantId: string; clientId: string; clientSecret: string; subscriptionId: string };
  try {
    secrets = decryptCredentials(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt Azure credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored Azure credentials.' }, { status: 500 });
  }

  const credential = new ClientSecretCredential(secrets.tenantId, secrets.clientId, secrets.clientSecret);
  const subscriptionId = secrets.subscriptionId;
  const compute = new ComputeManagementClient(credential, subscriptionId);
  const network = new NetworkManagementClient(credential, subscriptionId);
  const web = new WebSiteManagementClient(credential, subscriptionId);

  const checks: CheckResult[] = [];

  // Disks are read once: the unattached rule needs them, and the snapshot
  // rule needs their IDs to tell which snapshots are orphaned.
  let diskRows: { id: string; name: string; diskState: string | null; sizeGb: number | null; location: string | null }[] | null =
    null;
  let diskError: string | null = null;
  try {
    diskRows = [];
    for await (const disk of compute.disks.list()) {
      diskRows.push({
        id: disk.id ?? '',
        name: disk.name ?? '',
        diskState: disk.diskState ?? null,
        sizeGb: disk.diskSizeGB ?? null,
        location: disk.location ?? null,
      });
    }
  } catch (err) {
    diskRows = null;
    diskError = permissionHint(err);
  }

  checks.push(
    diskRows
      ? unattachedDisks(diskRows)
      : unavailableCheck(
          'unattached-managed-disks',
          'Unattached managed disks',
          'builtin',
          `Could not list managed disks: ${diskError}`
        )
  );

  checks.push(
    await runCheck('unassociated-public-ips', 'Unassociated public IPs', async () => {
      const rows = [];
      for await (const address of network.publicIPAddresses.listAll()) {
        rows.push({
          id: address.id ?? '',
          name: address.name ?? '',
          ipAddress: address.ipAddress ?? null,
          hasIpConfiguration: Boolean(address.ipConfiguration),
          location: address.location ?? null,
        });
      }
      return unassociatedPublicIps(rows);
    })
  );

  checks.push(
    await runCheck('stopped-not-deallocated-vms', 'VMs stopped but still billing', async () => {
      // ARM's listAll $expand=instanceView is documented as only valid when
      // paired with a $filter, which this route has no natural filter for.
      // Rather than risk it silently omitting instanceView (which would
      // leave powerState null and make every VM look "not stopped" --
      // exactly the silent-clean-grid failure this feature must avoid),
      // power state is looked up per VM via a bounded fan-out instead.
      const vms: { id: string; name: string; resourceGroup: string; location: string | null }[] = [];
      for await (const vm of compute.virtualMachines.listAll()) {
        vms.push({
          id: vm.id ?? '',
          name: vm.name ?? '',
          resourceGroup: resourceGroupFromId(vm.id),
          location: vm.location ?? null,
        });
      }

      const rows = await mapWithConcurrency(vms, INSTANCE_VIEW_LOOKUP_CONCURRENCY, async (vm) => {
        if (!vm.resourceGroup || !vm.name) {
          return { id: vm.id, name: vm.name, powerState: null, location: vm.location };
        }
        const instanceView = await compute.virtualMachines.instanceView(vm.resourceGroup, vm.name);
        const powerState =
          instanceView.statuses?.find((status) => status.code?.startsWith('PowerState/'))?.code ?? null;
        return { id: vm.id, name: vm.name, powerState, location: vm.location };
      });

      return stoppedNotDeallocatedVms(rows);
    })
  );

  checks.push(
    await runCheck('orphaned-snapshots', 'Snapshots of deleted disks', async () => {
      if (!diskRows) throw new Error('Could not list managed disks, which is needed to tell which snapshots are orphaned.');
      const existingDiskIds = new Set(diskRows.map((disk) => disk.id));
      const rows = [];
      for await (const snapshot of compute.snapshots.list()) {
        rows.push({
          id: snapshot.id ?? '',
          name: snapshot.name ?? '',
          sourceDiskId: snapshot.creationData?.sourceResourceId ?? null,
          sizeGb: snapshot.diskSizeGB ?? null,
          location: snapshot.location ?? null,
        });
      }
      return orphanedSnapshots(rows, existingDiskIds);
    })
  );

  checks.push(
    await runCheck('empty-app-service-plans', 'App Service plans with no apps', async () => {
      const rows = [];
      for await (const plan of web.appServicePlans.list()) {
        rows.push({
          id: plan.id ?? '',
          name: plan.name ?? '',
          numberOfSites: plan.numberOfSites ?? 0,
          sku: plan.sku?.name ?? null,
          location: plan.location ?? null,
        });
      }
      return emptyAppServicePlans(rows);
    })
  );

  checks.push(
    await runCheck('empty-backend-load-balancers', 'Load balancers with empty backend pools', async () => {
      const rows = [];
      for await (const loadBalancer of network.loadBalancers.listAll()) {
        const backendAddressCount = (loadBalancer.backendAddressPools ?? []).reduce(
          (total, pool) => total + (pool.loadBalancerBackendAddresses?.length ?? pool.backendIPConfigurations?.length ?? 0),
          0
        );
        rows.push({
          id: loadBalancer.id ?? '',
          name: loadBalancer.name ?? '',
          backendAddressCount,
          sku: loadBalancer.sku?.name ?? null,
          location: loadBalancer.location ?? null,
        });
      }
      return emptyBackendPoolLoadBalancers(rows);
    })
  );

  checks.push(
    await runCheck('orphaned-network-interfaces', 'Orphaned network interfaces', async () => {
      const rows = [];
      for await (const nic of network.networkInterfaces.listAll()) {
        rows.push({
          id: nic.id ?? '',
          name: nic.name ?? '',
          hasVirtualMachine: Boolean(nic.virtualMachine?.id),
          location: nic.location ?? null,
        });
      }
      return orphanedNetworkInterfaces(rows);
    })
  );

  checks.push(
    await runCheck('storage-accounts-without-lifecycle', 'Storage accounts with no lifecycle policy', async () => {
      const storage = new StorageManagementClient(credential, subscriptionId);

      const accounts = [];
      for await (const account of storage.storageAccounts.list()) {
        accounts.push(account);
      }

      const rows = await mapWithConcurrency(accounts, INSTANCE_VIEW_LOOKUP_CONCURRENCY, async (account) => {
        const resourceGroup = resourceGroupFromId(account.id);
        const row: StorageLifecycleInput = {
          id: account.id ?? '',
          name: account.name ?? '',
          location: account.location ?? null,
          hasLifecyclePolicy: false,
          lookupError: null,
        };
        try {
          const policy = await storage.managementPolicies.get(resourceGroup, account.name ?? '', 'default');
          row.hasLifecyclePolicy = (policy.policy?.rules ?? []).length > 0;
        } catch (err) {
          // A 404 IS the finding: no management policy is configured. Anything
          // else leaves the account unknown, which the rule reports separately.
          const status = (err as { statusCode?: number })?.statusCode;
          if (status !== 404) row.lookupError = errorMessage(err);
        }
        return row;
      });

      return storageAccountsWithoutLifecycle(rows);
    })
  );

  checks.push(
    await runCheck('workspaces-costly-log-settings', 'Log Analytics workspaces with costly settings', async () => {
      const insights = new OperationalInsightsManagementClient(credential, subscriptionId);

      const rows = [];
      for await (const workspace of insights.workspaces.list()) {
        // Some API versions report "no cap" as -1 rather than omitting the
        // field; the rule treats null (not -1) as "no cap configured".
        const dailyQuota = workspace.workspaceCapping?.dailyQuotaGb;
        rows.push({
          id: workspace.id ?? '',
          name: workspace.name ?? '',
          location: workspace.location ?? null,
          retentionInDays: workspace.retentionInDays ?? null,
          dailyQuotaGb: dailyQuota === undefined || dailyQuota === -1 ? null : dailyQuota,
        });
      }

      return workspacesWithCostlyLogSettings(rows);
    })
  );

  checks.push(
    await runCheck('advisor-rightsizing', 'Underutilized virtual machines', async () => {
      const advisor = new AdvisorManagementClient(credential, subscriptionId);

      const rows = [];
      // Pushing the category filter server-side (rather than pulling every
      // category and filtering in-process) means the rule's own in-process
      // Cost check below is a redundant guard, not the only line of defense.
      for await (const rec of advisor.recommendations.list({ filter: "Category eq 'Cost'" })) {
        const savings = Number(rec.extendedProperties?.savingsAmount);
        rows.push({
          // rec.id is the recommendation's own ARM id (.../Microsoft.Advisor/
          // recommendations/{guid}) -- its last path segment is the guid, not
          // a resource identifier, so it can never join to a cost_records row.
          // resourceMetadata.resourceId is the ARM id of the VM (or other
          // resource) the recommendation is actually about; rec.id is kept
          // only as a last-resort fallback so a finding never comes back with
          // an empty resourceId.
          id: rec.resourceMetadata?.resourceId ?? rec.id ?? '',
          category: rec.category ?? '',
          impactedField: rec.impactedField ?? '',
          impactedValue: rec.impactedValue ?? '',
          problem: rec.shortDescription?.problem ?? 'Underutilized resource',
          savingsAmount: Number.isFinite(savings) ? savings : null,
          savingsCurrency: rec.extendedProperties?.savingsCurrency ?? null,
        });
      }

      return advisorRightsizingRecommendations(rows);
    })
  );

  try {
    const resourceIds = checks.flatMap((check) => check.findings.map((finding) => finding.resourceId));
    const costs = await fetchCostsForResources(adminClient, periodId, 'azure', companyId, resourceIds);
    for (const check of checks) {
      for (const finding of check.findings) {
        finding.monthlyCost = lookupCost(costs, finding.resourceId);
      }
    }
  } catch (err) {
    console.error('Failed to join Azure leakage findings to billing data:', err);
  }

  return NextResponse.json({
    connected: true,
    // Azure resources span locations, so there is no single region for the header.
    region: null,
    fetchedAt: new Date().toISOString(),
    checks,
  } satisfies FindingsResponse);
}
