import type { CloudProvider } from './types';

export const CLOUD_PROVIDERS: CloudProvider[] = ['aws', 'azure', 'gcp', 'snowflake'];

export const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  aws: 'Amazon Web Services',
  azure: 'Microsoft Azure',
  gcp: 'Google Cloud',
  snowflake: 'Snowflake',
};

export const CLOUD_PROVIDER_COLORS: Record<CloudProvider, string> = {
  aws: 'var(--primary)',
  azure: 'var(--muted-foreground)',
  gcp: '#22a06b',
  snowflake: '#e08a2e',
};

export function formatBillingMonth(billingMonth: string | null): string {
  if (!billingMonth) return '—';
  return new Date(`${billingMonth}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
