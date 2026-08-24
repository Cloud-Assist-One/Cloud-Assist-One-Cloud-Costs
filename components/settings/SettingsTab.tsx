'use client';

import { useState, type ComponentType } from 'react';
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

const PANELS: Record<CloudProvider, ComponentType<{ companyId: string }>> = {
  aws: AwsCredentialsPanel,
  azure: AzureCredentialsPanel,
  gcp: GcpCredentialsPanel,
  snowflake: SnowflakeCredentialsPanel,
};

export default function SettingsTab({ companyId }: SettingsTabProps) {
  const [provider, setProvider] = useState<CloudProvider>('aws');
  const ActivePanel = PANELS[provider];

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

      <ActivePanel companyId={companyId} />
    </div>
  );
}
