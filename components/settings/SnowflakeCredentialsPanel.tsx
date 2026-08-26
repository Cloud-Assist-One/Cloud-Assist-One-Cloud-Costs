'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { SnowflakeCredentialSummary } from '@/lib/types';

interface SnowflakeCredentialsPanelProps {
  companyId: string;
  canAdd?: boolean;
  limitMessage?: string | null;
  onConnectionsChanged?: () => void;
}

export default function SnowflakeCredentialsPanel({
  companyId,
  canAdd,
  limitMessage,
  onConnectionsChanged,
}: SnowflakeCredentialsPanelProps) {
  return (
    <ConnectionsPanel<SnowflakeCredentialSummary>
      companyId={companyId}
      canAdd={canAdd}
      limitMessage={limitMessage}
      onConnectionsChanged={onConnectionsChanged}
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
