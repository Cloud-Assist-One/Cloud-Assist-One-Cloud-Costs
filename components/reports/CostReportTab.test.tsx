import { render, screen, waitFor } from '@testing-library/react';
import CostReportTab from './CostReportTab';

const loadRecords = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            gte: () => ({
              lte: () => ({
                range: (...args: unknown[]) => loadRecords(...args),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

// Recharts renders to SVG with layout measurements jsdom doesn't provide;
// stub it to a lightweight marker so tests assert on our data, not on chart rendering.
jest.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return new Proxy(
    {},
    {
      get: () => Passthrough,
    }
  );
});

describe('CostReportTab', () => {
  beforeEach(() => {
    loadRecords.mockReset();
  });

  it('shows the total cost and a per-service breakdown for the current month', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 5 },
      ],
    });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" />);

    expect(await screen.findByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText('Amazon EC2')).toBeInTheDocument();
    expect(screen.getByText('Amazon S3')).toBeInTheDocument();
  });

  it('shows an empty state when there are no records in range', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="azure" />);

    expect(await screen.findByText(/no cost data for this range/i)).toBeInTheDocument();
  });
});
