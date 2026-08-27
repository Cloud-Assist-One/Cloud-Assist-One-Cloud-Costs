import { classifySecurityHubError, normalizeSecurityHubFindings, mapSecurityHubSeverity } from './securityHub';

function awsError(name: string, httpStatusCode?: number) {
  const err = new Error(`${name} occurred`) as Error & { name: string; $metadata?: { httpStatusCode?: number } };
  err.name = name;
  if (httpStatusCode) err.$metadata = { httpStatusCode };
  return err;
}

describe('classifySecurityHubError', () => {
  it('treats InvalidAccessException as the service simply not being enabled', () => {
    expect(classifySecurityHubError(awsError('InvalidAccessException'))).toEqual({ kind: 'not-enabled' });
  });

  it('treats AccessDeniedException as a permissions problem worth reporting', () => {
    const result = classifySecurityHubError(awsError('AccessDeniedException'));

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('securityhub:GetFindings');
  });

  it('treats an HTTP 403 as a permissions problem even when the name is unfamiliar', () => {
    const result = classifySecurityHubError(awsError('SomeOtherException', 403));

    expect(result.kind).toBe('unavailable');
  });

  it('treats an unrecognized error as unavailable rather than silently falling back', () => {
    const result = classifySecurityHubError(new Error('socket hang up'));

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('socket hang up');
  });

  it('handles a thrown non-Error value', () => {
    const result = classifySecurityHubError('something odd');

    expect(result.kind).toBe('unavailable');
  });
});

describe('mapSecurityHubSeverity', () => {
  it('maps CRITICAL and HIGH straight through', () => {
    expect(mapSecurityHubSeverity('CRITICAL')).toBe('critical');
    expect(mapSecurityHubSeverity('HIGH')).toBe('high');
  });

  it('maps MEDIUM to medium and both LOW and INFORMATIONAL to low', () => {
    expect(mapSecurityHubSeverity('MEDIUM')).toBe('medium');
    expect(mapSecurityHubSeverity('LOW')).toBe('low');
    expect(mapSecurityHubSeverity('INFORMATIONAL')).toBe('low');
  });

  it('defaults an unknown or missing label to medium', () => {
    expect(mapSecurityHubSeverity(null)).toBe('medium');
    expect(mapSecurityHubSeverity('WEIRD')).toBe('medium');
  });
});

describe('normalizeSecurityHubFindings', () => {
  const base = {
    id: 'finding-1',
    title: 'S3 buckets should prohibit public read access',
    description: 'This control checks whether the bucket allows public reads.',
    severityLabel: 'CRITICAL',
    region: 'us-east-1',
    resourceId: 'arn:aws:s3:::assets',
    generatorId: 's3-bucket-public-read-prohibited',
  };

  it('groups findings that share a control into one check', () => {
    const checks = normalizeSecurityHubFindings([
      base,
      { ...base, id: 'finding-2', resourceId: 'arn:aws:s3:::logs' },
    ]);

    expect(checks).toHaveLength(1);
    expect(checks[0].findings).toHaveLength(2);
    expect(checks[0].title).toBe('S3 buckets should prohibit public read access');
  });

  it('marks every normalized check as sourced from the native service', () => {
    const checks = normalizeSecurityHubFindings([base]);

    expect(checks[0].source).toBe('native');
    expect(checks[0].status).toBe('ok');
  });

  it('splits findings from different controls into separate checks', () => {
    const checks = normalizeSecurityHubFindings([
      base,
      { ...base, id: 'finding-3', generatorId: 'iam-root-access-key-check', title: 'Root user should not have keys' },
    ]);

    expect(checks).toHaveLength(2);
    expect(checks.map((check) => check.title).sort()).toEqual([
      'Root user should not have keys',
      'S3 buckets should prohibit public read access',
    ]);
  });

  it('carries the severity, resource and description onto each finding', () => {
    const checks = normalizeSecurityHubFindings([base]);

    expect(checks[0].findings[0]).toMatchObject({
      severity: 'critical',
      resourceId: 'arn:aws:s3:::assets',
      region: 'us-east-1',
      detail: 'This control checks whether the bucket allows public reads.',
      monthlyCost: null,
    });
  });

  it('shortens the resource ARN into a readable name', () => {
    const checks = normalizeSecurityHubFindings([base]);

    expect(checks[0].findings[0].resourceName).toBe('assets');
  });

  it('returns no checks for an empty finding list', () => {
    expect(normalizeSecurityHubFindings([])).toEqual([]);
  });
});
