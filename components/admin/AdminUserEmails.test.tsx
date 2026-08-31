import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminUserEmails from './AdminUserEmails';

const listCompanies = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ order: (...args: unknown[]) => listCompanies(...args) }),
    }),
  }),
}));

const oneUser = {
  users: [
    { id: 'u1', email: 'client@example.com', role: 'client', company_id: 'c1', created_at: '2026-07-01T00:00:00.000Z' },
  ],
};

describe('AdminUserEmails', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    listCompanies.mockReset().mockResolvedValue({
      data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }],
    });
  });

  it('lists existing users with their role and company', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => oneUser });

    render(<AdminUserEmails />);

    expect(await screen.findByText('client@example.com')).toBeInTheDocument();
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
  });

  it('deletes a user after confirmation and refreshes the list', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => oneUser })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [] }) });

    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<AdminUserEmails />);

    await screen.findByText('client@example.com');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/admin/users/u1', expect.objectContaining({ method: 'DELETE' }))
    );
    await waitFor(() => expect(screen.getByText('No users yet.')).toBeInTheDocument());

    confirmSpy.mockRestore();
  });

  it('keeps the user listed when the delete is declined', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => oneUser });

    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    render(<AdminUserEmails />);

    await screen.findByText('client@example.com');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(global.fetch).not.toHaveBeenCalledWith('/api/admin/users/u1', expect.anything());
    expect(screen.getByText('client@example.com')).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it('reports a failed delete instead of silently leaving the row', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => oneUser })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'You cannot delete the last remaining staff account.' }) });

    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<AdminUserEmails />);

    await screen.findByText('client@example.com');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('last remaining staff account');
    expect(screen.getByText('client@example.com')).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  describe('sign-up and sign-in state', () => {
    /** A free sign-up whose magic link is still sitting unopened in an inbox. */
    const pendingSignup = {
      users: [
        {
          id: 'u2',
          email: 'pending@example.com',
          role: 'client',
          company_id: 'c1',
          created_at: '2026-08-25T00:00:00.000Z',
          email_confirmed_at: null,
          last_sign_in_at: null,
        },
      ],
    };

    const activeUser = {
      users: [
        {
          id: 'u3',
          email: 'active@example.com',
          role: 'client',
          company_id: 'c1',
          created_at: '2026-08-01T00:00:00.000Z',
          email_confirmed_at: '2026-08-02T10:00:00.000Z',
          last_sign_in_at: '2026-08-30T09:00:00.000Z',
        },
      ],
    };

    it('shows an unopened magic link as a sign-up that never completed', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => pendingSignup });

      render(<AdminUserEmails />);

      await screen.findByText('pending@example.com');

      // Scoped to the row: the intro paragraph explains what the label means
      // and so contains the same words.
      const row = screen.getByRole('row', { name: /pending@example\.com/ });
      expect(row).toHaveTextContent('Link not used yet');
      expect(row).toHaveTextContent('Not confirmed');
      expect(row).toHaveTextContent('Never');
    });

    it('shows when a confirmed account last signed in', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => activeUser });

      render(<AdminUserEmails />);

      await screen.findByText('active@example.com');
      const row = screen.getByRole('row', { name: /active@example\.com/ });
      expect(row).toHaveTextContent('Active');
      expect(row).toHaveTextContent(new Date('2026-08-30T09:00:00.000Z').toLocaleString());
      expect(row).toHaveTextContent(new Date('2026-08-02T10:00:00.000Z').toLocaleString());
    });

    // The existing rows predate these columns, and a list that throws on one
    // is worse than a list that admits it does not know.
    it('renders a row that carries no sign-in data at all', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => oneUser });

      render(<AdminUserEmails />);

      await screen.findByText('client@example.com');

      expect(screen.getByRole('row', { name: /client@example\.com/ })).toHaveTextContent('Link not used yet');
    });
  });
});
