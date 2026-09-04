import {
  DEFAULT_HOURLY_RATE_CENTS,
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

  // These feed real Stripe invoice items. A defect upstream must not become a
  // negative or NaN charge on a customer's card.
  it('never produces a negative charge', () => {
    expect(invoiceAmountCents(-30, 17500)).toBe(0);
  });

  it('is 0 for non-finite minutes rather than propagating NaN', () => {
    expect(invoiceAmountCents(Number.NaN, 17500)).toBe(0);
    expect(invoiceAmountCents(Number.POSITIVE_INFINITY, 17500)).toBe(0);
  });

  it('is 0 for a non-finite rate', () => {
    expect(invoiceAmountCents(60, Number.NaN)).toBe(0);
  });

  it('never returns -0', () => {
    expect(Object.is(invoiceAmountCents(0, 17500), -0)).toBe(false);
  });
});
