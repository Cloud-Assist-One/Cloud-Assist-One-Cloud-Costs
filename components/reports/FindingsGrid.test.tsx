import { render, screen, within } from '@testing-library/react';
import FindingsGrid from './FindingsGrid';
import type { CheckResult, Finding } from '@/lib/types';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'medium',
    resourceId: 'arn:res-1',
    resourceName: 'res-1',
    region: 'us-east-1',
    detail: 'Something is wrong.',
    monthlyCost: null,
    ...overrides,
  };
}

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    checkId: 'check-1',
    title: 'Open security groups',
    source: 'builtin',
    status: 'ok',
    unavailableReason: null,
    findings: [finding()],
    ...overrides,
  };
}

describe('FindingsGrid', () => {
  it('renders a section per check with a count badge', () => {
    render(
      <FindingsGrid
        kind="security-checks"
        checks={[check({ checkId: 'a', title: 'Open security groups', findings: [finding(), finding()] })]}
      />
    );

    expect(screen.getByRole('heading', { name: 'Open security groups' })).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows the reason and no table when a check could not run', () => {
    render(
      <FindingsGrid
        kind="security-checks"
        checks={[
          check({
            status: 'unavailable',
            unavailableReason: 'The credential needs ec2:DescribeSecurityGroups.',
            findings: [],
          }),
        ]}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('ec2:DescribeSecurityGroups');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('never says "no findings" for an unavailable check', () => {
    render(
      <FindingsGrid
        kind="security-checks"
        checks={[check({ status: 'unavailable', unavailableReason: 'Access denied.', findings: [] })]}
      />
    );

    expect(screen.queryByText(/no findings/i)).not.toBeInTheDocument();
  });

  it('says the check passed when it ran and found nothing', () => {
    render(<FindingsGrid kind="security-checks" checks={[check({ findings: [] })]} />);

    expect(screen.getByText(/no findings/i)).toBeInTheDocument();
  });

  it('shows a severity column for security checks', () => {
    render(<FindingsGrid kind="security-checks" checks={[check({ findings: [finding({ severity: 'critical' })] })]} />);

    expect(screen.getByRole('columnheader', { name: /severity/i })).toBeInTheDocument();
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /monthly cost/i })).not.toBeInTheDocument();
  });

  it('shows a monthly cost column for cost leakage instead of severity', () => {
    render(
      <FindingsGrid
        kind="cost-leakage"
        checks={[check({ title: 'Unattached EBS volumes', findings: [finding({ monthlyCost: 42.5 })] })]}
      />
    );

    expect(screen.getByRole('columnheader', { name: /monthly cost/i })).toBeInTheDocument();
    expect(screen.getByText('$42.50')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /severity/i })).not.toBeInTheDocument();
  });

  it('renders an unmatched cost as a dash, not as zero', () => {
    render(<FindingsGrid kind="cost-leakage" checks={[check({ findings: [finding({ monthlyCost: null })] })]} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('sorts leakage findings by cost descending with unknown costs last', () => {
    render(
      <FindingsGrid
        kind="cost-leakage"
        checks={[
          check({
            findings: [
              finding({ resourceName: 'cheap', monthlyCost: 5 }),
              finding({ resourceName: 'unknown', monthlyCost: null }),
              finding({ resourceName: 'expensive', monthlyCost: 500 }),
            ],
          }),
        ]}
      />
    );

    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      'expensive',
      'cheap',
      'unknown',
    ]);
  });

  it('labels a check whose findings came from the provider native service', () => {
    render(<FindingsGrid kind="security-checks" checks={[check({ source: 'native' })]} />);

    expect(screen.getByText(/security hub \/ defender/i)).toBeInTheDocument();
  });
});
