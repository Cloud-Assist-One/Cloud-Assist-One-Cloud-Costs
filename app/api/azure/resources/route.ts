import { NextRequest, NextResponse } from 'next/server';
import { ClientSecretCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { ContainerInstanceManagementClient } from '@azure/arm-containerinstance';
import { SqlManagementClient } from '@azure/arm-sql';
import { CosmosDBManagementClient } from '@azure/arm-cosmosdb';
import { ApiManagementClient } from '@azure/arm-apimanagement';
import { StorageManagementClient } from '@azure/arm-storage';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type {
  AzureResourcesResponse,
  AzureVmRow,
  AzureFunctionAppRow,
  AzureContainerGroupRow,
  AzureSqlDatabaseRow,
  AzureCosmosDbAccountRow,
  AzureApiManagementRow,
  AzureStorageAccountRow,
} from '@/lib/types';

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

export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const credentialId = request.nextUrl.searchParams.get('credentialId');
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
    return NextResponse.json({ connected: false } satisfies AzureResourcesResponse);
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

  async function fetchVms(): Promise<{ data: AzureVmRow[]; error: string | null }> {
    try {
      const client = new ComputeManagementClient(credential, subscriptionId);
      const rows: AzureVmRow[] = [];
      for await (const vm of client.virtualMachines.listAll()) {
        rows.push({
          name: vm.name ?? '',
          vmSize: vm.hardwareProfile?.vmSize ?? null,
          provisioningState: vm.provisioningState ?? null,
          resourceGroup: resourceGroupFromId(vm.id),
          location: vm.location ?? null,
          timeCreated: vm.timeCreated ? new Date(vm.timeCreated).toISOString() : null,
        });
      }
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchFunctionApps(): Promise<{ data: AzureFunctionAppRow[]; error: string | null }> {
    try {
      const client = new WebSiteManagementClient(credential, subscriptionId);
      const rows: AzureFunctionAppRow[] = [];
      for await (const site of client.webApps.list()) {
        if (!site.kind?.includes('functionapp')) continue;
        rows.push({
          name: site.name ?? '',
          state: site.state ?? null,
          kind: site.kind ?? '',
          resourceGroup: resourceGroupFromId(site.id),
          location: site.location ?? null,
          createdAt: site.systemData?.createdAt ? new Date(site.systemData.createdAt).toISOString() : null,
        });
      }
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchContainerGroups(): Promise<{ data: AzureContainerGroupRow[]; error: string | null }> {
    try {
      const client = new ContainerInstanceManagementClient(credential, subscriptionId);
      const rows: AzureContainerGroupRow[] = [];
      for await (const group of client.containerGroups.list()) {
        rows.push({
          name: group.name ?? '',
          resourceGroup: resourceGroupFromId(group.id),
          location: group.location ?? null,
          provisioningState: group.provisioningState ?? null,
          containerImages: (group.containers ?? []).map((c) => c.image).join(', '),
          // ContainerGroup has no creation-timestamp field on this SDK version
          // (no systemData, no direct field) -- always null, by design.
          createdAt: null,
        });
      }
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchSqlDatabases(): Promise<{ data: AzureSqlDatabaseRow[]; error: string | null }> {
    try {
      const client = new SqlManagementClient(credential, subscriptionId);
      const rows: AzureSqlDatabaseRow[] = [];
      const errors: string[] = [];
      for await (const server of client.servers.list()) {
        const resourceGroup = resourceGroupFromId(server.id);
        if (!server.name || !resourceGroup) continue;
        try {
          for await (const database of client.databases.listByServer(resourceGroup, server.name)) {
            if (database.name === 'master') continue;
            rows.push({
              serverName: server.name,
              databaseName: database.name ?? '',
              resourceGroup,
              status: database.status ?? null,
              serviceObjective: database.currentServiceObjectiveName ?? null,
              creationDate: database.creationDate ? new Date(database.creationDate).toISOString() : null,
            });
          }
        } catch (err) {
          // One server's databases failing to list (e.g. a permissions gap
          // scoped to that server) must not blank out every other server's
          // databases -- skip it and keep going, but surface the failure
          // instead of silently reporting fewer rows.
          errors.push(`${server.name}: ${errorMessage(err)}`);
        }
      }
      return { data: rows, error: errors.length > 0 ? errors.join(' | ') : null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchCosmosDbAccounts(): Promise<{ data: AzureCosmosDbAccountRow[]; error: string | null }> {
    try {
      const client = new CosmosDBManagementClient(credential, subscriptionId);
      const rows: AzureCosmosDbAccountRow[] = [];
      for await (const account of client.databaseAccounts.list()) {
        rows.push({
          name: account.name ?? '',
          resourceGroup: resourceGroupFromId(account.id),
          location: account.location ?? null,
          kind: account.kind ?? null,
          provisioningState: account.provisioningState ?? null,
          createdAt: account.systemData?.createdAt ? new Date(account.systemData.createdAt).toISOString() : null,
        });
      }
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchApiManagementServices(): Promise<{ data: AzureApiManagementRow[]; error: string | null }> {
    try {
      const client = new ApiManagementClient(credential, subscriptionId);
      const rows: AzureApiManagementRow[] = [];
      for await (const service of client.apiManagementService.list()) {
        rows.push({
          name: service.name ?? '',
          resourceGroup: resourceGroupFromId(service.id),
          location: service.location ?? null,
          skuName: service.sku?.name ?? null,
          createdAtUtc: service.createdAtUtc ? new Date(service.createdAtUtc).toISOString() : null,
        });
      }
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  async function fetchStorageAccounts(): Promise<{ data: AzureStorageAccountRow[]; error: string | null }> {
    try {
      const client = new StorageManagementClient(credential, subscriptionId);
      const rows: AzureStorageAccountRow[] = [];
      for await (const account of client.storageAccounts.list()) {
        rows.push({
          name: account.name ?? '',
          resourceGroup: resourceGroupFromId(account.id),
          location: account.location ?? null,
          kind: account.kind ?? null,
          skuName: account.sku?.name ?? null,
          creationTime: account.creationTime ? new Date(account.creationTime).toISOString() : null,
        });
      }
      return { data: rows, error: null };
    } catch (err) {
      return { data: [], error: errorMessage(err) };
    }
  }

  // Each fetcher catches its own errors and always resolves (never rejects),
  // matching the AWS resources route's convention -- one service's failure
  // never blanks out the others.
  const [
    virtualMachines,
    functionApps,
    containerGroups,
    sqlDatabases,
    cosmosDbAccounts,
    apiManagementServices,
    storageAccounts,
  ] = await Promise.all([
    fetchVms(),
    fetchFunctionApps(),
    fetchContainerGroups(),
    fetchSqlDatabases(),
    fetchCosmosDbAccounts(),
    fetchApiManagementServices(),
    fetchStorageAccounts(),
  ]);

  return NextResponse.json({
    connected: true,
    fetchedAt: new Date().toISOString(),
    virtualMachines,
    functionApps,
    containerGroups,
    sqlDatabases,
    cosmosDbAccounts,
    apiManagementServices,
    storageAccounts,
  } satisfies AzureResourcesResponse);
}
