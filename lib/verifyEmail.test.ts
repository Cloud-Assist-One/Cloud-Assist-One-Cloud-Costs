import { resourceVerifyMailto, findingVerifyMailto } from './verifyEmail';
import type { CheckResult, Finding } from './types';

// Reading a mailto: assertion is unbearable percent-encoded, so every test
// decodes the two parts back to plain text before asserting on them.
function parts(href: string): { subject: string; body: string } {
  const query = href.slice('mailto:?'.length);
  const params = new URLSearchParams(query);
  return { subject: params.get('subject') ?? '', body: params.get('body') ?? '' };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'critical',
    resourceId: 'sg-1',
    resourceName: 'web',
    region: 'us-east-1',
    detail: 'Security group web (sg-1) allows inbound traffic from the internet on port 22.',
    monthlyCost: null,
    ...overrides,
  };
}

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    checkId: 'open-security-groups',
    title: 'Security groups open to the internet',
    source: 'builtin',
    status: 'ok',
    unavailableReason: null,
    findings: [],
    ...overrides,
  };
}

describe('resourceVerifyMailto', () => {
  it('names AWS in the subject for an AWS resource', () => {
    const { subject } = parts(resourceVerifyMailto('aws', 'EC2 instance', 'web-1'));

    expect(subject).toBe('Verify AWS resource: EC2 instance web-1');
  });

  // The pre-existing helper hardcoded "AWS", so Azure tabs emailed clients
  // about an "AWS resource: Virtual Machine". This is the regression test
  // that bug never had.
  it('names Azure in the subject for an Azure resource', () => {
    const { subject } = parts(resourceVerifyMailto('azure', 'Virtual Machine', 'vm-1'));

    expect(subject).toBe('Verify Azure resource: Virtual Machine vm-1');
  });

  it('keeps the established body wording', () => {
    const { body } = parts(resourceVerifyMailto('aws', 'S3 bucket', 'assets'));

    expect(body).toBe('Please verify this S3 bucket "assets" is valid and let me know what it is being used for.');
  });

  it('percent-encodes the mailto so a name with spaces survives', () => {
    const href = resourceVerifyMailto('aws', 'EC2 instance', 'my web server');

    expect(href.startsWith('mailto:?subject=')).toBe(true);
    expect(href).not.toContain('my web server');
    expect(parts(href).subject).toContain('my web server');
  });
});

describe('findingVerifyMailto for security checks', () => {
  it('asks whether the exposure is intentional', () => {
    const { body } = parts(findingVerifyMailto('aws', 'security-checks', check(), finding()));

    expect(body).toContain('Is this intentional?');
    expect(body).toContain('can it be restricted?');
  });

  it('names the provider and the resource in the subject', () => {
    const { subject } = parts(findingVerifyMailto('aws', 'security-checks', check(), finding()));

    expect(subject).toBe('Verify AWS security finding: web');
  });

  it('names Azure for an Azure finding', () => {
    const { subject } = parts(findingVerifyMailto('azure', 'security-checks', check(), finding()));

    expect(subject).toContain('Azure');
  });

  it('quotes the check title, severity, resource, region and the finding detail', () => {
    const { body } = parts(findingVerifyMailto('aws', 'security-checks', check(), finding()));

    expect(body).toContain('Security groups open to the internet');
    expect(body).toContain('critical');
    expect(body).toContain('web');
    expect(body).toContain('us-east-1');
    expect(body).toContain('allows inbound traffic from the internet on port 22');
  });

  it('omits the region line when the finding has no region', () => {
    const { body } = parts(findingVerifyMailto('aws', 'security-checks', check(), finding({ region: null })));

    expect(body).not.toContain('Region:');
  });

  it('never mentions cost, since security findings are not priced', () => {
    const { body } = parts(
      findingVerifyMailto('aws', 'security-checks', check(), finding({ monthlyCost: 12.5 }))
    );

    expect(body).not.toContain('Cost:');
  });
});

describe('findingVerifyMailto for cost leakage', () => {
  const leakCheck = check({ checkId: 'unattached-ebs-volumes', title: 'Unattached EBS volumes' });
  const leak = finding({
    severity: 'low',
    resourceId: 'vol-1',
    resourceName: 'scratch',
    detail: 'Volume vol-1 (200 GiB) is not attached to any instance and bills for its full provisioned size.',
    monthlyCost: 8.4,
  });

  it('asks whether the resource can be deleted', () => {
    const { body } = parts(findingVerifyMailto('aws', 'cost-leakage', leakCheck, leak));

    expect(body).toContain('Is this still needed, or can it be deleted?');
  });

  it('calls it an unused resource in the subject', () => {
    const { subject } = parts(findingVerifyMailto('aws', 'cost-leakage', leakCheck, leak));

    expect(subject).toBe('Verify AWS unused resource: scratch');
  });

  it('includes the monthly cost when it is known', () => {
    const { body } = parts(findingVerifyMailto('aws', 'cost-leakage', leakCheck, leak));

    expect(body).toContain('Cost:');
    expect(body).toContain('$8.40/mo');
  });

  // A resource missing from the billing pull has an unknown cost, not a
  // zero one. Emailing a client "Cost: $0.00/mo" about something we want
  // deleted would be actively misleading.
  it('omits the cost line entirely when the cost is unknown', () => {
    const { body } = parts(findingVerifyMailto('aws', 'cost-leakage', leakCheck, { ...leak, monthlyCost: null }));

    expect(body).not.toContain('Cost:');
    expect(body).not.toContain('$0.00');
    expect(body).not.toContain('—');
  });

  it('still includes a genuine zero cost', () => {
    const { body } = parts(findingVerifyMailto('aws', 'cost-leakage', leakCheck, { ...leak, monthlyCost: 0 }));

    expect(body).toContain('$0.00/mo');
  });

  it('never mentions severity, since every leakage finding is low', () => {
    const { body } = parts(findingVerifyMailto('aws', 'cost-leakage', leakCheck, leak));

    expect(body).not.toContain('Severity:');
  });
});
