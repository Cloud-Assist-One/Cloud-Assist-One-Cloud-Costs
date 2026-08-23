import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import AccentColorPicker from './AccentColorPicker';
import { ACCENT_COLOR_STORAGE_KEY } from '@/lib/accentColor';

describe('AccentColorPicker', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.style.removeProperty('--primary');
    document.documentElement.style.removeProperty('--accent');
  });

  it('opens a swatch grid and applies + persists a color on click', async () => {
    const user = userEvent.setup();
    render(<AccentColorPicker />);

    await user.click(screen.getByRole('button', { name: /color/i }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Green' }));

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#16a34a');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#16a34a');
    expect(window.localStorage.getItem(ACCENT_COLOR_STORAGE_KEY)).toBe('#16a34a');
  });

  it('resets to the default color and clears storage', async () => {
    window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, '#16a34a');
    const user = userEvent.setup();
    render(<AccentColorPicker />);

    await user.click(screen.getByRole('button', { name: /color/i }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Default' }));

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('');
    expect(window.localStorage.getItem(ACCENT_COLOR_STORAGE_KEY)).toBeNull();
  });

  it('re-applies a previously saved color on mount', async () => {
    window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, '#dc2626');
    render(<AccentColorPicker />);

    expect(await screen.findByText('Color')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#dc2626');
  });

  it('does not cause a hydration mismatch when a color is already persisted', () => {
    window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, '#dc2626');
    const container = document.createElement('div');
    container.innerHTML = renderToString(<AccentColorPicker />);

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      hydrateRoot(container, <AccentColorPicker />);
    });

    const hydrationErrors = consoleError.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.includes('Hydration')
    );
    expect(hydrationErrors).toHaveLength(0);

    consoleError.mockRestore();
  });
});
