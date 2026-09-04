/**
 * The standard consulting rate, in cents. Not a secret, so it lives in
 * version control where a change is reviewable rather than in an env var.
 * A company may override it via companies.hourly_rate_cents.
 */
export const DEFAULT_HOURLY_RATE_CENTS = 17_500;

export function hourlyRateCentsFor(companyRate: number | null | undefined): number {
  if (typeof companyRate !== 'number') return DEFAULT_HOURLY_RATE_CENTS;
  if (!Number.isFinite(companyRate) || companyRate < 0) return DEFAULT_HOURLY_RATE_CENTS;
  return Math.round(companyRate);
}

/** Integer cents throughout -- money never touches a float we keep. */
export function invoiceAmountCents(minutes: number, rateCents: number): number {
  return Math.round((minutes / 60) * rateCents);
}

/** Decimal hours for the human-readable invoice line, e.g. "1.5". */
export function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return String(Number(hours.toFixed(2)));
}
