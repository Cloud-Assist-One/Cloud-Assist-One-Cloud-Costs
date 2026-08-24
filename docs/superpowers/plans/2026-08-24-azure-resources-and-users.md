# Azure Resources & Users Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Azure "Resources" and "Users" sub-tab to the existing Azure tab (currently Overview-only), backed by real ARM/Microsoft Graph API calls, reusing the AWS-built `ResourceGrid`/`ResourceLegend`/account-picker pattern.

**Architecture:** Two new API routes (`/api/azure/resources`, `/api/azure/ad-users`) decrypt a saved Azure connection's `{tenantId, clientId, clientSecret, subscriptionId}`, build one shared `ClientSecretCredential`, and fetch each Azure resource type / Graph users in parallel via `Promise.all` over never-rejecting per-service fetchers — the exact shape `app/api/aws/resources/route.ts` already uses. Two new tab components (`AzureResourcesTab`, `AzureUsersTab`) mirror `AwsResourcesTab`/`AwsIamUsersTab` exactly, including the account picker (Azure already supports multi-account from the Foundation sub-project, so there's no separate "add picker later" step this time). `AppShell.tsx` gains an Overview/Resources/Users sub-tab strip on the Azure tab, matching AWS's Overview/Resources/IAM Users strip.

**Tech Stack:** `@azure/identity` (ClientSecretCredential), `@azure/arm-compute` `^25.1.1`, `@azure/arm-appservice` `^19.0.0`, `@azure/arm-containerinstance` `^9.1.0`, `@azure/arm-sql` `^11.0.0`, `@azure/arm-cosmosdb` `^17.0.0`, `@azure/arm-apimanagement` `^10.0.0`, `@azure/arm-storage` `^20.1.0`, `@microsoft/microsoft-graph-client` `^3.0.7` — all already installed and in `package.json` (approved and added in the prior session turn; no task in this plan installs anything).

**Spec:** docs/superpowers/specs/2026-08-24-azure-resources-and-users-design.md

## Global Constraints

- No new npm dependencies — everything needed is already installed.
- No Jest coverage for the two new API routes (established convention in this codebase) — they're verified live in the browser in the final task, not with route-level unit tests.
- Every SDK method/field name in this plan was verified directly against the installed packages' `.d.ts` files (not assumed from memory or possibly-stale web docs) — implementers should trust this plan's exact code over any different pattern they might recall from older Azure SDK versions.
- Azure SQL Database listing is a deliberate two-level N+1 (list servers, then list databases per server) — this is Azure's actual data model (no flat cross-subscription "all databases" call exists without a separate Resource Graph package), matching this project's existing DynamoDB per-table `DescribeTableCommand` precedent. Each server's database-listing call is individually try/catch-guarded so one server's permission gap doesn't blank the whole grid.
- Container Instances (`ContainerGroup`) and this SDK version have no creation-timestamp field at all (verified: no `systemData`, no direct field) — that grid's `createdAt` is always `null`, so its rows never get age-colored. This is expected, not a bug.

---

### Task 1: Azure row types and response types

**Files:**
- Modify: `lib/types.ts` (append new interfaces; do not touch any existing ones)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AzureVmRow`, `AzureFunctionAppRow`, `AzureContainerGroupRow`, `AzureSqlDatabaseRow`, `AzureCosmosDbAccountRow`, `AzureApiManagementRow`, `AzureStorageAccountRow`, `AzureAdUserRow`, `AzureResourceResult<T>`, `AzureResourcesResponse`, `AzureAdUsersResponse` — Tasks 2-5 import these exact names/shapes.

- [ ] **Step 1: Append these interfaces to the end of `lib/types.ts`**

```ts
export interface AzureVmRow {
  name: string;
  vmSize: string | null;
  provisioningState: string | null;
  resourceGroup: string;
  location: string | null;
  timeCreated: string | null;
}

export interface AzureFunctionAppRow {
  name: string;
  state: string | null;
  kind: string;
  resourceGroup: string;
  location: string | null;
  createdAt: string | null;
}

export interface AzureContainerGroupRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  provisioningState: string | null;
  containerImages: string;
  createdAt: string | null;
}

export interface AzureSqlDatabaseRow {
  serverName: string;
  databaseName: string;
  resourceGroup: string;
  status: string | null;
  serviceObjective: string | null;
  creationDate: string | null;
}

export interface AzureCosmosDbAccountRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  kind: string | null;
  provisioningState: string | null;
  createdAt: string | null;
}

export interface AzureApiManagementRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  skuName: string | null;
  createdAtUtc: string | null;
}

export interface AzureStorageAccountRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  kind: string | null;
  skuName: string | null;
  creationTime: string | null;
}

export interface AzureAdUserRow {
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
  createdDateTime: string | null;
}

export interface AzureResourceResult<T> {
  data: T[];
  error: string | null;
}

