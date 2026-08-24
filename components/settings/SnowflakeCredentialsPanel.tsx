'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { SnowflakeCredentialSummary } from '@/lib/types';

export default function SnowflakeCredentialsPanel({ companyId }: { companyId: string }) {
  return (
    <ConnectionsPanel<SnowflakeCredentialSummary>
      companyId={companyId}
      apiPath="/api/settings/snowflake-credentials"
      fields={[
        { name: 'account', label: 'Account identifier', type: 'text' },
        { name: 'username', label: 'Username', type: 'text' },
        { name: 'password', label: 'Password', type: 'password' },
      ]}
      renderSummary={(c) => `Account ${c.account}, user ${c.username}`}
    />
  );
}
