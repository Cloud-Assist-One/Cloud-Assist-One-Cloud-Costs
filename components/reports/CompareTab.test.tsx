import { render, screen } from '@testing-library/react';
import CompareTab from './CompareTab';

const loadRecords = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              range: (...args: unknown[]) => loadRecords(...args),
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

  it('shows separate AWS, Azure, and Google Cloud totals for the period', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', cloud_provider: 'aws', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 5 },
        { id: 'r3', cloud_provider: 'azure', service_name: 'Azure App Service', usage_date: '2026-07-01', cost: 8 },
        { id: 'r4', cloud_provider: 'gcp', service_name: 'Compute Engine', usage_date: '2026-07-01', cost: 4 },
      ],
    });

    render(<CompareTab companyId="company-1" periodId="period-1" />);

    const awsHeading = await screen.findByRole('heading', { name: 'Amazon Web Services' });
    const awsCard = awsHeading.closest('.card');
    expect(awsCard).not.toBeNull();
    expect(awsCard as HTMLElement).toHaveTextContent('$15.00');

    const azureHeading = screen.getByRole('heading', { name: 'Microsoft Azure' });
    const azureCard = azureHeading.closest('.card');
    expect(azureCard).not.toBeNull();
    expect(azureCard as HTMLElement).toHaveTextContent('$8.00');

    const gcpHeading = screen.getByRole('heading', { name: 'Google Cloud' });
    const gcpCard = gcpHeading.closest('.card');
    expect(gcpCard).not.toBeNull();
    expect(gcpCard as HTMLElement).toHaveTextContent('$4.00');
  });

  it('shows a category-level breakdown table for overlapping service types across all 3 providers', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', cloud_provider: 'azure', service_name: 'Azure App Service', usage_date: '2026-07-01', cost: 8 },
        { id: 'r3', cloud_provider: 'aws', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 3 },
        { id: 'r4', cloud_provider: 'gcp', service_name: 'Compute Engine', usage_date: '2026-07-01', cost: 6 },
      ],
    });

    render(<CompareTab companyId="company-1" periodId="period-1" />);

    expect(await screen.findByText('Compute')).toBeInTheDocument();
    expect(screen.getByText('Storage')).toBeInTheDocument();

    const computeRow = screen.getByText('Compute').closest('tr');
    expect(computeRow).not.toBeNull();
    expect(computeRow as HTMLElement).toHaveTextContent('$10.00');
    expect(computeRow as HTMLElement).toHaveTextContent('$8.00');
    expect(computeRow as HTMLElement).toHaveTextContent('$6.00');

    const storageRow = screen.getByText('Storage').closest('tr');
    expect(storageRow).not.toBeNull();
    expect(storageRow as HTMLElement).toHaveTextContent('$3.00');
    expect(storageRow as HTMLElement).toHaveTextContent('$0.00');
  });
});
