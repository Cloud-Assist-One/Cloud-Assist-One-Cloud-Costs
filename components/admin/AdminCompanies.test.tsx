import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminCompanies from './AdminCompanies';

const listCompanies = jest.fn();
const insertCompany = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ order: (...args: unknown[]) => listCompanies(...args) }),
      insert: (...args: unknown[]) => insertCompany(...args),
    }),
  }),
}));

describe('AdminCompanies', () => {
  beforeEach(() => {
    listCompanies.mockReset().mockResolvedValue({
      data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }],
    });
    insertCompany.mockReset().mockReturnValue(Promise.resolve({ error: null }));
    global.fetch = jest.fn();
  });

  it('lists existing companies', async () => {
    render(<AdminCompanies />);
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
  });

  it('creates a new company', async () => {
    const user = userEvent.setup();
    render(<AdminCompanies />);

    await screen.findByText('Acme Corp');
    await user.type(screen.getByLabelText(/company name/i), 'Globex');
    await user.click(screen.getByRole('button', { name: /create company/i }));

    await waitFor(() => expect(insertCompany).toHaveBeenCalledWith(expect.objectContaining({ name: 'Globex' })));
  });

  it('does not show a Delete button for a non-admin', async () => {
    render(<AdminCompanies />);
    await screen.findByText('Acme Corp');
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('requires typing the exact company name before deleting', async () => {
    const user = userEvent.setup();
    render(<AdminCompanies isAdmin />);

    await screen.findByText('Acme Corp');
    await user.click(screen.getByRole('button', { name: /delete/i }));

    const confirmButton = screen.getByRole('button', { name: /confirm delete/i });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText(/type "acme corp"/i), 'wrong name');
    expect(confirmButton).toBeDisabled();
  });

  it('deletes the company after typing the exact name and refreshes the list', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) });
    listCompanies.mockResolvedValueOnce({
      data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }],
    });
    listCompanies.mockResolvedValueOnce({ data: [] });

    const user = userEvent.setup();
    render(<AdminCompanies isAdmin />);

    await screen.findByText('Acme Corp');
    await user.click(screen.getByRole('button', { name: /delete/i }));
    await user.type(screen.getByLabelText(/type "acme corp"/i), 'Acme Corp');
    await user.click(screen.getByRole('button', { name: /confirm delete/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/admin/companies/c1', expect.objectContaining({ method: 'DELETE' }))
    );
    await waitFor(() => expect(screen.getByText('No companies yet.')).toBeInTheDocument());
  });
});