export type AzureResourcesResponse =
  | { connected: false }
  | {
      connected: true;
      fetchedAt: string;
      virtualMachines: AzureResourceResult<AzureVmRow>;
      functionApps: AzureResourceResult<AzureFunctionAppRow>;
      containerGroups: AzureResourceResult<AzureContainerGroupRow>;
      sqlDatabases: AzureResourceResult<AzureSqlDatabaseRow>;
      cosmosDbAccounts: AzureResourceResult<AzureCosmosDbAccountRow>;
      apiManagementServices: AzureResourceResult<AzureApiManagementRow>;
      storageAccounts: AzureResourceResult<AzureStorageAccountRow>;
    };

export type AzureAdUsersResponse =
  | { connected: false }
  | {
      connected: true;
      fetchedAt: string;
      users: AzureResourceResult<AzureAdUserRow>;
    };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — nothing else in the codebase references these new names yet.

- [ ] **Step 3: Commit**

```bash
git add lib/types.ts
git commit -m "Add Azure resource and Azure AD user row/response types"
```

---

### Task 2: `/api/azure/resources` route

**Files:**
- Create: `app/api/azure/resources/route.ts`

**Interfaces:**
- Consumes: `AzureResourcesResponse` and the 7 row types (Task 1); `requireCompanyAccess` (`lib/admin-guard.ts`), `createAdminClient` (`lib/supabase/admin.ts`), `decryptCredentials` (`lib/cloudCredentialsCrypto.ts`) — all unchanged, already used by the AWS resources route.
- Produces: `GET ?companyId=&credentialId=` → `AzureResourcesResponse`. Task 4's `AzureResourcesTab` calls this exact path/shape.

- [ ] **Step 1: Create the file with this exact content**

```ts
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
        } catch {
          // One server's databases failing to list (e.g. a permissions gap
          // scoped to that server) must not blank out every other server's
          // databases -- skip it and keep going.
        }
      }
      return { data: rows, error: null };
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/azure/resources/route.ts
git commit -m "Add the Azure resources API route (7 ARM resource types)"
```

---

### Task 3: `/api/azure/ad-users` route

**Files:**
- Create: `app/api/azure/ad-users/route.ts`

**Interfaces:**
- Consumes: `AzureAdUsersResponse`, `AzureAdUserRow` (Task 1); same guard/admin-client/decrypt helpers as Task 2.
- Produces: `GET ?companyId=&credentialId=` → `AzureAdUsersResponse`. Task 5's `AzureUsersTab` calls this exact path/shape.

- [ ] **Step 1: Create the file with this exact content**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type { AzureAdUsersResponse, AzureAdUserRow } from '@/lib/types';

// Microsoft Graph's most common failure here is a missing admin-consented
// User.Read.All application permission -- a completely separate grant from
// the ARM "Reader" role the Resources tab needs, so this is the single most
// likely support question this feature generates. Point at it directly
// rather than surfacing Graph's raw, generic authorization error text.
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (/authorization|forbidden|insufficient/i.test(err.message)) {
      return `${err.message} (This usually means the app registration needs the Microsoft Graph "User.Read.All" application permission, with admin consent granted -- a separate grant from the ARM "Reader" role used for the Resources tab.)`;
    }
    return err.message;
  }
  return 'Unknown error.';
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
    return NextResponse.json({ connected: false } satisfies AzureAdUsersResponse);
  }

  let secrets: { tenantId: string; clientId: string; clientSecret: string; subscriptionId: string };
  try {
    secrets = decryptCredentials(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt Azure credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored Azure credentials.' }, { status: 500 });
  }

  let users: AzureAdUserRow[] = [];
  let usersError: string | null = null;
  try {
    const credential = new ClientSecretCredential(secrets.tenantId, secrets.clientId, secrets.clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });
    const client = Client.initWithMiddleware({ authProvider });
    const result = await client.api('/users').select('id,displayName,userPrincipalName,createdDateTime').get();
    users = ((result.value ?? []) as Record<string, unknown>[]).map((user) => ({
      id: (user.id as string) ?? '',
      displayName: (user.displayName as string | null) ?? null,
      userPrincipalName: (user.userPrincipalName as string | null) ?? null,
      createdDateTime: user.createdDateTime ? new Date(user.createdDateTime as string).toISOString() : null,
    }));
  } catch (err) {
    usersError = errorMessage(err);
  }

  return NextResponse.json({
    connected: true,
    fetchedAt: new Date().toISOString(),
    users: { data: users, error: usersError },
  } satisfies AzureAdUsersResponse);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/azure/ad-users/route.ts
