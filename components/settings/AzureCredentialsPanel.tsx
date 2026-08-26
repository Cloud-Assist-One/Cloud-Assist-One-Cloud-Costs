'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { AzureCredentialSummary } from '@/lib/types';

interface AzureCredentialsPanelProps {
  companyId: string;
  canAdd?: boolean;
  limitMessage?: string | null;
  onConnectionsChanged?: () => void;
}

export default function AzureCredentialsPanel({
  companyId,
  canAdd,
  limitMessage,
  onConnectionsChanged,
}: AzureCredentialsPanelProps) {
  return (
    <ConnectionsPanel<AzureCredentialSummary>
      companyId={companyId}
      canAdd={canAdd}
      limitMessage={limitMessage}
      onConnectionsChanged={onConnectionsChanged}
      apiPath="/api/settings/azure-credentials"
      fields={[
        { name: 'tenantId', label: 'Tenant ID', type: 'text' },
        { name: 'clientId', label: 'Client ID', type: 'text' },
        { name: 'clientSecret', label: 'Client secret', type: 'password' },
        { name: 'subscriptionId', label: 'Subscription ID', type: 'text' },
        // Optional: names the Azure tag surfaced as an extra column on the
        // Resources tab. Blank leaves that column off.
        { name: 'tagKey', label: 'Tag to display (optional)', type: 'text' },
      ]}
      renderSummary={(c) =>
        `Subscription ${c.subscriptionId}, client ${c.clientId}${c.tagKey ? `, tag ${c.tagKey}` : ''}`
      }
    />
  );
}
