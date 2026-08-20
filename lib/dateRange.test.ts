import { computeDateRange, shiftReferenceDate } from './dateRange';

describe('computeDateRange', () => {
  it('returns the same start and end for "day"', () => {
    const range = computeDateRange('day', new Date(Date.UTC(2026, 6, 15)));
    expect(range).toEqual({ start: '2026-07-15', end: '2026-07-15' });
  });

  it('returns Monday-Sunday for "week", for a mid-week reference date', () => {
    // 2026-07-15 is a Wednesday
    const range = computeDateRange('week', new Date(Date.UTC(2026, 6, 15)));
    expect(range).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('returns Monday-Sunday for "week", when the reference date is a Sunday', () => {
    // 2026-07-19 is a Sunday
    const range = computeDateRange('week', new Date(Date.UTC(2026, 6, 19)));
    expect(range).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('returns the first and last day of the month for "month"', () => {
    const range = computeDateRange('month', new Date(Date.UTC(2026, 6, 15)));
    expect(range).toEqual({ start: '2026-07-01', end: '2026-07-31' });
  });
});

describe('shiftReferenceDate', () => {
  it('shifts by one day', () => {
    const result = shiftReferenceDate('day', new Date(Date.UTC(2026, 6, 15)), 1);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-16');
  });

  it('shifts by one week', () => {
    const result = shiftReferenceDate('week', new Date(Date.UTC(2026, 6, 15)), -1);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-08');
  });

  it('shifts by one month, rolling over into the next year', () => {
    const result = shiftReferenceDate('month', new Date(Date.UTC(2026, 11, 15)), 1);
    expect(result.toISOString().slice(0, 10)).toBe('2027-01-15');
  });
});
