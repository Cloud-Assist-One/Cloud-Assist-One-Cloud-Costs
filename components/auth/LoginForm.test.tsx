import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginForm from './LoginForm';

const signInWithPassword = jest.fn();
const resetPasswordForEmail = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
      resetPasswordForEmail: (...args: unknown[]) => resetPasswordForEmail(...args),
    },
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

describe('LoginForm', () => {
  beforeEach(() => {
    signInWithPassword.mockReset();
    resetPasswordForEmail.mockReset();
  });

  it('signs in with the entered email and password', async () => {
    signInWithPassword.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'client@example.com');
    await user.type(screen.getByLabelText(/password/i), 'correct-horse');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'client@example.com',
      password: 'correct-horse',
    });
  });

  it('shows an error when sign-in fails', async () => {
    signInWithPassword.mockResolvedValueOnce({ error: { message: 'Invalid login credentials' } });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'client@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid email or password/i);
  });

  it('sends a password reset email when "Forgot password?" is clicked', async () => {
    resetPasswordForEmail.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'client@example.com');
    await user.click(screen.getByRole('button', { name: /forgot password/i }));

    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      'client@example.com',
      expect.objectContaining({ redirectTo: expect.stringContaining('/reset-password') })
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/reset email sent/i);
  });
});
