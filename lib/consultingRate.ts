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

/**
 * Integer cents throughout -- money never touches a float we keep.
 *
 * Guarded, unlike a naive multiply: these amounts become real Stripe invoice
 * items, so a negative duration or a NaN leaking in from upstream must resolve
 * to zero rather than becoming a negative charge or a NaN on a customer's
 * invoice. `|| 0` also normalises -0 to 0.
 */
export function invoiceAmountCents(minutes: number, rateCents: number): number {
  if (!Number.isFinite(minutes) || !Number.isFinite(rateCents)) return 0;
  if (minutes <= 0 || rateCents <= 0) return 0;
  return Math.round((minutes / 60) * rateCents) || 0;
}
