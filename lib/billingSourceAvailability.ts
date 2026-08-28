import type { CloudProvider } from './types';

/** Only the fields deciding which pull a provider offers. */
export interface BillingSourceSummary {
  cloud_provider: string;
  enabled?: boolean | null;
}

/**
 * The configured buckets a given cloud can actually pull from.
 *
 * Scoped to one provider because the Cost Report renders per cloud: an S3
 * bucket says nothing about whether the Azure tab has a container, and
 * offering a Detail Pull there whose only option is an AWS bucket is worse
 * than offering the Quick Pull that does work.
 *
 * A disabled source does not count. The pull route rejects it outright, so
 * treating it as "set up" would leave the tab with one button that refuses to
 * run and no fallback.
 */
export function sourcesForProvider<T extends BillingSourceSummary>(
  sources: readonly T[],
  provider: CloudProvider
): T[] {
  return sources.filter((source) => source.cloud_provider === provider && source.enabled !== false);
}

/**
 * True when this provider should offer the Detail Pull instead of Quick Pull.
 *
 * Exactly one of the two is ever shown. Quick Pull replaces a date range
 * wholesale, so when it runs after a Detail Pull it overwrites resource-level
 * CUR rows with grouped ones that carry no resource ids -- losing the detail
 * the Cost Leakage cost column depends on. Never showing both is what stops
 * that happening by a misclick.
 */
export function hasDetailPullSource(
  sources: readonly BillingSourceSummary[],
  provider: CloudProvider
): boolean {
  return sourcesForProvider(sources, provider).length > 0;
}
