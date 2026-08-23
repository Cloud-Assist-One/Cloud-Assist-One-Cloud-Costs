import { render, screen } from '@testing-library/react';
import CostReportTab from './CostReportTab';

const loadRecords = jest.fn();
const loadBillingMonth = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'uploaded_files') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: (...args: unknown[]) => loadBillingMonth(...args),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  range: (...args: unknown[]) => loadRecords(...args),
                }),
              }),
            }),
          }),
        }),
      };
    },
  }),
}));

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
    loadBillingMonth.mockReset().mockResolvedValue({ data: null });
  });

  it('shows the total cost and a per-service breakdown for the period', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 5 },
      ],
    });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);

    expect(await screen.findByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText('Amazon EC2')).toBeInTheDocument();
    expect(screen.getByText('Amazon S3')).toBeInTheDocument();
  });

  it("shows the period's billing month above the graphs", async () => {
    loadRecords.mockResolvedValueOnce({
      data: [{ id: 'r1', service_name: 'Amazon EC2', usage_date: '2026-08-01', cost: 10 }],
    });
    loadBillingMonth.mockResolvedValueOnce({ data: { billing_month: '2026-08-01' } });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);

    expect(await screen.findByText('Billing month: August 2026')).toBeInTheDocument();
  });

  it('shows an empty state when there are no records in the period', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="azure" periodId="period-1" />);

    expect(await screen.findByText(/no cost data for this period/i)).toBeInTheDocument();
  });
});