git commit -m "Add the Azure AD (Entra ID) users API route via Microsoft Graph"
```

---

### Task 4: `AzureResourcesTab` component

**Files:**
- Create: `components/reports/AzureResourcesTab.tsx`
- Create: `components/reports/AzureResourcesTab.module.css`
- Test: `components/reports/AzureResourcesTab.test.tsx`

**Interfaces:**
- Consumes: `ResourceGrid`, `ResourceLegend` (`./ResourceGrid`, unchanged); `AzureCredentialSummary` (already exists in `lib/types.ts` from the Foundation sub-project); `AzureResourcesResponse` and the 7 row types (Task 1); `GET /api/settings/azure-credentials?companyId=` (already exists, returns `{connections: AzureCredentialSummary[]}`, from the Foundation sub-project); `GET /api/azure/resources?companyId=&credentialId=` (Task 2).
- Produces: `AzureResourcesTab({ companyId: string })`. Task 6 renders this in `AppShell.tsx`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AzureResourcesTab from './AzureResourcesTab';

const emptyResource = { data: [], error: null };
const connectionsResponse = {
  connections: [{ id: 'conn-1', label: 'Production', tenantId: 't1', clientId: 'c1', subscriptionId: 's1' }],
};

function makeResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connected: true,
    fetchedAt: '2026-08-24T12:00:00.000Z',
    virtualMachines: emptyResource,
    functionApps: emptyResource,
    containerGroups: emptyResource,
    sqlDatabases: emptyResource,
    cosmosDbAccounts: emptyResource,
    apiManagementServices: emptyResource,
    storageAccounts: emptyResource,
    ...overrides,
  };
}

describe('AzureResourcesTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a not-connected message when there are no saved Azure connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<AzureResourcesTab companyId="company-1" />);

    expect(await screen.findByText(/azure isn't connected yet/i)).toBeInTheDocument();
  });

  it('renders rows for each grid when data is present', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            virtualMachines: {
              data: [
                {
                  name: 'web-vm-1',
                  vmSize: 'Standard_B2s',
                  provisioningState: 'Succeeded',
                  resourceGroup: 'rg-prod',
                  location: 'eastus',
                  timeCreated: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
            storageAccounts: {
              data: [
                {
                  name: 'mystorageacct',
                  resourceGroup: 'rg-prod',
                  location: 'eastus',
                  kind: 'StorageV2',
                  skuName: 'Standard_LRS',
                  creationTime: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
          }),
      });

    render(<AzureResourcesTab companyId="company-1" />);

    expect(await screen.findByText('web-vm-1')).toBeInTheDocument();
    expect(screen.getByText('Standard_B2s')).toBeInTheDocument();
    expect(screen.getByText('mystorageacct')).toBeInTheDocument();
    expect(screen.getByText('No Function Apps found.')).toBeInTheDocument();
  });

  it('shows a per-grid error without hiding other grids', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            virtualMachines: { data: [], error: 'AuthorizationFailed: the client does not have permission' },
            storageAccounts: {
              data: [{ name: 'mystorageacct', resourceGroup: 'rg-prod', location: 'eastus', kind: null, skuName: null, creationTime: null }],
              error: null,
            },
          }),
      });

    render(<AzureResourcesTab companyId="company-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/authorizationfailed/i);
    expect(screen.getByText('mystorageacct')).toBeInTheDocument();
  });

  it('shows the age color-code legend', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    render(<AzureResourcesTab companyId="company-1" />);

    expect(await screen.findByText(/new in the last 24 hours/i)).toBeInTheDocument();
  });

  it('links the verify icon to a pre-filled mailto for that resource', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            virtualMachines: {
              data: [
                {
                  name: 'web-vm-1',
                  vmSize: 'Standard_B2s',
                  provisioningState: 'Succeeded',
                  resourceGroup: 'rg-prod',
                  location: 'eastus',
                  timeCreated: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
          }),
      });

    render(<AzureResourcesTab companyId="company-1" />);

    await screen.findByText('web-vm-1');
    const verifyLink = screen.getByRole('link', { name: /email to verify this virtual machine, web-vm-1/i });
    const href = decodeURIComponent(verifyLink.getAttribute('href') ?? '');
    expect(href).toContain('mailto:?subject=Verify AWS resource: Virtual Machine web-vm-1');
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AzureResourcesTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
  });

  it("switches accounts via the picker and refetches that account's resources", async () => {
    const twoConnections = {
      connections: [
        { id: 'conn-1', label: 'Production', tenantId: 't1', clientId: 'c1', subscriptionId: 's1' },
        { id: 'conn-2', label: 'Client sandbox', tenantId: 't2', clientId: 'c2', subscriptionId: 's2' },
      ],
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => twoConnections })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AzureResourcesTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.selectOptions(screen.getByLabelText(/account/i), 'conn-2');

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith('/api/azure/resources?companyId=company-1&credentialId=conn-2')
    );
  });
});
```

