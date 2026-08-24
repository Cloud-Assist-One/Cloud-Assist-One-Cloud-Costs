import { getResourceAgeColor } from './resourceAge';

describe('getResourceAgeColor', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns orange for something created within the last 24 hours', () => {
    expect(getResourceAgeColor('2026-08-24T00:00:01.000Z')).toBe('orange');
  });

  it('returns blue for something created within the last week', () => {
    expect(getResourceAgeColor('2026-08-20T12:00:00.000Z')).toBe('blue');
  });

  it('returns green for something created within the last month', () => {
    expect(getResourceAgeColor('2026-08-01T12:00:00.000Z')).toBe('green');
  });

  it('returns null for something older than a month', () => {
    expect(getResourceAgeColor('2026-06-01T12:00:00.000Z')).toBeNull();
  });

  it('returns null when no creation date is available', () => {
    expect(getResourceAgeColor(null)).toBeNull();
    expect(getResourceAgeColor(undefined)).toBeNull();
  });

  it('returns null for an unparseable date', () => {
    expect(getResourceAgeColor('not-a-date')).toBeNull();
  });
});
