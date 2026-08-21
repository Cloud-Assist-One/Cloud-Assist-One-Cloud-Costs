import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminUsers from './AdminUsers';

const listCompanies = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ order: (...args: unknown[]) => listCompanies(...args) }),
    }),
  }),
}));

describe('AdminUsers', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    listCompanies.mockReset().mockResolvedValue({
      data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }],
    });
  });

  it('lists existing users with their role and company', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: [{ id: 'u1', email: 'client@example.com', role: 'client', company_id: 'c1', created_at: '2026-07-01T00:00:00.000Z' }],
      }),
    });

    render(<AdminUsers />);

    expect(await screen.findByText('client@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
  });

  it('creates a new client user tied to a company', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'u2', email: 'new@example.com', role: 'client', companyId: 'c1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [{ id: 'u2', email: 'new@example.com', role: 'client', company_id: 'c1' }] }) });

    const user = userEvent.setup();
    render(<AdminUsers />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/admin/users'));

    await user.type(screen.getByLabelText(/email/i), 'new@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.selectOptions(screen.getByLabelText(/company/i), 'c1');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/users',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });
});
