import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import ThemeToggle from './ThemeToggle';

const setTheme = jest.fn();
let mockTheme = 'system';
let mockResolved = 'light';
// Real next-themes has no access to localStorage during server rendering, so
// theme is unresolved there; the client's first render already has it. `renderPhase`
// lets the hydration test below simulate that asymmetry explicitly (jsdom runs both
// renderToString and hydrateRoot in the same environment, so nothing does this for us).
let renderPhase: 'server' | 'client' = 'client';

jest.mock('next-themes', () => ({
  useTheme: () => ({
    theme: renderPhase === 'server' ? undefined : mockTheme,
    resolvedTheme: renderPhase === 'server' ? undefined : mockResolved,
    setTheme: (...args: unknown[]) => setTheme(...args),
  }),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    setTheme.mockReset();
    mockTheme = 'system';
    mockResolved = 'light';
    renderPhase = 'client';
  });

  it('switches to dark when the page is currently light', async () => {
    mockTheme = 'light';
    mockResolved = 'light';
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /theme/i }));

    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('switches to light when the page is currently dark', async () => {
    mockTheme = 'dark';
    mockResolved = 'dark';
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /theme/i }));

    expect(setTheme).toHaveBeenCalledWith('light');
  });

  // The app still opens on the OS preference; the button just no longer
  // offers "System" as a third stop. Clicking it has to commit to whichever
  // theme is the opposite of what is on screen -- not to the literal string
  // "system", which would leave the page looking unchanged.
  it('commits to a real theme when the page is still following the system', async () => {
    mockTheme = 'system';
    mockResolved = 'dark';
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /theme/i }));

    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('never sets the theme to system', async () => {
    for (const [theme, resolved] of [
      ['system', 'light'],
      ['system', 'dark'],
      ['light', 'light'],
      ['dark', 'dark'],
    ]) {
      setTheme.mockReset();
      mockTheme = theme;
      mockResolved = resolved;
      const { unmount } = render(<ThemeToggle />);

      await userEvent.setup().click(screen.getByRole('button', { name: /theme/i }));

      expect(setTheme).not.toHaveBeenCalledWith('system');
      unmount();
    }
  });

  // Two states that look identical on a light machine is what made the old
  // three-way cycle read as a button that did nothing.
  it('labels itself with what is on screen, never "System"', () => {
    mockTheme = 'system';
    mockResolved = 'dark';
    render(<ThemeToggle />);

    const button = screen.getByRole('button', { name: /theme/i });
    expect(button).toHaveTextContent(/dark/i);
    expect(button).not.toHaveTextContent(/system/i);
  });

  it('does not cause a hydration mismatch when a non-system theme is already persisted', () => {
    mockTheme = 'dark';
    mockResolved = 'dark';
    renderPhase = 'server';
    const container = document.createElement('div');
    container.innerHTML = renderToString(<ThemeToggle />);

    renderPhase = 'client';
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      hydrateRoot(container, <ThemeToggle />);
    });

    const hydrationErrors = consoleError.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.includes('Hydration')
    );
    expect(hydrationErrors).toHaveLength(0);

    consoleError.mockRestore();
  });
});