Note: the "verify icon" test asserts `mailto:?subject=Verify AWS resource: ...` (not "Azure resource") — this is intentional, not a typo. `ResourceGrid`'s `verifyMailtoHref` helper hard-codes the string "AWS resource" regardless of which provider's tab renders it (it was written before multi-provider support existed). This is a pre-existing, out-of-scope wording quirk in shared code — do not "fix" it as part of this task; the test asserts the actual current behavior.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- AzureResourcesTab`
Expected: FAIL — `Cannot find module './AzureResourcesTab'`.

- [ ] **Step 3: Write `components/reports/AzureResourcesTab.module.css`**

```css
.wrapper {
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.accountPicker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.accountPicker select {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
}

.fetchedAt {
  color: var(--muted-foreground);
  font-size: 0.85rem;
  font-family: var(--font-mono);
}

.error {
  color: #d1274b;
  font-size: 0.875rem;
}
```

- [ ] **Step 4: Write `components/reports/AzureResourcesTab.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResourceGrid, ResourceLegend } from './ResourceGrid';
import type {
  AzureCredentialSummary,
  AzureResourcesResponse,
  AzureVmRow,
  AzureFunctionAppRow,
  AzureContainerGroupRow,
  AzureSqlDatabaseRow,
  AzureCosmosDbAccountRow,
  AzureApiManagementRow,
  AzureStorageAccountRow,
} from '@/lib/types';
import styles from './AzureResourcesTab.module.css';

interface AzureResourcesTabProps {
  companyId: string;
}

export default function AzureResourcesTab({ companyId }: AzureResourcesTabProps) {
  const [connections, setConnections] = useState<AzureCredentialSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [response, setResponse] = useState<AzureResourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadResources = useCallback(
    async (credentialId: string) => {
      const res = await fetch(`/api/azure/resources?companyId=${companyId}&credentialId=${credentialId}`);
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? 'Could not load Azure resources.');
      }
      return body as AzureResourcesResponse;
    },
    [companyId]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const listRes = await fetch(`/api/settings/azure-credentials?companyId=${companyId}`);
        const listBody = await listRes.json();
        const list = (listBody.connections ?? []) as AzureCredentialSummary[];
        if (cancelled) return;
        setConnections(list);

        if (list.length === 0) {
          setLoading(false);
          return;
        }

        const firstId = list[0].id;
        setSelectedId(firstId);
        const result = await loadResources(firstId);
        if (!cancelled) {
          setResponse(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load Azure resources.');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadResources]);

  async function handleSelectConnection(id: string) {
    setSelectedId(id);
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadResources(id);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Azure resources.');
    }
    setRefreshing(false);
  }

  async function handleRefresh() {
    if (!selectedId) return;
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadResources(selectedId);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Azure resources.');
    }
    setRefreshing(false);
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  if (error) {
    return (
      <p role="alert" className={styles.error}>
        {error}
      </p>
    );
  }

  if (!connections || connections.length === 0 || !response?.connected) {
    return <p>Azure isn&apos;t connected yet. Add your Azure connection in the Settings tab to see live resources.</p>;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div className={styles.accountPicker}>
          <label htmlFor="azure-account-picker">Account</label>
          <select
            id="azure-account-picker"
            value={selectedId ?? ''}
            onChange={(e) => handleSelectConnection(e.target.value)}
            disabled={refreshing}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.fetchedAt}>Last refreshed {new Date(response.fetchedAt).toLocaleTimeString()}</span>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <ResourceLegend />

      <ResourceGrid<AzureVmRow>
        title="Virtual Machines"
        emptyLabel="No virtual machines found."
        result={response.virtualMachines}
        getCreatedAt={(r) => r.timeCreated}
        getName={(r) => r.name}
        resourceType="Virtual Machine"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'Size', render: (r) => r.vmSize ?? '—' },
          { header: 'State', render: (r) => r.provisioningState ?? '—' },
          { header: 'Resource group', render: (r) => r.resourceGroup || '—' },
          { header: 'Location', render: (r) => r.location ?? '—' },
        ]}
      />

      <ResourceGrid<AzureFunctionAppRow>
        title="Function Apps"
        emptyLabel="No Function Apps found."
        result={response.functionApps}
        getCreatedAt={(r) => r.createdAt}
        getName={(r) => r.name}
        resourceType="Function App"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'State', render: (r) => r.state ?? '—' },
          { header: 'Kind', render: (r) => r.kind },
          { header: 'Resource group', render: (r) => r.resourceGroup || '—' },
          { header: 'Location', render: (r) => r.location ?? '—' },
        ]}
      />

      <ResourceGrid<AzureContainerGroupRow>
        title="Container Groups"
        emptyLabel="No Container Groups found."
        result={response.containerGroups}
        getCreatedAt={(r) => r.createdAt}
        getName={(r) => r.name}
        resourceType="Container Group"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'Images', render: (r) => r.containerImages || '—' },
          { header: 'State', render: (r) => r.provisioningState ?? '—' },
          { header: 'Resource group', render: (r) => r.resourceGroup || '—' },
          { header: 'Location', render: (r) => r.location ?? '—' },
        ]}
      />

      <ResourceGrid<AzureSqlDatabaseRow>
        title="SQL Databases"
        emptyLabel="No SQL databases found."
        result={response.sqlDatabases}
        getCreatedAt={(r) => r.creationDate}
        getName={(r) => `${r.serverName}/${r.databaseName}`}
        resourceType="SQL Database"
        columns={[
          { header: 'Server', render: (r) => r.serverName },
          { header: 'Database', render: (r) => r.databaseName },
          { header: 'Status', render: (r) => r.status ?? '—' },
          { header: 'Service objective', render: (r) => r.serviceObjective ?? '—' },
          { header: 'Resource group', render: (r) => r.resourceGroup || '—' },
        ]}
      />

      <ResourceGrid<AzureCosmosDbAccountRow>
        title="Cosmos DB Accounts"
        emptyLabel="No Cosmos DB accounts found."
        result={response.cosmosDbAccounts}
        getCreatedAt={(r) => r.createdAt}
        getName={(r) => r.name}
        resourceType="Cosmos DB account"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'Kind', render: (r) => r.kind ?? '—' },
          { header: 'State', render: (r) => r.provisioningState ?? '—' },
          { header: 'Resource group', render: (r) => r.resourceGroup || '—' },
          { header: 'Location', render: (r) => r.location ?? '—' },
        ]}
      />

      <ResourceGrid<AzureApiManagementRow>
        title="API Management Services"
        emptyLabel="No API Management services found."
        result={response.apiManagementServices}
        getCreatedAt={(r) => r.createdAtUtc}
        getName={(r) => r.name}
        resourceType="API Management service"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'SKU', render: (r) => r.skuName ?? '—' },
          { header: 'Resource group', render: (r) => r.resourceGroup || '—' },
          { header: 'Location', render: (r) => r.location ?? '—' },
        ]}
      />

      <ResourceGrid<AzureStorageAccountRow>
        title="Storage Accounts"
        emptyLabel="No Storage Accounts found."
        result={response.storageAccounts}
        getCreatedAt={(r) => r.creationTime}
        getName={(r) => r.name}
        resourceType="Storage Account"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'Kind', render: (r) => r.kind ?? '—' },
          { header: 'SKU', render: (r) => r.skuName ?? '—' },
          { header: 'Resource group', render: (r) => r.resourceGroup || '—' },
          { header: 'Location', render: (r) => r.location ?? '—' },
        ]}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- AzureResourcesTab`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add components/reports/AzureResourcesTab.tsx components/reports/AzureResourcesTab.module.css components/reports/AzureResourcesTab.test.tsx
git commit -m "Add AzureResourcesTab with a multi-account picker"
```

