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

  it('creates a new client user tied to a company', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'u2', email: 'new@example.com', role: 'client', companyId: 'c1' }),
    });

    const user = userEvent.setup();
    render(<AdminUsers />);

    await screen.findByRole('option', { name: 'Acme Corp' });

    await user.type(screen.getByLabelText(/email/i), 'new@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.selectOptions(screen.getByLabelText(/company/i), 'c1');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/admin/users', expect.objectContaining({ method: 'POST' }))
    );
  });

  it('confirms the new account by name, since the list of accounts lives elsewhere now', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'u2', email: 'new@example.com', role: 'client' }),
    });

    const user = userEvent.setup();
    render(<AdminUsers />);

    await screen.findByRole('option', { name: 'Acme Corp' });
    await user.type(screen.getByLabelText(/email/i), 'new@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByRole('status')).toHaveTextContent('new@example.com');
    // Cleared fields alone would be ambiguous, so the form must not look
    // merely reset -- it has to say what happened.
    expect(screen.getByLabelText(/email/i)).toHaveValue('');
  });

  it('reports a failed create rather than clearing the form', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'A user with this email already exists.' }),
    });

    const user = userEvent.setup();
    render(<AdminUsers />);

    await screen.findByRole('option', { name: 'Acme Corp' });
    await user.type(screen.getByLabelText(/email/i), 'taken@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByLabelText(/email/i)).toHaveValue('taken@example.com');
  });

  it('does not offer the Admin role option to a non-admin', async () => {
    render(<AdminUsers />);

    await screen.findByRole('option', { name: 'Acme Corp' });
    expect(screen.queryByRole('option', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('refreshes the company list on demand without discarding the current selection', async () => {
    listCompanies.mockResolvedValueOnce({
      data: [
        { id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' },
        { id: 'c2', name: 'Globex', created_at: '2026-07-02T00:00:00.000Z' },
      ],
    });
    const user = userEvent.setup();
    render(<AdminUsers />);

    await screen.findByRole('option', { name: 'Globex' });
    await user.selectOptions(screen.getByLabelText(/company/i), 'c2');

    listCompanies.mockResolvedValueOnce({
      data: [
        { id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' },
        { id: 'c2', name: 'Globex', created_at: '2026-07-02T00:00:00.000Z' },
        { id: 'c3', name: 'Brand New Co', created_at: '2026-08-01T00:00:00.000Z' },
      ],
    });
    await user.click(screen.getByRole('button', { name: /refresh companies/i }));

    expect(await screen.findByRole('option', { name: 'Brand New Co' })).toBeInTheDocument();
    expect(screen.getByLabelText(/company/i)).toHaveValue('c2');
  });

  it('lets an admin create another admin account', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'u3', email: 'newadmin@example.com', role: 'admin' }),
    });

    const user = userEvent.setup();
    render(<AdminUsers isAdmin />);

    await screen.findByRole('option', { name: 'Acme Corp' });

    await user.type(screen.getByLabelText(/email/i), 'newadmin@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.selectOptions(screen.getByLabelText(/role/i), 'admin');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/users',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            email: 'newadmin@example.com',
            password: 'correct-horse-battery',
            role: 'admin',
            companyId: undefined,
          }),
        })
      )
    );
  });
});
