import { render, screen } from '@testing-library/react';
import TrendSidebar from './TrendSidebar';

const loadTrend = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: (...args: unknown[]) => loadTrend(...args),
        }),
      }),
    }),
  }),
}));

jest.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return new Proxy({}, { get: () => Passthrough });
});

describe('TrendSidebar', () => {
  beforeEach(() => {
    loadTrend.mockReset();
  });

  it('shows trailing-12-month totals per provider', async () => {
    loadTrend.mockResolvedValueOnce({
      data: [
        { month: '2026-07-01', cloud_provider: 'aws', total: 100 },
        { month: '2026-07-01', cloud_provider: 'azure', total: 40 },
        { month: '2026-08-01', cloud_provider: 'aws', total: 120 },
      ],
    });

    render(<TrendSidebar companyId="company-1" />);

    expect(await screen.findByText('$120.00')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('$40.00')).toBeInTheDocument();
  });

  it('shows all 4 providers per month, defaulting to $0.00 when a provider has no data', async () => {
    loadTrend.mockResolvedValueOnce({
      data: [{ month: '2026-08-01', cloud_provider: 'aws', total: 50 }],
    });

    render(<TrendSidebar companyId="company-1" />);

    await screen.findByText('$50.00');
    expect(screen.getByText(/google cloud/i)).toBeInTheDocument();
    expect(screen.getByText(/snowflake/i)).toBeInTheDocument();
    expect(screen.getAllByText('$0.00').length).toBe(3);
  });

  it('shows an empty state when there is no trend data', async () => {
    loadTrend.mockResolvedValueOnce({ data: [] });

    render(<TrendSidebar companyId="company-1" />);

    expect(await screen.findByText(/no trend data yet/i)).toBeInTheDocument();
  });
});
