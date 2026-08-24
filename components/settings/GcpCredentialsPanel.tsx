'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { GcpCredentialSummary } from '@/lib/types';

export default function GcpCredentialsPanel({ companyId }: { companyId: string }) {
  return (
    <ConnectionsPanel<GcpCredentialSummary>
      companyId={companyId}
      apiPath="/api/settings/gcp-credentials"
      fields={[
        { name: 'projectId', label: 'Project ID', type: 'text' },
        { name: 'serviceAccountJson', label: 'Service account JSON key', type: 'textarea' },
      ]}
      renderSummary={(c) => `Project ${c.projectId}`}
    />
  );
}
