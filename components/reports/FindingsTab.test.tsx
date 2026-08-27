import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FindingsTab from './FindingsTab';

const connectionsResponse = {
  connections: [
    { id: 'conn-1', label: 'Production', accessKeyIdMasked: 'AKIA********WXYZ', region: 'us-east-1', tagKey: '' },
    { id: 'conn-2', label: 'Sandbox', accessKeyIdMasked: 'AKIA********ABCD', region: 'us-west-2', tagKey: '' },
  ],
};

function findingsResponse(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    region: 'us-east-1',
    fetchedAt: '2026-08-27T12:00:00.000Z',
    checks: [
      {
        checkId: 'unattached-ebs-volumes',
        title: 'Unattached EBS volumes',
        source: 'builtin',
        status: 'ok',
        unavailableReason: null,
        findings: [
          {
            severity: 'low',
            resourceId: 'arn:vol-1',
            resourceName: 'scratch',
            region: 'us-east-1',
            detail: 'Volume vol-1 is not attached to any instance.',
            monthlyCost: 8.4,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('FindingsTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('tells the user to connect AWS when there are no saved connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);

    expect(await screen.findByText(/aws isn't connected yet/i)).toBeInTheDocument();
  });

  it('tells the user to connect Azure when the provider is azure', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="azure" kind="security-checks" />);

    expect(await screen.findByText(/azure isn't connected yet/i)).toBeInTheDocument();
  });

  it('requests the route for its provider and kind, passing the active period', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId="period-9" provider="aws" kind="cost-leakage" />);

    await screen.findByText('scratch');

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/settings/aws-credentials?companyId=company-1');
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe(
      '/api/aws/cost-leakage?companyId=company-1&credentialId=conn-1&periodId=period-9'
    );
  });

  it('omits the period parameter when no period is active', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId={null} provider="aws" kind="security-checks" />);

    await screen.findByText('scratch');

    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe(
      '/api/aws/security-checks?companyId=company-1&credentialId=conn-1'
    );
  });

  it('renders the findings returned by the route', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);

    expect(await screen.findByRole('heading', { name: 'Unattached EBS volumes' })).toBeInTheDocument();
    expect(screen.getByText('scratch')).toBeInTheDocument();
    expect(screen.getByText('$8.40')).toBeInTheDocument();
  });

  it('refetches when a different account is picked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);
    await screen.findByText('scratch');

    await userEvent.selectOptions(screen.getByLabelText(/account/i), 'conn-2');

    await waitFor(() => {
      expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('credentialId=conn-2');
    });
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);
    await screen.findByText('scratch');

    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  it('shows the route error when the request fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Could not decrypt the stored AWS credentials.' }) });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not decrypt the stored AWS credentials.');
  });
});
