import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AwsResourcesTab from './AwsResourcesTab';

const emptyResource = { data: [], error: null };

function makeResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connected: true,
    region: 'us-east-1',
    fetchedAt: '2026-08-24T12:00:00.000Z',
    ec2: emptyResource,
    lambda: emptyResource,
    ecs: emptyResource,
    rds: emptyResource,
    dynamodb: emptyResource,
    apis: emptyResource,
    s3: emptyResource,
    ...overrides,
  };
}

describe('AwsResourcesTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a not-connected message when AWS has not been set up', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connected: false }) });

    render(<AwsResourcesTab companyId="company-1" />);

    expect(await screen.findByText(/aws isn't connected yet/i)).toBeInTheDocument();
  });

  it('renders rows for each grid when data is present', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeResponse({
          ec2: {
            data: [
              {
                instanceId: 'i-123',
                name: 'web-1',
                instanceType: 't3.micro',
                state: 'running',
                availabilityZone: 'us-east-1a',
                privateIp: '10.0.0.1',
                publicIp: null,
              },
            ],
            error: null,
          },
          s3: { data: [{ name: 'my-bucket', creationDate: '2026-01-01T00:00:00.000Z' }], error: null },
        }),
    });

    render(<AwsResourcesTab companyId="company-1" />);

    expect(await screen.findByText('i-123')).toBeInTheDocument();
    expect(screen.getByText('web-1')).toBeInTheDocument();
    expect(screen.getByText('my-bucket')).toBeInTheDocument();
    expect(screen.getByText('No Lambda functions found.')).toBeInTheDocument();
  });

  it('shows a per-grid error without hiding other grids', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeResponse({
          ec2: { data: [], error: 'AccessDenied: not authorized to perform ec2:DescribeInstances' },
          s3: { data: [{ name: 'my-bucket', creationDate: null }], error: null },
        }),
    });

    render(<AwsResourcesTab companyId="company-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/accessdenied/i);
    expect(screen.getByText('my-bucket')).toBeInTheDocument();
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AwsResourcesTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  });
});
