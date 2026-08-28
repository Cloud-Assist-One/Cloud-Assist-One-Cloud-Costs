import { formatCost, preciseNumber } from './formatCost';

describe('formatCost', () => {
  it('renders an ordinary amount to the cent', () => {
    expect(formatCost(12.3)).toBe('$12.30');
    expect(formatCost(1234.567)).toBe('$1234.57');
  });

  it('renders exact zero as zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  // The reason this exists. A quarter of a real CUR month costs a fraction of
  // a penny, and rendering those as "$0.00" made the rows look like nothing
  // and made the zero-cost filter look broken.
  it('never shows a real cost as $0.00', () => {
    expect(formatCost(0.0000004)).toBe('<$0.01');
    expect(formatCost(0.004)).toBe('<$0.01');
  });

  it('shows a credit too small to round as a credit, not as zero', () => {
    expect(formatCost(-0.0000004)).toBe('>-$0.01');
  });

  it('rounds up to a real cent once there is one', () => {
    expect(formatCost(0.005)).toBe('$0.01');
    expect(formatCost(0.01)).toBe('$0.01');
  });

  it('keeps negatives readable as negatives', () => {
    expect(formatCost(-12.3)).toBe('-$12.30');
  });

  it('renders a missing cost as an em dash rather than zero', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
  });

  it('does not render NaN', () => {
    expect(formatCost(Number.NaN)).toBe('—');
  });
});

describe('preciseNumber', () => {
  it('gives back an ordinary number unchanged', () => {
    expect(preciseNumber(12.3)).toBe('12.3');
    expect(preciseNumber(24)).toBe('24');
  });

  // The whole point of the hover: the cell shows "<$0.01" and this shows what
  // it actually was.
  it('spells out a value the cell had to round away', () => {
    expect(preciseNumber(0.0000004)).toBe('0.0000004');
  });

  // String(0.0000000002) is "2e-10", which is not a number anyone wants to
  // read off a billing row.
  it('never falls back to exponential notation', () => {
    expect(preciseNumber(0.0000000002)).toBe('0.0000000002');
    expect(preciseNumber(0.0000000002)).not.toContain('e');
  });

  it('does not pad an exact value with trailing zeros', () => {
    expect(preciseNumber(0.5)).toBe('0.5');
    expect(preciseNumber(0)).toBe('0');
  });

  it('keeps the sign on a credit', () => {
    expect(preciseNumber(-0.0000004)).toBe('-0.0000004');
  });

  it('says nothing for a missing value', () => {
    expect(preciseNumber(null)).toBe('');
    expect(preciseNumber(undefined)).toBe('');
    expect(preciseNumber(Number.NaN)).toBe('');
  });
});
