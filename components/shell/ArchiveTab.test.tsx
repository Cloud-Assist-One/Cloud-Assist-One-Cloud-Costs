import { render, screen } from '@testing-library/react';
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
});
