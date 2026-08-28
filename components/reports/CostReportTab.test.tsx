import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

jest.mock('./PullBillingModal', () => ({
  __esModule: true,
  default: ({
    onClose,
    onPulled,
  }: {
    onClose: () => void;
    onPulled: (result: { rowCount: number; newPeriodId?: string }) => void;
  }) => (
    <div>
      pull-billing-modal-content
      <button type="button" onClick={onClose}>
        close-modal
      </button>
      <button type="button" onClick={() => onPulled({ rowCount: 5 })}>
        simulate-pulled
      </button>
      <button type="button" onClick={() => onPulled({ rowCount: 5, newPeriodId: 'period-2' })}>
        simulate-pulled-with-archive
      </button>
    </div>
  ),
}));

jest.mock('./PullBillingFromBucketModal', () => ({
  __esModule: true,
  default: ({ onClose }: { onClose: () => void }) => (
    <div>
      bucket-pull-modal-content
      <button type="button" onClick={onClose}>
        close-bucket-modal
      </button>
    </div>
  ),
}));

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

  it('states which run produced the data, and when, under the billing month', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });
    loadBillingMonth.mockResolvedValueOnce({
      data: { billing_month: '2026-08-01', origin: 'detail_pull', created_at: '2026-08-28T15:42:00.000Z' },
    });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);

    expect(await screen.findByText(/Detail pull ·/)).toBeInTheDocument();
    expect(screen.getByText(/Aug 28, 2026/)).toBeInTheDocument();
  });

  // Rows written before uploaded_files.origin existed still have a billing
  // month worth showing; the line just says less about them.
  it('still shows the billing month when the run has no recorded origin', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });
    loadBillingMonth.mockResolvedValueOnce({
      data: { billing_month: '2026-08-01', origin: null, created_at: '2026-08-28T15:42:00.000Z' },
    });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);

    expect(await screen.findByText('Billing month: August 2026')).toBeInTheDocument();
    expect(screen.queryByText(/pull ·/i)).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no records in the period', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="azure" periodId="period-1" />);

    expect(await screen.findByText(/no cost data for this period/i)).toBeInTheDocument();
  });

  it('shows a Quick Pull button for AWS that opens the modal', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);

    const button = await screen.findByRole('button', { name: /quick pull/i });
    await userEvent.click(button);

    expect(screen.getByText('pull-billing-modal-content')).toBeInTheDocument();
  });

  it('unmounts the modal when it is closed', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);

    await userEvent.click(await screen.findByRole('button', { name: /quick pull/i }));
    expect(screen.getByText('pull-billing-modal-content')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'close-modal' }));
    expect(screen.queryByText('pull-billing-modal-content')).not.toBeInTheDocument();
  });

  it('shows a Quick Pull button for Azure, which also has a billing API', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="azure" periodId="period-1" />);

    expect(await screen.findByRole('button', { name: /quick pull/i })).toBeInTheDocument();
  });

  it.each(['gcp', 'snowflake'] as const)(
    'does not show either pull button for %s, which is upload-only',
    async (provider) => {
      loadRecords.mockResolvedValueOnce({ data: [] });

      render(<CostReportTab companyId="company-1" cloudProvider={provider} periodId="period-1" />);

      await screen.findByText(/no cost data for this period/i);
      // Both by their real names. Querying a name no button carries would
      // pass whether or not the buttons rendered.
      expect(screen.queryByRole('button', { name: /quick pull/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /detail pull/i })).not.toBeInTheDocument();
    }
  );

  it('does not show either pull button when the period is read-only', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" isReadOnly />);

    await screen.findByText(/no cost data for this period/i);
    expect(screen.queryByRole('button', { name: /quick pull/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /detail pull/i })).not.toBeInTheDocument();
  });

  it('shows a Detail Pull button that opens the bucket modal', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);

    await userEvent.click(await screen.findByRole('button', { name: /detail pull/i }));

    expect(screen.getByText('bucket-pull-modal-content')).toBeInTheDocument();
  });

  it('reloads cost records after a successful pull', async () => {
    loadRecords
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ id: 'r1', service_name: 'Amazon EC2', usage_date: '2026-08-01', cost: 20 }],
      });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);
    await screen.findByText(/no cost data for this period/i);

    await userEvent.click(screen.getByRole('button', { name: /quick pull/i }));
    await userEvent.click(screen.getByRole('button', { name: 'simulate-pulled' }));

    // Single record's per-service total and grand total both render "$20.00",
    // so this asserts on the two matching cells rather than a single unique node.
    expect(await screen.findAllByText('$20.00')).toHaveLength(2);
    expect(loadRecords).toHaveBeenCalledTimes(2);
  });

  it('keeps the modal open after a successful pull so the result is visible', async () => {
    loadRecords.mockResolvedValue({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);
    await screen.findByText(/no cost data for this period/i);

    await userEvent.click(screen.getByRole('button', { name: /quick pull/i }));
    expect(screen.getByText('pull-billing-modal-content')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'simulate-pulled' }));

    // Modal should still be visible after pull succeeds
    expect(screen.getByText('pull-billing-modal-content')).toBeInTheDocument();

    // Modal should only unmount after close-modal is clicked
    await userEvent.click(screen.getByRole('button', { name: 'close-modal' }));
    expect(screen.queryByText('pull-billing-modal-content')).not.toBeInTheDocument();
  });

  it('calls onPeriodArchived when the pull result includes a newPeriodId', async () => {
    const onPeriodArchived = jest.fn();
    loadRecords.mockResolvedValue({ data: [] });

    render(
      <CostReportTab
        companyId="company-1"
        cloudProvider="aws"
        periodId="period-1"
        onPeriodArchived={onPeriodArchived}
      />
    );
    await screen.findByText(/no cost data for this period/i);

    await userEvent.click(screen.getByRole('button', { name: /quick pull/i }));
    await userEvent.click(screen.getByRole('button', { name: 'simulate-pulled-with-archive' }));

    expect(onPeriodArchived).toHaveBeenCalledWith('period-2');
  });
});
