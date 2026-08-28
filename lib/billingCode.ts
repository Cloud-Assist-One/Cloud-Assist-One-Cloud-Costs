/**
 * The billing-code tag, under whichever spelling it arrived in.
 *
 * The same rule is stated in SQL as private.billing_code_of, which backs the
 * generated billing_code column the Line Items filter queries. Filtering
 * happens in Postgres and display happens here, so neither side can call the
 * other — change the two together.
 */

/**
 * True for the billing-code tag under any spelling.
 *
 * Tag keys are typed by hand in each cloud console, so the same tag shows up
 * as "Billing Code", "billing_code", "BillingCode", "billing-code" and so on.
 * Comparing on letters and digits alone treats them all as one tag.
 */
export function isBillingCodeTag(key: string): boolean {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'billingcode';
}

/**
 * Shows only the billing code, not the whole tag set.
 *
 * A resource can carry dozens of tags, which made the column an unreadable
 * run-on string. The billing code is the one this grid is used to group by.
 */
export function formatTags(tags: Record<string, string> | null): string {
  if (!tags) return '—';
  const matches = Object.entries(tags).filter(([key]) => isBillingCodeTag(key));
  if (matches.length === 0) return '—';
  // Keyed only by value: the column header already says what it is, and a
  // resource tagged twice under different spellings should read as its
  // values, not repeat the key.
  return matches.map(([, value]) => value).join(', ');
}
