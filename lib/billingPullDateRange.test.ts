import { resolvePullDateRange } from './billingPullDateRange';

describe('resolvePullDateRange', () => {
  it('returns the full month range for a past month', () => {
    const result = resolvePullDateRange('2026-06-01', new Date('2026-08-19T12:00:00Z'));
    expect(result).toEqual({ rangeStart: '2026-06-01', rangeEnd: '2026-07-01' });
  });

  it('returns a month-to-date range ending tomorrow for the current month', () => {
    const result = resolvePullDateRange('2026-08-01', new Date('2026-08-19T12:00:00Z'));
    expect(result).toEqual({ rangeStart: '2026-08-01', rangeEnd: '2026-08-20' });
  });

  it('handles a past month that crosses a year boundary', () => {
    const result = resolvePullDateRange('2025-12-01', new Date('2026-01-15T00:00:00Z'));
    expect(result).toEqual({ rangeStart: '2025-12-01', rangeEnd: '2026-01-01' });
  });

  it('rolls into the next month when today is the last day of the current month', () => {
    const result = resolvePullDateRange('2026-08-01', new Date('2026-08-31T12:00:00Z'));
    expect(result).toEqual({ rangeStart: '2026-08-01', rangeEnd: '2026-09-01' });
  });

  it('throws for a month after the current calendar month', () => {
    expect(() => resolvePullDateRange('2026-09-01', new Date('2026-08-19T12:00:00Z'))).toThrow(
      'billingMonth cannot be after the current calendar month.'
    );
  });
});
