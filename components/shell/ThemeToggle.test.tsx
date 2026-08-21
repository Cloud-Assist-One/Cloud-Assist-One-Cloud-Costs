import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThemeToggle from './ThemeToggle';

const setTheme = jest.fn();
let mockTheme = 'system';

jest.mock('next-themes', () => ({
  useTheme: () => ({ theme: mockTheme, setTheme: (...args: unknown[]) => setTheme(...args) }),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    setTheme.mockReset();
    mockTheme = 'system';
  });

  it('cycles from system to light when clicked', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /theme/i }));

    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('cycles from light to dark when clicked', async () => {
    mockTheme = 'light';
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /theme/i }));

    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('cycles from dark back to system when clicked', async () => {
    mockTheme = 'dark';
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /theme/i }));

    expect(setTheme).toHaveBeenCalledWith('system');
  });
});
