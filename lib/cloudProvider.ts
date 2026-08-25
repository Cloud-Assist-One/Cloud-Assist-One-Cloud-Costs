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

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface MonthOption {
  label: string;
  value: string;
}

// Shared by UploadForm (all 12 months of the current year) and
// PullBillingModal (capped to the current month) so the two forms can't
// disagree on which months exist for a given "now" — both must build their
// options from UTC, since a local-time basis can put the two forms in
// different months on the first/last day of a month depending on the
// viewer's timezone.
export function buildMonthOptions(now: Date): MonthOption[] {
  const year = now.getUTCFullYear();
  return MONTH_NAMES.map((name, i) => ({
    label: `${name} ${year}`,
    value: `${year}-${String(i + 1).padStart(2, '0')}-01`,
  }));
}
