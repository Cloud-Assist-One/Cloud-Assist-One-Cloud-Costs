import {
  DEFAULT_HOURLY_RATE_CENTS,
  formatHours,
  hourlyRateCentsFor,
  invoiceAmountCents,
} from './consultingRate';

describe('hourlyRateCentsFor', () => {
  it('defaults to $175/hr when the company has no rate', () => {
    expect(DEFAULT_HOURLY_RATE_CENTS).toBe(17500);
    expect(hourlyRateCentsFor(null)).toBe(17500);
    expect(hourlyRateCentsFor(undefined)).toBe(17500);
  });

  it('prefers a negotiated per-company rate', () => {
    expect(hourlyRateCentsFor(22500)).toBe(22500);
  });

  it('honours a deliberate zero rate for pro bono work', () => {
    expect(hourlyRateCentsFor(0)).toBe(0);
  });

  it('falls back to the default on a nonsense rate', () => {
    expect(hourlyRateCentsFor(-100)).toBe(17500);
    expect(hourlyRateCentsFor(Number.NaN)).toBe(17500);
  });
});

describe('invoiceAmountCents', () => {
  it('bills a whole hour at the full rate', () => {
    expect(invoiceAmountCents(60, 17500)).toBe(17500);
  });

  it('bills 90 minutes at one and a half times the rate', () => {
    expect(invoiceAmountCents(90, 17500)).toBe(26250);
  });

  it('returns whole cents for a rate that does not divide evenly', () => {
    const amount = invoiceAmountCents(50, 17500);
    expect(amount).toBe(14583);
    expect(Number.isInteger(amount)).toBe(true);
  });

  it('is 0 for zero minutes', () => {
    expect(invoiceAmountCents(0, 17500)).toBe(0);
  });
});

describe('formatHours', () => {
  it('renders minutes as decimal hours for the invoice line', () => {
    expect(formatHours(90)).toBe('1.5');
    expect(formatHours(60)).toBe('1');
    expect(formatHours(50)).toBe('0.83');
  });
});
