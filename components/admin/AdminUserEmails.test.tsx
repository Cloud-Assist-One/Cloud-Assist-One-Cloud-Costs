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
});
