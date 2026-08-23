import type { CloudProvider } from './types';

export const CLOUD_PROVIDERS: CloudProvider[] = ['aws', 'azure', 'gcp', 'snowflake'];

export const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  aws: 'Amazon Web Services',
  azure: 'Microsoft Azure',
  gcp: 'Google Cloud',
  snowflake: 'Snowflake',
};
