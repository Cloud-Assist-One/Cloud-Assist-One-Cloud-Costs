/**
 * The billing month a parsed file is for, taken from its contents.
 *
 * Used as the fallback when a bucket layout does not state the month, and as
 * a cross-check when it does — a manifest claiming August over rows that are
 * plainly July should fail the run rather than import into the wrong period.
 */
export function deriveBillingMonth(rows: readonly { usage_date: string }[]): string | null {
  const countByMonth = new Map<string, number>();

  for (const row of rows) {
    const match = /^(\d{4})-(\d{2})-\d{2}/.exec(row.usage_date ?? '');
    if (!match) continue;
    const month = `${match[1]}-${match[2]}-01`;
    countByMonth.set(month, (countByMonth.get(month) ?? 0) + 1);
  }

  if (countByMonth.size === 0) return null;

  // Sorted so an exact tie resolves toward the earlier month every time: a
  // re-pull of the same file must never land in a different period.
  return [...countByMonth.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0][0];
}
