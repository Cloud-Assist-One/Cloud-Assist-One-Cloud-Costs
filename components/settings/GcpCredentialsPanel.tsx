'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { GcpCredentialSummary } from '@/lib/types';

interface GcpCredentialsPanelProps {
  companyId: string;
  canAdd?: boolean;
  limitMessage?: string | null;
  onConnectionsChanged?: () => void;
}

export default function GcpCredentialsPanel({
  companyId,
  canAdd,
  limitMessage,
  onConnectionsChanged,
}: GcpCredentialsPanelProps) {
  return (
    <ConnectionsPanel<GcpCredentialSummary>
      companyId={companyId}
      canAdd={canAdd}
      limitMessage={limitMessage}
      onConnectionsChanged={onConnectionsChanged}
      apiPath="/api/settings/gcp-credentials"
      fields={[
        { name: 'projectId', label: 'Project ID', type: 'text' },
        { name: 'serviceAccountJson', label: 'Service account JSON key', type: 'textarea' },
      ]}
      renderSummary={(c) => `Project ${c.projectId}`}
    />
  );
}
