import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SignupForm from './SignupForm';

describe('SignupForm', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('requires email, company name, first name, and last name before submitting', async () => {
    const user = userEvent.setup();
    render(<SignupForm />);

    await user.click(screen.getByRole('button', { name: /create free account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/required/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends exactly the five fields and shows the check-your-email state on success', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    render(<SignupForm />);

    await user.type(screen.getByLabelText(/^email$/i), 'new@example.com');
    await user.type(screen.getByLabelText(/company name/i), 'Acme Corp');
    await user.type(screen.getByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    await user.type(screen.getByLabelText(/phone number/i), '555-1234');
    await user.click(screen.getByRole('button', { name: /create free account/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/signup');
    expect(JSON.parse(init.body)).toEqual({
      email: 'new@example.com',
      companyName: 'Acme Corp',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '555-1234',
    });

    expect(await screen.findByRole('status')).toHaveTextContent(/check your email/i);
  });

  it('shows a server error via role="alert" and keeps what the user typed', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'An account with that email already exists. Please sign in instead.' }),
    });
    const user = userEvent.setup();
    render(<SignupForm />);

    await user.type(screen.getByLabelText(/^email$/i), 'existing@example.com');
    await user.type(screen.getByLabelText(/company name/i), 'Acme Corp');
    await user.type(screen.getByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    await user.click(screen.getByRole('button', { name: /create free account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
    expect(screen.getByLabelText(/^email$/i)).toHaveValue('existing@example.com');
    expect(screen.getByLabelText(/company name/i)).toHaveValue('Acme Corp');
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Ada');
    expect(screen.getByLabelText(/last name/i)).toHaveValue('Lovelace');
  });
});
