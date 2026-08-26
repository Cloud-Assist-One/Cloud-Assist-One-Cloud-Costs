'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { AwsCredentialSummary } from '@/lib/types';

interface AwsCredentialsPanelProps {
  companyId: string;
  canAdd?: boolean;
  limitMessage?: string | null;
  onConnectionsChanged?: () => void;
}

export default function AwsCredentialsPanel({
  companyId,
  canAdd,
  limitMessage,
  onConnectionsChanged,
}: AwsCredentialsPanelProps) {
  return (
    <ConnectionsPanel<AwsCredentialSummary>
      companyId={companyId}
      canAdd={canAdd}
      limitMessage={limitMessage}
      onConnectionsChanged={onConnectionsChanged}
      apiPath="/api/settings/aws-credentials"
      fields={[
        { name: 'accessKeyId', label: 'Access key ID', type: 'text' },
        { name: 'secretAccessKey', label: 'Secret access key', type: 'password' },
        { name: 'region', label: 'Region', type: 'text', defaultValue: 'us-east-1' },
        // Optional: names the AWS tag surfaced as an extra column on the
        // Resources and IAM Users tabs. Blank leaves that column off.
        { name: 'tagKey', label: 'Tag to display (optional)', type: 'text' },
      ]}
      renderSummary={(c) =>
        `Access key ${c.accessKeyIdMasked}, region ${c.region}${c.tagKey ? `, tag ${c.tagKey}` : ''}`
      }
    />
  );
}