---

### Task 5: `AzureUsersTab` component

**Files:**
- Create: `components/reports/AzureUsersTab.tsx`
- Create: `components/reports/AzureUsersTab.module.css`
- Test: `components/reports/AzureUsersTab.test.tsx`

**Interfaces:**
- Consumes: `ResourceGrid`, `ResourceLegend`; `AzureCredentialSummary`; `AzureAdUsersResponse`, `AzureAdUserRow` (Task 1); `GET /api/settings/azure-credentials?companyId=`; `GET /api/azure/ad-users?companyId=&credentialId=` (Task 3).
- Produces: `AzureUsersTab({ companyId: string })`. Task 6 renders this in `AppShell.tsx`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AzureUsersTab from './AzureUsersTab';

const connectionsResponse = {
  connections: [{ id: 'conn-1', label: 'Production', tenantId: 't1', clientId: 'c1', subscriptionId: 's1' }],
};

function makeResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connected: true,
    fetchedAt: '2026-08-24T12:00:00.000Z',
    users: { data: [], error: null },
    ...overrides,
  };
}

describe('AzureUsersTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a not-connected message when there are no saved Azure connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<AzureUsersTab companyId="company-1" />);

    expect(await screen.findByText(/azure isn't connected yet/i)).toBeInTheDocument();
  });

  it('renders a row for each Azure AD user', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            users: {
              data: [
                {
                  id: 'abc-123',
                  displayName: 'Jane Doe',
                  userPrincipalName: 'jane.doe@example.onmicrosoft.com',
                  createdDateTime: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
          }),
      });

    render(<AzureUsersTab companyId="company-1" />);

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane.doe@example.onmicrosoft.com')).toBeInTheDocument();
  });

  it('shows a Graph-permission-specific error message when the users call fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            users: {
              data: [],
              error:
                'Insufficient privileges to complete the operation. (This usually means the app registration needs the Microsoft Graph "User.Read.All" application permission, with admin consent granted -- a separate grant from the ARM "Reader" role used for the Resources tab.)',
            },
          }),
      });

    render(<AzureUsersTab companyId="company-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/user\.read\.all/i);
  });

  it('shows the age color-code legend', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    render(<AzureUsersTab companyId="company-1" />);

    expect(await screen.findByText(/new in the last 24 hours/i)).toBeInTheDocument();
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AzureUsersTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
  });

  it("switches accounts via the picker and refetches that account's users", async () => {
    const twoConnections = {
      connections: [
        { id: 'conn-1', label: 'Production', tenantId: 't1', clientId: 'c1', subscriptionId: 's1' },
        { id: 'conn-2', label: 'Client sandbox', tenantId: 't2', clientId: 'c2', subscriptionId: 's2' },
      ],
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => twoConnections })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AzureUsersTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.selectOptions(screen.getByLabelText(/account/i), 'conn-2');

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith('/api/azure/ad-users?companyId=company-1&credentialId=conn-2')
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- AzureUsersTab`
Expected: FAIL — `Cannot find module './AzureUsersTab'`.

- [ ] **Step 3: Write `components/reports/AzureUsersTab.module.css`**

Identical content to `components/reports/AzureResourcesTab.module.css` (Task 4, Step 3) — copy it verbatim.

- [ ] **Step 4: Write `components/reports/AzureUsersTab.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResourceGrid, ResourceLegend } from './ResourceGrid';
import type { AzureCredentialSummary, AzureAdUsersResponse, AzureAdUserRow } from '@/lib/types';
import styles from './AzureUsersTab.module.css';

