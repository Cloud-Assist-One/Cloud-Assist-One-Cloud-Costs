'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { AwsCredentialSummary } from '@/lib/types';

export default function AwsCredentialsPanel({ companyId }: { companyId: string }) {
  return (
    <ConnectionsPanel<AwsCredentialSummary>
      companyId={companyId}
      apiPath="/api/settings/aws-credentials"
      fields={[
        { name: 'accessKeyId', label: 'Access key ID', type: 'text' },
        { name: 'secretAccessKey', label: 'Secret access key', type: 'password' },
        { name: 'region', label: 'Region', type: 'text', defaultValue: 'us-east-1' },
      ]}
      renderSummary={(c) => `Access key ${c.accessKeyIdMasked}, region ${c.region}`}
    />
  );
}
