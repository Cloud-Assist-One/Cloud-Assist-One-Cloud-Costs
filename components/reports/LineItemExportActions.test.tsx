import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LineItemExportActions from './LineItemExportActions';
import { EXPORT_ROW_CAP } from '@/lib/lineItemExport';

const fetchAllLineItems = jest.fn();

jest.mock('@/lib/lineItemExport', () => ({
  ...jest.requireActual('@/lib/lineItemExport'),
  fetchAllLineItems: (...args: unknown[]) => fetchAllLineItems(...args),
}));

jest.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

const filters = { periodId: 'period-1' };
const sort = { column: 'usage_date' as const, direction: 'desc' as const };

const row = {
  id: 'r1',
  usage_date: '2026-08-01',
  cloud_provider: 'aws',
  service_name: 'Amazon EC2',
  cost: 10,
  tags: { 'Billing Code': 'CC-1' },
};

let downloaded: { filename: string; text: string } | null = null;

beforeAll(() => {
  // jsdom has neither, and the component's download path uses both.
  global.URL.createObjectURL = jest.fn(() => 'blob:fake');
  global.URL.revokeObjectURL = jest.fn();
  window.print = jest.fn();

  // Capture what the anchor would have downloaded.
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) downloaded = { filename: this.download, text: '' };
    else realClick.call(this);
  };
});

describe('LineItemExportActions', () => {
  beforeEach(() => {
    downloaded = null;
    fetchAllLineItems.mockReset().mockResolvedValue({ rows: [row], totalCount: 1, capped: false });
  });

  it('exports using the filters currently applied, not the visible page', async () => {
    render(<LineItemExportActions filters={filters} sort={sort} />);

    await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(fetchAllLineItems).toHaveBeenCalled());
    expect(fetchAllLineItems.mock.calls[0][1]).toEqual(filters);
  });

  it('names the download after the period', async () => {
    render(<LineItemExportActions filters={filters} sort={sort} />);

    await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(downloaded?.filename).toBe('line-items-period-1.csv'));
  });

  // A CSV that stops at the cap while looking complete is the failure this
  // whole feature exists to avoid.
  it('says so when the cap excluded rows', async () => {
    fetchAllLineItems.mockResolvedValue({
      rows: [row],
      totalCount: EXPORT_ROW_CAP + 250,
      capped: true,
    });

    render(<LineItemExportActions filters={filters} sort={sort} />);
    await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(new RegExp(EXPORT_ROW_CAP.toLocaleString()));
    expect(notice).toHaveTextContent(new RegExp((EXPORT_ROW_CAP + 250).toLocaleString()));
  });

  it('says nothing about caps when everything was included', async () => {
    render(<LineItemExportActions filters={filters} sort={sort} />);

    await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(fetchAllLineItems).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('reports a failure rather than downloading an empty file', async () => {
    fetchAllLineItems.mockRejectedValue(new Error('permission denied'));

    render(<LineItemExportActions filters={filters} sort={sort} />);
    await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/permission denied/i);
    expect(downloaded).toBeNull();
  });

  it('prints the whole filtered set rather than the page', async () => {
    render(<LineItemExportActions filters={filters} sort={sort} />);

    await userEvent.click(screen.getByRole('button', { name: /print all/i }));

    await waitFor(() => expect(window.print).toHaveBeenCalled());
    expect(fetchAllLineItems).toHaveBeenCalledWith(expect.anything(), filters, sort);
  });

  it('disables both actions while one is running', async () => {
    let release: (value: unknown) => void = () => {};
    fetchAllLineItems.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    render(<LineItemExportActions filters={filters} sort={sort} />);
    await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(screen.getByRole('button', { name: /print all/i })).toBeDisabled();

    release({ rows: [], totalCount: 0, capped: false });
    await waitFor(() => expect(screen.getByRole('button', { name: /print all/i })).not.toBeDisabled());
  });
});
