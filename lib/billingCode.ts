/**
 * The billing-code tag, under whichever spelling it arrived in.
 *
 * The same rule is stated in SQL as private.billing_code_of, which backs the
 * generated billing_code column the Line Items filter queries. Filtering
 * happens in Postgres and display happens here, so neither side can call the
 * other — change the two together.
 */

/**
 * A CUR delivers every tag inside one JSON map, and keeps the full column name
 * as the key -- "resourceTags/user:Billing Code" rather than "Billing Code".
 * Cost Explorer pulls and hand uploads carry the bare name. Stripping the
 * prefix is what lets one rule cover both, and its absence is what made
 * billing codes disappear the moment CUR data replaced a Cost Explorer pull.
 */
const CUR_TAG_PREFIX = /^(resource[_\s-]?tags[/_])?user[:_]/i;

/**
 * True for the billing-code tag under any spelling.
 *
 * Tag keys are typed by hand in each cloud console, so the same tag shows up
 * as "Billing Code", "billing_code", "BillingCode", "billing-code" and so on.
 * Comparing on letters and digits alone treats them all as one tag.
 */
export function isBillingCodeTag(key: string): boolean {
  return key.replace(CUR_TAG_PREFIX, '').replace(/[^a-z0-9]/gi, '').toLowerCase() === 'billingcode';
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
