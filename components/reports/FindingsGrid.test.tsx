import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  it('renders a section per check with a count badge', async () => {
    render(
      <FindingsGrid
        provider="aws"
        companyId="company-1"
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
        provider="aws"
        companyId="company-1"
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
        provider="aws"
        companyId="company-1"
        kind="security-checks"
        checks={[check({ status: 'unavailable', unavailableReason: 'Access denied.', findings: [] })]}
      />
    );

    expect(screen.queryByText(/no findings/i)).not.toBeInTheDocument();
  });

  it('says the check passed when it ran and found nothing', () => {
    render(<FindingsGrid provider="aws"
        companyId="company-1" kind="security-checks" checks={[check({ findings: [] })]} />);

    expect(screen.getByText(/no findings/i)).toBeInTheDocument();
  });

  it('shows a severity column for security checks', () => {
    render(<FindingsGrid provider="aws"
        companyId="company-1" kind="security-checks" checks={[check({ findings: [finding({ severity: 'critical' })] })]} />);

    expect(screen.getByRole('columnheader', { name: /severity/i })).toBeInTheDocument();
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /monthly cost/i })).not.toBeInTheDocument();
  });

  it('shows a monthly cost column for cost leakage instead of severity', () => {
    render(
      <FindingsGrid
        provider="aws"
        companyId="company-1"
        kind="cost-leakage"
        checks={[check({ title: 'Unattached EBS volumes', findings: [finding({ monthlyCost: 42.5 })] })]}
      />
    );

    expect(screen.getByRole('columnheader', { name: /monthly cost/i })).toBeInTheDocument();
    expect(screen.getByText('$42.50')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /severity/i })).not.toBeInTheDocument();
  });

  it('renders an unmatched cost as a dash, not as zero', () => {
    render(<FindingsGrid provider="aws"
        companyId="company-1" kind="cost-leakage" checks={[check({ findings: [finding({ monthlyCost: null })] })]} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('sorts leakage findings by cost descending with unknown costs last', () => {
    render(
      <FindingsGrid
        provider="aws"
        companyId="company-1"
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
    render(<FindingsGrid provider="aws"
        companyId="company-1" kind="security-checks" checks={[check({ source: 'native' })]} />);

    expect(screen.getByText(/security hub \/ defender/i)).toBeInTheDocument();
  });

  it('orders security-checks sections by their most severe finding, critical first', () => {
    render(
      <FindingsGrid
        provider="aws"
        companyId="company-1"
        kind="security-checks"
        checks={[
          check({ checkId: 'medium-1', title: 'Medium check', findings: [finding({ severity: 'medium' })] }),
          check({ checkId: 'critical-1', title: 'Critical check', findings: [finding({ severity: 'critical' })] }),
          check({ checkId: 'high-1', title: 'High check', findings: [finding({ severity: 'high' })] }),
        ]}
      />
    );

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual(['Critical check', 'High check', 'Medium check']);
  });

  it('ranks a section by its single most severe finding, not its first one', () => {
    render(
      <FindingsGrid
        provider="aws"
        companyId="company-1"
        kind="security-checks"
        checks={[
          check({ checkId: 'high-only', title: 'High only', findings: [finding({ severity: 'high' })] }),
          check({
            checkId: 'mixed',
            title: 'Mostly low, one critical',
            findings: [finding({ severity: 'low' }), finding({ severity: 'critical' })],
          }),
        ]}
      />
    );

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual(['Mostly low, one critical', 'High only']);
  });

  it('puts an unavailable section first, ahead of every severity', () => {
    render(
      <FindingsGrid
        provider="aws"
        companyId="company-1"
        kind="security-checks"
        checks={[
          check({ checkId: 'critical-1', title: 'Critical check', findings: [finding({ severity: 'critical' })] }),
          check({
            checkId: 'unavailable-1',
            title: 'Could not run',
            status: 'unavailable',
            unavailableReason: 'Access denied.',
            findings: [],
          }),
        ]}
      />
    );

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual(['Could not run', 'Critical check']);
  });

  it('puts a clean (no-findings) section after every section with findings', () => {
    render(
      <FindingsGrid
        provider="aws"
        companyId="company-1"
        kind="security-checks"
        checks={[
          check({ checkId: 'clean-1', title: 'Clean check', findings: [] }),
          check({ checkId: 'low-1', title: 'Low check', findings: [finding({ severity: 'low' })] }),
        ]}
      />
    );

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual(['Low check', 'Clean check']);
  });

  it('leaves cost-leakage section order untouched (route push order, not severity)', () => {
    render(
      <FindingsGrid
        provider="aws"
        companyId="company-1"
        kind="cost-leakage"
        checks={[
          check({ checkId: 'b', title: 'Second pushed' }),
          check({ checkId: 'a', title: 'First pushed' }),
        ]}
      />
    );

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual(['Second pushed', 'First pushed']);
  });

  describe('the Verify action', () => {
    function decodedHref(link: HTMLElement): string {
      return decodeURIComponent(link.getAttribute('href') ?? '');
    }

    // The mailto now sits behind the Email item in the row's menu.
    async function openMenu(rowName?: RegExp): Promise<HTMLElement> {
      const user = userEvent.setup();
      const triggers = screen.getAllByRole('button', { name: rowName ?? /verify this finding/i });
      await user.click(triggers[0]);
      return screen.getByRole('menuitem', { name: /^email$/i });
    }

    it('renders one Verify link per finding row', () => {
      render(
        <FindingsGrid
          provider="aws"
        companyId="company-1"
          kind="security-checks"
          checks={[check({ findings: [finding({ resourceName: 'one' }), finding({ resourceName: 'two' })] })]}
        />
      );

      expect(screen.getAllByRole('button', { name: /verify this finding/i })).toHaveLength(2);
    });

    it('builds a mailto carrying the check title and the finding detail', async () => {
      render(
        <FindingsGrid
          provider="aws"
        companyId="company-1"
          kind="security-checks"
          checks={[
            check({
              title: 'Security groups open to the internet',
              findings: [finding({ detail: 'Port 22 is open to the whole internet.' })],
            }),
          ]}
        />
      );

      const href = decodedHref(await openMenu());
      expect(href.startsWith('mailto:?')).toBe(true);
      expect(href).toContain('Security groups open to the internet');
      expect(href).toContain('Port 22 is open to the whole internet.');
    });

    it('asks whether the exposure is intentional on security checks', async () => {
      render(<FindingsGrid provider="aws"
        companyId="company-1" kind="security-checks" checks={[check()]} />);

      expect(decodedHref(await openMenu())).toContain('Is this intentional?');
    });

    it('asks whether the resource can be deleted on cost leakage', async () => {
      render(<FindingsGrid provider="aws"
        companyId="company-1" kind="cost-leakage" checks={[check()]} />);

      expect(decodedHref(await openMenu())).toContain('can it be deleted?');
    });

    it('names the provider so an Azure finding does not say AWS', async () => {
      render(<FindingsGrid provider="azure"
          companyId="company-1" kind="security-checks" checks={[check()]} />);

      const href = decodedHref(await openMenu());
      expect(href).toContain('Azure');
      expect(href).not.toContain('AWS');
    });

    it('gives each link an accessible name identifying its resource', () => {
      render(
        <FindingsGrid
          provider="aws"
        companyId="company-1"
          kind="security-checks"
          checks={[check({ findings: [finding({ resourceName: 'web-sg' })] })]}
        />
      );

      expect(screen.getByRole('button', { name: /verify this finding, web-sg/i })).toBeInTheDocument();
    });

    // A check that could not run has no rows, so there is nothing to ask
    // about — and no header cell should be left dangling either.
    it('renders no Verify column for a check that could not run', () => {
      render(
        <FindingsGrid
          provider="aws"
        companyId="company-1"
          kind="security-checks"
          checks={[check({ status: 'unavailable', unavailableReason: 'Access denied.', findings: [] })]}
        />
      );

      expect(screen.queryByRole('button', { name: /verify this finding/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: /verify/i })).not.toBeInTheDocument();
    });
  });
});
