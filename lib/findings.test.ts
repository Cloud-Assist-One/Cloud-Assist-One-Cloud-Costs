import { sortFindings, okCheck, unavailableCheck } from './findings';
import type { Finding } from './types';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'low',
    resourceId: 'id-1',
    resourceName: 'name-1',
    region: 'us-east-1',
    detail: 'detail',
    monthlyCost: null,
    ...overrides,
  };
}

describe('sortFindings', () => {
  it('orders critical before high before medium before low', () => {
    const sorted = sortFindings([
      finding({ severity: 'medium', resourceId: 'm' }),
      finding({ severity: 'critical', resourceId: 'c' }),
      finding({ severity: 'low', resourceId: 'l' }),
      finding({ severity: 'high', resourceId: 'h' }),
    ]);

    expect(sorted.map((f) => f.resourceId)).toEqual(['c', 'h', 'm', 'l']);
  });

  it('does not mutate the input array', () => {
    const input = [finding({ severity: 'low', resourceId: 'l' }), finding({ severity: 'critical', resourceId: 'c' })];

    sortFindings(input);

    expect(input.map((f) => f.resourceId)).toEqual(['l', 'c']);
  });
});

describe('okCheck', () => {
  it('builds an ok check with its findings sorted by severity', () => {
    const result = okCheck('sg-open', 'Security groups open to the internet', 'builtin', [
      finding({ severity: 'medium', resourceId: 'm' }),
      finding({ severity: 'critical', resourceId: 'c' }),
    ]);

    expect(result.status).toBe('ok');
    expect(result.unavailableReason).toBeNull();
    expect(result.source).toBe('builtin');
    expect(result.findings.map((f) => f.resourceId)).toEqual(['c', 'm']);
  });
});

describe('unavailableCheck', () => {
  it('carries the reason and no findings', () => {
    const result = unavailableCheck('sg-open', 'Security groups open to the internet', 'builtin', 'Access denied.');

    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toBe('Access denied.');
    expect(result.findings).toEqual([]);
  });
});
