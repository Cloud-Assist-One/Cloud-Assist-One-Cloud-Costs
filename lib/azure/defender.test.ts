import { classifyDefenderError, normalizeDefenderAssessments, mapDefenderSeverity } from './defender';

function restError(statusCode: number, code?: string) {
  const err = new Error(code ?? `HTTP ${statusCode}`) as Error & { statusCode?: number; code?: string };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

describe('classifyDefenderError', () => {
  it('treats SubscriptionNotRegistered as the service not being enabled', () => {
    expect(classifyDefenderError(restError(409, 'SubscriptionNotRegistered'))).toEqual({ kind: 'not-enabled' });
  });

  it('treats MissingSubscriptionRegistration as the service not being enabled', () => {
    expect(classifyDefenderError(restError(409, 'MissingSubscriptionRegistration'))).toEqual({ kind: 'not-enabled' });
  });

  it('treats a 403 as a missing role worth reporting', () => {
    const result = classifyDefenderError(restError(403));

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('Security Reader');
  });

  it('treats an unrecognized error as unavailable rather than silently falling back', () => {
    const result = classifyDefenderError(new Error('getaddrinfo ENOTFOUND'));

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('ENOTFOUND');
  });
});

describe('mapDefenderSeverity', () => {
  it('maps High to high and Medium to medium', () => {
    expect(mapDefenderSeverity('High')).toBe('high');
    expect(mapDefenderSeverity('Medium')).toBe('medium');
  });

  it('maps Low to low', () => {
    expect(mapDefenderSeverity('Low')).toBe('low');
  });

  it('defaults an unknown severity to medium', () => {
    expect(mapDefenderSeverity(null)).toBe('medium');
    expect(mapDefenderSeverity('Nonsense')).toBe('medium');
  });
});

describe('normalizeDefenderAssessments', () => {
  const base = {
    id: '/subscriptions/s1/providers/Microsoft.Security/assessments/a1',
    assessmentKey: 'storage-public-access',
    displayName: 'Storage accounts should restrict public access',
    description: 'Public access exposes container contents anonymously.',
    severity: 'High',
    statusCode: 'Unhealthy',
    resourceId: '/subscriptions/s1/storage/sa-1',
    resourceName: 'sa-1',
  };

  it('groups assessments sharing a key into one check', () => {
    const checks = normalizeDefenderAssessments([
      base,
      { ...base, id: 'a2', resourceId: '/subscriptions/s1/storage/sa-2', resourceName: 'sa-2' },
    ]);

    expect(checks).toHaveLength(1);
    expect(checks[0].findings).toHaveLength(2);
    expect(checks[0].title).toBe('Storage accounts should restrict public access');
  });

  it('drops healthy assessments, which are passing controls rather than findings', () => {
    const checks = normalizeDefenderAssessments([{ ...base, statusCode: 'Healthy' }]);

    expect(checks).toEqual([]);
  });

  it('drops not-applicable assessments', () => {
    const checks = normalizeDefenderAssessments([{ ...base, statusCode: 'NotApplicable' }]);

    expect(checks).toEqual([]);
  });

  it('marks normalized checks as native', () => {
    const checks = normalizeDefenderAssessments([base]);

    expect(checks[0].source).toBe('native');
    expect(checks[0].status).toBe('ok');
  });

  it('carries severity, resource and description onto each finding', () => {
    const checks = normalizeDefenderAssessments([base]);

    expect(checks[0].findings[0]).toMatchObject({
      severity: 'high',
      resourceId: '/subscriptions/s1/storage/sa-1',
      resourceName: 'sa-1',
      detail: 'Public access exposes container contents anonymously.',
      monthlyCost: null,
    });
  });
});
