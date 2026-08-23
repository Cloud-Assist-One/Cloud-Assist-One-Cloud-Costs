import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LineItemsTab from './LineItemsTab';

const fetchPage = jest.fn();
const fetchReferenced = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}));

jest.mock('@/lib/lineItemQuery', () => ({
  fetchLineItemsPage: (...args: unknown[]) => fetchPage(...args),
  fetchReferencedRecordIds: (...args: unknown[]) => fetchReferenced(...args),
}));

describe('LineItemsTab', () => {
  beforeEach(() => {
    fetchPage.mockReset();
    fetchReferenced.mockReset();
    fetchReferenced.mockResolvedValue(new Set());
  });

  it('shows a page of line items with totals and pagination info', async () => {
    fetchPage.mockResolvedValueOnce({
      rows: [
        { id: 'r1', company_id: 'c1', period_id: 'p1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-08-01', cost: 12.5, account_id: null, source_file_id: 'f1', created_at: '2026-08-01T00:00:00.000Z' },
      ],
      totalCount: 120,
    });

    render(<LineItemsTab companyId="c1" periodId="p1" />);

    expect(await screen.findByText('Amazon EC2')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Amazon Web Services' })).toBeInTheDocument();
  });

  it('offers all 4 cloud providers in the Provider filter', async () => {
    fetchPage.mockResolvedValue({ rows: [], totalCount: 0 });

    render(<LineItemsTab companyId="c1" periodId="p1" />);
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    expect(screen.getByRole('option', { name: 'Amazon Web Services' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Microsoft Azure' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Google Cloud' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Snowflake' })).toBeInTheDocument();
  });

  it('shows the note/todo indicator for a referenced row', async () => {
    fetchPage.mockResolvedValueOnce({
      rows: [
        { id: 'r1', company_id: 'c1', period_id: 'p1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-08-01', cost: 12.5, account_id: null, source_file_id: 'f1', created_at: '2026-08-01T00:00:00.000Z' },
      ],
      totalCount: 1,
    });
    fetchReferenced.mockResolvedValueOnce(new Set(['r1']));

    render(<LineItemsTab companyId="c1" periodId="p1" />);

    await screen.findByText('Amazon EC2');
    expect(screen.getByTitle('Referenced by a note or follow-up')).toBeInTheDocument();
  });

  it('re-fetches with the initial service filter when provided', async () => {
    fetchPage.mockResolvedValue({ rows: [], totalCount: 0 });

    render(<LineItemsTab companyId="c1" periodId="p1" initialServiceFilter={['Amazon EC2']} />);

    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(fetchPage.mock.calls[0][1]).toMatchObject({ serviceNames: ['Amazon EC2'] });
  });

  it('clicking a sort button toggles direction and re-fetches', async () => {
    fetchPage.mockResolvedValue({ rows: [], totalCount: 0 });
    const user = userEvent.setup();

    render(<LineItemsTab companyId="c1" periodId="p1" />);

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /sort by cost/i }));

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(fetchPage.mock.calls[1][2]).toEqual({ column: 'cost', direction: 'desc' });
  });
});
