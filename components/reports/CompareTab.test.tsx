import { render, screen } from '@testing-library/react';
import CompareTab from './CompareTab';

const loadRecords = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            lte: () => ({
              order: () => ({
                range: (...args: unknown[]) => loadRecords(...args),
              }),
            }),
          }),
        }),
      }),
    }),
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

describe('CompareTab', () => {
  beforeEach(() => {
    loadRecords.mockReset();
  });

  it('shows separate AWS and Azure totals for the current range', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', cloud_provider: 'aws', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 5 },
        { id: 'r3', cloud_provider: 'azure', service_name: 'Azure App Service', usage_date: '2026-07-01', cost: 8 },
      ],
    });

    render(<CompareTab companyId="company-1" />);

    expect(await screen.findByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText('$8.00')).toBeInTheDocument();
    expect(screen.getByText('AWS')).toBeInTheDocument();
    expect(screen.getByText('Azure')).toBeInTheDocument();
  });
});
