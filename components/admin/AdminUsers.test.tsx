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

  it('deletes a user after confirmation and refreshes the list', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          users: [{ id: 'u1', email: 'client@example.com', role: 'client', company_id: 'c1', created_at: '2026-07-01T00:00:00.000Z' }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [] }) });

    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<AdminUsers />);

    await screen.findByText('client@example.com');
    await user.click(screen.getByRole('button', { name: /delete/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/admin/users/u1', expect.objectContaining({ method: 'DELETE' }))
    );
    await waitFor(() => expect(screen.getByText('No users yet.')).toBeInTheDocument());

    confirmSpy.mockRestore();
  });

  it('does not offer the Admin role option to a non-admin', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ users: [] }) });
    render(<AdminUsers />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/admin/users'));
    expect(screen.queryByRole('option', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('lets an admin create another admin account', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'u3', email: 'newadmin@example.com', role: 'admin' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          users: [{ id: 'u3', email: 'newadmin@example.com', role: 'admin', company_id: null, created_at: '2026-07-01T00:00:00.000Z' }],
        }),
      });

    const user = userEvent.setup();
    render(<AdminUsers isAdmin />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/admin/users'));

    await user.type(screen.getByLabelText(/email/i), 'newadmin@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.selectOptions(screen.getByLabelText(/role/i), 'admin');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/users',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'newadmin@example.com', password: 'correct-horse-battery', role: 'admin', companyId: undefined }),
        })
      )
    );
  });
});
