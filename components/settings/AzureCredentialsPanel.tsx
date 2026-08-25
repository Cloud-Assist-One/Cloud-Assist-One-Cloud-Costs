'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { AzureCredentialSummary } from '@/lib/types';

export default function AzureCredentialsPanel({ companyId }: { companyId: string }) {
  return (
    <ConnectionsPanel<AzureCredentialSummary>
      companyId={companyId}
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
