'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';
import AwsCredentialsPanel from './AwsCredentialsPanel';
import AzureCredentialsPanel from './AzureCredentialsPanel';
import GcpCredentialsPanel from './GcpCredentialsPanel';
import SnowflakeCredentialsPanel from './SnowflakeCredentialsPanel';
import styles from './SettingsTab.module.css';

interface SettingsTabProps {
  companyId: string;
}

interface ProviderPanelProps {
  companyId: string;
  canAdd?: boolean;
  limitMessage?: string | null;
  onConnectionsChanged?: () => void;
}

const PANELS: Record<CloudProvider, ComponentType<ProviderPanelProps>> = {
  aws: AwsCredentialsPanel,
  azure: AzureCredentialsPanel,
  gcp: GcpCredentialsPanel,
  snowflake: SnowflakeCredentialsPanel,
};

export default function SettingsTab({ companyId }: SettingsTabProps) {
  const [provider, setProvider] = useState<CloudProvider>('aws');
  // Assume adding is allowed until the allowance check comes back, so the
  // button doesn't flash disabled while loading — the POST route is the
  // real enforcement regardless of what this shows.
  const [canAdd, setCanAdd] = useState(true);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  // Bumped after a connection is added or removed so the allowance below
  // reloads without a page refresh.
  const [reloadToken, setReloadToken] = useState(0);
  const ActivePanel = PANELS[provider];

  useEffect(() => {
    let cancelled = false;

    async function loadAllowance() {
      try {
        const response = await fetch(`/api/settings/connection-allowance?companyId=${companyId}`);
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) return;
        setCanAdd(Boolean(body.canAdd));
        setLimitMessage(body.message ?? null);
      } catch {
        // Leave the previous allowance in place; the button greying is only
        // a courtesy — the server still enforces the cap on a direct POST.
      }
    }

    loadAllowance();
    return () => {
      cancelled = true;
    };
  }, [companyId, reloadToken]);

  return (
    <div className={styles.wrapper}>
      <Tabs value={provider} onValueChange={(value) => setProvider(value as CloudProvider)}>
        <TabsList>
          {CLOUD_PROVIDERS.map((p) => (
            <TabsTrigger key={p} value={p}>
              {CLOUD_PROVIDER_LABELS[p]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <ActivePanel
        companyId={companyId}
        canAdd={canAdd}
        limitMessage={limitMessage}
        onConnectionsChanged={() => setReloadToken((token) => token + 1)}
      />
    </div>
  );
}
