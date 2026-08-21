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
});
