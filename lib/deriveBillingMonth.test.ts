import { deriveBillingMonth } from './deriveBillingMonth';

function rows(...dates: string[]) {
  return dates.map((usage_date) => ({ usage_date }));
}

describe('deriveBillingMonth', () => {
  it('returns the first day of the month the rows belong to', () => {
    expect(deriveBillingMonth(rows('2026-08-01', '2026-08-15', '2026-08-31'))).toBe('2026-08-01');
  });

  // A CUR often carries a few days either side of the boundary. The month
  // holding most of the usage is the month the file is for.
  it('picks the month holding the most rows when a file straddles a boundary', () => {
    expect(deriveBillingMonth(rows('2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03'))).toBe('2026-08-01');
  });

  // Deterministic beats arbitrary: an exact tie always resolves the same way,
  // so a re-pull of the same file cannot land in a different period.
  it('breaks an exact tie toward the earlier month', () => {
    expect(deriveBillingMonth(rows('2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'))).toBe('2026-07-01');
  });

  it('returns null for an empty parse', () => {
    expect(deriveBillingMonth([])).toBeNull();
  });

  it('ignores rows whose date is unusable rather than failing the whole file', () => {
    expect(deriveBillingMonth(rows('not-a-date', '2026-08-10', '2026-08-11'))).toBe('2026-08-01');
  });

  it('returns null when no row has a usable date', () => {
    expect(deriveBillingMonth(rows('not-a-date', ''))).toBeNull();
  });
});
