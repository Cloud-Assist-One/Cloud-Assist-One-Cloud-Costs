import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import ThemeToggle from './ThemeToggle';

const setTheme = jest.fn();
let mockTheme = 'system';
// Real next-themes has no access to localStorage during server rendering, so
// theme is unresolved there; the client's first render already has it. `renderPhase`
// lets the hydration test below simulate that asymmetry explicitly (jsdom runs both
// renderToString and hydrateRoot in the same environment, so nothing does this for us).
let renderPhase: 'server' | 'client' = 'client';

jest.mock('next-themes', () => ({
  useTheme: () => ({
    theme: renderPhase === 'server' ? undefined : mockTheme,
    setTheme: (...args: unknown[]) => setTheme(...args),
  }),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    setTheme.mockReset();
    mockTheme = 'system';
    renderPhase = 'client';
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

  it('does not cause a hydration mismatch when a non-system theme is already persisted', () => {
    mockTheme = 'dark';
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