interface AzureUsersTabProps {
  companyId: string;
}

export default function AzureUsersTab({ companyId }: AzureUsersTabProps) {
  const [connections, setConnections] = useState<AzureCredentialSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [response, setResponse] = useState<AzureAdUsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(
    async (credentialId: string) => {
      const res = await fetch(`/api/azure/ad-users?companyId=${companyId}&credentialId=${credentialId}`);
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? 'Could not load Azure AD users.');
      }
      return body as AzureAdUsersResponse;
    },
    [companyId]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const listRes = await fetch(`/api/settings/azure-credentials?companyId=${companyId}`);
        const listBody = await listRes.json();
        const list = (listBody.connections ?? []) as AzureCredentialSummary[];
        if (cancelled) return;
        setConnections(list);

        if (list.length === 0) {
          setLoading(false);
          return;
        }

        const firstId = list[0].id;
        setSelectedId(firstId);
        const result = await loadUsers(firstId);
        if (!cancelled) {
          setResponse(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load Azure AD users.');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadUsers]);

  async function handleSelectConnection(id: string) {
    setSelectedId(id);
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadUsers(id);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Azure AD users.');
    }
    setRefreshing(false);
  }

  async function handleRefresh() {
    if (!selectedId) return;
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadUsers(selectedId);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Azure AD users.');
    }
    setRefreshing(false);
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  if (error) {
    return (
      <p role="alert" className={styles.error}>
        {error}
      </p>
    );
  }

  if (!connections || connections.length === 0 || !response?.connected) {
    return <p>Azure isn&apos;t connected yet. Add your Azure connection in the Settings tab to see Azure AD users.</p>;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div className={styles.accountPicker}>
          <label htmlFor="azure-users-account-picker">Account</label>
          <select
            id="azure-users-account-picker"
            value={selectedId ?? ''}
            onChange={(e) => handleSelectConnection(e.target.value)}
            disabled={refreshing}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.fetchedAt}>Last refreshed {new Date(response.fetchedAt).toLocaleTimeString()}</span>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <ResourceLegend />

      <ResourceGrid<AzureAdUserRow>
        title="Azure AD Users"
        emptyLabel="No Azure AD users found."
        result={response.users}
        getCreatedAt={(r) => r.createdDateTime}
        getName={(r) => r.displayName ?? r.userPrincipalName ?? r.id}
        resourceType="Azure AD user"
        columns={[
          { header: 'Display name', render: (r) => r.displayName ?? '—' },
          { header: 'User principal name', render: (r) => r.userPrincipalName ?? '—' },
          { header: 'Created', render: (r) => r.createdDateTime ?? '—' },
        ]}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- AzureUsersTab`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add components/reports/AzureUsersTab.tsx components/reports/AzureUsersTab.module.css components/reports/AzureUsersTab.test.tsx
git commit -m "Add AzureUsersTab listing Azure AD (Entra ID) users via Graph"
```

---

### Task 6: Wire the Azure sub-tab strip into `AppShell.tsx`

**Files:**
- Modify: `components/shell/AppShell.tsx`
- Modify: `components/shell/AppShell.module.css`
- Modify: `components/shell/AppShell.test.tsx`

**Interfaces:**
- Consumes: `AzureResourcesTab` (Task 4), `AzureUsersTab` (Task 5).
- Produces: renames `isAwsWideView` → `isWideCloudView` (now covers both AWS's and Azure's non-Overview sub-tabs) and `styles.awsSubTabs` → `styles.cloudSubTabs`; adds `azureSubTab` state. No external prop signature changes to `AppShell` itself.

- [ ] **Step 1: Add the `AzureResourcesTab`/`AzureUsersTab` imports**

In `components/shell/AppShell.tsx`, after the existing `import AwsIamUsersTab from '../reports/AwsIamUsersTab';` line, add:

```tsx
import AzureResourcesTab from '../reports/AzureResourcesTab';
import AzureUsersTab from '../reports/AzureUsersTab';
```

- [ ] **Step 2: Add `azureSubTab` state and rename `isAwsWideView`**

Replace:

```tsx
  const [awsSubTab, setAwsSubTab] = useState<'overview' | 'resources' | 'iamUsers'>('overview');
  const isAwsWideView = activeTab === 'aws' && (awsSubTab === 'resources' || awsSubTab === 'iamUsers');
```

with:

```tsx
  const [awsSubTab, setAwsSubTab] = useState<'overview' | 'resources' | 'iamUsers'>('overview');
  const [azureSubTab, setAzureSubTab] = useState<'overview' | 'resources' | 'users'>('overview');
  const isWideCloudView =
    (activeTab === 'aws' && (awsSubTab === 'resources' || awsSubTab === 'iamUsers')) ||
    (activeTab === 'azure' && (azureSubTab === 'resources' || azureSubTab === 'users'));
```

- [ ] **Step 3: Update the two `isAwsWideView` usages to `isWideCloudView`**

Replace:

```tsx
          <div className={REPORT_TABS.includes(activeTab) && !isAwsWideView ? styles.reportLayout : undefined}>
            {REPORT_TABS.includes(activeTab) && !isAwsWideView && (
              <TrendSidebar key={effectiveCompanyId} companyId={effectiveCompanyId} />
            )}
            <div className={isAwsWideView ? styles.resourcesContent : styles.reportContent}>
```

with:

```tsx
          <div className={REPORT_TABS.includes(activeTab) && !isWideCloudView ? styles.reportLayout : undefined}>
            {REPORT_TABS.includes(activeTab) && !isWideCloudView && (
              <TrendSidebar key={effectiveCompanyId} companyId={effectiveCompanyId} />
            )}
            <div className={isWideCloudView ? styles.resourcesContent : styles.reportContent}>
```

- [ ] **Step 4: Rename the AWS sub-tabs wrapper class and add the Azure sub-tab block**

Replace:

```tsx
              {activeTab === 'aws' && (
                <div className={styles.awsSubTabs}>
                  <Tabs
                    value={awsSubTab}
                    onValueChange={(value) => setAwsSubTab(value as 'overview' | 'resources' | 'iamUsers')}
                  >
                    <TabsList>
                      <TabsTrigger value="overview">Overview</TabsTrigger>
                      <TabsTrigger value="resources">Resources</TabsTrigger>
                      <TabsTrigger value="iamUsers">IAM Users</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {awsSubTab === 'overview' ? (
                    <CostReportTab
                      companyId={effectiveCompanyId}
                      cloudProvider="aws"
                      periodId={periodIdForReports}
                      onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                    />
                  ) : awsSubTab === 'resources' ? (
                    <AwsResourcesTab companyId={effectiveCompanyId} />
                  ) : (
                    <AwsIamUsersTab companyId={effectiveCompanyId} />
                  )}
                </div>
              )}
              {activeTab === 'azure' && (
                <CostReportTab
                  companyId={effectiveCompanyId}
                  cloudProvider="azure"
                  periodId={periodIdForReports}
                  onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                />
              )}
```

with:

```tsx
              {activeTab === 'aws' && (
                <div className={styles.cloudSubTabs}>
                  <Tabs
                    value={awsSubTab}
                    onValueChange={(value) => setAwsSubTab(value as 'overview' | 'resources' | 'iamUsers')}
                  >
                    <TabsList>
                      <TabsTrigger value="overview">Overview</TabsTrigger>
                      <TabsTrigger value="resources">Resources</TabsTrigger>
                      <TabsTrigger value="iamUsers">IAM Users</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {awsSubTab === 'overview' ? (
                    <CostReportTab
                      companyId={effectiveCompanyId}
                      cloudProvider="aws"
                      periodId={periodIdForReports}
                      onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                    />
                  ) : awsSubTab === 'resources' ? (
                    <AwsResourcesTab companyId={effectiveCompanyId} />
                  ) : (
                    <AwsIamUsersTab companyId={effectiveCompanyId} />
                  )}
                </div>
              )}
              {activeTab === 'azure' && (
                <div className={styles.cloudSubTabs}>
                  <Tabs
                    value={azureSubTab}
                    onValueChange={(value) => setAzureSubTab(value as 'overview' | 'resources' | 'users')}
                  >
                    <TabsList>
                      <TabsTrigger value="overview">Overview</TabsTrigger>
                      <TabsTrigger value="resources">Resources</TabsTrigger>
                      <TabsTrigger value="users">Users</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {azureSubTab === 'overview' ? (
                    <CostReportTab
                      companyId={effectiveCompanyId}
                      cloudProvider="azure"
                      periodId={periodIdForReports}
                      onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                    />
                  ) : azureSubTab === 'resources' ? (
                    <AzureResourcesTab companyId={effectiveCompanyId} />
                  ) : (
                    <AzureUsersTab companyId={effectiveCompanyId} />
                  )}
                </div>
              )}
```

- [ ] **Step 5: Rename the CSS class in `components/shell/AppShell.module.css`**

Find the `.awsSubTabs` rule (near the bottom of the file, alongside `.archiveBanner`/`.archiveError`) and rename it to `.cloudSubTabs`:

```css
.cloudSubTabs {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
```

(Keep whatever declarations the existing `.awsSubTabs` rule already has — only the selector name changes.)

Also update the comment above `.resourcesContent` (added by the Foundation sub-project) that currently says "The Resources and IAM Users sub-tabs show live AWS inventory..." — broaden it to also mention Azure:

```css
/* The Resources/IAM-Users (AWS) and Resources/Users (Azure) sub-tabs show
   live cloud inventory, not a billing trend, so they skip the TrendSidebar
   and its 290px reservation (see reportLayout below) and get a 25% wider
   column (56rem * 1.25) to avoid a horizontal scrollbar on the grids. */
```

- [ ] **Step 6: Update `components/shell/AppShell.test.tsx`**

Add a mock for the two new components, alongside the existing `AwsResourcesTab`/`AwsIamUsersTab` mocks:

```tsx
jest.mock('./../reports/AzureResourcesTab', () => ({
  __esModule: true,
  default: () => <div>azure-resources-tab-content</div>,
}));
jest.mock('./../reports/AzureUsersTab', () => ({
  __esModule: true,
  default: () => <div>azure-users-tab-content</div>,
}));
```

Add a new test alongside the existing `'shows an Overview/Resources/IAM Users sub-tab strip on the AWS tab...'` test:

```tsx
  it('shows an Overview/Resources/Users sub-tab strip on the Azure tab, defaulting to Overview', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await user.click(screen.getByRole('tab', { name: /microsoft azure/i }));
    expect(await screen.findByText('report-tab-content for azure')).toBeInTheDocument();
    expect(screen.queryByText('azure-resources-tab-content')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^resources$/i }));
    expect(await screen.findByText('azure-resources-tab-content')).toBeInTheDocument();
    expect(screen.queryByText('report-tab-content for azure')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^users$/i }));
    expect(await screen.findByText('azure-users-tab-content')).toBeInTheDocument();
    expect(screen.queryByText('azure-resources-tab-content')).not.toBeInTheDocument();
  });
```

Place this test directly after the existing AWS sub-tab-strip test in the same `describe` block. Since both AWS and Azure sub-tab strips now render a `TabsTrigger` literally named "Resources" (`getByRole('tab', { name: /^resources$/i })` after switching to the Azure tab is scoped correctly because the AWS tab's own "Resources"/"IAM Users" triggers are unmounted once `activeTab` switches away from `'aws'` — only one provider's sub-tab strip is ever rendered at a time).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- AppShell`
Expected: PASS (all existing AppShell tests plus the new one).

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add components/shell/AppShell.tsx components/shell/AppShell.module.css components/shell/AppShell.test.tsx
git commit -m "Add an Overview/Resources/Users sub-tab strip to the Azure tab"
```

---

### Task 7: Full pipeline, live verification, and cleanup

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything built in Tasks 1-6.
- Produces: nothing new.

- [ ] **Step 1: Run the full automated pipeline**

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all pass (the only known pre-existing warning is the unrelated `LineItemsTab.tsx` React Compiler notice).

- [ ] **Step 2: Live browser verification against a real Azure account**

This step needs a real Azure app registration the user provides (Tenant ID / Client ID / Client Secret / Subscription ID), with:
- The "Reader" RBAC role assigned on at least the target subscription (or a resource group with a few resources in it), and
- The Microsoft Graph **application permission** `User.Read.All` granted with **admin consent** (a separate grant from the RBAC role above — this is the single most likely place verification will hit a permission gap, and that is fine/expected: the goal is confirming the *error path* shows the pointed hint, not necessarily that Users succeeds).

If the controller does not already have this credential in hand, ask the user for it before starting this step (mirroring how the AWS test key was requested in the Foundation sub-project) — do not proceed with fabricated placeholder values for a real-account verification pass.

1. Start the dev server (checking the port isn't already in use first).
2. Create a disposable staff test account, sign in, pick an existing test company.
3. Settings → Microsoft Azure sub-tab → add a connection with the real Tenant ID/Client ID/Client Secret/Subscription ID.
4. Azure tab → Resources sub-tab: confirm the account picker shows the new connection, real resource data loads (or a clear per-grid error naming the specific ARM permission gap, which is an acceptable and expected outcome depending on what the test app registration's Reader role actually covers), the age-color legend renders, and Refresh works.
5. Azure tab → Users sub-tab: confirm either real Azure AD users list, or — if Graph permission wasn't granted — the specific "needs Microsoft Graph User.Read.All" hint renders (not a generic/opaque error), proving the pointed error-message logic in Task 3 actually fires correctly against a real Graph authorization failure.
6. Disconnect the test Azure connection from Settings; confirm the Resources/Users tabs return to "Azure isn't connected yet."

- [ ] **Step 3: Clean up test artifacts**

- Disconnect the Azure connection added during verification.
- Delete the disposable Supabase auth account via the Admin API.
- Stop the dev server (check the real PID via `netstat`/`taskkill` if the tracked process doesn't actually die — a recurring environment quirk noted in this project's session history).
- Remind the user to rotate/regenerate the app registration's client secret (not necessarily delete the whole app registration, unless they created it solely for this test) since it was used for live verification.

- [ ] **Step 4: Final commit**

If Steps 1-3 required any fixups, commit them. Skip this entirely if nothing needed fixing — do not create an empty commit.
