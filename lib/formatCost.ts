/**
 * A cost as the grid shows it.
 *
 * Two decimals for anything that has them, and an explicit "less than a cent"
 * for anything that does not. Provider line items run to ten decimal places,
 * so a quarter of a real CUR month costs a fraction of a penny -- rendering
 * those as "$0.00" made real charges look like nothing, and made the
 * hide-zero-cost filter look broken when those rows stayed on screen.
 *
 * Nothing is hidden or rounded away in the data itself: these numbers are
 * reconciled against the provider's own invoice, so the totals have to include
 * every fraction. Only the rendering changes.
 *
 * Follows the same idiom formatQuantity already uses in the line items grid.
 */

/** Below this a two-decimal render would read as zero. */
const SMALLEST_SHOWN = 0.005;

export function formatCost(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';

  if (amount !== 0 && Math.abs(amount) < SMALLEST_SHOWN) {
    return amount > 0 ? '<$0.01' : '>-$0.01';
  }

  // Sign outside the dollar mark: "-$12.30" rather than "$-12.30".
  return amount < 0 ? `-$${Math.abs(amount).toFixed(2)}` : `$${amount.toFixed(2)}`;
}

/**
 * The exact figure, for a tooltip beside the rounded one.
 *
 * String() switches to exponential notation below 1e-6, so a rate of
 * 0.0000000002 would render as "2e-10" -- not a number anyone wants to read
 * off a billing row. toFixed keeps it decimal; the trailing zeros it adds are
 * then trimmed so an exact value is not padded out.
 */
export function preciseNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);

  // Twelve covers the ten decimal places provider line items carry.
  return value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}
