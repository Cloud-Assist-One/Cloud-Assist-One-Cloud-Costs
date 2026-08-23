import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ArchiveTab from './ArchiveTab';

const loadPeriods = jest.fn();
const loadRangeStart = jest.fn();
const loadRangeEnd = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'billing_periods') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: (...args: unknown[]) => loadPeriods(...args),
              }),
            }),
          }),
        };
      }
      let ascending = true;
      return {
        select: () => ({
          eq: () => ({
            order: (_col: string, opts: { ascending: boolean }) => {
              ascending = opts.ascending;
              return {
                limit: () => ({
                  maybeSingle: () => (ascending ? loadRangeStart() : loadRangeEnd()),
                }),
              };
            },
          }),
        }),
      };
    },
  }),
}));

describe('ArchiveTab', () => {
  beforeEach(() => {
    loadPeriods.mockReset();
    loadRangeStart.mockReset();
    loadRangeEnd.mockReset();
    loadRangeStart.mockResolvedValue({ data: { usage_date: '2026-07-01' } });
    loadRangeEnd.mockResolvedValue({ data: { usage_date: '2026-07-31' } });
    global.fetch = jest.fn();
  });

  it('lists archived periods with a computed date-range label', async () => {
    loadPeriods.mockResolvedValueOnce({
      data: [
        { id: 'p1', company_id: 'c1', status: 'archived', created_at: '2026-07-01T00:00:00.000Z', archived_at: '2026-08-01T00:00:00.000Z' },
      ],
    });

    render(<ArchiveTab companyId="c1" onSelectPeriod={jest.fn()} />);

    expect(await screen.findByText('2026-07-01 – 2026-07-31')).toBeInTheDocument();
  });

  it('calls onSelectPeriod with the period id when clicked', async () => {
    loadPeriods.mockResolvedValueOnce({
      data: [
        { id: 'p1', company_id: 'c1', status: 'archived', created_at: '2026-07-01T00:00:00.000Z', archived_at: '2026-08-01T00:00:00.000Z' },
      ],
    });
    const onSelectPeriod = jest.fn();
    const user = userEvent.setup();

    render(<ArchiveTab companyId="c1" onSelectPeriod={onSelectPeriod} />);

    await user.click(await screen.findByRole('button', { name: '2026-07-01 – 2026-07-31' }));
    expect(onSelectPeriod).toHaveBeenCalledWith('p1');
  });

  it('shows an empty state with no archived periods', async () => {
    loadPeriods.mockResolvedValueOnce({ data: [] });

    render(<ArchiveTab companyId="c1" onSelectPeriod={jest.fn()} />);

    expect(await screen.findByText(/no archived periods yet/i)).toBeInTheDocument();
  });

  it('requires typing DELETE before the confirm button is enabled', async () => {
    loadPeriods.mockResolvedValueOnce({
      data: [
        { id: 'p1', company_id: 'c1', status: 'archived', created_at: '2026-07-01T00:00:00.000Z', archived_at: '2026-08-01T00:00:00.000Z' },
      ],
    });
    const user = userEvent.setup();
    render(<ArchiveTab companyId="c1" onSelectPeriod={jest.fn()} />);

    await user.click(await screen.findByRole('button', { name: /delete/i }));
    const confirmButton = screen.getByRole('button', { name: /confirm delete/i });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText(/type "delete"/i), 'delete');
    expect(confirmButton).toBeDisabled();

    await user.clear(screen.getByLabelText(/type "delete"/i));
    await user.type(screen.getByLabelText(/type "delete"/i), 'DELETE');
    expect(confirmButton).not.toBeDisabled();
  });

  it('deletes the period after typing DELETE and refreshes the list', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) });
    loadPeriods.mockResolvedValueOnce({
      data: [
        { id: 'p1', company_id: 'c1', status: 'archived', created_at: '2026-07-01T00:00:00.000Z', archived_at: '2026-08-01T00:00:00.000Z' },
      ],
    });
    loadPeriods.mockResolvedValueOnce({ data: [] });

    const user = userEvent.setup();
    render(<ArchiveTab companyId="c1" onSelectPeriod={jest.fn()} />);

    await user.click(await screen.findByRole('button', { name: /delete/i }));
    await user.type(screen.getByLabelText(/type "delete"/i), 'DELETE');
    await user.click(screen.getByRole('button', { name: /confirm delete/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/periods/p1', expect.objectContaining({ method: 'DELETE' }))
    );
    await waitFor(() => expect(screen.getByText(/no archived periods yet/i)).toBeInTheDocument());
  });

  it('surfaces an error if deleting the period fails', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Only archived periods can be deleted.' }),
    });
    loadPeriods.mockResolvedValueOnce({
      data: [
        { id: 'p1', company_id: 'c1', status: 'archived', created_at: '2026-07-01T00:00:00.000Z', archived_at: '2026-08-01T00:00:00.000Z' },
      ],
    });

    const user = userEvent.setup();
    render(<ArchiveTab companyId="c1" onSelectPeriod={jest.fn()} />);

    await user.click(await screen.findByRole('button', { name: /delete/i }));
    await user.type(screen.getByLabelText(/type "delete"/i), 'DELETE');
    await user.click(screen.getByRole('button', { name: /confirm delete/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Only archived periods can be deleted.');
  });
});
