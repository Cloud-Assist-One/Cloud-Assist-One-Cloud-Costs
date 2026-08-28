import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LineItemTotals from './LineItemTotals';

const fetchLineItemSummary = jest.fn();
const fetchLineItemGroups = jest.fn();

jest.mock('@/lib/lineItemAggregates', () => ({
  ...jest.requireActual('@/lib/lineItemAggregates'),
  fetchLineItemSummary: (...args: unknown[]) => fetchLineItemSummary(...args),
  fetchLineItemGroups: (...args: unknown[]) => fetchLineItemGroups(...args),
}));

jest.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

const filters = { periodId: 'period-1' };

describe('LineItemTotals', () => {
  beforeEach(() => {
    fetchLineItemSummary.mockReset().mockResolvedValue({ rowCount: 314, totalCost: 85.39 });
    fetchLineItemGroups.mockReset().mockResolvedValue([]);
  });

  it('shows the row count and total for the current filter', async () => {
    render(<LineItemTotals filters={filters} />);

    expect(await screen.findByText(/314 line items/i)).toBeInTheDocument();
    expect(screen.getByText(/\$85\.39/)).toBeInTheDocument();
  });

  it('says one line item rather than "1 line items"', async () => {
    fetchLineItemSummary.mockResolvedValue({ rowCount: 1, totalCost: 2 });

    render(<LineItemTotals filters={filters} />);

    expect(await screen.findByText(/1 line item\b/i)).toBeInTheDocument();
  });

  // The total describes the filtered set, not the page, so it has to refetch
  // whenever the filter moves or it would quietly describe the previous one.
  it('refetches when the filter changes', async () => {
    const { rerender } = render(<LineItemTotals filters={filters} />);
    await waitFor(() => expect(fetchLineItemSummary).toHaveBeenCalledTimes(1));

    rerender(<LineItemTotals filters={{ ...filters, searchText: 'ec2' }} />);

    await waitFor(() => expect(fetchLineItemSummary).toHaveBeenCalledTimes(2));
    expect(fetchLineItemSummary.mock.calls[1][1]).toEqual({ periodId: 'period-1', searchText: 'ec2' });
  });

  it('reports a failure instead of showing a total that is not real', async () => {
    fetchLineItemSummary.mockRejectedValue(new Error('permission denied'));

    render(<LineItemTotals filters={filters} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/permission denied/i);
    expect(screen.queryByText(/line items/i)).not.toBeInTheDocument();
  });

  describe('grouping', () => {
    it('groups nothing until a grouping is chosen', async () => {
      render(<LineItemTotals filters={filters} />);

      await screen.findByText(/314 line items/i);
      expect(fetchLineItemGroups).not.toHaveBeenCalled();
    });

    it('shows a subtotal row per group, biggest first', async () => {
      fetchLineItemGroups.mockResolvedValue([
        { groupKey: 'Amazon EC2', rowCount: 10, totalCost: 900 },
        { groupKey: 'Amazon S3', rowCount: 4, totalCost: 12.3 },
      ]);

      render(<LineItemTotals filters={filters} />);
      await userEvent.selectOptions(await screen.findByLabelText(/group by/i), 'service_name');

      expect(await screen.findByText('Amazon EC2')).toBeInTheDocument();
      expect(screen.getByText('$900.00')).toBeInTheDocument();
      expect(screen.getByText('Amazon S3')).toBeInTheDocument();
    });

    // Rows with no billing code are the ones worth chasing, so they must not
    // silently vanish from a report grouped by billing code.
    it('labels the group with no value rather than hiding it', async () => {
      fetchLineItemGroups.mockResolvedValue([{ groupKey: null, rowCount: 7, totalCost: 42 }]);

      render(<LineItemTotals filters={filters} />);
      await userEvent.selectOptions(await screen.findByLabelText(/group by/i), 'billing_code');

      expect(await screen.findByText(/untagged|none/i)).toBeInTheDocument();
      expect(screen.getByText('$42.00')).toBeInTheDocument();
    });

    it('stops grouping when the grouping is cleared', async () => {
      fetchLineItemGroups.mockResolvedValue([{ groupKey: 'Amazon EC2', rowCount: 1, totalCost: 5 }]);

      render(<LineItemTotals filters={filters} />);
      const select = await screen.findByLabelText(/group by/i);
      await userEvent.selectOptions(select, 'service_name');
      expect(await screen.findByText('Amazon EC2')).toBeInTheDocument();

      await userEvent.selectOptions(select, '');

      await waitFor(() => expect(screen.queryByText('Amazon EC2')).not.toBeInTheDocument());
    });
  });
});
