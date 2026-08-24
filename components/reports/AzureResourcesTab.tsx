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
